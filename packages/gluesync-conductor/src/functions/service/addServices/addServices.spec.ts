import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { AddServicesHandler } from './addServices.model';

const helper = (p: string): string =>
  path.resolve(__dirname, '../../../helpers', p);

const load = (orchestrator: unknown) => {
  const created: unknown[][] = [];
  const handler = loadWithStubs<{ default: AddServicesHandler }>(
    path.resolve(__dirname, './addServices'),
    {
      [helper('orchestrator/getOrchestrator/getOrchestrator')]: {
        getDecidedOrchestrator: async () => orchestrator ?? undefined,
      },
      [helper('composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => ({ services: {} }),
      },
      [helper('processService/processService')]: {
        default: async (
          _compose: unknown,
          services: ReadonlyArray<{ serviceId: string }>,
          _validate: unknown,
          createService: (service: unknown) => unknown,
        ) => {
          services.forEach(service => created.push([createService(service)]));
          return { results: [{ success: true, serviceId: 'x' }] };
        },
      },
      [helper('composeFile/createComposeService/createComposeService')]: {
        default: (type: string, options: unknown) => ({ type, options }),
      },
      [helper('processService/service.factory')]: {
        default: (service: unknown) => service,
      },
      [helper('cleanResults/cleanResults')]: {
        default: async (results: unknown) => results,
      },
    },
  ).default;

  return { handler, created };
};

const run = async (handler: AddServicesHandler) => {
  const sent: Array<{ code?: number; body?: unknown }> = [{}];
  const reply = {
    code: (n: number) => {
      sent[0].code = n;
      return reply;
    },
    send: (body: unknown) => {
      sent[0].body = body;
      return reply;
    },
  };
  await (handler as unknown as (req: unknown, reply: unknown) => Promise<void>)(
    {
      query: {},
      body: {
        services: [{ id: '1', imageName: 'agent', type: 'agent', labels: {} }],
      },
      server: { docker: {} },
    },
    reply,
  );

  return sent[0];
};

describe('addServices', () => {
  it('writes compose services without the swarm option', async () => {
    const { handler, created } = load({ mode: 'compose' });

    assert.equal((await run(handler)).code, 200);
    assert.equal(
      'swarm' in ((created[0][0] as { options: object }).options as object),
      false,
    );
  });

  it('writes stack file services on Swarm', async () => {
    const { handler, created } = load({
      mode: 'swarm',
      namespace: 'gs',
      selfService: 'gluesync-conductor',
      isManager: true,
    });

    assert.equal((await run(handler)).code, 200);
    assert.deepEqual(
      (created[0][0] as { options: { swarm: unknown } }).options.swarm,
      {},
    );
  });

  it('answers 503 DOCKER_NOT_READY and writes nothing while the mode is unknown', async () => {
    const { handler, created } = load(null);
    const { code, body } = await run(handler);

    assert.equal(code, 503);
    assert.equal(
      (body as { diagnosis: { code: string } }).diagnosis.code,
      'DOCKER_NOT_READY',
    );
    assert.deepEqual(created, []);
  });
});
