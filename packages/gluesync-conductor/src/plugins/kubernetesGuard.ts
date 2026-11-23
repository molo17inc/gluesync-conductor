import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import getKubernetesOrchestrator from '../helpers/orchestrator/getKubernetesOrchestrator/getKubernetesOrchestrator';
import buildUnsupportedOnKubernetesReply from '../helpers/orchestrator/buildUnsupportedOnKubernetesReply/buildUnsupportedOnKubernetesReply';
import KUBERNETES_CONTAINER_ACTIONS from '../helpers/kubernetes/kubernetesContainerActions';

// The routes the Kubernetes mode serves, by route pattern. Anything else that
// is a route of this API is refused, so a route added later is refused too
// until it is listed here. `POST /containers` is served for the actions of
// KUBERNETES_CONTAINER_ACTIONS only.
export const KUBERNETES_SUPPORTED_ROUTES: ReadonlySet<string> = new Set([
  'GET /health',
  'GET /connectivity',
  'GET /info',
  'GET /version',
  'GET /containers',
  'GET /services',
  'GET /services/:id',
  'GET /services/:id/version/:releaseChannel?',
  // Answers `supported: false` with the reason, as on Docker Swarm
  'GET /disaster-recovery/setup',
]);

// The API documentation, which no orchestrator is asked for
const DOCS_PREFIXES: ReadonlyArray<string> = [
  '/docs',
  '/openapi.json',
  '/documentation',
];

const isDocs = (url: string): boolean => {
  const path = url.split('?')[0];

  return DOCS_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`),
  );
};

// A HEAD is answered by the GET route
const methodOf = (req: Readonly<FastifyRequest>): string =>
  req.method === 'HEAD' ? 'GET' : req.method;

const actionOf = (req: Readonly<FastifyRequest>): string | undefined => {
  const action = (req.body as { action?: unknown } | null | undefined)?.action;

  return typeof action === 'string' && action.trim() ? action : undefined;
};

/** `POST /containers (update)`: the route as registered, with the action of a container request. */
export const describeRequest = (req: Readonly<FastifyRequest>): string => {
  const route = `${methodOf(req)} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
  const action = actionOf(req);

  return action ? `${route} (${action})` : route;
};

const CONTAINER_ACTION_ROUTE = 'POST /containers';

// `POST /containers` with an action the Kubernetes mode runs
const isServedAction = (req: Readonly<FastifyRequest>): boolean =>
  `${methodOf(req)} ${req.routeOptions.url}` === CONTAINER_ACTION_ROUTE &&
  KUBERNETES_CONTAINER_ACTIONS.has(actionOf(req) ?? '');

/**
 * Kubernetes mode serves the read-only routes, and the update and restart
 * actions of `POST /containers`. Every other route of the API
 * answers 501 here, before its handler could reach for the container engine or
 * the compose file, neither of which a pod has. It runs after the body is
 * parsed (so the action can be named) and before validation and the handler.
 * Compose and swarm are not affected.
 */
const kubernetesGuardPlugin = (
  fastify: Readonly<FastifyInstance>,
  _opts: unknown,
  done: (err?: Readonly<Error>) => void,
): void => {
  fastify.addHook('preValidation', async (req, reply) => {
    // An unknown path keeps its 404, a CORS preflight its answer
    const served =
      !getKubernetesOrchestrator() ||
      req.is404 ||
      req.method === 'OPTIONS' ||
      isDocs(req.url) ||
      KUBERNETES_SUPPORTED_ROUTES.has(
        `${methodOf(req)} ${req.routeOptions.url}`,
      ) ||
      isServedAction(req);

    return served
      ? undefined
      : reply
          .code(501)
          .send(buildUnsupportedOnKubernetesReply(describeRequest(req)));
  });

  done();
};

// Wrap with fastify-plugin to disable encapsulation
export default fp(kubernetesGuardPlugin, {
  name: 'kubernetes-guard',
  encapsulate: false,
});
