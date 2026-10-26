/* eslint-disable functional/no-let, functional/immutable-data, no-param-reassign -- an in-memory file system with fault injection is stateful by nature */
import { dirname } from 'node:path';
import {
  FileHandleLike,
  SafeWriteFs,
} from '../helpers/file/safeWriteFile/safeWriteFile.model';

export type Fault = Readonly<{
  /** Index of the operation (0-based, every fs and handle call counts) that fails. */
  at: number;
  code: string;
  /** For a write: bytes stored before the error. */
  partial?: number;
}>;

export type FakeOptions = Readonly<{
  files: Readonly<Record<string, string>>;
  /** Total bytes the disk holds across all files; unlimited when omitted. */
  capacity?: number;
  /** What statfs reports as free bytes; the real free space when omitted. */
  statfsFree?: number;
  statfsError?: string;
  fault?: Fault;
  /** Code rename fails with. */
  renameError?: string;
  /** Device of each path; 1 for the others. */
  devs?: Readonly<Record<string, number>>;
}>;

type Entry = { data: Buffer; mode: number };

const errno = (code: string, message = code): Error =>
  Object.assign(new Error(`${code}: ${message}`), { code });

export type FakeFs = SafeWriteFs &
  Readonly<{
    read: (path: string) => string | undefined;
    names: () => ReadonlyArray<string>;
    trace: ReadonlyArray<string>;
    statfsCalls: ReadonlyArray<string>;
    /** Counts every change to a file, so "untouched" can be asserted. */
    mutations: () => number;
  }>;

const makeFakeFs = (options: FakeOptions): FakeFs => {
  const files = new Map<string, Entry>(
    Object.entries(options.files).map(([path, text]) => [
      path,
      { data: Buffer.from(text), mode: 0o640 },
    ]),
  );
  const dirs = new Set(Object.keys(options.files).map(dirname));
  const trace: string[] = [];
  const statfsCalls: string[] = [];
  let mutations = 0;

  const used = (): number =>
    [...files.values()].reduce((sum, { data }) => sum + data.length, 0);

  const step = (name: string): Fault | undefined => {
    trace.push(name);
    const { fault } = options;
    if (fault && fault.at === trace.length - 1) {
      if (fault.partial === undefined || name !== 'write') {
        throw errno(fault.code);
      }
      return fault;
    }
    return undefined;
  };

  const entryOf = (path: string): Entry => {
    const entry = files.get(path);
    if (!entry) {
      throw errno('ENOENT', path);
    }
    return entry;
  };

  const store = (entry: Entry, bytes: Buffer, position: number): number => {
    const room =
      options.capacity === undefined
        ? bytes.length
        : Math.max(
            0,
            Math.min(
              bytes.length,
              entry.data.length + options.capacity - used() - position,
            ),
          );
    if (room > 0) {
      const next = Buffer.alloc(
        Math.max(entry.data.length, position + room),
        0,
      );
      entry.data.copy(next);
      bytes.copy(next, position, 0, room);
      entry.data = next;
      mutations += 1;
    }
    return room;
  };

  const handleFor = (path: string): FileHandleLike => ({
    read: async (buffer, offset, length, position) => {
      step('read');
      const slice = entryOf(path).data.subarray(position, position + length);
      slice.copy(buffer, offset);
      return { bytesRead: slice.length };
    },
    write: async (buffer, offset, length, position) => {
      const fault = step('write');
      const entry = entryOf(path);
      const bytes = buffer.subarray(offset, offset + length);
      if (fault) {
        store(entry, bytes.subarray(0, fault.partial), position);
        throw errno(fault.code);
      }
      const stored = store(entry, bytes, position);
      if (stored === 0 && length > 0) {
        throw errno('ENOSPC');
      }
      return { bytesWritten: stored };
    },
    truncate: async length => {
      step('truncate');
      const entry = entryOf(path);
      entry.data = entry.data.subarray(0, length);
      mutations += 1;
    },
    sync: async () => {
      step('sync');
    },
    chmod: async mode => {
      step('chmod');
      entryOf(path).mode = mode;
    },
    close: async () => {
      step('close');
    },
  });

  const fakeFs: SafeWriteFs = {
    open: async (path, flags, mode) => {
      step(`open ${flags}`);
      if (dirs.has(path) && !files.has(path)) {
        return handleFor(path);
      }
      if (flags === 'wx') {
        if (files.has(path)) {
          throw errno('EEXIST', path);
        }
        files.set(path, { data: Buffer.alloc(0), mode: mode ?? 0o644 });
        mutations += 1;
      }
      entryOf(path);
      return handleFor(path);
    },
    stat: async path => {
      step('stat');
      const dev = options.devs?.[path] ?? 1;
      if (dirs.has(path) && !files.has(path)) {
        return { dev, mode: 0o755 };
      }
      return { dev, mode: entryOf(path).mode };
    },
    statfs: async path => {
      step('statfs');
      statfsCalls.push(path);
      if (options.statfsError) {
        throw errno(options.statfsError);
      }
      const free =
        options.statfsFree ??
        (options.capacity === undefined
          ? 1e12
          : Math.max(0, options.capacity - used()));
      return { bavail: free, bsize: 1 };
    },
    rename: async (from, to) => {
      step('rename');
      if (options.renameError) {
        throw errno(options.renameError);
      }
      files.set(to, entryOf(from));
      files.delete(from);
      mutations += 1;
    },
    unlink: async path => {
      step('unlink');
      entryOf(path);
      files.delete(path);
      mutations += 1;
    },
    readFile: async path => {
      step('readFile');
      return Buffer.from(entryOf(path).data);
    },
  };

  return {
    ...fakeFs,
    read: path => files.get(path)?.data.toString(),
    names: () => [...files.keys()],
    trace,
    statfsCalls,
    mutations: () => mutations,
  };
};

export default makeFakeFs;
