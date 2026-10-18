import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { getLogger } from '../../utils/logger';
import getRootPath from '../getRootPath/getRootPath';
import {
  CommandResult,
  CommandRunner,
  HostSetupOutcome,
  KitControlArch,
  KitControlLogger,
  SyncKitControlOptions,
  SyncKitControlResult,
} from './syncKitControl.model';

const LOG_PREFIX = '[kit-control-sync]';

const ROOT_FOLDER_PATH = '/opt/gluesync-conductor/root-folder';
const BUNDLE_DIRS: ReadonlyArray<string> = [
  '/opt/gluesync-conductor/kit-control',
  join(process.cwd(), 'build', 'kit-control'),
];

const ARCHS: ReadonlyArray<KitControlArch> = ['amd64', 'arm64'];
const COMPOSE_FILES: ReadonlyArray<string> = [
  'docker-compose.yml',
  'docker-compose.yaml',
];
const LEGACY_FILES: ReadonlyArray<string> = [
  'stop.sh',
  'update.sh',
  'collect-logs.sh',
  'gluesync-cli',
];
const LEGACY_DIR_NAME = '.legacy';
const MIGRATED_MARKER = '.gluesync-control-migrated';
const HOST_SETUP_MARKER = '.gluesync-control-host-setup';

/** Part of the exec line of the bundled run.sh shim; tells the shim from an old run.sh. */
export const RUN_SH_SHIM_MARKER = 'gluesync" run --folder';

const VERSION_TIMEOUT_MS = 10_000;
const HOST_SETUP_TIMEOUT_MS = 120_000;
const DEFAULT_HELPER_IMAGE = 'docker:28';

const binaryName = (arch: KitControlArch): string => `gluesync-linux-${arch}`;

/** First dotted number of a text ("Gluesync Control 1.4.2.425" -> "1.4.2.425"). */
export const parseVersion = (text: string): string | null =>
  text
    .split(/[^0-9.]+/)
    .map(token => token.split('.').filter(part => part !== ''))
    .find(parts => parts.length >= 2)
    ?.join('.') ?? null;

/** Numeric, part by part, any number of parts (semver cannot do 4). Negative, 0 or positive like a - b. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);

  return (
    Array.from(
      { length },
      (_, index) => (left[index] ?? 0) - (right[index] ?? 0),
    ).find(diff => diff !== 0) ?? 0
  );
};

const QUOTED_QUOTE = String.raw`'\''`;

const shellQuote = (value: string): string =>
  ["'", value.replaceAll("'", QUOTED_QUOTE), "'"].join('');

/**
 * POSIX sh that runs on the Docker host (in its namespaces). Mirrors gs_install_control of the Linux installer:
 * gluesync on the PATH, sudo's secure_path case, and the daily self-update when systemd is there.
 */
export const buildHostSetupScript = (hostKitPath: string): string =>
  [
    `H=${shellQuote(hostKitPath)}`,
    'BIN_DIR=/usr/local/bin',
    'SUDO_BIN_DIR=/usr/bin',
    'mkdir -p "$BIN_DIR" || exit 1',
    'ln -sfn "$H/gluesync" "$BIN_DIR/gluesync" || exit 1',
    'echo "linked $BIN_DIR/gluesync"',
    `sp=$(sudo -V 2>/dev/null | sed -n 's/^Value to override user.s [$]PATH with: //p' | head -n 1) || sp=`,
    'if [ -n "$sp" ]; then',
    '  case ":$sp:" in',
    '    *":$BIN_DIR:"*) ;;',
    '    *)',
    '      target=',
    '      if [ -L "$SUDO_BIN_DIR/gluesync" ]; then target=$(readlink "$SUDO_BIN_DIR/gluesync" 2>/dev/null || true); fi',
    '      ours=no',
    '      if [ ! -e "$SUDO_BIN_DIR/gluesync" ] && [ ! -L "$SUDO_BIN_DIR/gluesync" ]; then ours=yes; fi',
    '      case "$target" in "$H"/*) ours=yes ;; esac',
    '      if [ "$ours" = yes ]; then',
    '        if ln -sfn "$H/gluesync" "$SUDO_BIN_DIR/gluesync"; then echo "linked $SUDO_BIN_DIR/gluesync"; else echo "could not link $SUDO_BIN_DIR/gluesync"; fi',
    '      else',
    '        echo "kept $SUDO_BIN_DIR/gluesync (not ours)"',
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    'if [ -d /run/systemd/system ]; then',
    '  "$H/gluesync" self-update --enable-auto || exit 1',
    '  echo "daily automatic update enabled"',
    'else',
    '  echo "no systemd: daily automatic update not enabled"',
    'fi',
    'exit 0',
  ].join('\n');

