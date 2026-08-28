export type GetEnvFilePath = () => Promise<string>;

export type ReadEnvFile = () => Promise<ReadonlyArray<string>>;

export type WriteEnvFile = (lines: ReadonlyArray<string>) => Promise<void>;

export type IsLegacyUpdateEnabled = (lines: ReadonlyArray<string>) => boolean;

export type EnableLegacyUpdate = (
  lines: ReadonlyArray<string>,
) => ReadonlyArray<string>;

export type DisableLegacyUpdate = (
  lines: ReadonlyArray<string>,
) => ReadonlyArray<string>;
