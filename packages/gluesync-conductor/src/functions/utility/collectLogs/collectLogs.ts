import { spawn } from 'node:child_process';
import {
  access,
  constants,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  dirname,
} from 'node:path';
import { AxiosError } from 'axios';
import { text } from 'stream/consumers';
import { CollectLogsHandler } from './collectLogs.model';
import getRootPath from '../../../helpers/getRootPath/getRootPath';
import axiosWithRetry from '../../../utils/axiosWithRetry';
import collectLogsByScript from '../../../helpers/collectLogsByScript/collectLogsByScript';

type Logger = Readonly<{
  debug: (
    obj: Readonly<Record<string, unknown>> | string,
    msg?: string,
  ) => void;
  info: (obj: Readonly<Record<string, unknown>> | string, msg?: string) => void;
  warn: (obj: Readonly<Record<string, unknown>> | string, msg?: string) => void;
  error: (
    obj: Readonly<Record<string, unknown>> | string,
    msg?: string,
  ) => void;
}>;

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type CollectLogsResult = Readonly<{
  output: string;
  archivePath?: string;
}>;

type CollectLogsOptions = Readonly<{
  ticketId?: string;
  email?: string;
  localOnly: boolean;
  logger?: Logger;
}>;

type CollectLogsError = Error &
  Readonly<{
    details?: string;
    isCollectLogsError: true;
  }>;

type CommandOptions = Readonly<{
  cwd?: string;
  input?: string;
  useShell?: boolean;
}>;

type FileCollectionOptions = Readonly<{
  excludeDir?: string;
  isWindows: boolean;
}>;

type DockerCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
}>;

type DockerPsContainer = Readonly<Record<string, string>>;

type CompressionCandidate = Readonly<{
  name: string;
  archivePath: string;
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  successLog: string;
  failLog: string;
}>;

const MAX_OUTPUT_LINES = 10;
const SCRIPT_VERSION = '2.2-internal';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOG_LOOKBACK_DAYS = 5;
const SYSTEM_INFO_SCRIPT_LINUX = 'system-info.sh';
const SYSTEM_INFO_SCRIPT_WINDOWS = 'system-info.ps1';
const WEBDAV_PAYLOAD =
  '<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:"><propname/></propfind>';

const parseLogLookbackDays = (): number => {
  const raw = process.env.COLLECT_LOG_LOOKBACK_DAYS;

  if (raw === undefined) {
    return DEFAULT_LOG_LOOKBACK_DAYS;
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_LOOKBACK_DAYS;
  }

  return parsed;
};

const parseDockerLogSinceHours = (lookbackDays: number): number => {
  const raw = process.env.COLLECT_DOCKER_LOG_SINCE_HOURS;

  if (raw === undefined) {
    return lookbackDays * 24;
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return lookbackDays * 24;
  }

  return parsed;
};

const parseDockerTailLines = (): number | undefined => {
  const raw = process.env.COLLECT_DOCKER_LOG_TAIL_LINES;

  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
};
const createCollectLogsError = (
  message: string,
  details?: string,
): CollectLogsError =>
  Object.assign(new Error(message), {
    details,
    isCollectLogsError: true as const,
  });

const isCollectLogsError = (error: unknown): error is CollectLogsError =>
  error instanceof Error &&
  'isCollectLogsError' in error &&
  error.isCollectLogsError === true;

const sanitizeLines = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map(line => line.replace(/[^\t -~]/g, '').trimEnd())
    .filter(line => line.length > 0);

const formatOutput = (text: string): string => {
  const lines = sanitizeLines(text);

  if (lines.length === 0) {
    return 'Unknown error';
  }

  if (lines.length <= MAX_OUTPUT_LINES) {
    return lines.join('\n');
  }

  return `${lines.slice(0, MAX_OUTPUT_LINES).join('\n')}\n...`;
};

type StreamState = Readonly<{
  stdout: string;
  stderr: string;
}>;

type StreamEvent =
  | Readonly<{ type: 'stdout'; chunk: string }>
  | Readonly<{ type: 'stderr'; chunk: string }>;

const appendEvent = (state: StreamState, event: StreamEvent): StreamState => {
  if (event.type === 'stdout') {
    return {
      ...state,
      stdout: state.stdout + event.chunk,
    };
  }

  return {
    ...state,
    stderr: state.stderr + event.chunk,
  };
};

const runCommandCapture = async (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): Promise<CommandResult> =>
  new Promise(resolve => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: options.useShell ?? false,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutPromise = child.stdout
      ? text(child.stdout)
      : Promise.resolve('');
    const stderrPromise = child.stderr
      ? text(child.stderr)
      : Promise.resolve('');

    const initialState: StreamState = { stdout: '', stderr: '' };

    child.once('error', error => {
      Promise.all([stdoutPromise, stderrPromise]).then(([stdout, stderr]) => {
        const afterStdout = appendEvent(initialState, {
          type: 'stdout',
          chunk: stdout,
        });
        const finalState = appendEvent(afterStdout, {
          type: 'stderr',
          chunk: stderr,
        });
        resolve({
          exitCode: 1,
          stdout: finalState.stdout,
          stderr: finalState.stderr || error.message,
        });
      });
    });

    child.once('close', code => {
      Promise.all([stdoutPromise, stderrPromise]).then(([stdout, stderr]) => {
        const afterStdout = appendEvent(initialState, {
          type: 'stdout',
          chunk: stdout,
        });
        const finalState = appendEvent(afterStdout, {
          type: 'stderr',
          chunk: stderr,
        });
        resolve({
          exitCode: code ?? 1,
          stdout: finalState.stdout,
          stderr: finalState.stderr,
        });
      });
    });

    if (child.stdin) {
      if (typeof options.input === 'string' && options.input.length > 0) {
        child.stdin.write(options.input, 'utf8');
      }
      child.stdin.end();
    }
  });

const runCommandStrict = async (
  command: string,
  args: ReadonlyArray<string>,
  options: Readonly<{ cwd?: string }> = {},
): Promise<boolean> => {
  const result = await runCommandCapture(command, args, { cwd: options.cwd });
  return result.exitCode === 0;
};

const findFirstExistingPath = async (
  candidates: ReadonlyArray<string>,
): Promise<string | null> => {
  const checks = await Promise.all(
    candidates.map(async candidate => {
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        return null;
      }
    }),
  );

  return (
    checks.find((candidate): candidate is string => candidate !== null) ?? null
  );
};

const resolveSystemInfoScriptPath = async (
  isWindows: boolean,
): Promise<string | null> => {
  const scriptName = isWindows
    ? SYSTEM_INFO_SCRIPT_WINDOWS
    : SYSTEM_INFO_SCRIPT_LINUX;

  const candidates = [
    join(process.cwd(), scriptName),
    join(process.cwd(), 'build', scriptName),
    isWindows
      ? `C:\\opt\\gluesync-conductor\\${scriptName}`
      : `/opt/gluesync-conductor/${scriptName}`,
  ];

  return findFirstExistingPath(candidates);
};