/** The docker run of the privileged helper that enters the host namespaces to run the script. */
export const buildHostSetupArgs = (
  image: string,
  hostKitPath: string,
): ReadonlyArray<string> => [
  'run',
  '--rm',
  '--privileged',
  '--pid=host',
  '--net=host',
  '-v',
  '/var/run/docker.sock:/var/run/docker.sock',
  image,
  'nsenter',
  '-t',
  '1',
  '-m',
  '-u',
  '-i',
  '-n',
  '-p',
  '--',
  'sh',
  '-c',
  buildHostSetupScript(hostKitPath),
];

const defaultRun: CommandRunner = (cmd, args, opts) =>
  new Promise<CommandResult>(resolve => {
    execFile(
      cmd,
      [...args],
      {
        timeout: opts?.timeoutMs ?? VERSION_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = (() => {
          if (!error) {
            return 0;
          }
          const errorCode = (error as NodeJS.ErrnoException).code;
          return typeof errorCode === 'number' && errorCode !== 0
            ? errorCode
            : -1;
        })();

        resolve({
          code,
          stdout: String(stdout),
          stderr: error && !stderr ? error.message : String(stderr),
        });
      },
    );
  });

const pathExists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

const readTextOrNull = (path: string): Promise<string | null> =>
  readFile(path, 'utf8').then(
    content => content,
    () => null,
  );

/** Copies next to the target, sets the mode and renames over it, so a reader never sees half a file. */
const installFile = async (
  source: string,
  target: string,
  mode: number,
): Promise<void> => {
  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);

  try {
    await copyFile(source, temp);
    await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

const detectVersion = async (
  run: CommandRunner,
  binaryPath: string,
): Promise<string | null> => {
  const result = await run(binaryPath, ['--version'], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });

  return result.code === 0
    ? (parseVersion(result.stdout) ?? parseVersion(result.stderr))
    : null;
};

const formatTimestamp = (isoDate: string): string =>
  isoDate
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs one step; a failure is logged and the step falls back, so the following steps still run. */
const attempt = async <T>(
  logger: KitControlLogger,
  step: string,
  action: () => Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, `${LOG_PREFIX} ${step} failed`);
    return fallback;
  }
};

type Bundle = Readonly<{ dir: string; version: string }>;

const REQUIRED_BUNDLE_FILES: ReadonlyArray<string> = [
  ...ARCHS.map(binaryName),
  'run.sh',
  'VERSION',
];

const inspectBundle = async (dir: string): Promise<Bundle | null> => {
  const present = await Promise.all(
    REQUIRED_BUNDLE_FILES.map(file =>
      stat(join(dir, file)).then(
        info => info.isFile(),
        () => false,
      ),
    ),
  );

  if (!present.every(Boolean)) {
    return null;
  }

  const [version, shim] = await Promise.all([
    readTextOrNull(join(dir, 'VERSION')),
    readTextOrNull(join(dir, 'run.sh')),
  ]);
  const parsed = version ? parseVersion(version) : null;

  return parsed && shim?.includes(RUN_SH_SHIM_MARKER)
    ? { dir, version: parsed }
    : null;
};

const findBundle = async (
  dirs: ReadonlyArray<string>,
): Promise<Bundle | null> => {
  const bundles = await Promise.all(dirs.map(inspectBundle));
  return bundles.find(bundle => bundle !== null) ?? null;
};

type BinariesOutcome = Readonly<{
  written: ReadonlyArray<string>;
  failed: boolean;
  hadNoBinaries: boolean;
  ownVersion: string | null;
}>;

type Context = Readonly<{
  options: SyncKitControlOptions;
  bundle: Bundle;
  ownArch: KitControlArch;
}>;

