/* eslint-disable max-classes-per-file, functional/no-classes, functional/no-this-expressions -- Error subclasses are how callers tell these failures apart */

/** Not enough free space for a write (kernel ENOSPC/EDQUOT or our own pre-flight). */
export class DiskFullError extends Error {
  readonly code = 'ENOSPC';

  readonly path: string;

  readonly needed: number;

  readonly available: number | undefined;

  constructor(
    path: string,
    needed: number,
    available?: number,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(
      `not enough free disk space to write ${path}: need ${needed} bytes, ${available ?? 'unknown'} available`,
      options,
    );
    this.name = 'DiskFullError';
    this.path = path;
    this.needed = needed;
    this.available = available;
  }
}

/** The content was refused before the file was touched (empty, invalid, ...). */
export class UnsafeWriteError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`refusing to write ${path}: ${reason}`);
    this.name = 'UnsafeWriteError';
    this.path = path;
  }
}