const runSystemInfoScript = async (
  outputPath: string,
  isWindows: boolean,
): Promise<boolean> => {
  const scriptPath = await resolveSystemInfoScriptPath(isWindows);

  if (!scriptPath) {
    return false;
  }

  if (isWindows) {
    return runCommandStrict(
      'pwsh',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-OutputPath',
        outputPath,
      ],
      {},
    );
  }

  return runCommandStrict('/bin/bash', [scriptPath, outputPath], {});
};

const isPathInside = (
  candidatePath: string,
  parentPath: string,
  isWindows: boolean,
): boolean => {
  const normalizedCandidate = resolve(candidatePath);
  const normalizedParent = resolve(parentPath);
  const candidate = isWindows
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const parent = isWindows ? normalizedParent.toLowerCase() : normalizedParent;

  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
};

const commandExists = async (
  commandName: string,
  isWindows: boolean,
): Promise<boolean> => {
  const lookup = await runCommandCapture(isWindows ? 'where' : 'which', [
    commandName,
  ]);
  return lookup.exitCode === 0;
};

const resolveWebDavRootUrl = (): string => {
  const baseUrl = (
    process.env.WEBDAV_BASE_URL || 'https://webdav.hq.molo17.com'
  )
    .trim()
    .replace(/\/+$/, '');
  const remotePath = (process.env.WEBDAV_REMOTE_PATH || '').trim();

  if (remotePath) {
    return `${baseUrl}/${remotePath.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
  }

  return `${baseUrl}/`;
};

const basicAuthHeader = (ticketId: string, email: string): string =>
  `Basic ${Buffer.from(`${ticketId}:${email}`).toString('base64')}`;

const ftpFailureHint = (statusCode: number, stderr: string): string => {
  const normalized = stderr.toLowerCase();

  if (normalized.includes('550')) {
    return 'FTP server returned 550 (permission/target issue). Verify ticket/email and available space.';
  }

  if (normalized.includes('530')) {
    return 'FTP server returned 530 (authentication failure). Verify ticket and email.';
  }

  if (normalized.includes('curl: (7)')) {
    return 'Unable to reach ftp.molo17.com (curl 7). Ensure outbound FTP is allowed.';
  }

  if (statusCode === 18) {
    return 'FTP transfer was interrupted before completion (curl 18).';
  }

  if (statusCode === 28) {
    return 'FTP upload timed out (curl 28).';
  }

  if (statusCode === 67) {
    return 'FTP authentication failed (curl 67). Verify ticket and email.';
  }

  return 'FTP upload failed.';
};

const resolveSearchDir = async (isWindows: boolean): Promise<string> => {
  const configuredRoot = getRootPath();
  const fallbackRoot = isWindows
    ? 'C:\\opt\\gluesync-conductor'
    : '/opt/gluesync-conductor';

  const candidates = [
    join(configuredRoot, 'root-folder'),
    join(fallbackRoot, 'root-folder'),
    join(process.cwd(), 'root-folder'),
    process.cwd(),
  ];

  const results = await Promise.all(
    candidates.map(async candidate => {
      try {
        const fileStat = await stat(candidate);
        return fileStat.isDirectory() ? candidate : null;
      } catch {
        return null;
      }
    }),
  );

  const validDir =
    results.find((candidate): candidate is string => candidate !== null) ??
    null;

  if (validDir === null) {
    throw createCollectLogsError(
      'No valid search directory found for log collection.',
    );
  }

  return validDir;
};

const resolveOutputDir = async (): Promise<string> => {
  const invokeDir = process.cwd();
  const probePath = join(
    invokeDir,
    `.collect_logs_write_test_${process.pid}.tmp`,
  );

  try {
    await writeFile(probePath, 'ok', 'utf8');
    await rm(probePath, { force: true });
    return invokeDir;
  } catch {
    return tmpdir();
  }
};

const collectFilesRecursively = async (
  rootDir: string,
  filter: (filePath: string) => boolean,
  options: FileCollectionOptions,
): Promise<ReadonlyArray<string>> => {
  const collectFromDir = async (
    currentDir: string,
  ): Promise<ReadonlyArray<string>> => {
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(
      () => [],
    );

    const nestedFiles = await Promise.all(
      entries.map(async entry => {
        const fullPath = join(currentDir, entry.name);

        if (
          options.excludeDir &&
          isPathInside(fullPath, options.excludeDir, options.isWindows)
        ) {
          return [];
        }

        if (entry.isDirectory()) {
          return collectFromDir(fullPath);
        }

        if (entry.isFile() && filter(fullPath)) {
          return [fullPath];
        }

        return [];
      }),
    );

    return nestedFiles.flat();
  };

  return collectFromDir(rootDir);
};

const tryReadFile = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return `Unable to read file: ${reason}`;
  }
};

const deleteOldLogs = async (
  searchDir: string,
  isWindows: boolean,
  logger?: Logger,
): Promise<void> => {
  try {
    const logFiles = await collectFilesRecursively(
      searchDir,
      filePath => {
        const extension = extname(filePath).toLowerCase();
        const name = basename(filePath).toLowerCase();
        return (
          extension === '.log' ||
          extension === '.err' ||
          name.endsWith('.log.gz')
        );
      },
      { isWindows },
    );

    const now = Date.now();

    await Promise.all(
      logFiles.map(async filePath => {
        try {
          const fileStat = await stat(filePath);
          const age = now - fileStat.mtimeMs;

          if (age > THIRTY_DAYS_MS) {
            logger?.info(
              {
                filePath,
                ageDays: Math.floor(age / (24 * 60 * 60 * 1000)),
              },
              'Deleting old log file',
            );
            await rm(filePath, { force: true });
          }
        } catch (error) {
          logger?.warn(
            { filePath, error },
            'Failed to delete old log file, skipping',
          );
        }
      }),
    );
  } catch (error) {
    logger?.error({ error }, 'Failed to complete old logs deletion process');
  }
};

const getCommandSection = async (
  title: string,
  command: string,
  args: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const result = await runCommandCapture(command, args);
  const body = `${result.stdout}${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    return [
      `### ${title}`,
      body || '(no output returned)',
      `(command exited with status ${result.exitCode})`,
      '',
    ];
  }

  return [`### ${title}`, body || '(no output returned)', ''];
};

const writeSystemReport = async (
  outputPath: string,
  isWindows: boolean,
): Promise<void> => {
  if (await runSystemInfoScript(outputPath, isWindows)) {
    return;
  }

  const header = [
    'Gluesync System Report',
    `Generated on: ${new Date().toISOString()}`,
    '',
  ];

  const commandSpecs: ReadonlyArray<
    Readonly<{
      title: string;
      command: string;
      args: ReadonlyArray<string>;
    }>
  > = isWindows
    ? [
        { title: 'systeminfo', command: 'systeminfo', args: [] },
        {
          title: 'wmic os get caption,version /value',
          command: 'wmic',
          args: ['os', 'get', 'caption,version', '/value'],
        },
        { title: 'ipconfig /all', command: 'ipconfig', args: ['/all'] },
      ]
    : [
        { title: 'uname -a', command: 'uname', args: ['-a'] },
        {
          title: 'hostnamectl status',
          command: 'hostnamectl',
          args: ['status'],
        },
        { title: 'df -h', command: 'df', args: ['-h'] },
        { title: 'ip addr', command: 'ip', args: ['addr'] },
      ];

  const sections = await Promise.all(
    commandSpecs.map(({ title, command, args }) =>
      getCommandSection(title, command, args),
    ),
  );

  await writeFile(
    outputPath,
    [...header, ...sections.flat()].join('\n'),
    'utf8',
  );
};

const writeFileDump = async (
  outputPath: string,
  searchRoot: string,
  extensions: ReadonlyArray<string>,
  options: FileCollectionOptions,
): Promise<void> => {
  const extensionSet = new Set(extensions.map(ext => ext.toLowerCase()));
  const matchingFiles = await collectFilesRecursively(
    searchRoot,
    filePath => extensionSet.has(extname(filePath).toLowerCase()),
    options,
  );

  const header = [`Full dump generated on: ${new Date().toISOString()}`, ''];

  if (matchingFiles.length === 0) {
    await writeFile(
      outputPath,
      [
        ...header,
        `No matching files were found within ${searchRoot}.`,
        '',
      ].join('\n'),
      'utf8',
    );
    return;
  }

  const fileSections = await Promise.all(
    matchingFiles.map(async filePath => {
      const relativePath = relative(searchRoot, filePath);
      return [
        `----- START ${relativePath} -----`,
        await tryReadFile(filePath),
        `----- END ${relativePath} -----`,
        '',
      ];
    }),
  );

  await writeFile(
    outputPath,
    [...header, ...fileSections.flat()].join('\n'),
    'utf8',
  );
};

const writeDockerReport = async (outputPath: string): Promise<void> => {
  const commands: ReadonlyArray<DockerCommand> = [
    { cmd: 'docker', args: ['--version'] },
    { cmd: 'docker', args: ['info'] },
    { cmd: 'docker', args: ['ps', '-a'] },
    { cmd: 'docker', args: ['images'] },
    { cmd: 'docker', args: ['stats', '--no-stream'] },
    { cmd: 'docker', args: ['compose', 'version'] },
    { cmd: 'docker-compose', args: ['--version'] },
  ];

  const sections = await Promise.all(
    commands.map(async entry => {
      const result = await runCommandCapture(entry.cmd, entry.args);
      const body = `${result.stdout}${result.stderr}`.trim();
      const title = `### ${entry.cmd} ${entry.args.join(' ')}`.trim();

      if (result.exitCode !== 0) {
        return [
          title,
          body || '(no output returned)',
          `(command exited with status ${result.exitCode})`,
          '',
        ];
      }

      return [title, body || '(no output returned)', ''];
    }),
  );

  await writeFile(
    outputPath,
    [
      `Docker diagnostics generated on: ${new Date().toISOString()}`,
      '',
      ...sections.flat(),
    ].join('\n'),
    'utf8',
  );
};

const parseDockerPsLine = (line: string): DockerPsContainer | null => {
  try {
    return JSON.parse(line) as DockerPsContainer;
  } catch {
    return null;
  }
};

const streamDockerLogsToFile = async (
  container: DockerPsContainer,
  outputDirectory: string,
  sinceHours: number,
  tailLines?: number,
  logger?: Logger,
): Promise<string | null> => {
  const containerId = container.ID || '';
  const containerName =
    container.Names || containerId.slice(0, Math.min(12, containerId.length));

  if (!containerId) {
    return null;
  }

  const safeName = containerName.replace(/[\\/:*?"<>|]/g, '_');
  const filePath = join(outputDirectory, `container-${safeName}.log`);

  const args = [
    'logs',
    '--since',
    `${sinceHours}h`,
    ...(typeof tailLines === 'number' &&
    Number.isFinite(tailLines) &&
    tailLines > 0
      ? ['--tail', String(tailLines)]
      : []),
    containerId,
  ];

  const child = spawn('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: false,
  });

  const writer = createWriteStream(filePath, { flags: 'w', encoding: 'utf8' });

  writer.write(
    [
      `Container Logs for: ${containerName}`,
      `Container ID: ${containerId}`,
      `Status: ${container.Status || 'unknown'}`,
      `Image: ${container.Image || 'unknown'}`,
      `Collected on: ${new Date().toISOString()}`,
      `Since: last ${sinceHours} hours`,
      `Tail lines: ${typeof tailLines === 'number' ? String(tailLines) : 'all'}`,
      '',
      '================================================================================',
      '',
    ].join('\n'),
  );

  child.stdout?.pipe(writer, { end: false });
  child.stderr?.pipe(writer, { end: false });

  const exitCode = await new Promise<number>(resolve => {
    child.on('error', error => {
      writer.write(
        `\n[collect-logs] docker logs spawn error: ${error.message}\n`,
      );
      resolve(1);
    });

    child.on('close', code => {
      resolve(code ?? 1);
    });
  });

  writer.end(`\n[collect-logs] docker logs exit code: ${exitCode}\n`);
  await finished(writer);

  if (exitCode !== 0) {
    logger?.warn(
      { containerId, containerName, exitCode },
      'docker logs returned non-zero exit code',
    );
  }

  return filePath;
};

const exportDockerContainerLogs = async (
  outputDirectory: string,
  sinceHours: number,
  tailLines: number | undefined,
  logger?: Logger,
): Promise<ReadonlyArray<string>> => {
  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch {
    return [];
  }

  const containersResult = await runCommandCapture('docker', [
    'ps',
    '-a',
    '--format',
    '{{json .}}',
  ]);

  if (containersResult.exitCode !== 0) {
    return [];
  }

  const containers = containersResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseDockerPsLine)
    .filter((container): container is DockerPsContainer => {
      const containerId = container?.ID || '';
      return container !== null && containerId.length > 0;
    });

  const exportedFiles = await Promise.all(
    containers.map(container =>
      streamDockerLogsToFile(
        container,
        outputDirectory,
        sinceHours,
        tailLines,
        logger,
      ),
    ),
  );

  return exportedFiles.filter(
    (filePath): filePath is string => filePath !== null,
  );
};

const toRelativeArchivePaths = (
  searchDir: string,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  files
    .map(filePath => {
      const rel = relative(searchDir, filePath);
      return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : rel;
    })
    .filter((entry): entry is string => entry !== null);

const isArchiveValid = async (archivePath: string): Promise<boolean> => {
  try {
    const stats = await stat(archivePath);
    // Minimum valid archive size: 100 bytes (rough heuristic)
    // Empty/compressed empty files are typically 20-40 bytes
    if (stats.size < 100) {
      return false;
    }

    // Verify archive can be read by checking its format
    const ext = extname(archivePath).toLowerCase();

    if (ext === '.zip') {
      // Check zip magic number (PK\x03\x04 or PK\x05\x06 for empty zip)
      const header = await readFile(archivePath).then(b => b.subarray(0, 4));
      const magic = Buffer.from([0x50, 0x4b]);
      return header.subarray(0, 2).equals(magic);
    }

    if (ext === '.tar.gz' || ext.endsWith('.gz')) {
      // Check gzip magic number (0x1f 0x8b)
      const header = await readFile(archivePath).then(b => b.subarray(0, 2));
      const magic = Buffer.from([0x1f, 0x8b]);
      return header.equals(magic);
    }

    if (ext === '.tar.zst') {
      // Check zstd magic number (0x28 0xb5 0x2f 0xfd)
      const header = await readFile(archivePath).then(b => b.subarray(0, 4));
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      return header.equals(magic);
    }

    if (ext === '.tar.xz') {
      // Check xz magic number (0xfd 0x37 0x7a 0x58 0x5a 0x00)
      const header = await readFile(archivePath).then(b => b.subarray(0, 6));
      const magic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
      return header.equals(magic);
    }

    return true;
  } catch {
    return false;
  }
};

const createArchive = async (
  searchDir: string,
  outputDir: string,
  files: ReadonlyArray<string>,
  isWindows: boolean,
  logger?: Logger,
): Promise<string> => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*/, '')
    .replace('T', '-');

  const archiveBaseName = `support-logs-v${SCRIPT_VERSION}-${timestamp}`;
  const relativePaths = toRelativeArchivePaths(searchDir, files);

  if (relativePaths.length === 0) {
    throw createCollectLogsError(
      'No valid relative files found for archive creation. Check searchDir alignment.',
    );
  }

  const zipPath = join(outputDir, `${archiveBaseName}.zip`);
  const tarPath = join(outputDir, `${archiveBaseName}.tar`);

  const listFilePath = join(
    outputDir,
    `.collect-logs-${Date.now()}-${process.pid}.list`,
  );

  await writeFile(listFilePath, `${relativePaths.join('\n')}\n`, 'utf8');

  try {
    const zstdAvailable = !isWindows && (await commandExists('zstd', false));

    // =========================
    // WINDOWS PATH
    // =========================
    if (isWindows) {
      logger?.info({ zipPath }, 'Trying Compress-Archive (Windows primary)');

      const psScript = `
        $ErrorActionPreference = "Stop";

        $source = "${searchDir.replace(/"/g, '""')}";
        $dest = "${zipPath.replace(/"/g, '""')}";

        if (Test-Path $dest) { Remove-Item $dest -Force }

        Compress-Archive -Path "$source\\*" -DestinationPath $dest -Force
      `;

      const zipResult = await runCommandCapture(
        'pwsh',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { cwd: process.cwd(), useShell: false },
      );

      if (zipResult.exitCode === 0 && (await isArchiveValid(zipPath))) {
        logger?.info({ zipPath }, 'Compress-Archive succeeded');
        return zipPath;
      }

      logger?.warn(
        { stderr: zipResult.stderr },
        'Compress-Archive failed, falling back to tar.exe',
      );

      // fallback tar.exe
      const tarResult = await runCommandCapture(
        'tar.exe',
        ['-cf', tarPath, '-C', searchDir, '-T', listFilePath],
        { cwd: process.cwd(), useShell: false },
      );

      if (tarResult.exitCode === 0 && (await isArchiveValid(tarPath))) {
        return tarPath;
      }

      throw createCollectLogsError(
        'Both Compress-Archive and tar.exe failed on Windows.',
        `${zipResult.stderr}\n${tarResult.stderr}`,
      );
    }

    // =========================
    // LINUX PATH
    // =========================
    const candidateMatrix: ReadonlyArray<CompressionCandidate | null> = [
      {
        name: 'tar.gz',
        archivePath: join(outputDir, `${archiveBaseName}.tar.gz`),
        command: 'tar',
        args: [
          '-czf',
          join(outputDir, `${archiveBaseName}.tar.gz`),
          '-C',
          searchDir,
          '-T',
          listFilePath,
        ],
        cwd: process.cwd(),
        successLog: 'tar.gz created successfully',
        failLog: 'tar.gz failed',
      },

      zstdAvailable
        ? {
            name: 'tar.zst',
            archivePath: join(outputDir, `${archiveBaseName}.tar.zst`),
            command: 'tar',
            args: [
              '--zstd',
              '-cf',
              join(outputDir, `${archiveBaseName}.tar.zst`),
              '-C',
              searchDir,
              '-T',
              listFilePath,
            ],
            cwd: process.cwd(),
            successLog: 'tar.zst created successfully',
            failLog: 'tar.zst failed',
          }
        : null,
    ];

    const availableCandidates = candidateMatrix.filter(
      (c): c is CompressionCandidate => c !== null,
    );

    const compressedArchivePath = await availableCandidates.reduce<
      Promise<string | null>
    >(async (acc, candidate) => {
      const resolved = await acc;
      if (resolved) {
        return resolved;
      }

      logger?.info({ candidate: candidate.name }, 'Trying compression');

      const result = await runCommandCapture(
        candidate.command,
        candidate.args,
        { cwd: candidate.cwd, useShell: false },
      );

      if (result.exitCode !== 0) {
        logger?.warn(
          { candidate: candidate.name, stderr: result.stderr },
          candidate.failLog,
        );
        return null;
      }

      const valid = await isArchiveValid(candidate.archivePath);

      if (!valid) {
        await rm(candidate.archivePath, { force: true });
        return null;
      }

      return candidate.archivePath;
    }, Promise.resolve<string | null>(null));

    if (compressedArchivePath) {
      return compressedArchivePath;
    }

    // =========================
    // FINAL FALLBACK (LINUX TAR ONLY)
    // =========================
    const fallbackPath = join(outputDir, `${archiveBaseName}.tar`);

    logger?.info(
      { archivePath: fallbackPath },
      'All candidates failed. Using tar fallback',
    );

    const finalResult = await runCommandCapture(
      'tar',
      ['-cf', fallbackPath, '-C', searchDir, '-T', listFilePath],
      { cwd: process.cwd(), useShell: false },
    );

    if (finalResult.exitCode === 0 && (await isArchiveValid(fallbackPath))) {
      return fallbackPath;
    }

    throw createCollectLogsError('Archive creation failed on all attempts.');
  } finally {
    await rm(listFilePath, { force: true });
  }
};