/** Step 1: write the binaries that are missing, and replace them all when the bundle is strictly newer. */
const syncBinaries = async ({
  options,
  bundle,
  ownArch,
}: Context): Promise<BinariesOutcome> => {
  const { rootFolder, run, logger } = options;
  const ownPath = join(rootFolder, binaryName(ownArch));

  const existing = await Promise.all(
    ARCHS.map(arch => pathExists(join(rootFolder, binaryName(arch)))),
  );
  const ownExists = await pathExists(ownPath);
  const installed = ownExists ? await detectVersion(run, ownPath) : null;

  if (ownExists && installed === null) {
    logger.warn(
      { file: ownPath },
      `${LOG_PREFIX} cannot tell the installed Gluesync Control version, existing binaries are left as they are`,
    );
  } else if (installed !== null) {
    logger.info(
      { installed, bundled: bundle.version },
      compareVersions(bundle.version, installed) > 0
        ? `${LOG_PREFIX} bundled Gluesync Control is newer, updating the binaries`
        : `${LOG_PREFIX} installed Gluesync Control is up to date (never downgraded)`,
    );
  }

  const replaceExisting =
    installed !== null && compareVersions(bundle.version, installed) > 0;

  const outcomes = await Promise.all(
    ARCHS.map(async (arch, index) => {
      const name = binaryName(arch);

      if (existing[index] && !replaceExisting) {
        return { name, written: false, failed: false };
      }

      try {
        await installFile(
          join(bundle.dir, name),
          join(rootFolder, name),
          0o755,
        );
        logger.info(
          { file: name, version: bundle.version },
          `${LOG_PREFIX} wrote ${name}`,
        );
        return { name, written: true, failed: false };
      } catch (error) {
        logger.warn(
          { file: name, error: errorMessage(error) },
          `${LOG_PREFIX} could not write ${name}`,
        );
        return { name, written: false, failed: true };
      }
    }),
  );

  const ownNow = await pathExists(ownPath);
  const ownVersion = ownNow ? await detectVersion(run, ownPath) : null;

  return {
    written: outcomes
      .filter(outcome => outcome.written)
      .map(({ name }) => name),
    failed: outcomes.some(outcome => outcome.failed),
    hadNoBinaries: existing.every(found => !found),
    ownVersion,
  };
};

/** Step 2: gluesync -> gluesync-linux-<arch>, only when nothing is called gluesync yet. */
const ensureLink = async ({ options, ownArch }: Context): Promise<boolean> => {
  const linkPath = join(options.rootFolder, 'gluesync');
  const target = binaryName(ownArch);

  if (
    (await pathExists(linkPath)) ||
    !(await pathExists(join(options.rootFolder, target)))
  ) {
    return false;
  }

  await symlink(target, linkPath);
  options.logger.info(
    { link: linkPath, target },
    `${LOG_PREFIX} created the gluesync link`,
  );
  return true;
};

type LegacyMover = (name: string) => Promise<boolean>;

/** Moves a file of the kit into .legacy/<timestamp>/ (created on the first move); copy and delete across devices. */
const createLegacyMover = (
  rootFolder: string,
  timestamp: string,
  logger: KitControlLogger,
): LegacyMover => {
  const legacyDir = join(rootFolder, LEGACY_DIR_NAME, timestamp);

  return async name => {
    const source = join(rootFolder, name);

    if (!(await pathExists(source))) {
      return false;
    }

    const target = join(legacyDir, name);
    await mkdir(legacyDir, { recursive: true });

    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }
      await cp(source, target, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await rm(source, { recursive: true, force: true });
    }

    logger.info(
      { from: source, to: target },
      `${LOG_PREFIX} moved ${name} to ${LEGACY_DIR_NAME}/${timestamp}`,
    );
    return true;
  };
};

