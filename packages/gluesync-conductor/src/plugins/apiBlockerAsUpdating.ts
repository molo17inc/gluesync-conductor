import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import updateModeEmitter from './updateModeEmitter';

// isUpdateMode state
const cell = new Map<string, boolean>([['value', false]]);

export const enableUpdateMode = (): void => {
  // if (cell.get('value') ?? true) {
  //   return;
  // }

  console.log('[CONDUCTOR-UPDATE] enableUpdateMode called');
  cell.set('value', true);
  updateModeEmitter.emit('updateModeEnabled');
};

export const disableUpdateMode = (): void => {
  // if (!(cell.get('value') ?? false)) {
  //   return;
  // }

  console.log('[CONDUCTOR-UPDATE] disableUpdateMode called');
  cell.set('value', false);
  updateModeEmitter.emit('updateModeDisabled');
};

export const isUpdateMode = (): boolean => cell.get('value') ?? false;

type ApiBlockerOptions = {
  statusCode?: number;
  message?: string;
  bypassPaths?: string[];
  bypassMethods?: string[];
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

  const bypassPaths = opts.bypassPaths ?? [];
  const bypassMethods = opts.bypassMethods?.map(m => m.toUpperCase()) ?? [];

  fastify.log.info('[CONDUCTOR-UPDATE] blocker plugin registered');

  fastify.addHook('onRequest', async (req, reply) => {
    if (isUpdateMode()) {
      const pathAllowed = bypassPaths.some(
        path => req.url === path || req.url.startsWith(`${path}/`),
      );

      const methodAllowed =
        bypassMethods.length === 0 || bypassMethods.includes(req.method);

      const shouldBypass = pathAllowed && methodAllowed;

      fastify.log.debug(
        `[CONDUCTOR-UPDATE] bypassCheck: pathAllowed=${pathAllowed}, methodAllowed=${methodAllowed}, shouldBypass=${shouldBypass}`,
      );

      if (!shouldBypass) {
        reply.header('Retry-After', '60').code(statusCode).send({
          success: false,
          error: 'Conductor update in progress',
          message,
        });
      }
    }
  });

  done();
};

// Wrap with fastify-plugin to disable encapsulation
export default fp(apiBlockerAsUpdatingPlugin, {
  name: 'api-blocker',
  encapsulate: false,
});
