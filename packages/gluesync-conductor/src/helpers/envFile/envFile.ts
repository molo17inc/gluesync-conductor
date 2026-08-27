import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';

import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import getRootPath from '../getRootPath/getRootPath';

import {
  DisableLegacyUpdate,
  EnableLegacyUpdate,
  GetEnvFilePath,
  IsLegacyUpdateEnabled,
  ReadEnvFile,
  WriteEnvFile,
} from './envFile.model';

const CONDUCTOR_SERVICE = process.env.CONDUCTOR_NAME || 'gluesync-conductor';
const LEGACY_UPDATE_KEY = 'GS_LEGACY_TLS';

type EnvFileCandidate = Readonly<{
  path: string;
  required: boolean;
}>;

const canonicalizePath = (path: string): string =>
  path.replace(/\\+/g, '/').trim();

const normalizeEnvFile = (
  envFile: unknown,
): ReadonlyArray<EnvFileCandidate> => {
  if (!envFile) {
    return [];
  }

  if (Array.isArray(envFile)) {
    return envFile.map<EnvFileCandidate>(entry => {
      if (typeof entry === 'string') {
        return { path: canonicalizePath(entry), required: true };
      }

      const element = entry as { path?: string; required?: boolean };

      return {
        path: canonicalizePath(element.path ?? ''),
        required: element.required ?? true,
      };
    });
  }

  if (typeof envFile === 'string') {
    return [{ path: canonicalizePath(envFile), required: true }];
  }

  const element = envFile as { path?: string; required?: boolean };

  return [
    {
      path: canonicalizePath(element.path ?? ''),
      required: element.required ?? true,
    },
  ];
};

const getEnvFilePath: GetEnvFilePath = async () => {
  try {
    const composeFile = await readComposeFile({ raw: true });
    const envFile = composeFile.services?.[CONDUCTOR_SERVICE]?.env_file;
    const candidates = normalizeEnvFile(envFile);
    const existing = candidates.find(({ path }) => existsSync(path));

    if (existing) {
      return existing.path;
    }
  } catch {
    // fall back to the project-root .env if we cannot read the compose file
  }

  return getRootPath({ filename: '.env' });
};

const isActiveLegacyUpdateLine = (line: string): boolean => {
  const trimmed = line.trim();

  return (
    !trimmed.startsWith('#') && trimmed.startsWith(`${LEGACY_UPDATE_KEY}=`)
  );
};

const readEnvFile: ReadEnvFile = async () => {
  try {
    const content = await readFile(await getEnvFilePath(), 'utf8');

    return content.split('\n');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const writeEnvFile: WriteEnvFile = async lines => {
  const content = lines.join('\n');
  const normalized = content.endsWith('\n') ? content : `${content}\n`;

  await writeFile(await getEnvFilePath(), normalized, 'utf8');
};

const isLegacyUpdateEnabled: IsLegacyUpdateEnabled = lines =>
  lines.some(isActiveLegacyUpdateLine);

const enableLegacyUpdate: EnableLegacyUpdate = lines => {
  if (lines.length === 0) {
    return [`${LEGACY_UPDATE_KEY}=2`];
  }

  const index = lines.findIndex(isActiveLegacyUpdateLine);

  if (index >= 0) {
    return lines;
  }

  return [...lines, `${LEGACY_UPDATE_KEY}=2`];
};

const disableLegacyUpdate: DisableLegacyUpdate = lines =>
  lines.filter(line => !isActiveLegacyUpdateLine(line));

export {
  getEnvFilePath,
  readEnvFile,
  writeEnvFile,
  isLegacyUpdateEnabled,
  enableLegacyUpdate,
  disableLegacyUpdate,
};
