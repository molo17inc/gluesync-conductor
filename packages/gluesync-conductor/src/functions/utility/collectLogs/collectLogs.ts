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
import { CollectLogsHandler } from './collectLogs.model';
import getRootPath from '../../../helpers/getRootPath/getRootPath';

// Simple logger interface for internal functions
type Logger = {
  debug: (obj: Record<string, unknown> | string, msg?: string) => void;
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
};

const MAX_OUTPUT_LINES = 10;
const SCRIPT_VERSION = '2.0 internal';
const SYSTEM_INFO_SCRIPT_LINUX = 'system-info.sh';
const SYSTEM_INFO_SCRIPT_WINDOWS = 'system-info.ps1';
const WEBDAV_PAYLOAD =
  '<?xml version="1.0" encoding="UTF-8"?><propfind xmlns="DAV:"><propname/></propfind>';

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

type CollectLogsError = Error & { details?: string; isCollectLogsError: true };

const createCollectLogsError = (
  message: string,
  details?: string,
): CollectLogsError => {
  const error = new Error(message) as CollectLogsError;
  error.details = details;
  error.isCollectLogsError = true;
  return error;
};

const isCollectLogsError = (err: unknown): err is CollectLogsError =>
  err instanceof Error &&
  (err as Partial<CollectLogsError>).isCollectLogsError === true;

const sanitizeLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(line => line.replace(/[^\t -~]/g, '').trimEnd()) // tab + printable ASCII
    .filter(line => line.length > 0);

const formatOutput = (text: string): string => {
  const lines = sanitizeLines(text);
  if (!lines.length) {
    return 'Unknown error';
  }
  if (lines.length <= MAX_OUTPUT_LINES) {
    return lines.join('\n');
  }
  return `${lines.slice(0, MAX_OUTPUT_LINES).join('\n')}\n...`;
};

const runCommand = async (
  command: string,
  args: ReadonlyArray<string>,
  options: Readonly<{ cwd?: string; input?: string; useShell?: boolean }> = {},
): Promise<CommandResult> =>
  new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: options.useShell ?? false,
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', chunk => {
      stdoutChunks.push(Buffer.from(chunk));
    });

    child.stderr.on('data', chunk => {
      stderrChunks.push(Buffer.from(chunk));
    });

    child.on('error', err => {
      rejectCommand(err);
    });

    child.on('close', code => {
      resolveCommand({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    if (options.input) {
      child.stdin.write(options.input, 'utf8');
    }
    child.stdin.end();
  });

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

  const validCandidate = await candidates.reduce<Promise<string | null>>(
    async (acc, candidate) => {
      const result = await acc;
      if (result !== null) {
        return result;
      }
      try {
        await access(candidate, constants.F_OK);
        return candidate;
      } catch {
        return null;
      }
    },
    Promise.resolve(null),
  );

  return validCandidate;
};

const runSystemInfoScript = async (
  outputPath: string,
  isWindows: boolean,
): Promise<boolean> => {
  const scriptPath = await resolveSystemInfoScriptPath(isWindows);

  if (!scriptPath) {
    return false;
  }

  const command = isWindows ? 'pwsh' : '/bin/bash';
  const args = isWindows
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-OutputPath',
        outputPath,
      ]
    : [scriptPath, outputPath];

  try {
    const result = await runCommand(command, args);
    return result.exitCode === 0;
  } catch {
    return false;
  }
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
  try {
    const lookup = await runCommand(isWindows ? 'where' : 'which', [
      commandName,
    ]);
    return lookup.exitCode === 0;
  } catch {
    return false;
  }
};

