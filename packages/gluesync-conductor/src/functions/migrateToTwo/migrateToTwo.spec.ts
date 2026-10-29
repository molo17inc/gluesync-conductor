import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import type { MigrateToTwoHandler } from './migrateToTwo.model';

const helper = (p: string): string =>
  path.resolve(__dirname, '../../helpers', p);

const load = (orchestrator: unknown) => {
  const ran: number[] = [];
  const handler = loadWithStubs<{ default: MigrateToTwoHandler }>(
    path.resolve(__dirname, './migrateToTwo'),
    {
      [helper('orchestrator/getOrchestrator/getOrchestrator')]: {
        getDecidedOrchestrator: async () => orchestrator ?? undefined,
      },
      [helper('runMigrationScript/runMigrationScript')]: {
        default: async () => {
          ran.push(1);

          return { success: true, data: 'migrated' };
        },
      },
    },
  ).default;

  return { handler, ran };
};

const run = async (handler: MigrateToTwoHandler) => {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    status: (code: number) => {
      sent.code = code;

      return reply;
    },
    send: (body: unknown) => {
      sent.body = body;

      return reply;
    },
  };

  await (handler as unknown as (req: unknown, reply: unknown) => Promise<void>)(
    { server: { docker: {} }, log: { error: () => undefined } },
    reply,
  );

  return sent;
};

describe('migrateToTwo', () => {
  it('runs the migration script on compose', async () => {
    const { handler, ran } = load({ mode: 'compose' });
    const { code, body } = await run(handler);

    assert.equal(code, 200);
    assert.deepEqual(body, { success: true, data: 'migrated' });
    assert.equal(ran.length, 1);
  });

  it('refuses with 501 SWARM_UNSUPPORTED on swarm and runs nothing', async () => {
    const { handler, ran } = load({
      mode: 'swarm',
      namespace: 'gs',
      selfService: 'gluesync-conductor',
      isManager: true,
    });
    const { code, body } = await run(handler);
    const { diagnosis } = body as {
      diagnosis: { code: string; params: { feature: string } };
    };

    assert.equal(code, 501);
    assert.equal(diagnosis.code, 'SWARM_UNSUPPORTED');
    assert.equal(diagnosis.params.feature, 'migration-to-v2');
    assert.equal(ran.length, 0);
  });

  it('answers 503 DOCKER_NOT_READY and runs nothing while the mode is unknown', async () => {
    const { handler, ran } = load(null);
    const { code, body } = await run(handler);

    assert.equal(code, 503);
    assert.equal(
      (body as { diagnosis: { code: string } }).diagnosis.code,
      'DOCKER_NOT_READY',
    );
    assert.equal(ran.length, 0);
  });
});
