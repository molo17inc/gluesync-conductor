import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

const load = () => {
  const state = { disabled: 0 };
  const { spawnAsync } = loadWithStubs<{
    spawnAsync: (
      cmd: string,
      args: ReadonlyArray<string>,
      opts?: Readonly<{ keepUpdateMode?: boolean }>,
    ) => Promise<boolean>;
  }>(here('./autoReboot'), {
    [here('./autoRebootWindows')]: { default: async () => true },
    [here('./autorebootLinux')]: { default: async () => true },
    [here('../../plugins/apiBlockerAsUpdating')]: {
      disableUpdateMode: () => {
        state.disabled += 1;
      },
    },
    [here('../../utils/logger')]: {
      getLogger: () => ({ info: () => 0 }),
    },
  });
  return { spawnAsync, state };
};

const node = (code: number) => ['-e', `process.exit(${code})`];

describe('spawnAsync', () => {
  it('ends update mode when the command succeeds', async () => {
    const { spawnAsync, state } = load();

    assert.equal(await spawnAsync(process.execPath, node(0)), true);
    assert.equal(state.disabled, 1);
  });

  it('leaves update mode on when the command only starts a detached helper', async () => {
    const { spawnAsync, state } = load();

    assert.equal(
      await spawnAsync(process.execPath, node(0), { keepUpdateMode: true }),
      true,
    );
    assert.equal(state.disabled, 0);
  });

  it('rejects when the command fails', async () => {
    const { spawnAsync, state } = load();

    await assert.rejects(
      spawnAsync(process.execPath, node(3), { keepUpdateMode: true }),
      /exited with code 3/,
    );
    assert.equal(state.disabled, 0);
  });
});
