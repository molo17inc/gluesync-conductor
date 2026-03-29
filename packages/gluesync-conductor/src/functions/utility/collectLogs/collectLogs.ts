/* eslint-disable functional/immutable-data */
/* eslint-disable functional/no-let */
/* eslint-disable functional/no-loop-statements */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */

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
  options: Readonly<{ cwd?: string; input?: string }> = {},
): Promise<CommandResult> =>
  new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
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

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
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

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const fileStat = await stat(candidate);
      if (fileStat.isDirectory()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  throw createCollectLogsError(
    'No valid search directory found for log collection.',
  );
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
  const files: string[] = [];
  const directories: string[] = [rootDir];

  while (directories.length > 0) {
    const currentDir = directories.pop();
    if (!currentDir) {
      continue;
    }

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (
        options.excludeDir &&
        isPathInside(fullPath, options.excludeDir, options.isWindows)
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(fullPath);
        continue;
      }

      if (entry.isFile() && filter(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
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

  const canUseZip = await commandExists('zip', isWindows);
  if (canUseZip) {
    const archivePath = join(outputDir, `${archiveBaseName}.zip`);
    const zipResult = await runCommand('zip', ['-@', archivePath], {
      cwd: searchDir,
      input: `${relativePaths.join('\n')}\n`,
    });

    if (zipResult.exitCode === 0) {
      return archivePath;
    }
  }

  const canUseTar = await commandExists('tar', isWindows);
  if (!canUseTar) {
    throw createCollectLogsError(
      "Neither 'zip' nor 'tar' commands are available to create an archive.",
    );
  }

  const archivePath = join(outputDir, `${archiveBaseName}.tar.gz`);
  const listFilePath = join(
    outputDir,
    `.collect-logs-${Date.now()}-${process.pid}.list`,
  );

  try {
    await writeFile(listFilePath, `${relativePaths.join('\n')}\n`, 'utf8');
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

    return archivePath;
  } finally {
    await rm(listFilePath, { force: true });
  }
};

const validateCredentialConnectivity = async (
  ticketId: string,
  email: string,
  isWindows: boolean,
): Promise<void> => {
  const webdavProbeUrl = resolveWebDavRootUrl();
  const headers = {
    Authorization: basicAuthHeader(ticketId, email),
    Depth: '0',
    'Content-Type': 'text/xml',
  };

  try {
    const response = await fetch(webdavProbeUrl, {
      method: 'PROPFIND',
      headers,
      body: WEBDAV_PAYLOAD,
    });
    if (response.ok || response.status === 207) {
      return;
    }
  } catch {
    // continue with FTP fallback
  }

  const hasCurl = await commandExists('curl', isWindows);
  if (!hasCurl) {
    throw createCollectLogsError(
      'Unable to validate credentials: WebDAV failed and curl is unavailable for FTP fallback.',
    );
  }

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
    throw createCollectLogsError(
      'Unable to validate ticket/email credentials before collecting logs.',
      formatOutput(`${ftpCheck.stdout}\n${ftpCheck.stderr}`),
    );
  }
};

const uploadArchive = async (
  archivePath: string,
  ticketId: string,
  email: string,
  isWindows: boolean,
): Promise<'webdav' | 'ftp'> => {
  const fileName = basename(archivePath);
  const encodedName = encodeURIComponent(fileName);
  const webDavTarget = `${resolveWebDavRootUrl()}${encodedName}`;

  try {
    const payload = await readFile(archivePath);
    const webdavResponse = await fetch(webDavTarget, {
      method: 'PUT',
      headers: {
        Authorization: basicAuthHeader(ticketId, email),
      },
      body: payload,
    });

    if (webdavResponse.ok) {
      return 'webdav';
    }
  } catch {
    // continue with FTP fallback
  }

  const hasCurl = await commandExists('curl', isWindows);
  if (!hasCurl) {
    throw createCollectLogsError(
      'WebDAV upload failed and curl is unavailable for FTP fallback upload.',
    );
  }

  const ftpUrl = `ftp://${ticketId}:${encodeURIComponent(email)}@ftp.molo17.com/${encodedName}`;
  const ftpResult = await runCommand('curl', ['-T', archivePath, ftpUrl]);

  if (ftpResult.exitCode !== 0) {
    const hint = ftpFailureHint(ftpResult.exitCode, ftpResult.stderr);
    throw createCollectLogsError(
      'Failed to upload to FTP after WebDAV failure.',
      formatOutput(`${hint}\n${ftpResult.stdout}\n${ftpResult.stderr}`),
    );
  }

  return 'ftp';
};

const collectLogsInternally = async (
  ticketId: string,
  email: string,
): Promise<CollectLogsResult> => {
  const isWindows = process.env.IS_WINDOWS?.toLowerCase() === 'true';
  const messages: string[] = [];

  await validateCredentialConnectivity(ticketId, email, isWindows);
  messages.push('Credential pre-check succeeded.');

  const searchDir = await resolveSearchDir(isWindows);
  const outputDir = await resolveOutputDir();
  messages.push(`Collecting logs from: ${searchDir}`);

  const extraDir = join(
    searchDir,
    `gluesync-support-extra-${Date.now()}-${process.pid}`,
  );

  let archivePath = '';

  try {
    await mkdir(extraDir, { recursive: true });

    const systemReportPath = join(extraDir, 'system-report.txt');
    const yamlDumpPath = join(extraDir, 'yaml-files-dump.txt');
    const xmlDumpPath = join(extraDir, 'xml-files-dump.txt');
    const dockerReportPath = join(extraDir, 'docker-report.txt');
    const containerLogsDir = join(extraDir, 'container-logs');

    await writeSystemReport(systemReportPath, isWindows);
    await writeFileDump(yamlDumpPath, searchDir, ['.yaml', '.yml'], {
      excludeDir: extraDir,
      isWindows,
    });
    await writeFileDump(xmlDumpPath, searchDir, ['.xml'], {
      excludeDir: extraDir,
      isWindows,
    });
    await writeDockerReport(dockerReportPath);
    await exportDockerContainerLogs(containerLogsDir);

    const logFiles = await collectFilesRecursively(
      searchDir,
      filePath => {
        const extension = extname(filePath).toLowerCase();
        return extension === '.log' || extension === '.err';
      },
      {
        isWindows,
      },
    );

    const diagnosticFiles = await collectFilesRecursively(
      extraDir,
      () => true,
      {
        isWindows,
      },
    );

    const candidateFiles = Array.from(
      new Set([...logFiles, ...diagnosticFiles]),
    );

    const readableFiles: string[] = [];
    for (const filePath of candidateFiles) {
      try {
        await access(filePath, constants.R_OK);
        readableFiles.push(filePath);
      } catch {
        continue;
      }
    }

    if (readableFiles.length === 0) {
      throw createCollectLogsError(
        'No readable log, error, or diagnostics files found to archive.',
      );
    }

    archivePath = await createArchive(
      searchDir,
      outputDir,
      readableFiles,
      isWindows,
    );
    messages.push(`Archive created: ${archivePath}`);

    const uploadedVia = await uploadArchive(
      archivePath,
      ticketId,
      email,
      isWindows,
    );
    messages.push(
      uploadedVia === 'webdav'
        ? 'Archive uploaded successfully via WebDAV.'
        : 'Archive uploaded successfully via FTP fallback.',
    );

    await rm(archivePath, { force: true });
    messages.push('Local archive removed after successful upload.');

    return {
      output: formatOutput(messages.join('\n')),
    };
  } finally {
    await rm(extraDir, { recursive: true, force: true });
  }
};

const handler: CollectLogsHandler = async (req, reply) => {
  const { ticketId, email } = req.body as Readonly<{
    ticketId?: string;
    email?: string;
  }>;

  if (!ticketId || !email) {
    return reply
      .code(400)
      .send({ success: false, error: 'ticketId and email are required' });
  }

  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    return reply
      .code(400)
      .send({ success: false, error: 'invalid email format' });
  }

  try {
    const result = await collectLogsInternally(ticketId, email);

    return reply.code(200).send({
      success: true,
      output: result.output,
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

    return reply
      .code(500)
      .send({ success: false, error: 'internal server error' });
  }
};

export default handler;
