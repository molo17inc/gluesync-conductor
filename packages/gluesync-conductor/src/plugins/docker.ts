import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import Docker from 'dockerode';
import * as os from 'os';
import * as fs from 'fs';
import { getDocker } from '../utils/docker/resilientDocker';
import { dockerSafeCall } from '../utils/docker/dockerSafeCall';
import { waitForDockerDaemon } from '../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';

const dockerPlugin = async (fastify: Readonly<FastifyInstance>) => {
  try {
    let docker: Docker;

    if (process.env.DOCKER_HOST) {
      fastify.log.info(
        `Using Docker host from environment: ${process.env.DOCKER_HOST}`,
      );
      docker = new Docker();
    } else if (os.platform() === 'darwin') {
      const possibleSocketPaths = [
        '/var/run/docker.sock',
        `${os.homedir()}/Library/Containers/com.docker.docker/Data/docker.sock`,
        '/Users/Shared/docker.sock',
        `${os.homedir()}/.docker/run/docker.sock`,
      ];

      const socketPath = possibleSocketPaths.find(path => fs.existsSync(path));

      if (socketPath) {
        fastify.log.info(`Using Docker socket at: ${socketPath}`);
        docker = new Docker({ socketPath });
      } else {
        fastify.log.warn(
          'Could not find Docker socket on macOS, using default configuration',
        );
        docker = new Docker();
      }
    } else if (os.platform() === 'win32') {
      fastify.log.info(
        'Using Windows Docker named pipe: \\\\.\\pipe\\docker_engine',
      );
      docker = getDocker(); // resilient Windows client
    } else {
      // Default for Linux
      fastify.log.info(
        'Using default Docker socket path: /var/run/docker.sock',
      );
      docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    // Wait for Docker daemon to be ready
    await dockerSafeCall(async d =>
      waitForDockerDaemon(d, fastify.log, {
        totalTimeoutMs: 15000,
        perAttemptTimeoutMs: 1500,
      }),
    );

    // Decorate Fastify instance
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
