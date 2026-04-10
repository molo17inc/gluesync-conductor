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
import { tmpdir } from 'node:os';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { AxiosError } from 'axios';
import { CollectLogsHandler } from './collectLogs.model';
import getRootPath from '../../../helpers/getRootPath/getRootPath';
import axiosWithRetry from '../../../utils/axiosWithRetry';

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
  input?: string;
  successLog: string;
  failLog: string;
}>;

const MAX_OUTPUT_LINES = 10;
const SCRIPT_VERSION = '2.0-internal';
const SYSTEM_INFO_SCRIPT_LINUX = 'system-info.sh';
const SYSTEM_INFO_SCRIPT_WINDOWS = 'system-info.ps1';
const WEBDAV_PAYLOAD =
  '<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:"><propname/></propfind>';

const createCollectLogsError = (
  message: string,
  details?: string,
): CollectLogsError =>
  Object.assign(new Error(message), {
    details,
    isCollectLogsError: true as const,
  });

const isCollectLogsError = (err: unknown): err is CollectLogsError =>
  err instanceof Error &&
  'isCollectLogsError' in err &&
  err.isCollectLogsError === true;

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

    const collectStream = (
      stream?: Readonly<NodeJS.ReadableStream>,
    ): Promise<string> => {
      if (!stream) {
        return Promise.resolve('');
      }

      stream.setEncoding('utf8');

      return new Promise<string>(streamResolve => {
        const accumulate = (
          acc: ReadonlyArray<string>,
          chunk: string,
        ): ReadonlyArray<string> => [...acc, chunk];

        const loop = (acc: ReadonlyArray<string>): void => {
          stream.once('data', (chunk: string) => {
            loop(accumulate(acc, chunk));
          });

          stream.once('end', () => {
            streamResolve(acc.join(''));
          });
        };

        loop([]);
      });
    };

    const stdoutPromise = collectStream(child.stdout);
    const stderrPromise = collectStream(child.stderr);

    const handleError = async (err: Readonly<Error>) => {
      const [stdout, stderr] = await Promise.all([
        stdoutPromise,
        stderrPromise,
      ]);

      if (stderr.length > 0) {
        resolve({ exitCode: 1, stdout, stderr });
        return;
      }

      resolve({ exitCode: 1, stdout, stderr: err.message });
    };

    const handleClose = async (code: number | null) => {
      const [stdout, stderr] = await Promise.all([
        stdoutPromise,
        stderrPromise,
      ]);

      const exitCode = code === null ? 1 : code;

      resolve({ exitCode, stdout, stderr });
    };

    child.on('error', handleError);
    child.on('close', handleClose);

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
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    return `Unable to read file: ${reason}`;
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

