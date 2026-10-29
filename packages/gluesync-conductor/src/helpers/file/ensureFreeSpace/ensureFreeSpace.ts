import { statfs as nodeStatfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DiskFullError } from '../safeWriteFile/safeWriteFile.errors';
import { EnsureFreeSpace, StatfsFn } from './ensureFreeSpace.model';

const DEFAULT_WRITE_RESERVE_BYTES = 1024 * 1024;
const DEFAULT_UPDATE_MIN_FREE_BYTES = 512 * 1024 * 1024;

// Read at call time, so tests (and the sandbox) can change them.
const bytesFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
};

export const getWriteReserveBytes = (): number =>
  bytesFromEnv('CONDUCTOR_WRITE_RESERVE_BYTES', DEFAULT_WRITE_RESERVE_BYTES);

export const getUpdateMinFreeBytes = (): number =>
  bytesFromEnv(
    'CONDUCTOR_UPDATE_MIN_FREE_BYTES',
    DEFAULT_UPDATE_MIN_FREE_BYTES,
  );

// Filesystems that cannot report free space (or a platform without statfs)
// must not block the write: the kernel's own ENOSPC is still handled.
const UNSUPPORTED = new Set(['ENOSYS', 'ENOTSUP', 'EINVAL']);

const availableBytes = async (
  path: string,
  statfs: StatfsFn,
): Promise<number | null> => {
  try {
    const { bavail, bsize } = await statfs(path);
    return Number(bavail) * Number(bsize);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // A file that does not exist yet lives on its directory's filesystem.
    if (code === 'ENOENT' && dirname(path) !== path) {
      return availableBytes(dirname(path), statfs);
    }
    if (typeof code === 'string' && UNSUPPORTED.has(code)) {
      return null;
    }
    throw error;
  }
};

// Best effort, for error messages: undefined when it cannot be told.
export const queryFreeBytes = async (
  path: string,
  statfs: StatfsFn = nodeStatfs,
): Promise<number | undefined> => {
  try {
    return (await availableBytes(path, statfs)) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Throws DiskFullError when any of `paths` sits on a filesystem with fewer than
 * `neededBytes` free. Pass the file itself when it exists: with a single-file
 * bind mount its directory is on another filesystem than the file.
 */
const ensureFreeSpace: EnsureFreeSpace = async (
  paths,
  neededBytes,
  statfs = nodeStatfs,
) => {
  await paths.reduce(async (previous, path) => {
    await previous;
    const available = await availableBytes(path, statfs);
    if (available !== null && available < neededBytes) {
      throw new DiskFullError(path, neededBytes, available);
    }
  }, Promise.resolve());
};

export default ensureFreeSpace;
