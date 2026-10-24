import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import type { RollbackServiceImages } from './rollbackServiceImages.model';

const here = (p: string): string => path.resolve(__dirname, p);

const load = ({
  upFails = new Set<string>(),
  writeError,
}: { upFails?: ReadonlySet<string>; writeError?: Error } = {}) => {
  const written: unknown[] = [];
  const recreated: string[] = [];
  const rollback = loadWithStubs<{ default: RollbackServiceImages }>(
    here('./rollbackServiceImages'),
    {
      [here('../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => ({
          version: '3',
          services: {
            grafana: { image: 'grafana:new' },
            chronos: { image: 'chronos:1' },
          },
        }),
      },
      [here('../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async (compose: unknown) => {
          if (writeError) {
            throw writeError;
          }
          written.push(compose);
        },
      },
      [here('../dockerode/createActions/createActions')]: {
        runCmd: async (_cmd: unknown, id: string) => {
          if (upFails.has(id)) {
            throw new Error(`up ${id} failed`);
          }
          recreated.push(id);
        },
      },
    },
  ).default;
  return { rollback, written, recreated };
};

describe('rollbackServiceImages', () => {
  it('does nothing without rollbacks', async () => {
    const { rollback, written } = load();
    assert.deepEqual(await rollback([], { recreate: true }), []);
    assert.equal(written.length, 0);
  });

  it('puts the old image back in the compose file without recreating', async () => {
    const { rollback, written, recreated } = load();
    const result = await rollback([{ id: 'grafana', image: 'grafana:old' }], {
      recreate: false,
    });
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true },
    ]);
    assert.deepEqual(written, [
      {
        version: '3',
        services: {
          grafana: { image: 'grafana:old' },
          chronos: { image: 'chronos:1' },
        },
      },
    ]);
    assert.deepEqual(recreated, []);
  });

  it('recreates each service and reports the ones that fail', async () => {
    const { rollback, recreated } = load({ upFails: new Set(['chronos']) });
    const result = await rollback(
      [
        { id: 'grafana', image: 'grafana:old' },
        { id: 'chronos', image: 'chronos:0' },
      ],
      { recreate: true },
    );
    assert.deepEqual(recreated, ['grafana']);
    assert.deepEqual(result, [
      { id: 'grafana', image: 'grafana:old', ok: true },
      {
        id: 'chronos',
        image: 'chronos:0',
        ok: false,
        error: 'up chronos failed',
      },
    ]);
  });

  it('reports a compose file it cannot write instead of throwing, and does not recreate', async () => {
    const full = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
    const { rollback, written, recreated } = load({ writeError: full });
    const result = await rollback(
      [
        { id: 'grafana', image: 'grafana:old' },
        { id: 'chronos', image: 'chronos:0' },
      ],
      { recreate: true },
    );
    assert.equal(written.length, 0);
    assert.deepEqual(recreated, []);
    assert.equal(result.length, 2);
    result.forEach(outcome => {
      assert.equal(outcome.ok, false);
      assert.match(outcome.error ?? '', /compose file could not be restored/);
      assert.match(outcome.error ?? '', /not enough free disk space/);
    });
  });
});
