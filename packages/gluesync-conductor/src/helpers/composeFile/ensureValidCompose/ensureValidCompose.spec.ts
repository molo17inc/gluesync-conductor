import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';

import {
  COMPOSE,
  CORRUPT_SHAPES,
  makeComposeSandbox,
} from '../../../testing/composeSandbox';
import loadWithStubs from '../../../testing/loadWithStubs';
import { ComposeFileCorruptError } from './composeFile.errors';
import type { EnsureValidCompose } from './ensureValidCompose.model';

const here = (p: string): string => path.resolve(__dirname, p);

const load = () => {
  const errors: unknown[][] = [];
  const ensureValidCompose = loadWithStubs<{ default: EnsureValidCompose }>(
    here('./ensureValidCompose'),
    {
      [here('../../../utils/logger')]: {
        getLogger: () => ({
          error: (...args: unknown[]) => errors.push(args),
        }),
      },
    },
  ).default;
  return { ensureValidCompose, errors };
};

let sandbox = makeComposeSandbox();
afterEach(() => sandbox.restore());

describe('ensureValidCompose', () => {
  CORRUPT_SHAPES.forEach(([name, text]) => {
    it(`restores ${name} from the last-good copy and logs an error`, async () => {
      sandbox = makeComposeSandbox();
      sandbox.setLastGood(COMPOSE);
      sandbox.setCompose(text);
      const { ensureValidCompose, errors } = load();

      const value = await ensureValidCompose(sandbox.compose);

      assert.equal(sandbox.read(sandbox.compose), COMPOSE);
      assert.deepEqual(Object.keys(value?.services), [
        'gluesync-core-hub',
        'gluesync-conductor',
      ]);
      assert.equal(errors.length, 1);
      assert.equal(
        errors[0][1],
        '[compose-guard] restored docker-compose.yml from last-good backup',
      );
    });

    it(`throws ComposeFileCorruptError for ${name} without a last-good copy, leaving the file as it is`, async () => {
      sandbox = makeComposeSandbox();
      sandbox.setCompose(text);
      const { ensureValidCompose } = load();

      await assert.rejects(
        ensureValidCompose(sandbox.compose),
        (error: unknown) => {
          assert.ok(error instanceof ComposeFileCorruptError);
          assert.match(
            error.message,
            /docker-compose\.yml is empty or corrupt/,
          );
          return true;
        },
      );
      assert.equal(sandbox.read(sandbox.compose), text);
    });
  });

  it('does not restore from an invalid last-good copy', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setLastGood('services: {}\n');
    sandbox.setCompose('');
    await assert.rejects(
      load().ensureValidCompose(sandbox.compose),
      ComposeFileCorruptError,
    );
    assert.equal(sandbox.read(sandbox.compose), '');
  });

  it('leaves a valid file alone and returns it parsed', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setLastGood(COMPOSE.replace('0.13.1', '0.13.0'));
    sandbox.setCompose(COMPOSE);
    const { ensureValidCompose, errors } = load();
    const value = await ensureValidCompose(sandbox.compose);
    assert.equal(
      value?.services['gluesync-conductor'].image,
      'molo17/gluesync-conductor:0.13.1',
    );
    assert.equal(sandbox.read(sandbox.compose), COMPOSE);
    assert.equal(errors.length, 0);
  });

  it('returns undefined for a file that does not exist', async () => {
    sandbox = makeComposeSandbox();
    assert.equal(await load().ensureValidCompose(sandbox.compose), undefined);
  });

  it('never restores another file from the compose backup', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setLastGood(COMPOSE);
    const other = path.join(
      mkdtempSync(path.join(tmpdir(), 'other-')),
      'x.yml',
    );
    writeFileSync(other, '');
    await assert.rejects(
      load().ensureValidCompose(other),
      ComposeFileCorruptError,
    );
    assert.equal(sandbox.read(other), '');
  });
});
