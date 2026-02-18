import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { getDocker } from '../utils/docker/getDocker';
import dockerSafeCall from '../utils/docker/dockerSafeCall';
import waitForDockerDaemon from '../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import { getLogger } from '../utils/logger';

const dockerPlugin = async (fastify: Readonly<FastifyInstance>) => {
  try {
    // Always use the unified resilient singleton
    const docker = getDocker();
    const logger = getLogger();

    // Wait for Docker daemon (cross‑platform, exponential backoff)
    await dockerSafeCall(async d =>
      waitForDockerDaemon(d, logger, {
        totalTimeoutMs: 15000,
        perAttemptTimeoutMs: 1500,
      }),
    );

    // Expose Docker + safe wrapper to Fastify
    fastify.decorate('docker', docker);
    fastify.decorate('dockerSafeCall', dockerSafeCall);

    fastify.log.info('Docker plugin registered successfully');
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
