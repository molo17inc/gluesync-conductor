import { existsSync } from 'node:fs';

// Fixed system directories: a `docker` found through PATH could be one that a
// writable directory of the PATH shadows. DOCKER_CLI_PATH overrides them.
const DOCKER_CLI_CANDIDATES: ReadonlyArray<string> = [
  '/usr/local/bin/docker',
  '/usr/bin/docker',
  '/bin/docker',
];

const resolveDockerCliPath = (): string => {
  const found = [process.env.DOCKER_CLI_PATH, ...DOCKER_CLI_CANDIDATES]
    .filter((candidate): candidate is string => !!candidate)
    .find(existsSync);

  if (!found) {
    throw new Error(
      `docker CLI not found in ${DOCKER_CLI_CANDIDATES.join(', ')}; set DOCKER_CLI_PATH`,
    );
  }

  return found;
};

export default resolveDockerCliPath;
