export type StatfsFn = (
  path: string,
) => Promise<Readonly<{ bavail: number | bigint; bsize: number | bigint }>>;

export type EnsureFreeSpace = (
  paths: ReadonlyArray<string>,
  neededBytes: number,
  statfs?: StatfsFn,
) => Promise<void>;
