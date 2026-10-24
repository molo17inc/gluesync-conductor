import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  COMPOSE,
  CORRUPT_SHAPES,
  makeComposeSandbox,
} from '../../../testing/composeSandbox';
import loadWithStubs from '../../../testing/loadWithStubs';
import { ComposeFileCorruptError } from '../ensureValidCompose/composeFile.errors';
import writeComposeFile from '../writeComposeFile/writeComposeFile';
import { readComposeFile } from './readComposeFile';

const here = (p: string): string => path.resolve(__dirname, p);

let sandbox = makeComposeSandbox();
afterEach(() => sandbox.restore());

describe('readComposeFile', () => {
  it('reads a valid compose file raw and parsed', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose(COMPOSE);
    const raw = await readComposeFile({ filename: sandbox.compose, raw: true });
    assert.equal(
      raw.services?.['gluesync-core-hub']?.image,
      'molo17/gluesync-core-hub:2.3.0.0',
    );
    const parsed = await readComposeFile({ filename: sandbox.compose });
    assert.ok(parsed.services);
  });

  it('reads a missing file as empty, as before', async () => {
    sandbox = makeComposeSandbox();
    assert.deepEqual(
      await readComposeFile({ filename: sandbox.compose, raw: true }),
      {},
    );
  });

  CORRUPT_SHAPES.forEach(([name, text]) => {
    it(`puts ${name} back from the last-good copy`, async () => {
      sandbox = makeComposeSandbox();
      sandbox.setLastGood(COMPOSE);
      sandbox.setCompose(text);
      const raw = await readComposeFile({
        filename: sandbox.compose,
        raw: true,
      });
      assert.equal(sandbox.read(sandbox.compose), COMPOSE);
      assert.deepEqual(Object.keys(raw.services ?? {}), [
        'gluesync-core-hub',
        'gluesync-conductor',
      ]);
    });

    it(`throws on ${name} without a last-good copy, never returning {}`, async () => {
      sandbox = makeComposeSandbox();
      sandbox.setCompose(text);
      await assert.rejects(
        readComposeFile({ filename: sandbox.compose, raw: true }),
        ComposeFileCorruptError,
      );
      await assert.rejects(
        readComposeFile({ filename: sandbox.compose }),
        ComposeFileCorruptError,
      );
      assert.equal(sandbox.read(sandbox.compose), text);
    });
  });
});

// Read-modify-write callers: when the read fails they must not write at all,
// or they would save a compose built from `{}` over the damaged file.
describe('compose callers with an unreadable compose file', () => {
  const setup = (text: string) => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose(text);
    const writes: unknown[] = [];
    const reader = {
      readComposeFile: (options: { raw?: boolean } = {}) =>
        readComposeFile({ ...options, filename: sandbox.compose }),
    };
    const writer = {
      default: async (json: unknown) => {
        writes.push(json);
      },
    };
    const stubs = {
      [here('./readComposeFile')]: reader,
      [here('../writeComposeFile/writeComposeFile')]: writer,
    };
    return { writes, stubs };
  };

  CORRUPT_SHAPES.forEach(([name, text]) => {
    it(`healConductorConf and autoAdoptServices do not write after reading ${name}`, async () => {
      const { writes, stubs } = setup(text);
      const rel = (p: string): string => here(`../../${p}`);
      const heal = loadWithStubs<{ default: () => Promise<boolean> }>(
        rel('healConductorConf/healConductorConf'),
        {
          [rel('composeFile/readComposeFile/readComposeFile')]:
            stubs[here('./readComposeFile')],
          [rel('composeFile/writeComposeFile/writeComposeFile')]:
            stubs[here('../writeComposeFile/writeComposeFile')],
        },
      ).default;
      await assert.rejects(heal(), ComposeFileCorruptError);

      const adopt = loadWithStubs<{
        default: () => Promise<{ success: boolean }>;
      }>(rel('autoAdoptServices/autoAdoptServices'), {
        [rel('composeFile/readComposeFile/readComposeFile')]:
          stubs[here('./readComposeFile')],
        [rel('composeFile/writeComposeFile/writeComposeFile')]:
          stubs[here('../writeComposeFile/writeComposeFile')],
      }).default;
      assert.equal((await adopt()).success, false);

      assert.deepEqual(writes, []);
      assert.equal(sandbox.read(sandbox.compose), text);
    });
  });

  CORRUPT_SHAPES.forEach(([name, text]) => {
    it(`editUpdateImagesInComposeFile does not turn ${name} into a stub compose`, async () => {
      setup(text);
      const rel = (p: string): string => here(`../../${p}`);
      const edit = loadWithStubs<{
        default: (
          ids: string[],
          compose: unknown,
          versions: unknown,
        ) => Promise<void>;
      }>(rel('editUpdatedImagesInComposeFile/editUpdateImagesInComposeFile'), {
        [rel('composeFile/writeComposeFile/writeComposeFile')]: {
          default: (json: Record<string, any>) =>
            writeComposeFile(json, sandbox.compose),
        },
      }).default;

      // what a caller holding an empty read would pass in
      await assert.rejects(
        edit(
          ['svc'],
          { services: { svc: { image: 'a/b:1' } } },
          {
            agentVersion: null,
            modules: [{ id: 'svc', version: '2' }],
          },
        ),
        ComposeFileCorruptError,
      );
      assert.equal(sandbox.read(sandbox.compose), text);
    });
  });
});