/** Step 3: run.sh is the shim. An old run.sh goes to .legacy first. Returns true when the shim was written. */
const ensureRunSh = async (
  { options, bundle, ownArch }: Context,
  moveToLegacy: LegacyMover,
): Promise<boolean> => {
  const { rootFolder, logger } = options;

  if (!(await pathExists(join(rootFolder, binaryName(ownArch))))) {
    logger.warn(
      `${LOG_PREFIX} no Gluesync Control binary for this CPU in the kit, run.sh left as it is`,
    );
    return false;
  }

  const current = await readTextOrNull(join(rootFolder, 'run.sh'));

  if (current?.includes(RUN_SH_SHIM_MARKER)) {
    return false;
  }

  if (await pathExists(join(rootFolder, 'run.sh'))) {
    await moveToLegacy('run.sh');
  }

  await installFile(
    join(bundle.dir, 'run.sh'),
    join(rootFolder, 'run.sh'),
    0o755,
  );
  logger.info(`${LOG_PREFIX} wrote the run.sh shim`);
  return true;
};

/** Step 4: the scripts Control replaces move to .legacy, only once the binary of this CPU has proven it runs here. */
const moveLegacyFiles = async (
  options: SyncKitControlOptions,
  moveToLegacy: LegacyMover,
): Promise<ReadonlyArray<string>> => {
  const moved = await Promise.all(
    LEGACY_FILES.map(async name => {
      try {
        return (await moveToLegacy(name)) ? name : null;
      } catch (error) {
        options.logger.warn(
          { file: name, error: errorMessage(error) },
          `${LOG_PREFIX} could not move ${name} to ${LEGACY_DIR_NAME}`,
        );
        return null;
      }
    }),
  );

  return moved.filter((name): name is string => name !== null);
};

/** The image of the Conductor's own container (works offline); a fallback image when it cannot be found. */
const resolveHelperImage = async (
  options: SyncKitControlOptions,
): Promise<string> => {
  const result = await options.run(
    'docker',
    ['inspect', '--format', '{{.Image}}', options.containerId],
    { timeoutMs: VERSION_TIMEOUT_MS },
  );
  const image = result.stdout.trim();

  if (result.code === 0 && /^[A-Za-z0-9][\w.:@/-]*$/.test(image)) {
    return image;
  }

  options.logger.warn(
    { containerId: options.containerId, fallback: options.fallbackHelperImage },
    `${LOG_PREFIX} cannot find the Conductor's own image, using the fallback helper image`,
  );
  return options.fallbackHelperImage;
};

/** Step 6: the host side (PATH link, daily self-update) of an old kit that was just migrated. */
const runHostSetup = async (
  options: SyncKitControlOptions,
): Promise<HostSetupOutcome> => {
  const { rootFolder, hostKitPath, logger, run, now } = options;

  const [migrated, done] = await Promise.all([
    pathExists(join(rootFolder, MIGRATED_MARKER)),
    pathExists(join(rootFolder, HOST_SETUP_MARKER)),
  ]);

  if (!migrated || done) {
    return 'not-needed';
  }

  if (!hostKitPath || !isAbsolute(hostKitPath)) {
    logger.warn(
      `${LOG_PREFIX} host setup skipped: BASE_PATH (the kit folder on the host) is not set`,
    );
    return 'skipped';
  }

  const image = await resolveHelperImage(options);
  const result = await run('docker', buildHostSetupArgs(image, hostKitPath), {
    timeoutMs: HOST_SETUP_TIMEOUT_MS,
  });

  if (result.code === 0) {
    const summary = result.stdout.trim();
    await writeFile(
      join(rootFolder, HOST_SETUP_MARKER),
      `${now().toISOString()}\n${summary}\n`,
    );
    logger.info({ summary }, `${LOG_PREFIX} host setup done`);
    return 'done';
  }

  logger.warn(
    {
      code: result.code,
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
    },
    `${LOG_PREFIX} host setup failed, it is retried at the next start. To do it by hand on the host: sudo ln -sfn ${hostKitPath}/gluesync /usr/local/bin/gluesync && sudo ${hostKitPath}/gluesync self-update --enable-auto`,
  );
  return 'failed';
};

