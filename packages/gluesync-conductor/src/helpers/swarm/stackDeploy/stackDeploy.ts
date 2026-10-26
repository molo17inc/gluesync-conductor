import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getLogger } from '../../../utils/logger';
import parseEnvFile from '../parseEnvFile/parseEnvFile';
import runDockerCli from '../runDockerCli/runDockerCli';
import { StackDeploy } from './stackDeploy.model';

const DEPLOY_TIMEOUT_MS = 120_000;

// `docker stack deploy` does not read `.env` (compose does), so the variables
// it interpolates have to be in its environment
const readEnvFile = async (
  envFilePath?: string,
): Promise<Readonly<Record<string, string>>> => {
  if (!envFilePath) {
    return {};
  }

  try {
    return parseEnvFile(await readFile(envFilePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

/**
 * Creates or updates the services of a stack from its file. `--detach=true`
 * returns once the services are created, convergence is waited for through the
 * API; `--resolve-image always` makes the manager look the tags up so tasks
 * start from the images the file names.
 */
const stackDeploy: StackDeploy = async (
  namespace,
  stackFilePath,
  envFilePath,
) => {
  const logger = getLogger();

  const { exitCode, output } = await runDockerCli(
    [
      'stack',
      'deploy',
      '--detach=true',
      '--resolve-image',
      'always',
      '-c',
      stackFilePath,
      namespace,
    ],
    {
      // Relative `file:` secrets and configs resolve against it
      cwd: dirname(stackFilePath),
      // The .env wins over what the Conductor itself runs with: it is the
      // stack's own configuration
      env: { ...process.env, ...(await readEnvFile(envFilePath)) },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    },
  );

  if (exitCode !== 0) {
    throw new Error(
      `docker stack deploy ${namespace} failed (exit ${exitCode}): ${output.trim()}`,
    );
  }

  logger.info({ namespace, output: output.trim() }, '[swarm] stack deployed');

  return output;
};

export default stackDeploy;
