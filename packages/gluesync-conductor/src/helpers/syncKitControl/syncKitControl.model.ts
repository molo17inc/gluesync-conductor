export type KitControlArch = 'amd64' | 'arm64';

export type CommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

/** Runs a program without a shell. Never rejects: a failure to start is a non-zero code. */
export type CommandRunner = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts?: Readonly<{ timeoutMs?: number }>,
) => Promise<CommandResult>;

export type KitControlLogger = Readonly<{
  info: (obj: object | string, msg?: string) => void;
  warn: (obj: object | string, msg?: string) => void;
  error: (obj: object | string, msg?: string) => void;
}>;

// eslint-disable-next-line functional/no-mixed-types
export type SyncKitControlOptions = Readonly<{
  /** The Linux kit folder as seen by the Conductor (default /opt/gluesync-conductor/root-folder). */
  rootFolder: string;
  /** Folders that may hold the bundled Control files, first complete one wins. */
  bundleDirs: ReadonlyArray<string>;
  /** CPU of this container (default: from process.arch). */
  ownArch: KitControlArch | null;
  /** The kit folder as seen by the Docker host (BASE_PATH). Empty when unknown. */
  hostKitPath: string;
  /** Container id used to find the Conductor's own image (default: os.hostname()). */
  containerId: string;
  /** Image used for the host helper when the own image cannot be found. */
  fallbackHelperImage: string;
  now: () => Date;
  run: CommandRunner;
  logger: KitControlLogger;
}>;

export type HostSetupOutcome = 'not-needed' | 'done' | 'failed' | 'skipped';

export type SyncKitControlResult = Readonly<{
  success: boolean;
  skipped: boolean;
  skipReason: string | null;
  binariesWritten: ReadonlyArray<string>;
  linkCreated: boolean;
  runShWritten: boolean;
  legacyMoved: ReadonlyArray<string>;
  migrated: boolean;
  hostSetup: HostSetupOutcome;
}>;
