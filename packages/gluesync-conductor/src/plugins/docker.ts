import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import Docker from 'dockerode';
import * as os from 'os';
import * as fs from 'fs';

const dockerPlugin = async (fastify: Readonly<FastifyInstance>) => {
  try {
    // eslint-disable-next-line functional/no-let
    let docker: Docker;

    // Check if DOCKER_HOST environment variable is set
    if (process.env.DOCKER_HOST) {
      fastify.log.info(
        `Using Docker host from environment: ${process.env.DOCKER_HOST}`,
      );
      docker = new Docker();
    } else if (os.platform() === 'darwin') {
      // On macOS, Docker Desktop socket path can be in different locations
      const possibleSocketPaths = [
        '/var/run/docker.sock',
        `${os.homedir()}/Library/Containers/com.docker.docker/Data/docker.sock`,
        '/Users/Shared/docker.sock',
        `${os.homedir()}/.docker/run/docker.sock`,
      ];

      // Find the first socket path that exists
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
    } else {
      // Default for Linux and other platforms
      fastify.log.info(
        'Using default Docker socket path: /var/run/docker.sock',
      );
      docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    // Decorate fastify instance with docker client
    fastify.decorate('docker', docker);

    fastify.log.info('Docker plugin registered');
  } catch (error) {
    fastify.log.error(
      `Error initializing Docker plugin: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
};

export default fp(dockerPlugin);
