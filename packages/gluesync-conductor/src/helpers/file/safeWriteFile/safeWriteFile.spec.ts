/* eslint-disable functional/no-loop-statements, no-restricted-syntax, no-await-in-loop -- the fault matrix walks every operation in turn */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import makeFakeFs, { FakeOptions } from '../../../testing/fakeSafeWriteFs';
import safeWriteFile from './safeWriteFile';
import { DiskFullError, UnsafeWriteError } from './safeWriteFile.errors';
import { WriteStrategy } from './safeWriteFile.model';

const DIR = '/srv/gs';
const FILE = `${DIR}/docker-compose.yml`;

const line = (text: string, size: number): string =>
  `${text}${'x'.repeat(Math.max(0, size - text.length - 1))}\n`;

// Same-size, growing and shrinking rewrites of a small file.
const CASES: ReadonlyArray<
  Readonly<{ name: string; old: string; next: string }>
> = [
  { name: 'grows', old: line('old', 40), next: line('new', 90) },
  { name: 'keeps its size', old: line('old', 60), next: line('new', 60) },
  { name: 'shrinks', old: line('old', 90), next: line('new', 40) },
];

const STRATEGIES: ReadonlyArray<WriteStrategy> = ['replace', 'in-place'];

const run = async (options: FakeOptions, next: string, mode: WriteStrategy) => {
  const fakeFs = makeFakeFs(options);
  const error = await safeWriteFile(FILE, next, { fs: fakeFs, mode }).then(
    () => undefined,
    (e: unknown) => e as Error & { code?: string },
  );
  return { fakeFs, error };
};

// Whatever happened, the file holds the old bytes (failure) or the new ones (success).
const assertAllOrNothing = (
  result: Awaited<ReturnType<typeof run>>,
  old: string,
  next: string,
  context: string,
): void => {
  const { fakeFs, error } = result;
  assert.equal(
    fakeFs.read(FILE),
    error ? old : next,
    `${context}: ${error ? `failed (${error.message})` : 'succeeded'}`,
  );
  assert.deepEqual(fakeFs.names(), [FILE], `${context}: leftover files`);
};

const writesOf = (trace: ReadonlyArray<string>): number[] =>
  trace.flatMap((name, index) => (name === 'write' ? [index] : []));

describe('safeWriteFile with faults at every step', () => {
  STRATEGIES.forEach(mode => {
    CASES.forEach(({ name, old, next }) => {
      ['ENOSPC', 'EDQUOT', 'EIO'].forEach(code => {
        it(`${mode}, content ${name}: a ${code} at any operation leaves old or new`, async () => {
          const clean = await run({ files: { [FILE]: old } }, next, mode);
          assert.equal(clean.error, undefined);
          assert.equal(clean.fakeFs.read(FILE), next);

          const writes = new Set(writesOf(clean.fakeFs.trace));
          const total = clean.fakeFs.trace.length;
          for (let at = 0; at < total; at += 1) {
            const partials = writes.has(at)
              ? [undefined, 0, 1, 17, next.length - 1]
              : [undefined];
            for (const partial of partials) {
              const result = await run(
                { files: { [FILE]: old }, fault: { at, code, partial } },
                next,
                mode,
              );
              assertAllOrNothing(
                result,
                old,
                next,
                `${code} at ${at}/${total} (${clean.fakeFs.trace[at]}) partial=${partial}`,
              );
              if (result.error && code !== 'EIO') {
                assert.ok(result.error instanceof DiskFullError);
                assert.equal(result.error.code, 'ENOSPC');
              }
            }
          }
        });
      });

      it(`${mode}, content ${name}: a disk that fills up after k bytes leaves old or new`, async () => {
        const upTo = old.length + next.length + 3;
        for (let capacity = old.length; capacity <= upTo; capacity += 1) {
          // statfs claims space, so the write itself has to hit ENOSPC.
          const result = await run(
            { files: { [FILE]: old }, capacity, statfsFree: 1e9 },
            next,
            mode,
          );
          assertAllOrNothing(result, old, next, `capacity ${capacity}`);
          // replace holds both files at once, in place only the longer one
          const needed =
            mode === 'replace'
              ? old.length + next.length
              : Math.max(old.length, next.length);
          assert.equal(
            result.error === undefined,
            capacity >= needed,
            `capacity ${capacity}, needed ${needed}`,
          );
          if (result.error) {
            assert.ok(result.error instanceof DiskFullError);
            assert.match(result.error.message, /not enough free disk space/);
            assert.match(result.error.message, /docker-compose\.yml/);
          }
        }
      });
    });
  });
});

