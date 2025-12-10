import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

// isUpdateMode state
const cell = new Map<string, boolean>([['value', false]]);

export const enableUpdateMode = (): void => {
  console.log('[CONDUCTOR-UPDATE] enableUpdateMode called');
  cell.set('value', true);
};

export const disableUpdateMode = (): void => {
  console.log('[CONDUCTOR-UPDATE] disableUpdateMode called');
  cell.set('value', false);
};

export const isUpdateMode = (): boolean => cell.get('value') ?? false;

type ApiBlockerOptions = {
  statusCode?: number;
  message?: string;
};
const apiBlockerAsUpdatingPlugin = (
  fastify: Readonly<FastifyInstance>,
  opts: Readonly<ApiBlockerOptions>,
  done: (err?: Readonly<Error>) => void,
): void => {
  const statusCode = opts.statusCode ?? 503;
  const message =
    opts.message ??
    'Conductor is currently updating and will be back online soon';

  fastify.log.info('[CONDUCTOR-UPDATE] blocker plugin registered');

  fastify.addHook('onRequest', async (req, reply) => {
    if (isUpdateMode()) {
      reply.header('Retry-After', '60').code(statusCode).send({
        success: false,
        error: 'Conductor update in progress',
        message,
      });
    }
  });

  done();
};

// Wrap with fastify-plugin to disable encapsulation
export default fp(apiBlockerAsUpdatingPlugin, {
  name: 'api-blocker',
  encapsulate: false,
});