const ownArchFromProcess = (): KitControlArch | null => {
  switch (process.arch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
};

const defaultHostKitPath = (): string =>
  process.env.PROJECT_CWD || process.env.BASE_PATH
    ? getRootPath({ basePath: process.env.BASE_PATH })
    : '';

const skipped = (
  reason: string,
  logger: KitControlLogger,
): SyncKitControlResult => {
  logger.info(`${LOG_PREFIX} skipped: ${reason}`);

  return {
    success: true,
    skipped: true,
    skipReason: reason,
    binariesWritten: [],
    linkCreated: false,
    runShWritten: false,
    legacyMoved: [],
    migrated: false,
    hostSetup: 'not-needed',
  };
};

const sync = async (
  options: SyncKitControlOptions,
): Promise<SyncKitControlResult> => {
  const { rootFolder, logger, now } = options;

  const bundle = await findBundle(options.bundleDirs);

  if (!bundle) {
    return skipped(
      `Gluesync Control bundle missing or incomplete (looked in ${options.bundleDirs.join(', ')})`,
      logger,
    );
  }

  const composePresent = await Promise.all(
    COMPOSE_FILES.map(file => pathExists(join(rootFolder, file))),
  );

  if (!composePresent.some(Boolean)) {
    return skipped(
      `${rootFolder} has no docker-compose file (not a Linux docker kit)`,
      logger,
    );
  }

  if (!options.ownArch) {
    return skipped(`unsupported CPU '${process.arch}'`, logger);
  }

  const context: Context = { options, bundle, ownArch: options.ownArch };
  const timestamp = formatTimestamp(now().toISOString());
  const moveToLegacy = createLegacyMover(rootFolder, timestamp, logger);

  const binaries = await syncBinaries(context);
  const linkCreated = await attempt(
    logger,
    'creating the gluesync link',
    () => ensureLink(context),
    false,
  );
  const runShWritten = await attempt(
    logger,
    'writing the run.sh shim',
    () => ensureRunSh(context, moveToLegacy),
    false,
  );

  const ownRuns = !binaries.failed && binaries.ownVersion !== null;
  const legacyMoved = ownRuns
    ? await moveLegacyFiles(options, moveToLegacy)
    : [];

  if (!ownRuns) {
    logger.warn(
      `${LOG_PREFIX} the Gluesync Control binary of this CPU did not run here, old scripts are left in place`,
    );
  }

  const ownWritten = binaries.written.includes(binaryName(context.ownArch));
  const migrated = binaries.hadNoBinaries && ownWritten && !binaries.failed;

  if (migrated && !(await pathExists(join(rootFolder, MIGRATED_MARKER)))) {
    await attempt(
      logger,
      'writing the migration marker',
      async () => {
        await writeFile(
          join(rootFolder, MIGRATED_MARKER),
          `${now().toISOString()}\n${binaries.ownVersion ?? bundle.version}\n`,
        );
        logger.info(`${LOG_PREFIX} old kit migrated to Gluesync Control`);
      },
      undefined,
    );
  }

  const hostSetup = await attempt<HostSetupOutcome>(
    logger,
    'host setup',
    () => runHostSetup(options),
    'failed',
  );

  return {
    success: !binaries.failed,
    skipped: false,
    skipReason: null,
    binariesWritten: binaries.written,
    linkCreated,
    runShWritten,
    legacyMoved,
    migrated,
    hostSetup,
  };
};

/**
 * Linux only. Delivers Gluesync Control (binaries, gluesync link, run.sh shim) from the Conductor image to the kit
 * folder, moves the scripts it replaces to .legacy, and finishes the host side of a migrated kit. Never throws.
 */
const syncKitControl = async (
  overrides: Partial<SyncKitControlOptions> = {},
): Promise<SyncKitControlResult> => {
  const logger = overrides.logger ?? getLogger();

  try {
    return await sync({
      rootFolder: ROOT_FOLDER_PATH,
      bundleDirs: BUNDLE_DIRS,
      ownArch: ownArchFromProcess(),
      hostKitPath: defaultHostKitPath(),
      containerId: hostname(),
      fallbackHelperImage:
        process.env.HELPER_IMAGE_LINUX || DEFAULT_HELPER_IMAGE,
      now: () => new Date(),
      run: defaultRun,
      ...overrides,
      logger,
    });
  } catch (error) {
    logger.error({ error }, `${LOG_PREFIX} failed to sync Gluesync Control`);

    return {
      success: false,
      skipped: false,
      skipReason: null,
      binariesWritten: [],
      linkCreated: false,
      runShWritten: false,
      legacyMoved: [],
      migrated: false,
      hostSetup: 'not-needed',
    };
  }
};

export default syncKitControl;