const exportDockerContainerLogs = async (
  outputDirectory: string,
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
    containers.map(async container => {
      const containerId = container.ID || '';
      const containerName =
        container.Names ||
        containerId.slice(0, Math.min(12, containerId.length));
      const safeName = containerName.replace(/[\\/:*?"<>|]/g, '_');
      const filePath = join(outputDirectory, `container-${safeName}.log`);
      const logsResult = await runCommandCapture('docker', [
        'logs',
        containerId,
      ]);

      if (
        logsResult.exitCode !== 0 &&
        !logsResult.stdout &&
        !logsResult.stderr
      ) {
        return null;
      }

      const content = [
        `Container Logs for: ${containerName}`,
        `Container ID: ${containerId}`,
        `Status: ${container.Status || 'unknown'}`,
        `Image: ${container.Image || 'unknown'}`,
        `Collected on: ${new Date().toISOString()}`,
        '',
        '================================================================================',
        '',
        `${logsResult.stdout}${logsResult.stderr}`,
      ].join('\n');

      await writeFile(filePath, content, 'utf8');
      return filePath;
    }),
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

  // Create the list file for tar/zip to consume
  const listFilePath = join(
    outputDir,
    `.collect-logs-${Date.now()}-${process.pid}.list`,
  );

  // Use \n for standard tar/zip lists
  await writeFile(listFilePath, `${relativePaths.join('\n')}\n`, 'utf8');

  try {
    const commandAvailability = await Promise.all([
      // isWindows ? commandExists('tar.exe', true) : Promise.resolve(false),
      !isWindows ? commandExists('zip', false) : commandExists('zip', true),
      !isWindows ? commandExists('zstd', false) : Promise.resolve(false),
    ]);

    const [zipAvailable, zstdAvailable] = commandAvailability;

    const candidateMatrix: ReadonlyArray<CompressionCandidate | null> = [
      // --- WINDOWS NATIVE (Nanoserver 2022 / Server 2019) ---
      isWindows
        ? ({
            name: 'tar.exe',
            archivePath: join(outputDir, `${archiveBaseName}.tar`),
            command: 'tar.exe',
            args: [
              '-cf',
              join(outputDir, `${archiveBaseName}.tar`),
              '-C',
              searchDir,
              '-T',
              listFilePath,
            ],
            cwd: process.cwd(),
            successLog: 'tar archive created via tar.exe',
            failLog: 'tar.exe failed, trying next candidate',
          } as CompressionCandidate)
        : null,

      // --- LINUX: PIGZ (Parallel GZIP - Fast & Multi-core) ---
      !isWindows
        ? ({
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
            failLog: 'tar.gz failed, trying next candidate',
          } as CompressionCandidate)
        : null,

      // --- LINUX: ZSTD (tar.zst) ---
      !isWindows && zstdAvailable
        ? ({
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
            failLog: 'tar.zst failed, trying next candidate',
          } as CompressionCandidate)
        : null,

      !isWindows && zipAvailable
        ? ({
            name: 'zip',
            archivePath: join(outputDir, `${archiveBaseName}.zip`),
            command: 'zip',
            args: ['-9', '-@', join(outputDir, `${archiveBaseName}.zip`)],
            cwd: searchDir,
            input: `${relativePaths.join('\n')}\n`,
            successLog: 'zip archive created successfully',
            failLog: 'zip failed, trying next candidate',
          } as CompressionCandidate)
        : null,
    ];

    const availableCandidates = candidateMatrix.filter(
      (candidate): candidate is CompressionCandidate => candidate !== null,
    );

    const compressedArchivePath = await availableCandidates.reduce<
      Promise<string | null>
    >(async (resolvedArchivePathPromise, candidate) => {
      const resolvedArchivePath = await resolvedArchivePathPromise;

      if (resolvedArchivePath !== null) {
        return resolvedArchivePath;
      }

      logger?.info(
        { candidate: candidate.name },
        `Attempting compression with ${candidate.name}`,
      );

      const result = await runCommandCapture(
        candidate.command,
        candidate.args,
        {
          cwd: candidate.cwd,
          ...(candidate.input ? { input: candidate.input } : {}),
          useShell: false,
        },
      );

      if (result.exitCode !== 0) {
        logger?.warn(
          {
            candidate: candidate.name,
            exitCode: result.exitCode,
            stderr: result.stderr,
          },
          candidate.failLog,
        );
        return null;
      }

      logger?.info(
        {
          archivePath: candidate.archivePath,
          candidate: candidate.name,
        },
        candidate.successLog,
      );

      const isValid = await isArchiveValid(candidate.archivePath);

      if (isValid) {
        logger?.info(
          {
            archivePath: candidate.archivePath,
            candidate: candidate.name,
          },
          'Archive validation passed',
        );
        return candidate.archivePath;
      }

      logger?.warn(
        {
          archivePath: candidate.archivePath,
          candidate: candidate.name,
        },
        'Archive validation failed (corrupted/empty), trying next candidate',
      );

      await rm(candidate.archivePath, { force: true });

      return null;
    }, Promise.resolve<string | null>(null));

    if (compressedArchivePath) {
      return compressedArchivePath;
    }

    // --- FINAL UNIVERSAL FALLBACK (Standard tar) ---
    const fallbackExt = isWindows ? '.zip' : '.tar';
    const fallbackPath = join(outputDir, `${archiveBaseName}${fallbackExt}`);
    const fallbackCmd = isWindows ? 'tar.exe' : 'tar';
    const fallbackArgs = isWindows
      ? ['-a', '-cf', fallbackPath, '-C', searchDir, '-T', listFilePath]
      : ['-cf', fallbackPath, '-C', searchDir, '-T', listFilePath];

    logger?.info(
      { command: fallbackCmd, archivePath: fallbackPath },
      `All candidates failed. Attempting final fallback: ${fallbackCmd}`,
    );
    const finalResult = await runCommandCapture(fallbackCmd, fallbackArgs, {
      cwd: process.cwd(),
      useShell: false,
    });

    if (finalResult.exitCode === 0) {
      const isValid = await isArchiveValid(fallbackPath);
      if (isValid) {
        logger?.info(
          { archivePath: fallbackPath },
          'Fallback archive validation passed',
        );
        return fallbackPath;
      }

      logger?.error(
        { archivePath: fallbackPath },
        'Fallback archive validation failed (corrupted)',
      );
      await rm(fallbackPath, { force: true });
    } else {
      logger?.error(
        {
          command: fallbackCmd,
          exitCode: finalResult.exitCode,
          stderr: finalResult.stderr,
        },
        'Final fallback compression failed',
      );
    }

    throw createCollectLogsError(
      'No archive compression tool available. Please install zip.',
    );
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
    .catch(err => ({
      ok: false as const,
      detail: `WebDAV credential pre-check failed: ${err instanceof Error ? err.message : 'unknown error'}`,
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

  logger?.info(
    { fileName, webDavTarget },
    'Starting archive upload via WebDAV',
  );

  const webDavResult = await readFile(archivePath)
    .then(async payload => {
      await axiosWithRetry<void>(webDavTarget, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(ticketId, email) },
        data: payload,
        retries: 3,
        timeout: 10000,
        backoffMs: 500,
      });

      return { ok: true as const, method: 'webdav' as const, detail: '' };
    })
    .catch(err => {
      const axiosErr = err as AxiosError;
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
    });

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
  const ftpResult = await runCommandCapture('curl', [
    '-T',
    archivePath,
    ftpUrl,
  ]);

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
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';

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
  const outputDir = await resolveOutputDir();
  const extraDir = join(
    searchDir,
    `gluesync-support-extra-${Date.now()}-${process.pid}`,
  );

  await mkdir(extraDir, { recursive: true });

  const systemReportPath = join(extraDir, 'system-report.txt');
  const yamlDumpPath = join(extraDir, 'yaml-files-dump.txt');
  const xmlDumpPath = join(extraDir, 'xml-files-dump.txt');
  const dockerReportPath = join(extraDir, 'docker-report.txt');
  const containerLogsDir = join(extraDir, 'container-logs');

  try {
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

    await exportDockerContainerLogs(containerLogsDir);

    const [logFiles, diagnosticFiles] = await Promise.all([
      collectFilesRecursively(
        searchDir,
        filePath => {
          const extension = extname(filePath).toLowerCase();
          return extension === '.log' || extension === '.err';
        },
        { isWindows },
      ),
      collectFilesRecursively(extraDir, () => true, { isWindows }),
    ]);

    const candidateFiles = Array.from(
      new Set([...logFiles, ...diagnosticFiles]),
    );
    const readableFiles = await filterReadableFiles(candidateFiles, logger);

    if (readableFiles.length === 0) {
      throw createCollectLogsError(
        'No readable log, error, or diagnostics files found to archive.',
      );
    }

    const archivePath = await createArchive(
      searchDir,
      outputDir,
      readableFiles,
      isWindows,
      logger,
    );

    if (localOnly) {
      return {
        output: formatOutput(
          [
            'Local-only mode enabled. Credential pre-check skipped.',
            `Collecting logs from: ${searchDir}`,
            `Archive created: ${archivePath}`,
            'Upload skipped (local-only mode).',
            `Archive available at: ${archivePath}`,
          ].join('\n'),
        ),
        archivePath,
      };
    }

    const uploadedVia = await uploadArchive(
      archivePath,
      ticketId || '',
      email || '',
      isWindows,
      logger,
    );

    await rm(archivePath, { force: true });

    return {
      output: formatOutput(
        [
          'Credential pre-check succeeded.',
          `Collecting logs from: ${searchDir}`,
          `Archive created: ${archivePath}`,
          uploadedVia === 'webdav'
            ? 'Archive uploaded successfully via WebDAV.'
            : 'Archive uploaded successfully via FTP fallback.',
          'Local archive removed after successful upload.',
        ].join('\n'),
      ),
    };
  } finally {
    await rm(extraDir, { recursive: true, force: true });
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
  } catch (err) {
    req.log.error({ err }, 'failed to collect logs internally');

    if (isCollectLogsError(err)) {
      return reply.code(500).send({
        success: false,
        error: err.message,
        details: err.details ? formatOutput(err.details) : undefined,
      });
    }

    return reply.code(500).send({
      success: false,
      error: 'internal server error',
    });
  }
};

export default handler;