const validateCredentialConnectivity = async (
  ticketId: string,
  email: string,
  isWindows: boolean,
  logger?: Logger,
): Promise<void> => {
  logger?.info(
    { ticketId, email },
    'Starting credential connectivity validation',
  );

  const webdavProbeUrl = resolveWebDavRootUrl();
  const headers = {
    Authorization: basicAuthHeader(ticketId, email),
    Depth: '0',
    'Content-Type': 'text/xml',
  };

  const webDavAttempt = await axiosWithRetry<unknown>(webdavProbeUrl, {
    method: 'PROPFIND',
    headers,
    data: WEBDAV_PAYLOAD,
    retries: 3,
    timeout: 5000,
    backoffMs: 300,
  })
    .then(() => ({ ok: true as const, detail: '' }))
    .catch(error => ({
      ok: false as const,
      detail: `WebDAV credential pre-check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    }));

  if (webDavAttempt.ok) {
    logger?.info('WebDAV credential pre-check succeeded');
    return;
  }

  logger?.warn(
    { detail: webDavAttempt.detail },
    'WebDAV credential pre-check failed',
  );

  const hasCurl = await commandExists('curl', isWindows);
  if (!hasCurl) {
    throw createCollectLogsError(
      'WebDAV credential check failed and curl is not available for FTP fallback.',
      webDavAttempt.detail || undefined,
    );
  }

  // FTP fallback if WebDAV fails
  const ftpCheck = await runCommandCapture('curl', [
    '--silent',
    '--fail',
    '--show-error',
    '--user',
    `${ticketId}:${email}`,
    '--list-only',
    'ftp://ftp.molo17.com/',
  ]);

  if (ftpCheck.exitCode !== 0) {
    throw createCollectLogsError(
      'Unable to validate credentials via WebDAV or FTP.',
      formatOutput(
        `${webDavAttempt.detail ? `${webDavAttempt.detail}\n` : ''}${ftpCheck.stdout}\n${ftpCheck.stderr}`,
      ),
    );
  }

  logger?.info('FTP fallback credential pre-check succeeded');
};

const uploadArchive = async (
  archivePath: string,
  ticketId: string,
  email: string,
  isWindows: boolean,
  logger?: Logger,
): Promise<'webdav' | 'ftp'> => {
  const fileName = basename(archivePath);
  const encodedName = encodeURIComponent(fileName);
  const webDavTarget = `${resolveWebDavRootUrl()}${encodedName}`;
  const uploadTimeoutMs = Number(
    process.env.WEBDAV_UPLOAD_TIMEOUT_MS ?? 600000,
  );

  logger?.info(
    { fileName, webDavTarget, uploadTimeoutMs },
    'Starting archive upload via WebDAV',
  );

  const webDavResult = await (async () => {
    const payload = createReadStream(archivePath);

    try {
      await axiosWithRetry<void>(webDavTarget, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(ticketId, email) },
        data: payload,
        retries: 3,
        timeout: uploadTimeoutMs,
        backoffMs: 500,
      });

      return { ok: true as const, method: 'webdav' as const, detail: '' };
    } catch (error) {
      const axiosErr = error as AxiosError;
      const status = axiosErr.response?.status;
      const statusText = axiosErr.response?.statusText;
      const detail = status
        ? `WebDAV upload failed with HTTP ${status} ${statusText}`
        : `WebDAV upload network error: ${axiosErr.message}`;

      return {
        ok: false as const,
        method: 'webdav' as const,
        detail,
      };
    } finally {
      payload.destroy();
    }
  })();

  if (webDavResult.ok) {
    logger?.info('WebDAV upload succeeded');
    return 'webdav';
  }

  logger?.warn({ detail: webDavResult.detail }, 'WebDAV upload failed');

  const hasCurl = await commandExists('curl', isWindows);
  if (!hasCurl) {
    throw createCollectLogsError(
      'WebDAV upload failed and curl is not available for FTP fallback.',
      webDavResult.detail || undefined,
    );
  }

  logger?.info('Attempting FTP fallback upload');
  const ftpUrl = `ftp://${ticketId}:${encodeURIComponent(email)}@ftp.molo17.com/${encodedName}`;
  const ftpConnectTimeoutMs = Number(
    process.env.FTP_UPLOAD_CONNECT_TIMEOUT_MS ?? 10000,
  );
  const ftpMaxTimeMs = Number(process.env.FTP_UPLOAD_MAX_TIME_MS ?? 600000);
  const ftpRetries = Number(process.env.FTP_UPLOAD_RETRIES ?? 3);
  const ftpRetryDelaySeconds = Number(
    process.env.FTP_UPLOAD_RETRY_DELAY_SECONDS ?? 2,
  );
  const ftpDisableEpsv =
    process.env.FTP_UPLOAD_DISABLE_EPSV?.toLowerCase() === 'true';

  const ftpArgsBase = [
    '--silent',
    '--show-error',
    '--fail',
    '--ftp-pasv',
    '--retry',
    String(ftpRetries),
    '--retry-delay',
    String(ftpRetryDelaySeconds),
    '--retry-all-errors',
    '--retry-connrefused',
    '--connect-timeout',
    String(Math.max(1, Math.ceil(ftpConnectTimeoutMs / 1000))),
    '--max-time',
    String(Math.max(1, Math.ceil(ftpMaxTimeMs / 1000))),
  ];

  const ftpArgs = [
    ...ftpArgsBase,
    ...(ftpDisableEpsv ? ['--disable-epsv'] : []),
    '-T',
    archivePath,
    ftpUrl,
  ];

  const ftpResult = await runCommandCapture('curl', ftpArgs);

  if (ftpResult.exitCode !== 0) {
    throw createCollectLogsError(
      'Failed to upload to FTP after WebDAV failure.',
      formatOutput(
        `${webDavResult.detail ? `${webDavResult.detail}\n` : ''}${ftpFailureHint(ftpResult.exitCode, ftpResult.stderr)}\n${ftpResult.stdout}\n${ftpResult.stderr}`,
      ),
    );
  }

  logger?.info('FTP fallback upload succeeded');
  return 'ftp';
};

const filterReadableFiles = async (
  filePaths: ReadonlyArray<string>,
  logger?: Logger,
): Promise<ReadonlyArray<string>> => {
  const checks = await Promise.all(
    filePaths.map(async filePath => {
      try {
        await access(filePath, constants.R_OK);
        return filePath;
      } catch {
        logger?.debug({ filePath }, 'File not readable, skipping');
        return null;
      }
    }),
  );

  return checks.filter((filePath): filePath is string => filePath !== null);
};

const collectLogsInternally = async (
  options: CollectLogsOptions,
): Promise<CollectLogsResult> => {
  const { ticketId, email, localOnly, logger } = options;
  const ticket = ticketId ?? '';
  const emailAddr = email ?? '';
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
  const collectLogsFromFiles =
    process.env.COLLECT_LOGS_FROM_FILES?.toLowerCase() !== 'false';
  const logLookbackDays = parseLogLookbackDays();
  const fileLogsCutoffMs = Date.now() - logLookbackDays * 24 * 60 * 60 * 1000;
  const dockerSinceHours = parseDockerLogSinceHours(logLookbackDays);
  const dockerTailLines = parseDockerTailLines();

  if (!localOnly && (!ticketId || !email)) {
    throw createCollectLogsError(
      'ticketId and email are required unless localOnly is true.',
    );
  }

  if (
    !localOnly &&
    ticketId &&
    email &&
    !(!!process.env.PROXY_HTTPS || !!process.env.PROXY_HTTP)
  ) {
    await validateCredentialConnectivity(ticketId, email, isWindows, logger);
  }

  const searchDir = await resolveSearchDir(isWindows);

  // Delete old logs (> 30 days) before collecting new ones
  await deleteOldLogs(searchDir, isWindows, logger);

  const outputDir = await resolveOutputDir();

  const extraDir = join(
    searchDir,
    `gluesync-support-extra-${Date.now()}-${process.pid}`,
  );

  // snapshot directory for Windows safety
  const snapshotDir = join(
    outputDir,
    `gluesync-snapshot-${Date.now()}-${process.pid}`,
  );

  await mkdir(extraDir, { recursive: true });
  await mkdir(snapshotDir, { recursive: true });

  const systemReportPath = join(extraDir, 'system-report.txt');
  const yamlDumpPath = join(extraDir, 'yaml-files-dump.txt');
  const xmlDumpPath = join(extraDir, 'xml-files-dump.txt');
  const dockerReportPath = join(extraDir, 'docker-report.txt');
  const containerLogsDir = join(extraDir, 'container-logs');

  try {
    // Parallel writes
    await Promise.all([
      writeSystemReport(systemReportPath, isWindows),
      writeFileDump(yamlDumpPath, searchDir, ['.yaml', '.yml'], {
        excludeDir: extraDir,
        isWindows,
      }),
      writeFileDump(xmlDumpPath, searchDir, ['.xml'], {
        excludeDir: extraDir,
        isWindows,
      }),
      writeDockerReport(dockerReportPath),
    ]);

    // Docker logs
    const dockerLogFiles = await exportDockerContainerLogs(
      containerLogsDir,
      dockerSinceHours,
      dockerTailLines,
      logger,
    );

    // Optional file-based logs.
    //
    // We scan from `searchDir` (the project root) AND from the well-known
    // mount points declared by the trial assembler's docker-compose template:
    //   - ./logs/core-hub  -> Logback file appender (C:\opt\gluesync\logs)
    //   - ./logs/chronos   -> Chronos service logs
    //   - ./logs           -> Conductor's own logs + catch-all
    // Hitting them explicitly is a safety net for environments where
    // `searchDir` resolves to a different parent than expected.
    const wellKnownLogDirs = collectLogsFromFiles
      ? Array.from(
          new Set([
            join(searchDir, 'logs'),
            join(searchDir, 'logs', 'core-hub'),
            join(searchDir, 'logs', 'chronos'),
          ]),
        )
      : [];

    const wellKnownLogDirsScanned: Array<
      Readonly<{ path: string; exists: boolean; matched: number }>
    > = [];

    const collectFromDirSafe = async (
      dir: string,
    ): Promise<ReadonlyArray<string>> => {
      try {
        const dirStat = await stat(dir);
        if (!dirStat.isDirectory()) {
          wellKnownLogDirsScanned.push({ path: dir, exists: false, matched: 0 });
          return [];
        }
      } catch {
        wellKnownLogDirsScanned.push({ path: dir, exists: false, matched: 0 });
        return [];
      }

      const matched = await collectFilesRecursively(
        dir,
        filePath => {
          const extension = extname(filePath).toLowerCase();
          return extension === '.log' || extension === '.err';
        },
        { excludeDir: extraDir, isWindows },
      );

      wellKnownLogDirsScanned.push({
        path: dir,
        exists: true,
        matched: matched.length,
      });
      return matched;
    };

    const wellKnownLogFiles = (
      await Promise.all(wellKnownLogDirs.map(collectFromDirSafe))
    ).flat();

    const recursiveLogFiles = collectLogsFromFiles
      ? await collectFilesRecursively(
          searchDir,
          filePath => {
            const extension = extname(filePath).toLowerCase();
            const name = basename(filePath).toLowerCase();
            return (
              extension === '.log' ||
              extension === '.err' ||
              name.endsWith('.log.gz')
            );
          },
          {
            excludeDir: extraDir,
            isWindows,
          },
        )
      : [];

    const fileLogFiles = Array.from(
      new Set([...wellKnownLogFiles, ...recursiveLogFiles]),
    );

    const recentFileLogCandidates = await Promise.all(
      fileLogFiles.map(async filePath => {
        try {
          const fileStats = await stat(filePath);
          return fileStats.mtimeMs >= fileLogsCutoffMs ? filePath : null;
        } catch {
          return null;
        }
      }),
    );

    const recentFileLogs = recentFileLogCandidates.filter(
      (filePath): filePath is string => filePath !== null,
    );

    // Diagnostics from extraDir
    const diagnosticFiles = await collectFilesRecursively(
      extraDir,
      () => true,
      { isWindows },
    );

    // Unique candidate files
    const candidateFiles = Array.from(
      new Set([...dockerLogFiles, ...recentFileLogs, ...diagnosticFiles]),
    );

    // Filter readable
    const readableFiles = await filterReadableFiles(candidateFiles, logger);

    if (readableFiles.length === 0) {
      throw createCollectLogsError(
        'No readable docker logs, diagnostics, or file-based logs found to archive.',
      );
    }

    // Snapshot files (copy into snapshotDir) and return list of targets.
    //
    // Strategy (per file, in order):
    //   1. On Windows: robocopy /B (backup mode) — uses the Windows backup
    //      API and bypasses share-mode restrictions on files that are open
    //      for writing by another process (e.g. Logback file appender or
    //      the Docker daemon). On Linux: plain `cp -p` — preserves mtimes
    //      and streams without loading into memory.
    //   2. Fallback: Node readFile + writeFile. Slower / not lock-friendly
    //      on Windows but works when robocopy/cp are not on PATH.
    //
    // Failed snapshots are excluded from the archive and recorded in the
    // collection report so support can see exactly what was dropped and why.
    type SnapshotResult =
      | Readonly<{ ok: true; target: string; source: string; method: 'robocopy' | 'cp' | 'node' }>
      | Readonly<{ ok: false; source: string; reason: string }>;

    const safeCopyWithRobocopy = async (
      sourceFile: string,
      targetFile: string,
    ): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> => {
      const sourceDirName = dirname(sourceFile);
      const sourceFileName = basename(sourceFile);
      const targetDirName = dirname(targetFile);
      const targetFileName = basename(targetFile);

      // /B          backup mode — opens via the Windows backup API,
      //             bypasses share-mode locks on files open for writing
      // /R:1 /W:1   one retry, one second wait (don't hang forever)
      // /NJH /NJS   no job header / summary noise in stdout
      // /NP /NDL    no progress / no directory list
      // /COPY:DAT   data + attributes + timestamps; skip ACL/owner/audit
      const args = [
        sourceDirName,
        targetDirName,
        sourceFileName,
        '/B',
        '/R:1',
        '/W:1',
        '/NJH',
        '/NJS',
        '/NP',
        '/NDL',
        '/COPY:DAT',
      ];

      const result = await runCommandCapture('robocopy', args);

      // robocopy exit codes 0..7 are "success-ish" (0/1 = no/files copied,
      // 2/4 = extras/mismatched, 8+ = real failure). We accept 0..7.
      if (result.exitCode >= 0 && result.exitCode <= 7) {
        // robocopy preserves the original filename; rename if target differs.
        if (sourceFileName !== targetFileName) {
          const copied = join(targetDirName, sourceFileName);
          try {
            const buf = await readFile(copied);
            await writeFile(targetFile, buf);
            await rm(copied, { force: true });
          } catch (err) {
            return {
              ok: false,
              reason: `robocopy rename failed: ${err instanceof Error ? err.message : 'unknown'}`,
            };
          }
        }
        return { ok: true };
      }

      return {
        ok: false,
        reason: `robocopy exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      };
    };

    const safeCopyWithCp = async (
      sourceFile: string,
      targetFile: string,
    ): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>> => {
      const result = await runCommandCapture('cp', ['-p', sourceFile, targetFile]);

      if (result.exitCode === 0) {
        return { ok: true };
      }

      return {
        ok: false,
        reason: `cp exit ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      };
    };

    const snapshotResults = await Promise.all(
      readableFiles.map(async (file): Promise<SnapshotResult> => {
        const rel = relative(searchDir, file);
        const relExtra = relative(extraDir, file);

        const safeRel = (() => {
          if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
            return rel;
          }

          if (!relExtra.startsWith('..')) {
            return join('diagnostics', relExtra);
          }

          return basename(file);
        })();

        const target = join(snapshotDir, safeRel);

        try {
          await mkdir(dirname(target), { recursive: true });
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'unknown error';
          logger?.warn({ file, reason }, 'Failed to create snapshot directory, excluding from archive');
          return { ok: false, source: file, reason };
        }

        // 1) Try platform-native safe copy (robocopy /B on Windows, cp on Linux).
        const nativeCopy = isWindows
          ? await safeCopyWithRobocopy(file, target)
          : await safeCopyWithCp(file, target);

        if (nativeCopy.ok) {
          return {
            ok: true,
            target,
            source: file,
            method: isWindows ? 'robocopy' : 'cp',
          };
        }

        logger?.debug(
          { file, reason: nativeCopy.reason },
          'Native safe-copy failed, falling back to Node readFile/writeFile',
        );

        // 2) Fallback to Node-level readFile/writeFile.
        try {
          const buf = await readFile(file);
          await writeFile(target, buf);
          return { ok: true, target, source: file, method: 'node' };
        } catch (err) {
          const nodeReason = err instanceof Error ? err.message : 'unknown error';
          const reason = `native-copy: ${nativeCopy.reason} | node-copy: ${nodeReason}`;
          logger?.warn({ file, reason }, 'Failed to snapshot file, excluding from archive');
          return { ok: false, source: file, reason };
        }
      }),
    );

    const filesToArchive = snapshotResults
      .filter((r): r is Extract<SnapshotResult, { ok: true }> => r.ok)
      .map(r => r.target);

    const snapshotFailures = snapshotResults.filter(
      (r): r is Extract<SnapshotResult, { ok: false }> => !r.ok,
    );

    // Write collection report into snapshotDir so it is always included in the archive.
    const collectionReportPath = join(snapshotDir, 'collection-report.txt');
    const reportLines = [
      'Gluesync Log Collection Report',
      `Generated on: ${new Date().toISOString()}`,
      `Platform: ${isWindows ? 'Windows' : 'Linux'}`,
      `Log lookback: ${logLookbackDays} day(s)`,
      `Docker log window: last ${dockerSinceHours}h`,
      `Docker tail lines: ${
        typeof dockerTailLines === 'number' ? String(dockerTailLines) : 'all'
      }`,
      `File-based log collection: ${
        collectLogsFromFiles ? 'enabled' : 'disabled'
      }`,
      '',
      '--- Enumerated candidates ---',
      `Total candidates found:   ${candidateFiles.length}`,
      `Readable (passed access check): ${readableFiles.length}`,
      `Successfully snapshotted: ${filesToArchive.length}`,
      `Failed to snapshot:       ${snapshotFailures.length}`,
      '',
    ];

    if (snapshotFailures.length > 0) {
      reportLines.push('--- Snapshot failures (files excluded from archive) ---');
      snapshotFailures.forEach(f => {
        reportLines.push(`  FAILED  ${f.source}`);
        reportLines.push(`    reason: ${f.reason}`);
      });
      reportLines.push('');
    }

    const successfulSnapshots = snapshotResults.filter(
      (r): r is Extract<SnapshotResult, { ok: true }> => r.ok,
    );

    const methodCounts = successfulSnapshots.reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.method]: (acc[r.method] ?? 0) + 1 }),
      {},
    );

    reportLines.push('--- Search roots ---');
    reportLines.push(`  searchDir: ${searchDir}`);
    if (wellKnownLogDirsScanned.length > 0) {
      reportLines.push('  Well-known mount points:');
      wellKnownLogDirsScanned.forEach(d => {
        reportLines.push(
          `    ${d.exists ? 'PRESENT' : 'MISSING'}  ${d.path}  (matched ${d.matched})`,
        );
      });
    }
    reportLines.push('');

    reportLines.push('--- Snapshot method breakdown ---');
    reportLines.push(`  robocopy: ${methodCounts['robocopy'] ?? 0}`);
    reportLines.push(`  cp:       ${methodCounts['cp'] ?? 0}`);
    reportLines.push(`  node:     ${methodCounts['node'] ?? 0}`);
    reportLines.push('');

    reportLines.push('--- Files included in archive ---');
    successfulSnapshots.forEach(r =>
      reportLines.push(`  OK  [${r.method}]  ${r.source}`),
    );
    reportLines.push('');

    await writeFile(collectionReportPath, reportLines.join('\n'), 'utf8');
    filesToArchive.push(collectionReportPath);

    // Create archive with fallback to legacy script
    const archiveCreationResult: {
      archivePath?: string;
      legacyFallback?: boolean;
      output?: string;
    } = await (async () => {
      try {
        const archivePath = await createArchive(
          snapshotDir,
          outputDir,
          filesToArchive,
          isWindows,
          logger,
        );
        return { archivePath };
      } catch (error) {
        logger?.warn(
          { error },
          'Internal archive creation failed, falling back to legacy script',
        );

        if (localOnly) {
          throw error;
        }

        const legacyResult = await collectLogsByScript({
          ticketId: ticket,
          email: emailAddr,
        });

        if (legacyResult.success) {
          return {
            legacyFallback: true,
            output: formatOutput(
              [
                'Internal archive creation failed.',
                'Legacy collect logs script completed successfully.',
                legacyResult.output,
              ].join('\n'),
            ),
          };
        }

        throw createCollectLogsError(
          'Archive creation failed and legacy fallback also failed.',
          legacyResult.output,
        );
      }
    })();

    // If legacy fallback succeeded, return immediately
    if (archiveCreationResult.legacyFallback) {
      return { output: archiveCreationResult.output! };
    }

    const { archivePath } = archiveCreationResult;

    // Ensure archivePath exists before proceeding to upload if not do legacy
    if (!archivePath) {
      // Try legacy collector if internal archive didn't produce a path
      const legacyResult = await collectLogsByScript({
        ticketId: ticket,
        email: emailAddr,
      });

      if (legacyResult.success) {
        return {
          output: formatOutput(
            [
              'Internal archive creation did not produce an archive path.',
              'Legacy collect logs script completed successfully.',
              legacyResult.output,
            ].join('\n'),
          ),
        };
      }

      throw createCollectLogsError(
        'Archive creation did not produce an archive path and legacy fallback failed.',
        legacyResult.output,
      );
    }

    // Local-only branch: return without upload
    if (localOnly) {
      return {
        output: formatOutput(
          [
            'Local-only mode enabled. Credential pre-check skipped.',
            `Collecting logs from last ${logLookbackDays} day(s).`,
            `Collecting logs from Docker (since ${dockerSinceHours}h, ${typeof dockerTailLines === 'number' ? `${dockerTailLines} tail lines` : 'all lines'} per container).`,
            collectLogsFromFiles
              ? 'File-based log collection enabled (default).'
              : 'File-based log collection disabled via COLLECT_LOGS_FROM_FILES=false.',
            `Archive created: ${archivePath}`,
            'Upload skipped (local-only mode).',
            `Archive available at: ${archivePath}`,
          ].join('\n'),
        ),
        archivePath,
      };
    }

    // Upload with fallback to legacy script
    const uploadResult: {
      uploadedVia?: 'webdav' | 'ftp';
      legacyFallback?: boolean;
      output?: string;
    } = await (async () => {
      try {
        // uploadArchive expects string args; use normalized ticket/email
        const uploadedVia = await uploadArchive(
          archivePath,
          ticket,
          emailAddr,
          isWindows,
          logger,
        );

        // only attempt to remove the archive if archivePath is a non-empty string
        if (archivePath) {
          await rm(archivePath, { force: true });
        }

        return { uploadedVia };
      } catch (error) {
        logger?.warn(
          { error },
          'Internal upload failed, falling back to legacy collect logs script',
        );

        if (archivePath) {
          await rm(archivePath, { force: true });
        }

        const legacyResult = await collectLogsByScript({
          ticketId: ticket,
          email: emailAddr,
        });

        if (legacyResult.success) {
          return {
            legacyFallback: true,
            output: formatOutput(
              [
                'Internal collector upload failed.',
                'Legacy collect logs script completed successfully.',
                legacyResult.output,
              ].join('\n'),
            ),
          };
        }

        throw createCollectLogsError(
          'Internal collector upload failed and legacy fallback also failed.',
          legacyResult.output,
        );
      }
    })();

    if (uploadResult.legacyFallback) {
      return { output: uploadResult.output! };
    }

    // Successful upload path
    return {
      output: formatOutput(
        [
          'Credential pre-check succeeded.',
          `Collecting logs from last ${logLookbackDays} day(s).`,
          `Collecting logs from Docker (since ${dockerSinceHours}h, ${typeof dockerTailLines === 'number' ? `${dockerTailLines} tail lines` : 'all lines'} per container).`,
          collectLogsFromFiles
            ? 'File-based log collection enabled (default).'
            : 'File-based log collection disabled via COLLECT_LOGS_FROM_FILES=false.',
          `Archive created: ${archivePath}`,
          uploadResult.uploadedVia === 'webdav'
            ? 'Archive uploaded successfully via WebDAV.'
            : 'Archive uploaded successfully via FTP fallback.',
          'Local archive removed after successful upload.',
        ].join('\n'),
      ),
    };
  } finally {
    // cleanup (still uses await inside finally)
    await rm(extraDir, { recursive: true, force: true });
    await rm(snapshotDir, { recursive: true, force: true });
  }
};

