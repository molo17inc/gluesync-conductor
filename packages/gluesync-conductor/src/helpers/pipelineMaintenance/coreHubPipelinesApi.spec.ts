import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import type CreateApi from './coreHubPipelinesApi';
import {
  CoreHubApiError,
  CoreHubUnreachableError,
} from './pipelineMaintenance.errors';

type Request = Readonly<{
  method: string;
  url: string;
  headers: Record<string, string>;
  timeout: number;
}>;

type Reply = Readonly<{ data?: unknown; status?: number; network?: string }>;

const axiosError = (reply: Reply) =>
  Object.assign(new Error(reply.network ?? `status ${reply.status}`), {
    isAxiosError: true,
    response: reply.network
      ? undefined
      : { status: reply.status, data: reply.data },
  });

const load = (replies: Record<string, Reply>) => {
  const requests: Request[] = [];
  const answer = async (
    method: string,
    url: string,
    config: Readonly<{ headers: Record<string, string>; timeout: number }>,
  ) => {
    requests.push({ method, url, ...config });
    const reply = replies[`${method} ${new URL(url).pathname}`] ?? {
      status: 404,
    };
    if (reply.network || (reply.status ?? 200) >= 400) {
      throw axiosError(reply);
    }
    return { status: reply.status ?? 200, data: reply.data };
  };
  const create = loadWithStubs<{ default: typeof CreateApi }>(
    path.resolve(__dirname, './coreHubPipelinesApi'),
    {
      axios: {
        default: {
          create: () => ({
            get: (url: string, config: never) => answer('GET', url, config),
            post: (url: string, _body: unknown, config: never) =>
              answer('POST', url, config),
          }),
          isAxiosError: (e: { isAxiosError?: boolean }) =>
            e?.isAxiosError === true,
        },
      },
    },
  ).default;
  return { create, requests };
};

const connected = {
  baseUrl: () => 'https://corehub:1717/',
  token: () => 'module-jwt',
  timeoutMs: 1000,
  commandTimeoutMs: 5000,
};

describe('coreHubPipelinesApi', () => {
  it('lists the pipelines with the module token', async () => {
    const { create, requests } = load({
      'GET /pipelines': {
        data: [
          {
            id: 'p1',
            name: 'Orders',
            configurationCompleted: true,
            isInMaintenanceMode: false,
            sourceAgentsInfo: [],
          },
          {
            id: 'p2',
            configurationCompleted: false,
            isInMaintenanceMode: true,
          },
          { id: 'p3' },
          { name: 'no id' },
        ],
      },
    });

    const pipelines = await create(connected).listPipelines();

    assert.deepEqual(pipelines, [
      {
        id: 'p1',
        name: 'Orders',
        configurationCompleted: true,
        isInMaintenanceMode: false,
      },
      {
        id: 'p2',
        name: undefined,
        configurationCompleted: false,
        isInMaintenanceMode: true,
      },
      {
        id: 'p3',
        name: undefined,
        configurationCompleted: true,
        isInMaintenanceMode: false,
      },
    ]);
    assert.equal(requests[0].url, 'https://corehub:1717/pipelines');
    assert.equal(requests[0].headers.Authorization, 'Bearer module-jwt');
    assert.equal(requests[0].timeout, 1000);
  });

  it('calls a pipeline running when an entity syncs or migrates', async () => {
    const { create, requests } = load({
      'GET /pipelines/a/entities-status': {
        data: [
          { entityId: 'e1', isSyncActive: false, isMigrationActive: false },
          { entityId: 'e2', isSyncActive: true, isMigrationActive: false },
        ],
      },
      'GET /pipelines/b/entities-status': {
        data: [
          { entityId: 'e1', isSyncActive: false, isMigrationActive: true },
        ],
      },
      'GET /pipelines/c/entities-status': {
        data: [
          { entityId: 'e1', isSyncActive: false, isMigrationActive: false },
        ],
      },
      'GET /pipelines/d%2Fx/entities-status': { data: [] },
    });
    const api = create(connected);

    assert.equal(await api.isRunning('a'), true);
    assert.equal(await api.isRunning('b'), true);
    assert.equal(await api.isRunning('c'), false);
    assert.equal(await api.isRunning('d/x'), false);
    assert.equal(
      requests[3].url,
      'https://corehub:1717/pipelines/d%2Fx/entities-status',
    );
  });

  it('enters and exits maintenance mode with the command timeout', async () => {
    const { create, requests } = load({
      'POST /pipelines/p1/commands/maintenance/enter': { status: 202 },
      'POST /pipelines/p1/commands/maintenance/exit': { status: 202 },
    });
    const api = create(connected);

    await api.enterMaintenance('p1');
    await api.exitMaintenance('p1');

    assert.deepEqual(
      requests.map(r => [r.method, r.url, r.timeout]),
      [
        [
          'POST',
          'https://corehub:1717/pipelines/p1/commands/maintenance/enter',
          5000,
        ],
        [
          'POST',
          'https://corehub:1717/pipelines/p1/commands/maintenance/exit',
          5000,
        ],
      ],
    );
  });

  it("turns Core Hub's error answer into a CoreHubApiError with its status and message", async () => {
    const { create } = load({
      'POST /pipelines/p1/commands/maintenance/enter': {
        status: 500,
        data: {
          notificationId: 7,
          message: 'Failed to enter maintenance mode.',
          exceptionMessage: 'agent busy',
        },
      },
    });

    const error = await create(connected)
      .enterMaintenance('p1')
      .catch((e: unknown) => e);

    assert.ok(error instanceof CoreHubApiError);
    assert.equal(error.status, 500);
    assert.match(
      error.message,
      /putting pipeline p1 in maintenance mode: Core Hub answered 500 \(Failed to enter maintenance mode\. - agent busy\)/,
    );
  });

  it('a refused connection is CoreHubUnreachableError', async () => {
    const { create } = load({
      'GET /pipelines': { network: 'connect ECONNREFUSED 10.0.0.2:1717' },
    });

    const error = await create(connected)
      .listPipelines()
      .catch((e: unknown) => e);

    assert.ok(error instanceof CoreHubUnreachableError);
    assert.match(error.message, /ECONNREFUSED/);
  });

  it('without a module token nothing is sent: CoreHubUnreachableError', async () => {
    const { create, requests } = load({});

    const error = await create({ ...connected, token: () => null })
      .listPipelines()
      .catch((e: unknown) => e);

    assert.ok(error instanceof CoreHubUnreachableError);
    assert.match(error.message, /not connected to Core Hub/);
    assert.equal(requests.length, 0);
  });

  it('without a Core Hub address nothing is sent: CoreHubUnreachableError', async () => {
    const { create, requests } = load({});

    const error = await create({ ...connected, baseUrl: () => null })
      .exitMaintenance('p1')
      .catch((e: unknown) => e);

    assert.ok(error instanceof CoreHubUnreachableError);
    assert.equal(requests.length, 0);
  });

  it('a list that is not a list is a CoreHubApiError', async () => {
    const { create } = load({ 'GET /pipelines': { data: '<html>' } });

    const error = await create(connected)
      .listPipelines()
      .catch((e: unknown) => e);

    assert.ok(error instanceof CoreHubApiError);
  });
});
