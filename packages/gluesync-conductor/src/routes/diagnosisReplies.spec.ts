import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, { type FastifyPluginAsync } from 'fastify';

import buildLocalErrorReply from '../diagnosis/buildLocalErrorReply';
import { ComposeFileCorruptError } from '../helpers/composeFile/ensureValidCompose/composeFile.errors';
import { DiskFullError } from '../helpers/file/safeWriteFile/safeWriteFile.errors';
import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: FastifyPluginAsync }>;

// Fastify serializes a reply by its status schema and drops what the schema does
// not list, so each route has to name `diagnosis` for the statuses that carry it.
const guard = () => async () => undefined;

const route = (file: string, handlers: ReadonlyArray<string>) => {
  const failure = { current: undefined as unknown };
  const handler = async (_req: unknown, reply: any) => {
    const local = buildLocalErrorReply(failure.current);
    return reply.code(local?.statusCode ?? 500).send(local?.body);
  };

  const stubs = Object.fromEntries([
    ...handlers.map(h => [
      path.resolve(__dirname, '..', h),
      { default: handler },
    ]),
    [
      path.resolve(__dirname, '../security'),
      {
        requireConfig: guard,
        requireManage: guard,
        requireContainerAction: guard,
      },
    ],
  ]);
  const subject = loadWithStubs<Subject>(path.resolve(__dirname, file), stubs);

  return { failure, plugin: subject.default };
};

const call = async (
  file: string,
  handlers: ReadonlyArray<string>,
  request: Readonly<{
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    payload?: object;
  }>,
  failure: unknown,
) => {
  const { failure: cell, plugin } = route(file, handlers);
  // eslint-disable-next-line functional/immutable-data
  cell.current = failure;
  const app = fastify({ ajv: { customOptions: { strict: false } } });
  await app.register(plugin);
  await app.ready();
  return app.inject(request);
};

const full = new DiskFullError('/srv/docker-compose.yml', 100, 5);
const corrupt = new ComposeFileCorruptError('/srv/docker-compose.yml', 'x');

const cases = [
  {
    name: 'POST /containers',
    file: './containers',
    handlers: ['functions/container/doContainersAction/doContainersAction'],
    request: {
      method: 'POST',
      url: '/containers',
      payload: { action: 'update', ids: [] },
    },
  },
  {
    name: 'GET /containers',
    file: './containers',
    handlers: ['functions/container/listContainers/listContainers'],
    request: { method: 'GET', url: '/containers' },
    only: 'corrupt',
  },
  {
    name: 'POST /services',
    file: './services',
    handlers: ['functions/service/addServices/addServices'],
    request: { method: 'POST', url: '/services', payload: { services: [] } },
  },
  {
    name: 'GET /services',
    file: './services',
    handlers: ['functions/service/getServices/getServices'],
    request: { method: 'GET', url: '/services' },
    only: 'corrupt',
  },
  {
    name: 'PUT /env/legacy-update',
    file: './env',
    handlers: [
      'functions/env/legacyUpdate/getLegacyUpdate',
      'functions/env/legacyUpdate/setLegacyUpdate',
    ],
    request: {
      method: 'PUT',
      url: '/env/legacy-update',
      payload: { enabled: true },
    },
  },
  {
    name: 'POST /collect-logs',
    file: './support',
    handlers: ['functions/utility/collectLogs/collectLogs'],
    request: { method: 'POST', url: '/collect-logs', payload: {} },
  },
  {
    name: 'GET /compose-to-json',
    file: './system',
    handlers: [
      'functions/info/info',
      'functions/version/version',
      'functions/composeToJSON/composeToJSON',
      'functions/system/connectivity/connectivity',
    ],
    request: { method: 'GET', url: '/compose-to-json' },
  },
] as const;

describe('error replies keep their diagnosis through the response schemas', () => {
  cases.forEach(({ name, file, handlers, request, ...rest }) => {
    const only = 'only' in rest ? rest.only : undefined;

    if (only !== 'corrupt') {
      it(`${name}: 507 with DISK_FULL`, async () => {
        const res = await call(file, handlers, request, full);

        assert.equal(res.statusCode, 507);
        assert.equal(res.json().diagnosis.code, 'DISK_FULL');
        assert.match(res.json().details, /not enough free disk space/);
      });
    }

    it(`${name}: 500 with COMPOSE_FILE_CORRUPT`, async () => {
      const res = await call(file, handlers, request, corrupt);

      assert.equal(res.statusCode, 500);
      assert.equal(res.json().diagnosis.code, 'COMPOSE_FILE_CORRUPT');
    });
  });
});
