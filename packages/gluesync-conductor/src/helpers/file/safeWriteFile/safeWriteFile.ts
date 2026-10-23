import { randomBytes } from 'node:crypto';
import { fsync } from 'node:fs';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import ensureFreeSpace, {
  getWriteReserveBytes,
  queryFreeBytes,
} from '../ensureFreeSpace/ensureFreeSpace';
import { DiskFullError, UnsafeWriteError } from './safeWriteFile.errors';
import {
  FileHandleLike,
  SafeWriteFile,
  SafeWriteFs,
  SafeWriteOptions,
} from './safeWriteFile.model';

const NEWLINE = 0x0a;
const RENAME_BLOCKED = new Set(['EBUSY', 'EXDEV', 'EPERM', 'EACCES']);

const fsyncAsync = promisify(fsync);

// fsync goes through the fd: FileHandle.sync is not implemented under Yarn PnP.
const realFs: SafeWriteFs = {
  open: async (path, flags, mode) => {
    const handle = await fsp.open(path, flags, mode);
    return {
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      write: (buffer, offset, length, position) =>
        handle.write(buffer, offset, length, position),
      truncate: length => handle.truncate(length),
      sync: () => fsyncAsync(handle.fd),
      chmod: mode => handle.chmod(mode),
      close: () => handle.close(),
    };
  },
  stat: path => fsp.stat(path),
  statfs: path => fsp.statfs(path),
  rename: (from, to) => fsp.rename(from, to),
  unlink: path => fsp.unlink(path),
  readFile: path => fsp.readFile(path),
};

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

const isDiskFull = (error: unknown): boolean =>
  error instanceof DiskFullError ||
  codeOf(error) === 'ENOSPC' ||
  codeOf(error) === 'EDQUOT';

// Kernel ENOSPC/EDQUOT become the DiskFullError callers (and the UI) know.
const asWriteError = async (
  fs: SafeWriteFs,
  path: string,
  needed: number,
  error: unknown,
): Promise<unknown> => {
  if (error instanceof DiskFullError || !isDiskFull(error)) {
    return error;
  }
  return new DiskFullError(
    path,
    needed,
    await queryFreeBytes(path, fs.statfs),
    { cause: error },
  );
};

const ignoreErrors = async (task: () => Promise<unknown>): Promise<void> => {
  try {
    await task();
  } catch {
    // best effort: the caller already has the error that matters
  }
};

// A write that stores nothing would loop forever: it is a full disk.
const writeAll = async (
  handle: FileHandleLike,
  buffer: Buffer,
  position: number,
  done = 0,
): Promise<void> => {
  if (done >= buffer.length) {
    return;
  }
  const { bytesWritten } = await handle.write(
    buffer,
    done,
    buffer.length - done,
    position + done,
  );
  if (bytesWritten <= 0) {
    throw Object.assign(new Error('write stored no bytes'), { code: 'ENOSPC' });
  }
  await writeAll(handle, buffer, position, done + bytesWritten);
};

// Reads until EOF or `max` bytes; one byte past the expected size shows extra data.
const readAll = async (
  handle: FileHandleLike,
  max: number,
  done = 0,
  chunks: ReadonlyArray<Buffer> = [],
): Promise<Buffer> => {
  if (done >= max) {
    return Buffer.concat(chunks);
  }
  const chunk = Buffer.alloc(max - done);
  const { bytesRead } = await handle.read(chunk, 0, chunk.length, done);
  return bytesRead <= 0
    ? Buffer.concat(chunks)
    : readAll(handle, max, done + bytesRead, [
        ...chunks,
        chunk.subarray(0, bytesRead),
      ]);
};

const padded = (data: Buffer, length: number): Buffer =>
  Buffer.concat([data, Buffer.alloc(length - data.length, NEWLINE)]);

// ------------------------------------------------------------ in place

// Blocks are allocated first (old content plus newlines means the same thing
// to YAML, .env and JSON), so the overwrite itself cannot hit ENOSPC.
const growFile = async (
  handle: FileHandleLike,
  oldLength: number,
  length: number,
): Promise<void> => {
  if (length > oldLength) {
    await writeAll(
      handle,
      Buffer.alloc(length - oldLength, NEWLINE),
      oldLength,
    );
    await handle.sync();
  }
};

const shrinkFile = async (
  handle: FileHandleLike,
  newLength: number,
  length: number,
): Promise<void> => {
  if (length > newLength) {
    await handle.truncate(newLength);
    await handle.sync();
  }
};

const verifyContent = async (
  handle: FileHandleLike,
  path: string,
  data: Buffer,
): Promise<void> => {
  const actual = await readAll(handle, data.length + 1);
  if (!actual.equals(data)) {
    throw new Error(`read-back of ${path} does not match what was written`);
  }
};

const restoreOldContent = async (
  handle: FileHandleLike,
  old: Buffer,
): Promise<void> => {
  await ignoreErrors(() => writeAll(handle, old, 0));
  await ignoreErrors(() => handle.truncate(old.length));
  await ignoreErrors(() => handle.sync());
};

