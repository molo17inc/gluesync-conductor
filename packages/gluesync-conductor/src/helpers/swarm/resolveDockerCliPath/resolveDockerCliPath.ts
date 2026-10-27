import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// Fixed system directories: a `docker` found through PATH could be one that a
// writable directory of the PATH shadows. DOCKER_CLI_PATH overrides them.
const LINUX_CANDIDATES: ReadonlyArray<string> = [
  '/usr/local/bin/docker',
  '/usr/bin/docker',
  '/bin/docker',
];

// Dockerfile.windows copies the CLI into System32; a Docker Engine installed
// from the static zip keeps it in Program Files
const windowsCandidates = (): ReadonlyArray<string> => [
  win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'docker.exe'),
  win32.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'docker',
    'docker.exe',
  ),
];

const candidates = (): ReadonlyArray<string> =>
  process.platform === 'win32' ? windowsCandidates() : LINUX_CANDIDATES;

const resolveDockerCliPath = (): string => {
  const fixed = candidates();
  const found = [process.env.DOCKER_CLI_PATH, ...fixed]
    .filter((candidate): candidate is string => !!candidate)
    .find(existsSync);

  if (!found) {
    throw new Error(
      `docker CLI not found in ${fixed.join(', ')}; set DOCKER_CLI_PATH`,
    );
  }

  return found;
};

export default resolveDockerCliPath;