const handler: CollectLogsHandler = async (req, reply) => {
  const {
    ticketId,
    email,
    localOnly = false,
  } = req.body as Readonly<{
    ticketId?: string;
    email?: string;
    localOnly?: boolean;
  }>;

  if (!localOnly && (!ticketId || !email)) {
    return reply.code(400).send({
      success: false,
      error: 'ticketId and email are required unless localOnly is true',
    });
  }

  if (!localOnly && email && !/^[^@\s]+@[^@\s]+$/.test(email)) {
    return reply.code(400).send({
      success: false,
      error: 'invalid email format',
    });
  }

  try {
    req.log.info(
      {
        ticketId: ticketId ? 'provided' : 'missing',
        email: email ? 'provided' : 'missing',
        localOnly,
        collectLogsFromFiles:
          process.env.COLLECT_LOGS_FROM_FILES?.toLowerCase() !== 'false',
        logLookbackDays: parseLogLookbackDays(),
        dockerSinceHours: parseDockerLogSinceHours(parseLogLookbackDays()),
        dockerTailLines: parseDockerTailLines(),
      },
      'Calling collectLogs internally',
    );

    const result = await collectLogsInternally({
      ticketId,
      email,
      localOnly,
      logger: req.log as unknown as Logger,
    });

    return reply.code(200).send({
      success: true,
      output: result.output,
      ...(result.archivePath ? { archivePath: result.archivePath } : {}),
    });
  } catch (error) {
    req.log.error({ error }, 'failed to collect logs internally');

    if (isCollectLogsError(error)) {
      return reply.code(500).send({
        success: false,
        error: error.message,
        details: error.details ? formatOutput(error.details) : undefined,
      });
    }

    return reply.code(500).send({
      success: false,
      error: 'internal server error',
    });
  }
};

export default handler;