const resolveWebDavRootUrl = (): string => {
  const baseUrl = (
    process.env.WEBDAV_BASE_URL || 'https://webdav.hq.molo17.com'
  )
    .trim()
    .replace(/\/+$/, '');
  const remotePath = (process.env.WEBDAV_REMOTE_PATH || '').trim();

  if (!remotePath) {
    return `${baseUrl}/`;
  }

  const normalizedPath = remotePath.replace(/^\/+/, '').replace(/\/+$/, '');
  return `${baseUrl}/${normalizedPath}/`;
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

  const validDir = await candidates.reduce<Promise<string | null>>(
    async (acc, candidate) => {
      const result = await acc;
      if (result !== null || !candidate) {
        return result;
      }
      try {
        const fileStat = await stat(candidate);
        return fileStat.isDirectory() ? candidate : null;
      } catch {
        return null;
      }
    },
    Promise.resolve(null),
  );

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
  options: Readonly<{ excludeDir?: string; isWindows: boolean }>,
): Promise<ReadonlyArray<string>> => {
  const collectFromDir = async (
    currentDir: string,
  ): Promise<ReadonlyArray<string>> => {
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(
      () => [],
    );

    const nestedFiles = await Promise.all(
      entries.map(
        async (
          entry: Readonly<Awaited<ReturnType<typeof readdir>>[number]>,
        ) => {
          const fullPath = join(currentDir, entry.name);

          if (
            options.excludeDir &&
            isPathInside(fullPath, options.excludeDir, options.isWindows)
          ) {
            return [] as string[];
          }

          if (entry.isDirectory()) {
            return collectFromDir(fullPath);
          }

          if (entry.isFile() && filter(fullPath)) {
            return [fullPath];
          }
          return [] as string[];
        },
      ),
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

const writeSystemReport = async (
  outputPath: string,
  isWindows: boolean,
): Promise<void> => {
  if (await runSystemInfoScript(outputPath, isWindows)) {
    return;
  }

  const sections: string[] = [
    'Gluesync System Report',
    `Generated on: ${new Date().toISOString()}`,
    '',
  ];

  const appendCommand = async (
    title: string,
    command: string,
    args: ReadonlyArray<string>,
  ): Promise<void> => {
    sections.push(`### ${title}`);
    try {
      const result = await runCommand(command, args);
      const body = `${result.stdout}${result.stderr}`.trim();
      sections.push(body || '(no output returned)');
      if (result.exitCode !== 0) {
        sections.push(`(command exited with status ${result.exitCode})`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      sections.push(`Command failed: ${reason}`);
    }
    sections.push('');
  };

  if (isWindows) {
    await appendCommand('systeminfo', 'systeminfo', []);
    await appendCommand('wmic os get caption,version /value', 'wmic', [
      'os',
      'get',
      'caption,version',
      '/value',
    ]);
    await appendCommand('ipconfig /all', 'ipconfig', ['/all']);
  } else {
    await appendCommand('uname -a', 'uname', ['-a']);
    await appendCommand('hostnamectl status', 'hostnamectl', ['status']);
    await appendCommand('df -h', 'df', ['-h']);
    await appendCommand('ip addr', 'ip', ['addr']);
  }

  await writeFile(outputPath, `${sections.join('\n')}\n`, 'utf8');
};

const writeFileDump = async (
  outputPath: string,
  searchRoot: string,
  extensions: ReadonlyArray<string>,
  options: Readonly<{ excludeDir?: string; isWindows: boolean }>,
): Promise<void> => {
  const extensionSet = new Set(extensions.map(ext => ext.toLowerCase()));
  const matchingFiles = await collectFilesRecursively(
    searchRoot,
    filePath => extensionSet.has(extname(filePath).toLowerCase()),
    options,
  );

  const lines: string[] = [
    `Full dump generated on: ${new Date().toISOString()}`,
    '',
  ];

  if (matchingFiles.length === 0) {
    lines.push(`No matching files were found within ${searchRoot}.`);
    await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
    return;
  }

  for (const filePath of matchingFiles) {
    const relativePath = relative(searchRoot, filePath);
    lines.push(`----- START ${relativePath} -----`);
    lines.push(await tryReadFile(filePath));
    lines.push(`----- END ${relativePath} -----`);
    lines.push('');
  }

  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
};

const writeDockerReport = async (outputPath: string): Promise<void> => {
  const sections: string[] = [
    `Docker diagnostics generated on: ${new Date().toISOString()}`,
    '',
  ];

  const commands: ReadonlyArray<
    Readonly<{ cmd: string; args: ReadonlyArray<string> }>
  > = [
    { cmd: 'docker', args: ['--version'] },
    { cmd: 'docker', args: ['info'] },
    { cmd: 'docker', args: ['ps', '-a'] },
    { cmd: 'docker', args: ['images'] },
    { cmd: 'docker', args: ['stats', '--no-stream'] },
    { cmd: 'docker', args: ['compose', 'version'] },
    { cmd: 'docker-compose', args: ['--version'] },
  ];

  for (const entry of commands) {
    sections.push(`### ${entry.cmd} ${entry.args.join(' ')}`.trim());
    try {
      const result = await runCommand(entry.cmd, entry.args);
      const body = `${result.stdout}${result.stderr}`.trim();
      sections.push(body || '(no output returned)');
      if (result.exitCode !== 0) {
        sections.push(`(command exited with status ${result.exitCode})`);
      }
    } catch {
      sections.push(`Command '${entry.cmd}' not available on this system.`);
    }
    sections.push('');
  }

  await writeFile(outputPath, `${sections.join('\n')}\n`, 'utf8');
};

const exportDockerContainerLogs = async (
  outputDirectory: string,
): Promise<ReadonlyArray<string>> => {
  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch {
    return [];
  }

  let containersResult: CommandResult;
  try {
    containersResult = await runCommand('docker', [
      'ps',
      '-a',
      '--format',
      '{{json .}}',
    ]);
  } catch {
    return [];
  }

  if (containersResult.exitCode !== 0) {
    return [];
  }

  const containerLines = containersResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const exportedFiles: string[] = [];

  for (const line of containerLines) {
    let container: Readonly<Record<string, string>> | null = null;
    try {
      const parsed = JSON.parse(line) as Record<string, string>;
      container = parsed;
    } catch {
      container = null;
    }

    if (!container) {
      continue;
    }

    const containerId = container.ID || '';
    if (!containerId) {
      continue;
    }

    const containerName =
      container.Names || containerId.slice(0, Math.min(12, containerId.length));
    const safeName = containerName.replace(/[\\/:*?"<>|]/g, '_');
    const filePath = join(outputDirectory, `container-${safeName}.log`);

    let logsResult: CommandResult;
    try {
      logsResult = await runCommand('docker', ['logs', containerId]);
    } catch {
      continue;
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
    exportedFiles.push(filePath);
  }

  return exportedFiles;
};

const toRelativeArchivePaths = (
  searchDir: string,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  files
    .map(filePath => {
      const rel = relative(searchDir, filePath);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        return null;
      }
      return rel;
    })
    .filter((entry): entry is string => entry !== null);

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
      'No valid relative files found for archive creation.',
    );
  }

  // Priority order: zstd (best speed/compression) > xz (max compression) > zip (compatibility) > tar.gz (fallback)
  const listFilePath = join(
    outputDir,
    `.collect-logs-${Date.now()}-${process.pid}.list`,
  );

  try {
    await writeFile(listFilePath, `${relativePaths.join('\n')}\n`, 'utf8');

    // Try zstd first (best for large logs: good compression, very fast)
    const canUseZstd = await commandExists('zstd', isWindows);
    if (canUseZstd) {
      logger?.info('Using zstd compression (high speed, good ratio)');
      const archivePath = join(outputDir, `${archiveBaseName}.tar.zst`);
      // Use shell pipeline: tar to stdout | zstd
      const zstdResult = await runCommand(
        'sh',
        [
          '-c',
          `tar -cf - -T "${listFilePath}" | zstd -T0 -19 > "${archivePath}"`,
        ],
        { cwd: searchDir, useShell: false }, // sh handles the pipe
      );

      if (zstdResult.exitCode === 0) {
        logger?.info({ archivePath }, 'zstd archive created successfully');
        return archivePath;
      }
      logger?.warn(
        { exitCode: zstdResult.exitCode, stderr: zstdResult.stderr },
        'zstd compression failed, trying next method',
      );
    }

    // Try xz for maximum compression (slower but best ratio)
    const canUseXz = await commandExists('xz', isWindows);
    if (canUseXz) {
      logger?.info('Using xz compression (maximum compression ratio)');
      const archivePath = join(outputDir, `${archiveBaseName}.tar.xz`);
      // Use shell pipeline: tar to stdout | xz
      const xzResult = await runCommand(
        'sh',
        ['-c', `tar -cf - -T "${listFilePath}" | xz -T0 -9 > "${archivePath}"`],
        { cwd: searchDir, useShell: false },
      );

      if (xzResult.exitCode === 0) {
        logger?.info({ archivePath }, 'xz archive created successfully');
        return archivePath;
      }
      logger?.warn(
        { exitCode: xzResult.exitCode, stderr: xzResult.stderr },
        'xz compression failed, trying next method',
      );
    }

    // Try parallel gzip (pigz) for faster gzip compression
    const canUsePigz = await commandExists('pigz', isWindows);
    if (canUsePigz) {
      logger?.info('Using pigz compression (parallel gzip)');
      const archivePath = join(outputDir, `${archiveBaseName}.tar.gz`);
      // Use shell pipeline: tar to stdout | pigz
      const pigzResult = await runCommand(
        'sh',
        ['-c', `tar -cf - -T "${listFilePath}" | pigz > "${archivePath}"`],
        { cwd: searchDir, useShell: false },
      );

      if (pigzResult.exitCode === 0) {
        logger?.info({ archivePath }, 'pigz archive created successfully');
        return archivePath;
      }
      logger?.warn(
        { exitCode: pigzResult.exitCode, stderr: pigzResult.stderr },
        'pigz compression failed, trying next method',
      );
    }

    // Fall back to zip (good Windows compatibility)
    const canUseZip = await commandExists('zip', isWindows);
    if (canUseZip) {
      logger?.info('Using zip compression');
      const archivePath = join(outputDir, `${archiveBaseName}.zip`);
      // Use -9 for maximum compression
      const zipResult = await runCommand('zip', ['-9', '-@', archivePath], {
        cwd: searchDir,
        input: `${relativePaths.join('\n')}\n`,
      });

      if (zipResult.exitCode === 0) {
        logger?.info({ archivePath }, 'zip archive created successfully');
        return archivePath;
      }
      logger?.warn('zip compression failed, using final fallback');
    }

    // Final fallback: standard tar.gz
    logger?.info('Using tar.gz compression (fallback)');
    const archivePath = join(outputDir, `${archiveBaseName}.tar.gz`);
    const tarResult = await runCommand(
      'tar',
      ['-czf', archivePath, '-T', listFilePath],
      { cwd: searchDir },
    );

    if (tarResult.exitCode !== 0) {
      throw createCollectLogsError(
        'Failed to create archive with tar.',
        formatOutput(`${tarResult.stdout}\n${tarResult.stderr}`),
      );
    }

    logger?.info({ archivePath }, 'tar.gz archive created successfully');
    return archivePath;
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
  let webDavFailureDetail = '';

  logger?.debug({ webdavProbeUrl }, 'Attempting WebDAV credential pre-check');
  try {
    const response = await fetch(webdavProbeUrl, {
      method: 'PROPFIND',
      headers,
      body: WEBDAV_PAYLOAD,
    });
    if (response.ok || response.status === 207) {
      logger?.info(
        { status: response.status },
        'WebDAV credential pre-check succeeded',
      );
      return;
    }
    const authHint =
      response.status === 401 || response.status === 403
        ? ' (authentication or authorization issue)'
        : '';
    webDavFailureDetail =
      `WebDAV credential pre-check failed with HTTP ${response.status} ${response.statusText}${authHint}`.trim();
    logger?.warn(
      { status: response.status, statusText: response.statusText },
      'WebDAV credential pre-check failed',
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    webDavFailureDetail = `WebDAV credential pre-check network error: ${reason}`;
    logger?.warn({ reason }, 'WebDAV credential pre-check network error');
    // continue with FTP fallback
  }

  logger?.info('Attempting FTP fallback for credential validation');
  const hasCurl = await commandExists('curl', isWindows);
  if (!hasCurl) {
    logger?.error('curl not available for FTP fallback');
    throw createCollectLogsError(
      'Unable to validate credentials: WebDAV failed and curl is unavailable for FTP fallback.',
      webDavFailureDetail || undefined,
    );
  }

  logger?.debug('Running FTP list command for credential check');
  const ftpCheck = await runCommand('curl', [
    '--silent',
    '--fail',
    '--show-error',
    '--user',
    `${ticketId}:${email}`,
    '--list-only',
    'ftp://ftp.molo17.com/',
  ]);

  if (ftpCheck.exitCode !== 0) {
    logger?.error(
      { exitCode: ftpCheck.exitCode, stderr: ftpCheck.stderr },
      'FTP credential check failed',
    );
    throw createCollectLogsError(
      'Unable to validate ticket/email credentials before collecting logs.',
      formatOutput(
        `${webDavFailureDetail ? `${webDavFailureDetail}\n` : ''}${ftpCheck.stdout}\n${ftpCheck.stderr}`,
      ),
    );
  }
  logger?.info('FTP credential pre-check succeeded');
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
  let webDavFailureDetail = '';

  logger?.info({ fileName, webDavTarget }, 'Starting archive upload');

  try {
    logger?.debug(
      { archivePath, size: (await stat(archivePath)).size },
      'Reading archive file for WebDAV upload',
    );
    const payload = await readFile(archivePath);
    logger?.info({ size: payload.length }, 'Uploading via WebDAV PUT');
    const webdavResponse = await fetch(webDavTarget, {
      method: 'PUT',
      headers: {
        Authorization: basicAuthHeader(ticketId, email),
      },
      body: payload,
    });

    if (webdavResponse.ok) {
      logger?.info('WebDAV upload succeeded');
      return 'webdav';
    }

    const authHint =
      webdavResponse.status === 401 || webdavResponse.status === 403
        ? ' (authentication or authorization issue)'
        : '';
    webDavFailureDetail =
      `WebDAV upload failed with HTTP ${webdavResponse.status} ${webdavResponse.statusText}${authHint}`.trim();
    logger?.warn(
      { status: webdavResponse.status, statusText: webdavResponse.statusText },
      'WebDAV upload failed',
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    webDavFailureDetail = `WebDAV upload network error: ${reason}`;
    logger?.warn({ reason }, 'WebDAV upload network error');
    // continue with FTP fallback
  }

  logger?.info('Attempting FTP fallback upload');
  const hasCurl = await commandExists('curl', isWindows);
  if (!hasCurl) {
    logger?.error('curl not available for FTP fallback upload');
    throw createCollectLogsError(
      'WebDAV upload failed and curl is unavailable for FTP fallback upload.',
      webDavFailureDetail || undefined,
    );
  }

  const ftpUrl = `ftp://${ticketId}:${encodeURIComponent(email)}@ftp.molo17.com/${encodedName}`;
  logger?.debug({ fileName }, 'Uploading via FTP using curl');
  const ftpResult = await runCommand('curl', ['-T', archivePath, ftpUrl]);

  if (ftpResult.exitCode !== 0) {
    const hint = ftpFailureHint(ftpResult.exitCode, ftpResult.stderr);
    logger?.error({ exitCode: ftpResult.exitCode, hint }, 'FTP upload failed');
    throw createCollectLogsError(
      'Failed to upload to FTP after WebDAV failure.',
      formatOutput(
        `${webDavFailureDetail ? `${webDavFailureDetail}\n` : ''}${hint}\n${ftpResult.stdout}\n${ftpResult.stderr}`,
      ),
    );
  }

  logger?.info('FTP upload succeeded');
  return 'ftp';
};

const collectLogsInternally = async (
  options: CollectLogsOptions,
): Promise<CollectLogsResult> => {
  const { ticketId, email, localOnly, logger } = options;
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
  const messages: string[] = [];

  logger?.info(
    {
      localOnly,
      ticketId: ticketId ? 'provided' : 'missing',
      email: email ? 'provided' : 'missing',
    },
    'Starting log collection',
  );

  if (!localOnly) {
    if (!ticketId || !email) {
      logger?.error('ticketId and email required but not provided');
      throw createCollectLogsError(
        'ticketId and email are required unless localOnly is true.',
      );
    }

    logger?.info('Validating credentials before collection');
    await validateCredentialConnectivity(ticketId, email, isWindows, logger);
    messages.push('Credential pre-check succeeded.');
  } else {
    logger?.info('Local-only mode: skipping credential validation');
    messages.push('Local-only mode enabled. Credential pre-check skipped.');
  }

  logger?.info('Resolving search directory');
  const searchDir = await resolveSearchDir(isWindows);
  logger?.info({ searchDir }, 'Search directory resolved');

  const outputDir = await resolveOutputDir();
  logger?.info({ outputDir }, 'Output directory resolved');
  messages.push(`Collecting logs from: ${searchDir}`);

  const extraDir = join(
    searchDir,
    `gluesync-support-extra-${Date.now()}-${process.pid}`,
  );

  let archivePath = '';

  try {
    logger?.info({ extraDir }, 'Creating extra diagnostics directory');
    await mkdir(extraDir, { recursive: true });

    const systemReportPath = join(extraDir, 'system-report.txt');
    const yamlDumpPath = join(extraDir, 'yaml-files-dump.txt');
    const xmlDumpPath = join(extraDir, 'xml-files-dump.txt');
    const dockerReportPath = join(extraDir, 'docker-report.txt');
    const containerLogsDir = join(extraDir, 'container-logs');

    logger?.info('Generating system report');
    await writeSystemReport(systemReportPath, isWindows);

    logger?.info('Dumping YAML files');
    await writeFileDump(yamlDumpPath, searchDir, ['.yaml', '.yml'], {
      excludeDir: extraDir,
      isWindows,
    });

    logger?.info('Dumping XML files');
    await writeFileDump(xmlDumpPath, searchDir, ['.xml'], {
      excludeDir: extraDir,
      isWindows,
    });

    logger?.info('Collecting Docker info');
    await writeDockerReport(dockerReportPath);

    logger?.info('Exporting container logs');
    const exportedContainerLogs =
      await exportDockerContainerLogs(containerLogsDir);
    logger?.info(
      { count: exportedContainerLogs.length },
      'Container logs exported',
    );

    logger?.info('Collecting log files recursively');
    const logFiles = await collectFilesRecursively(
      searchDir,
      filePath => {
        const extension = extname(filePath).toLowerCase();
        return extension === '.log' || extension === '.err';
      },
      { isWindows },
    );
    logger?.info({ count: logFiles.length }, 'Log files discovered');

    logger?.info('Collecting diagnostic files');
    const diagnosticFiles = await collectFilesRecursively(
      extraDir,
      () => true,
      { isWindows },
    );
    logger?.info(
      { count: diagnosticFiles.length },
      'Diagnostic files discovered',
    );

    const candidateFiles = Array.from(
      new Set([...logFiles, ...diagnosticFiles]),
    );

    logger?.info('Checking file readability');
    const readableFiles: string[] = [];
    for (const filePath of candidateFiles) {
      try {
        await access(filePath, constants.R_OK);
        readableFiles.push(filePath);
      } catch {
        logger?.debug({ filePath }, 'File not readable, skipping');
      }
    }
    logger?.info({ count: readableFiles.length }, 'Readable files for archive');

    if (readableFiles.length === 0) {
      logger?.error('No readable files found to archive');
      throw createCollectLogsError(
        'No readable log, error, or diagnostics files found to archive.',
      );
    }

    logger?.info('Creating archive');
    archivePath = await createArchive(
      searchDir,
      outputDir,
      readableFiles,
      isWindows,
      logger,
    );
    logger?.info({ archivePath }, 'Archive created successfully');
    messages.push(`Archive created: ${archivePath}`);

    if (localOnly) {
      messages.push('Upload skipped (local-only mode).');
      messages.push(`Archive available at: ${archivePath}`);

      logger?.info({ archivePath }, 'Local-only mode: returning archive path');
      return {
        output: formatOutput(messages.join('\n')),
        archivePath,
      };
    }

    logger?.info('Starting archive upload');
    const uploadedVia = await uploadArchive(
      archivePath,
      ticketId || '',
      email || '',
      isWindows,
      logger,
    );
    messages.push(
      uploadedVia === 'webdav'
        ? 'Archive uploaded successfully via WebDAV.'
        : 'Archive uploaded successfully via FTP fallback.',
    );
    logger?.info({ uploadedVia }, 'Archive upload completed');

    logger?.info({ archivePath }, 'Removing local archive after upload');
    await rm(archivePath, { force: true });
    messages.push('Local archive removed after successful upload.');

    return {
      output: formatOutput(messages.join('\n')),
    };
  } finally {
    logger?.info({ extraDir }, 'Cleaning up extra diagnostics directory');
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
    return reply
      .code(400)
      .send({ success: false, error: 'invalid email format' });
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
      logger: req.log,
    });

    const responsePayload: Readonly<{
      success: true;
      output: string;
      archivePath?: string;
    }> = {
      success: true,
      output: result.output,
      ...(result.archivePath ? { archivePath: result.archivePath } : {}),
    };

    return reply.code(200).send(responsePayload);
  } catch (err) {
    req.log.error({ err }, 'failed to collect logs internally');

    if (isCollectLogsError(err)) {
      return reply.code(500).send({
        success: false,
        error: err.message,
        details: err.details ? formatOutput(err.details) : undefined,
      });
    }

    return reply
      .code(500)
      .send({ success: false, error: 'internal server error' });
  }
};

export default handler;
