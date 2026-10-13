import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { type CurrentUser } from './types';
import {
  UserRole,
  canManage,
  canControl,
  canModifyConfiguration,
} from './userRole';
import { getIntrospector } from './corehubIntrospect';
import { getLogger } from '../utils/logger';

const BYPASS_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/docs',
  '/docs/',
  '/openapi.json',
  '/documentation',
  '/documentation/',
]);

const failOpenEnabled = (): boolean =>
  process.env.CONDUCTOR_AUTH_FAIL_OPEN?.toLowerCase() === 'true';

const isBypassPath = (url: Readonly<string>): boolean => {
  const path = url.split('?')[0];
  if (BYPASS_PATHS.has(path)) {
    return true;
  }
  const found = [...BYPASS_PATHS].some(
    bypassPath => bypassPath.endsWith('/') && path.startsWith(bypassPath),
  );
  return found;
};

export interface AuthenticatedRequest extends FastifyRequest {
  currentUser?: CurrentUser;
}

const authPlugin = async (
  fastify: Readonly<FastifyInstance>,
): Promise<void> => {
  fastify.addHook(
    'onRequest',
    async (
      req: Readonly<AuthenticatedRequest>,
      reply: Readonly<FastifyReply>,
    ) => {
      if (isBypassPath(req.url)) {
        return undefined;
      }

      if (failOpenEnabled()) {
        const logger = getLogger();
        logger.warn(
          'CONDUCTOR_AUTH_FAIL_OPEN is enabled — bypassing authentication. ' +
            'This MUST NOT be set in production.',
        );
        Reflect.set(req, 'currentUser', {
          username: '__fail_open__',
          role: UserRole.SUPER_ADMIN,
        });
        return undefined;
      }

      const cookieHeader = req.headers.cookie;
      const authorizationHeader = req.headers.authorization;

      const introspector = getIntrospector();
      const authResult = await (async (): Promise<
        { error: string } | { user: CurrentUser | null }
      > => {
        try {
          return {
            user: await introspector.introspect({
              cookieHeader,
              authorizationHeader,
            }),
          };
        } catch (error: unknown) {
          const logger = getLogger();
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            { error: message },
            'Conductor auth introspection failed',
          );
          return { error: message };
        }
      })();

      if ('error' in authResult) {
        return reply.code(503).send({
          success: false,
          error: 'CoreHub unavailable',
          details: authResult.error,
        });
      }

      if (authResult.user === null) {
        return reply.code(401).send({
          success: false,
          error: 'Not authenticated',
        });
      }

      Reflect.set(req, 'currentUser', authResult.user);
      return undefined;
    },
  );
};

export default fp(authPlugin, {
  name: 'conductor-auth',
  encapsulate: false,
});

export const requireManage =
  () =>
  async (
    req: Readonly<AuthenticatedRequest>,
    reply: Readonly<FastifyReply>,
  ) => {
    const user = req.currentUser;
    if (!user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }
    if (!canManage(user.role)) {
      return reply.code(403).send({
        success: false,
        error: `Role ${user.role} cannot manage`,
      });
    }
    return undefined;
  };

export const requireControl =
  () =>
  async (
    req: Readonly<AuthenticatedRequest>,
    reply: Readonly<FastifyReply>,
  ) => {
    const user = req.currentUser;
    if (!user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }
    if (!canControl(user.role)) {
      return reply.code(403).send({
        success: false,
        error: `Role ${user.role} cannot control`,
      });
    }
    return undefined;
  };

export const requireConfig =
  () =>
  async (
    req: Readonly<AuthenticatedRequest>,
    reply: Readonly<FastifyReply>,
  ) => {
    const user = req.currentUser;
    if (!user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }
    if (!canModifyConfiguration(user.role)) {
      return reply.code(403).send({
        success: false,
        error: `Role ${user.role} cannot modify configuration`,
      });
    }
    return undefined;
  };

// Day-to-day operations a MONITOR may run, like starting and stopping
// replication. Everything else (update, pull, kill, remove, undeploy, network
// cleanup) changes what is deployed and needs a role that can manage: the UI
// only offers those actions to SUPER_ADMIN and MANAGER, and Chronos calls in as
// EXTERNAL_MODULE.
const OPERATIONAL_CONTAINER_ACTIONS: ReadonlySet<string> = new Set([
  'restart',
  'start',
  'stop',
]);

export const requireContainerAction =
  () =>
  async (
    req: Readonly<AuthenticatedRequest>,
    reply: Readonly<FastifyReply>,
  ) => {
    const action = String((req.body as { action?: unknown })?.action ?? '');
    const guard = OPERATIONAL_CONTAINER_ACTIONS.has(action)
      ? requireControl()
      : requireManage();
    return guard(req, reply);
  };
