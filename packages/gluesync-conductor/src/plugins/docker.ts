import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { getDocker } from '../utils/docker/getDocker';
import dockerSafeCall from '../utils/docker/dockerSafeCall';
import waitForDockerDaemon from '../helpers/dockerode/waitForDockerDaemon/waitForDockerDaemon';
import { getLogger } from '../utils/logger';

const dockerPlugin = async (fastify: Readonly<FastifyInstance>) => {
  // Always use the unified resilient singleton
  const docker = getDocker();
  const logger = getLogger();

  try {
    // Wait for Docker daemon (cross‑platform, exponential backoff)
    await dockerSafeCall(async d =>
      waitForDockerDaemon(d, logger, {
        totalTimeoutMs: 15000,
        perAttemptTimeoutMs: 1500,
      }),
    );
    fastify.log.info('Docker plugin registered successfully');
  } catch (error) {
    // Start anyway: Docker calls fail per request (and recover with the
    // daemon) instead of the conductor exiting and crash-looping on a slow host.
    fastify.log.warn(
      { error },
      'Docker daemon not ready at startup; starting anyway, Docker calls will fail until it answers',
    );
  }

  // Expose Docker + safe wrapper to Fastify
  fastify.decorate('docker', docker);
  fastify.decorate('dockerSafeCall', dockerSafeCall);
};

export default fp(dockerPlugin);