const overwriteInPlace = async (
  handle: FileHandleLike,
  path: string,
  old: Buffer,
  data: Buffer,
): Promise<void> => {
  const length = Math.max(old.length, data.length);
  try {
    await growFile(handle, old.length, length);
    await writeAll(handle, padded(data, length), 0);
    await handle.sync();
    await shrinkFile(handle, data.length, length);
    await verifyContent(handle, path, data);
  } catch (error) {
    await restoreOldContent(handle, old);
    throw error;
  }
};

// For a single-file bind mount, which cannot be renamed over and must keep its
// inode: the file is never opened with 'w', so it is never empty on disk.
const writeInPlace = async (
  fs: SafeWriteFs,
  path: string,
  data: Buffer,
): Promise<void> => {
  const old = await fs.readFile(path);
  const needed = Math.max(0, data.length - old.length) + getWriteReserveBytes();
  await ensureFreeSpace([path], needed, fs.statfs);

  const handle = await fs.open(path, 'r+');
  try {
    await overwriteInPlace(handle, path, old, data);
  } finally {
    await ignoreErrors(() => handle.close());
  }
};

// ------------------------------------------------------------- replace

const tmpPathFor = (path: string): string =>
  join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );

const writeTmpFile = async (
  fs: SafeWriteFs,
  tmp: string,
  data: Buffer,
  mode: number | undefined,
): Promise<void> => {
  const handle = await fs.open(tmp, 'wx', mode);
  try {
    if (mode !== undefined) {
      await ignoreErrors(() => handle.chmod(mode));
    }
    await writeAll(handle, data, 0);
    await handle.sync();
  } finally {
    await ignoreErrors(() => handle.close());
  }
};

// Makes the rename durable. Not possible on every platform (Windows).
const syncDirectory = async (fs: SafeWriteFs, dir: string): Promise<void> => {
  await ignoreErrors(async () => {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await ignoreErrors(() => handle.close());
    }
  });
};

type ReplaceOutcome = 'done' | 'rename-blocked';

const replaceFile = async (
  fs: SafeWriteFs,
  path: string,
  data: Buffer,
  existingMode: number | undefined,
  allowFallback: boolean,
): Promise<ReplaceOutcome> => {
  const dir = dirname(path);
  const needed = data.length + getWriteReserveBytes();
  const tmp = tmpPathFor(path);

  try {
    await ensureFreeSpace(
      existingMode === undefined ? [dir] : [path, dir],
      needed,
      fs.statfs,
    );
    await writeTmpFile(fs, tmp, data, existingMode);
  } catch (error) {
    await ignoreErrors(() => fs.unlink(tmp));
    throw error;
  }

  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await ignoreErrors(() => fs.unlink(tmp));
    if (allowFallback && RENAME_BLOCKED.has(codeOf(error) ?? '')) {
      return 'rename-blocked';
    }
    throw error;
  }

  await syncDirectory(fs, dir);
  return 'done';
};

// ------------------------------------------------------------ entry

type Existing = Readonly<{ dev: number; mode: number }> | null;

const statOrNull = async (fs: SafeWriteFs, path: string): Promise<Existing> => {
  try {
    return await fs.stat(path);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

// A file on another device than its directory is a single-file bind mount.
const isSeparateMount = async (
  fs: SafeWriteFs,
  path: string,
  existing: NonNullable<Existing>,
): Promise<boolean> => (await fs.stat(dirname(path))).dev !== existing.dev;

const useReplace = async (
  fs: SafeWriteFs,
  path: string,
  existing: Existing,
  mode: NonNullable<SafeWriteOptions['mode']>,
): Promise<boolean> => {
  if (!existing || mode === 'replace') {
    return true;
  }
  return mode === 'auto' && !(await isSeparateMount(fs, path, existing));
};

const assertSafeContent = (
  path: string,
  data: Buffer,
  { allowEmpty, validate }: SafeWriteOptions,
): void => {
  if (data.length === 0 && !allowEmpty) {
    throw new UnsafeWriteError(path, 'content is empty');
  }
  validate?.(data);
};

const writeSafely = async (
  fs: SafeWriteFs,
  path: string,
  data: Buffer,
  options: SafeWriteOptions,
): Promise<void> => {
  const existing = await statOrNull(fs, path);
  const mode = options.mode ?? 'auto';

  if (await useReplace(fs, path, existing, mode)) {
    const outcome = await replaceFile(
      fs,
      path,
      data,
      existing ? existing.mode % 0o10000 : undefined,
      mode === 'auto',
    );
    if (outcome === 'done') {
      return;
    }
  }

  await writeInPlace(fs, path, data);
};

/**
 * Writes `content` so that, whether it returns or throws, the file holds
 * exactly the old bytes or exactly the new ones. A plain writeFile truncates
 * first: a full disk (or a kill) after that left docker-compose.yml empty.
 *
 * 'auto' replaces the file (temp file in the same directory, then rename)
 * unless it is a single-file bind mount or the rename is refused (EBUSY,
 * EXDEV, EPERM, EACCES), where it is overwritten in place without ever
 * truncating it before the new bytes are on disk.
 */
const safeWriteFile: SafeWriteFile = async (path, content, options = {}) => {
  const fs = options.fs ?? realFs;
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  assertSafeContent(path, data, options);

  try {
    await writeSafely(fs, path, data, options);
  } catch (error) {
    throw await asWriteError(
      fs,
      path,
      data.length + getWriteReserveBytes(),
      error,
    );
  }
};

export default safeWriteFile;
