import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { RestartWindowsDependentServices } from './restartWindowsDependentServices.models';
import type { RunCmd } from '../createActions/createActions.model';

const here = (p: string): string => path.resolve(__dirname, p);

const load = (readyError?: Error) =>
  loadWithStubs<{ default: RestartWindowsDependentServices }>(
    here('./restartWindowsDependentServices'),
    {
      [here('../../waitForContainerReady/waitForContainerReady')]: {
        default: async () => {
          if (readyError) {
            throw readyError;
          }
        },
      },
      [here('../../../utils/logger')]: {
        getLogger: () => ({ info: () => {}, warn: () => {} }),
      },
    },
  ).default;

const restart =
  (calls: string[], failing = false): RunCmd =>
  async (_cmd, id, filename, extraOptions) => {
    calls.push(`${id} ${filename} ${(extraOptions ?? []).join(' ')}`);
    if (failing) {
      throw new Error('restart broke');
    }
    return 'ok';
  };

const docker = {} as never;

describe('restartWindowsDependentServices', () => {
  it('restarts chronos and leaves the Conductor restart to after the reply', async () => {
    const calls: string[] = [];
    const message = await load()(
      docker,
      restart(calls),
      'compose.yml',
      'gluesync-core-hub',
      'gluesync-chronos',
      'gluesync-conductor',
    );
    assert.deepEqual(calls, ['gluesync-chronos compose.yml --no-deps']);
    assert.equal(
      message,
      'Core-hub gluesync-core-hub updated and restarted. Dependent services: gluesync-chronos restarted, gluesync-conductor restarts after this reply.',
    );
  });

  it('reports a chronos restart that failed, and goes on when Core Hub is not ready yet', async () => {
    const message = await load(new Error('not ready'))(
      docker,
      restart([], true),
      'compose.yml',
      'gluesync-core-hub',
      'gluesync-chronos',
      'gluesync-conductor',
    );
    assert.match(message, /gluesync-chronos restart failed/);
  });
});