describe('safeWriteFile pre-flight', () => {
  const old = line('old', 40);
  const next = line('new', 90);

  it('refuses with DiskFullError before touching anything when free space is short', async () => {
    const fakeFs = makeFakeFs({ files: { [FILE]: old }, statfsFree: 10 });
    await assert.rejects(
      safeWriteFile(FILE, next, { fs: fakeFs }),
      (error: unknown) => {
        assert.ok(error instanceof DiskFullError);
        assert.equal(error.code, 'ENOSPC');
        assert.equal(error.available, 10);
        assert.ok(error.needed >= next.length);
        assert.match(error.message, /not enough free disk space/);
        assert.match(error.message, /need \d+ bytes, 10 available/);
        return true;
      },
    );
    assert.equal(fakeFs.read(FILE), old);
    assert.equal(fakeFs.mutations(), 0);
    assert.deepEqual(fakeFs.names(), [FILE]);
  });

  it('keeps the reserve on top of what the write needs', async () => {
    const saved = process.env.CONDUCTOR_WRITE_RESERVE_BYTES;
    try {
      process.env.CONDUCTOR_WRITE_RESERVE_BYTES = '1000';
      const fakeFs = makeFakeFs({
        files: { [FILE]: old },
        statfsFree: next.length + 999,
      });
      await assert.rejects(
        safeWriteFile(FILE, next, { fs: fakeFs }),
        DiskFullError,
      );
      process.env.CONDUCTOR_WRITE_RESERVE_BYTES = '1';
      await safeWriteFile(FILE, next, {
        fs: makeFakeFs({
          files: { [FILE]: old },
          statfsFree: next.length + 1,
        }),
      });
    } finally {
      if (saved === undefined) {
        delete process.env.CONDUCTOR_WRITE_RESERVE_BYTES;
      } else {
        process.env.CONDUCTOR_WRITE_RESERVE_BYTES = saved;
      }
    }
  });

  it('asks statfs about the file itself, and the directory too when replacing', async () => {
    const replace = makeFakeFs({ files: { [FILE]: old } });
    await safeWriteFile(FILE, next, { fs: replace });
    assert.deepEqual(replace.statfsCalls, [FILE, DIR]);

    // a single-file bind mount: the directory is on another device
    const mounted = makeFakeFs({ files: { [FILE]: old }, devs: { [FILE]: 2 } });
    await safeWriteFile(FILE, next, { fs: mounted });
    assert.deepEqual(mounted.statfsCalls, [FILE]);

    const fresh = makeFakeFs({ files: { [`${DIR}/other`]: 'x' } });
    await safeWriteFile(FILE, next, { fs: fresh });
    assert.deepEqual(
      fresh.statfsCalls,
      [FILE.replace(/[^/]+$/, '')].map(() => DIR),
    );
  });

  it('proceeds when the file system cannot report free space', async () => {
    for (const code of ['ENOSYS', 'ENOTSUP', 'EINVAL']) {
      const fakeFs = makeFakeFs({ files: { [FILE]: old }, statfsError: code });
      await safeWriteFile(FILE, next, { fs: fakeFs });
      assert.equal(fakeFs.read(FILE), next, code);
    }
  });
});

