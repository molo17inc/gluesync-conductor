import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Docker from 'dockerode';

import {
  beginFullRestart,
  FULL_RESTART_HELPER_LABEL,
  fullRestartRunningSince,
} from './fullRestartInProgress';

const docker = (listContainers: (opts: unknown) => Promise<unknown>): Docker =>
  ({ listContainers }) as unknown as Docker;

const noHelpers = docker(async () => []);

describe('fullRestartRunningSince', () => {
  it('sees a restart this conductor started until it ends', async () => {
    assert.equal(await fullRestartRunningSince(noHelpers), undefined);

    const end = beginFullRestart();
    assert.match(
      (await fullRestartRunningSince(noHelpers)) ?? '',
      /^\d{4}-\d\d-\d\dT/,
    );

    end();
    assert.equal(await fullRestartRunningSince(noHelpers), undefined);
  });

  it('sees the helper of a restart another conductor started, by its label', async () => {
    const asked: unknown[] = [];
    const since = await fullRestartRunningSince(
      docker(async opts => {
        asked.push(opts);
        return [{ Created: 1_794_052_338 }, { Created: 1_794_052_310 }];
      }),
    );

    assert.equal(since, '2026-11-07T11:51:50.000Z');
    assert.deepEqual(asked, [
      { filters: { label: [FULL_RESTART_HELPER_LABEL] } },
    ]);
  });

  it('reads an engine that does not answer as no restart running', async () => {
    const since = await fullRestartRunningSince(
      docker(async () => {
        throw new Error('connect ENOENT');
      }),
    );
    assert.equal(since, undefined);
  });
});
