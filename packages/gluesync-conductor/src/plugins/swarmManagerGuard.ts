import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import getOrchestrator, {
  isSwarmRefusedOnPodman,
} from '../helpers/orchestrator/getOrchestrator/getOrchestrator';
import buildDiagnosis from '../diagnosis/buildDiagnosis';

// Answered without the Swarm API, so they work on a worker too
const ALWAYS_ALLOWED: ReadonlyArray<string> = [
  '/health',
  '/docs',
  '/openapi.json',
  '/documentation',
];

const isAlwaysAllowed = (url: string): boolean => {
  const path = url.split('?')[0];

  return ALWAYS_ALLOWED.some(
    allowed => path === allowed || path.startsWith(`${allowed}/`),
  );
};

/**
 * Services, tasks and service logs only answer on a swarm manager. A Conductor
 * that landed on a worker says so instead of failing in every route. Swarm
 * asked for on Podman, which has none, is refused the same way.
 */
const swarmManagerGuardPlugin = (
  fastify: Readonly<FastifyInstance>,
  _opts: unknown,
  done: (err?: Readonly<Error>) => void,
): void => {
  fastify.addHook('onRequest', async (req, reply) => {
    if (isAlwaysAllowed(req.url)) {
      return;
    }

    if (await isSwarmRefusedOnPodman(fastify.docker)) {
      await reply.code(501).send({
        success: false,
        error: 'Docker Swarm is not available on Podman',
        message:
          'CONDUCTOR_ORCHESTRATOR=swarm was asked for, but this engine is Podman, which has no Swarm mode. Run Gluesync with Compose.',
        diagnosis: buildDiagnosis({ code: 'SWARM_UNSUPPORTED_ON_PODMAN' }),
      });
      return;
    }

    const orchestrator = await getOrchestrator(fastify.docker);

    if (orchestrator.mode === 'swarm' && !orchestrator.isManager) {
      await reply.code(503).send({
        success: false,
        error: 'Conductor is not running on a swarm manager',
        message:
          'Docker Swarm services can only be managed from a manager node. Run Conductor on a manager.',
        diagnosis: buildDiagnosis({ code: 'SWARM_NOT_MANAGER' }),
      });
    }
  });

  done();
};

// Wrap with fastify-plugin to disable encapsulation
export default fp(swarmManagerGuardPlugin, {
  name: 'swarm-manager-guard',
  encapsulate: false,
});
