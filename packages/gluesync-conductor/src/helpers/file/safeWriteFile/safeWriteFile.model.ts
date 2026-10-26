import { StatfsFn } from '../ensureFreeSpace/ensureFreeSpace.model';

/** The part of fs.promises' FileHandle that safeWriteFile uses. */
export type FileHandleLike = Readonly<{
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  write: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesWritten: number }>;
  truncate: (length: number) => Promise<void>;
  sync: () => Promise<void>;
  chmod: (mode: number) => Promise<void>;
  close: () => Promise<void>;
}>;

/** Injectable file system, so tests can make any step fail. */
export type SafeWriteFs = Readonly<{
  open: (path: string, flags: string, mode?: number) => Promise<FileHandleLike>;
  stat: (path: string) => Promise<Readonly<{ dev: number; mode: number }>>;
  statfs: StatfsFn;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
}>;

export type WriteStrategy = 'auto' | 'replace' | 'in-place';

// eslint-disable-next-line functional/no-mixed-types
export type SafeWriteOptions = Readonly<{
  /** `.env` may legitimately be empty; anything else is refused when empty. */
  allowEmpty?: boolean;
  /** Throws to refuse the content before anything is touched. */
  validate?: (content: Buffer) => void;
  mode?: WriteStrategy;
  fs?: SafeWriteFs;
}>;

export type SafeWriteFile = (
  path: string,
  content: string | Buffer,
  options?: SafeWriteOptions,
) => Promise<void>;
