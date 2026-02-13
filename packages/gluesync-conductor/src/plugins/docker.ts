import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import Docker from 'dockerode';
import * as os from 'os';
import * as fs from 'fs';
import { getDocker } from '../utils/docker/resilientDocker';
import dockerSafeCall from '../utils/docker/dockerSafeCall';
import { waitForDockerDaemon } from '../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';

const dockerPlugin = async (fastify: Readonly<FastifyInstance>) => {
  try {
    const docker: Docker = (() => {
      if (process.env.DOCKER_HOST) {
        fastify.log.info(
          `Using Docker host from environment: ${process.env.DOCKER_HOST}`,
        );
        return new Docker();
      }

      if (os.platform() === 'darwin') {
        const possibleSocketPaths = [
          '/var/run/docker.sock',
          `${os.homedir()}/Library/Containers/com.docker.docker/Data/docker.sock`,
          '/Users/Shared/docker.sock',
          `${os.homedir()}/.docker/run/docker.sock`,
        ] as const;

        const socketPath = possibleSocketPaths.find(path =>
          fs.existsSync(path),
        );

        if (socketPath) {
          fastify.log.info(`Using Docker socket at: ${socketPath}`);
          return new Docker({ socketPath });
        }

        fastify.log.warn(
          'Could not find Docker socket on macOS, using default configuration',
        );
        return new Docker();
      }

      if (os.platform() === 'win32') {
        fastify.log.info(
          'Using Windows Docker named pipe: \\\\.\\pipe\\docker_engine',
        );
        return getDocker(); // resilient Windows client
      }

      // Linux default
      fastify.log.info(
        'Using default Docker socket path: /var/run/docker.sock',
      );
      return new Docker({ socketPath: '/var/run/docker.sock' });
    })();

    await dockerSafeCall(async d =>
      waitForDockerDaemon(d, fastify.log, {
        totalTimeoutMs: 15000,
        perAttemptTimeoutMs: 1500,
      }),
    );

    fastify.decorate('docker', docker);
    fastify.decorate('dockerSafeCall', dockerSafeCall);

    fastify.log.info('Production-safe Docker plugin registered');
  } catch (error) {
    fastify.log.error(
      `Error initializing Docker plugin: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
};

export default fp(dockerPlugin);
