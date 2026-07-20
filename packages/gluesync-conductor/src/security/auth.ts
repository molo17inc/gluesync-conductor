import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { type CurrentUser } from './types';
import {
  UserRole,
  canManageSchedules,
  canControlSchedules,
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

const isBypassPath = (url: string): boolean => {
  const path = url.split('?')[0];
  if (BYPASS_PATHS.has(path)) {
    return true;
  }
  const found = [...BYPASS_PATHS].some(
    bypassPath => bypassPath.endsWith('/') && path.startsWith(bypassPath),
  );
  return found;
};

// eslint-disable-next-line functional/no-mixed-types
export interface AuthenticatedRequest extends FastifyRequest {
  currentUser?: CurrentUser;
}

const authPlugin = async (
  fastify: Readonly<FastifyInstance>,
): Promise<void> => {
  fastify.addHook(
    'onRequest',
    // eslint-disable-next-line functional/prefer-immutable-types
    async (req: AuthenticatedRequest, reply: FastifyReply) => {
      if (isBypassPath(req.url)) {
        return undefined;
      }

      if (failOpenEnabled()) {
        const logger = getLogger();
        logger.warn(
          'CONDUCTOR_AUTH_FAIL_OPEN is enabled — bypassing authentication. ' +
            'This MUST NOT be set in production.',
        );
        // eslint-disable-next-line functional/immutable-data
        req.currentUser = {
          username: '__fail_open__',
          role: UserRole.SUPER_ADMIN,
        };
        return undefined;
      }

      const cookieHeader = req.headers.cookie;
      const authorizationHeader = req.headers.authorization;

      const introspector = getIntrospector();
      // eslint-disable-next-line functional/no-let
      let user: CurrentUser | null;
      try {
        user = await introspector.introspect({
          cookieHeader,
          authorizationHeader,
        });
      } catch (error: unknown) {
        const logger = getLogger();
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Conductor auth introspection failed',
        );
        return reply.code(401).send({
          success: false,
          error: 'Authentication verification failed',
        });
      }

      if (user === null) {
        return reply.code(401).send({
          success: false,
          error: 'Not authenticated',
        });
      }

      // eslint-disable-next-line functional/immutable-data
      req.currentUser = user;
      return undefined;
    },
  );
};

export default fp(authPlugin, {
  name: 'conductor-auth',
  encapsulate: false,
});

export const requireManage =
  // eslint-disable-next-line functional/prefer-immutable-types
  () => async (req: AuthenticatedRequest, reply: FastifyReply) => {
    const user = req.currentUser;
    if (!user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }
    if (!canManageSchedules(user.role)) {
      return reply.code(403).send({
        success: false,
        error: `Role ${user.role} cannot manage schedules`,
      });
    }
    return undefined;
  };

export const requireControl =
  // eslint-disable-next-line functional/prefer-immutable-types
  () => async (req: AuthenticatedRequest, reply: FastifyReply) => {
    const user = req.currentUser;
    if (!user) {
      return reply.code(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }
    if (!canControlSchedules(user.role)) {
      return reply.code(403).send({
        success: false,
        error: `Role ${user.role} cannot control schedules`,
      });
    }
    return undefined;
  };

export const requireConfig =
  // eslint-disable-next-line functional/prefer-immutable-types
  () => async (req: AuthenticatedRequest, reply: FastifyReply) => {
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