describe('safeWriteFile strategies', () => {
  const old = line('old', 40);
  const next = line('new', 90);

  it('falls back to writing in place when the rename is blocked', async () => {
    for (const code of ['EBUSY', 'EXDEV', 'EPERM', 'EACCES']) {
      const fakeFs = makeFakeFs({
        files: { [FILE]: old },
        renameError: code,
      });
      await safeWriteFile(FILE, next, { fs: fakeFs });
      assert.equal(fakeFs.read(FILE), next, code);
      assert.deepEqual(fakeFs.names(), [FILE], code);
      assert.ok(fakeFs.trace.includes('open r+'), code);
    }
  });

  it('does not fall back when replace was asked for', async () => {
    const fakeFs = makeFakeFs({ files: { [FILE]: old }, renameError: 'EBUSY' });
    await assert.rejects(
      safeWriteFile(FILE, next, { fs: fakeFs, mode: 'replace' }),
      { code: 'EBUSY' },
    );
    assert.equal(fakeFs.read(FILE), old);
    assert.deepEqual(fakeFs.names(), [FILE]);
  });

  it('writes a single-file bind mount in place, without a temp file', async () => {
    const fakeFs = makeFakeFs({ files: { [FILE]: old }, devs: { [FILE]: 7 } });
    await safeWriteFile(FILE, next, { fs: fakeFs });
    assert.equal(fakeFs.read(FILE), next);
    assert.equal(fakeFs.trace.includes('open wx'), false);
    assert.equal(fakeFs.trace.includes('rename'), false);
  });

  it('creates a missing file', async () => {
    const fakeFs = makeFakeFs({ files: { [`${DIR}/other`]: 'x' } });
    await safeWriteFile(FILE, next, { fs: fakeFs });
    assert.equal(fakeFs.read(FILE), next);
    assert.deepEqual([...fakeFs.names()].sort(), [FILE, `${DIR}/other`]);
  });

  it('is never empty on disk while writing in place', async () => {
    const fakeFs = makeFakeFs({ files: { [FILE]: old }, devs: { [FILE]: 7 } });
    await safeWriteFile(FILE, next, { fs: fakeFs, mode: 'in-place' });
    // no 'w' open, and the only truncate is to the new length
    assert.equal(
      fakeFs.trace.filter(name => name.startsWith('open')).join(),
      'open r+',
    );
  });
});

describe('safeWriteFile content checks', () => {
  const old = line('old', 40);

  it('refuses empty content unless it is allowed', async () => {
    const fakeFs = makeFakeFs({ files: { [FILE]: old } });
    await assert.rejects(
      safeWriteFile(FILE, '', { fs: fakeFs }),
      UnsafeWriteError,
    );
    await assert.rejects(
      safeWriteFile(FILE, Buffer.alloc(0), { fs: fakeFs }),
      /content is empty/,
    );
    assert.equal(fakeFs.read(FILE), old);
    assert.equal(fakeFs.trace.length, 0);

    await safeWriteFile(FILE, '', { fs: fakeFs, allowEmpty: true });
    assert.equal(fakeFs.read(FILE), '');
  });

  it('refuses content that does not validate, before touching the file', async () => {
    const fakeFs = makeFakeFs({ files: { [FILE]: old } });
    await assert.rejects(
      safeWriteFile(FILE, 'a: [', {
        fs: fakeFs,
        validate: () => {
          throw new Error('not yaml');
        },
      }),
      /not yaml/,
    );
    assert.equal(fakeFs.read(FILE), old);
    assert.equal(fakeFs.trace.length, 0);
  });
});

describe('safeWriteFile on the real file system', () => {
  const dirWith = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'safe-'));
    writeFileSync(join(dir, 'f.yml'), content);
    return dir;
  };

  STRATEGIES.forEach(mode => {
    it(`${mode} writes grown and shrunk content and keeps the mode`, async () => {
      const dir = dirWith('short\n');
      const file = join(dir, 'f.yml');
      chmodSync(file, 0o640);

      const longer = `${'a: 1\n'.repeat(200)}`;
      await safeWriteFile(file, longer, { mode });
      assert.equal(readFileSync(file, 'utf8'), longer);

      await safeWriteFile(file, 'b: 2\n', { mode });
      assert.equal(readFileSync(file, 'utf8'), 'b: 2\n');

      assert.equal(statSync(file).mode % 0o1000, 0o640);
      assert.deepEqual(readdirSync(dir), ['f.yml']);
    });
  });

  it('accepts Buffers and creates new files', async () => {
    const dir = dirWith('x\n');
    const file = join(dir, 'new.json');
    await safeWriteFile(file, Buffer.from('{"a":1}'));
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
  });
});
