/* eslint-disable no-throw-literal -- docker-compose rejects with plain { err } objects */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { RawComposeFile } from '../../../../models/composeFile.model';
import loadWithStubs from '../../../../testing/loadWithStubs';
import type { UpdateConductorOnly } from './updateConductorOnly.model';

const here = (p: string): string => path.resolve(__dirname, p);

const load = (rollbackOutcomes: unknown[] = []) => {
  const edits: unknown[][] = [];
  const rollbacks: unknown[][] = [];
  let updateModeEnabled = 0;
  const update = loadWithStubs<{ default: UpdateConductorOnly }>(
    here('./updateConductorOnly'),
    {
      [here(
        '../../../../helpers/editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile',
      )]: {
        default: async (...args: unknown[]) => {
          edits.push(args);
        },
      },
      [here('../../../../plugins/apiBlockerAsUpdating')]: {
        enableUpdateMode: () => {
          updateModeEnabled += 1;
        },
      },
      [here('../../../../helpers/rollbackServiceImages/rollbackServiceImages')]:
        {
          default: async (...args: unknown[]) => {
            rollbacks.push(args);
            return rollbackOutcomes;
          },
        },
    },
  ).default;
  return { update, edits, rollbacks, enabled: () => updateModeEnabled };
};

const compose = {
  services: { 'gluesync-conductor': { image: 'conductor:1' } },
} as unknown as RawComposeFile;

const info = { id: 'gluesync-conductor', availableVersion: '2.0.0' };

describe('updateConductorOnly', () => {
  it('refuses to update without an available version', async () => {
    const { update, edits } = load();
    await assert.rejects(
      update(async () => 'ok', { id: 'c', availableVersion: null }, compose),
      /No available version for conductor/,
    );
    assert.equal(edits.length, 0);
  });

  it('edits the compose file and enables update mode when the pull works', async () => {
    const { update, edits, rollbacks, enabled } = load();
    const result = await update(async id => `${id} ok`, info, compose);
    assert.deepEqual(edits, [
      [
        ['gluesync-conductor'],
        compose,
        {
          agentVersion: null,
          modules: [{ id: 'gluesync-conductor', version: '2.0.0' }],
        },
      ],
    ]);
    assert.deepEqual(result, {
      id: 'gluesync-conductor',
      results: [{ status: 'fulfilled', value: 'gluesync-conductor ok' }],
    });
    assert.equal(enabled(), 1);
    assert.equal(rollbacks.length, 0);
  });

  it('puts only the compose file back when the pull fails', async () => {
    const { update, rollbacks, enabled } = load();
    const result = await update(
      async () => {
        throw { exitCode: 1, err: 'pull access denied' };
      },
      info,
      compose,
    );
    assert.deepEqual(rollbacks, [
      [
        [{ id: 'gluesync-conductor', image: 'conductor:1' }],
        { recreate: false },
      ],
    ]);
    assert.deepEqual(result, {
      id: 'gluesync-conductor',
      results: [
        {
          status: 'rejected',
          reason: {
            err: 'pull access denied Compose file restored to conductor:1.',
          },
        },
      ],
    });
    assert.equal(enabled(), 0);
  });

  it('reports a compose file that could not be restored next to the pull error', async () => {
    const { update } = load([
      {
        id: 'gluesync-conductor',
        image: 'conductor:1',
        ok: false,
        error: 'compose file could not be restored: not enough free disk space',
      },
    ]);
    const result = await update(
      async () => {
        throw { exitCode: 1, err: 'pull access denied' };
      },
      info,
      compose,
    );
    assert.deepEqual(result.results, [
      {
        status: 'rejected',
        reason: {
          err: 'pull access denied Compose file could not be put back on conductor:1: compose file could not be restored: not enough free disk space',
        },
      },
    ]);
  });

  it('has nothing to restore when the compose file has no previous image', async () => {
    const { update, rollbacks } = load();
    const result = await update(
      async () => {
        throw new Error('boom');
      },
      info,
      { services: {} } as unknown as RawComposeFile,
    );
    assert.equal(rollbacks.length, 0);
    assert.deepEqual(result.results, [
      { status: 'rejected', reason: { err: 'boom' } },
    ]);
  });
});
