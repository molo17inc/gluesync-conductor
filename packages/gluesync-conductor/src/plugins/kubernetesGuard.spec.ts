import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';

import loadWithStubs from '../testing/loadWithStubs';
import agentRoutes from '../routes/agents';
import containerRoutes from '../routes/containers';
import disasterRecoveryRoutes from '../routes/disasterRecovery';
import envRoutes from '../routes/env';
import migrateRoutes from '../routes/migrate';
import serviceRoutes from '../routes/services';
import supportRoutes from '../routes/support';
import systemRoutes from '../routes/system';

type Subject = Readonly<{
  default: FastifyPluginAsync;
  KUBERNETES_SUPPORTED_ROUTES: ReadonlySet<string>;
}>;

const load = (kubernetes: boolean): Subject =>
  loadWithStubs<Subject>(path.resolve(__dirname, './kubernetesGuard'), {
    [path.resolve(
      __dirname,
      '../helpers/orchestrator/getKubernetesOrchestrator/getKubernetesOrchestrator',
    )]: {
      default: () =>
        kubernetes ? { mode: 'kubernetes', namespace: 'kit' } : undefined,
    },
  });

// Plain routes with the patterns of the real ones, answering 200
const buildPlain = async (kubernetes: boolean) => {
  const app = fastify();
  await app.register(load(kubernetes).default);
  [
    '/health',
    '/info',
    '/containers',
    '/services/:id',
    '/services/:id/version/:releaseChannel?',
    '/agents/:id/version/:releaseChannel?',
    '/compose-to-json',
    '/docs',
    '/docs/static/x.css',
    '/openapi.json',
  ].forEach(url => app.get(url, async () => ({ ok: true })));
  app.post(
    '/containers',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'ids'],
          properties: { action: { type: 'string', enum: ['update'] } },
        },
      },
    },
    async () => ({ ok: true }),
  );
  await app.ready();

  return app;
};

type Route = Readonly<{ method: string; url: string }>;

// The real route modules, behind the guard. Their handlers would reach for
// Docker and the compose file: a refused request must never get to them.
const buildReal = async () => {
  const routes: Route[] = [];
  // What was asked of the Docker client (Fastify itself looks for an accessor)
  const dockerUses: string[] = [];
  const app = fastify();
  app.decorate(
    'docker',
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property !== 'getter' && property !== 'setter') {
            dockerUses.push(String(property));
          }
          return undefined;
        },
      },
    ) as never,
  );
  app.addHook('onRoute', route => {
    [route.method].flat().forEach(method => {
      if (method !== 'HEAD') {
        routes.push({ method, url: route.url });
      }
    });
  });
  // Any role: the guard answers before the role checks of the routes
  app.addHook('onRequest', async req => {
    Object.assign(req, { currentUser: { username: 'u', role: 'VIEWER' } });
  });
  await app.register(load(true).default);
  await Promise.all(
    [
      systemRoutes,
      serviceRoutes,
      containerRoutes,
      agentRoutes,
      supportRoutes,
      migrateRoutes,
      envRoutes,
      disasterRecoveryRoutes,
    ].map(routesPlugin => app.register(routesPlugin as never)),
  );
  await app.ready();

  return { app, routes, dockerUses };
};

const concrete = (url: string): string =>
  url.replace(':id', 'gluesync-core-hub').replace('/:releaseChannel?', '/ga');

const inject = (app: FastifyInstance, { method, url }: Route, body?: object) =>
  app.inject({
    method: method as 'GET',
    url: concrete(url),
    ...(body ? { payload: body } : {}),
  });

describe('kubernetesGuard', () => {
  it('answers 501 with the route and the diagnosis for a route that is not served yet', async () => {
    const app = await buildPlain(true);

    const response = await app.inject({
      method: 'GET',
      url: '/compose-to-json',
    });
    const body = response.json();

    assert.equal(response.statusCode, 501);
    assert.equal(body.success, false);
    assert.equal(
      body.error,
      'GET /compose-to-json is not supported on Kubernetes yet',
    );
    assert.equal(typeof body.details, 'string');
    assert.equal(body.diagnosis.code, 'KUBERNETES_UNSUPPORTED');
    assert.equal(body.diagnosis.owner, 'local');
    assert.deepEqual(body.diagnosis.params, {
      feature: 'GET /compose-to-json',
    });
    await app.close();
  });

  it('names the action of a container request, and the route pattern rather than the id', async () => {
    const app = await buildPlain(true);

    const update = await app.inject({
      method: 'POST',
      url: '/containers?x=1',
      payload: { action: 'update', ids: ['gluesync-core-hub'] },
    });
    const agent = await app.inject({
      method: 'GET',
      url: '/agents/gluesync-core-hub/version/ga',
    });

    assert.equal(update.statusCode, 501);
    assert.equal(
      update.json().error,
      'POST /containers (update) is not supported on Kubernetes yet',
    );
    assert.equal(agent.statusCode, 501);
    assert.equal(
      agent.json().error,
      'GET /agents/:id/version/:releaseChannel? is not supported on Kubernetes yet',
    );
    await app.close();
  });

  it('refuses before the body is validated, so a wrong body is a 501 too', async () => {
    const app = await buildPlain(true);

    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/containers', payload: { ids: 1 } }),
      app.inject({
        method: 'POST',
        url: '/containers',
        payload: { action: 'bogus', ids: [] },
      }),
      app.inject({ method: 'POST', url: '/containers' }),
    ]);

    assert.deepEqual(
      responses.map(r => [r.statusCode, r.json().error]),
      [
        [501, 'POST /containers is not supported on Kubernetes yet'],
        [501, 'POST /containers (bogus) is not supported on Kubernetes yet'],
        [501, 'POST /containers is not supported on Kubernetes yet'],
      ],
    );
    await app.close();
  });

  it('lets the read-only routes, their HEAD, the docs and an unknown path through', async () => {
    const app = await buildPlain(true);

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/info' }),
      app.inject({ method: 'GET', url: '/containers?type=all' }),
      app.inject({ method: 'HEAD', url: '/containers' }),
      app.inject({ method: 'GET', url: '/services/gluesync-core-hub' }),
      app.inject({ method: 'GET', url: '/services/gluesync-core-hub/version' }),
      app.inject({
        method: 'GET',
        url: '/services/gluesync-core-hub/version/beta',
      }),
      app.inject({ method: 'GET', url: '/docs' }),
      app.inject({ method: 'GET', url: '/docs/static/x.css' }),
      app.inject({ method: 'GET', url: '/openapi.json' }),
      app.inject({ method: 'GET', url: '/does-not-exist' }),
      app.inject({ method: 'POST', url: '/does-not-exist' }),
    ]);

    assert.deepEqual(
      responses.map(r => r.statusCode),
      [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404, 404],
    );
    await app.close();
  });

  it('does nothing in compose and swarm', async () => {
    const app = await buildPlain(false);

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/compose-to-json' }),
      app.inject({ method: 'GET', url: '/agents/x/version' }),
      app.inject({
        method: 'POST',
        url: '/containers',
        payload: { action: 'update', ids: [] },
      }),
      // Validation is back in charge
      app.inject({ method: 'POST', url: '/containers', payload: { ids: [] } }),
    ]);

    assert.deepEqual(
      responses.map(r => r.statusCode),
      [200, 200, 200, 400],
    );
    await app.close();
  });

  describe('over the real routes', () => {
    it('serves exactly the routes of the allowlist, all of which exist', async () => {
      const { app, routes } = await buildReal();
      const registered = new Set(routes.map(r => `${r.method} ${r.url}`));
      const { KUBERNETES_SUPPORTED_ROUTES } = load(true);

      assert.deepEqual(
        [...KUBERNETES_SUPPORTED_ROUTES].filter(
          route => !registered.has(route),
        ),
        [],
      );
      assert.deepEqual(
        [...registered]
          .filter(route => !KUBERNETES_SUPPORTED_ROUTES.has(route))
          .sort(),
        [
          'GET /agents/:id/version/:releaseChannel?',
          'GET /compose-to-json',
          'GET /env/legacy-update',
          'POST /collect-logs',
          'POST /containers',
          'POST /disaster-recovery/disable',
          'POST /disaster-recovery/setup/first',
          'POST /disaster-recovery/setup/join',
          'POST /disaster-recovery/setup/pairing-code',
          'POST /migrate-to-two',
          'POST /services',
          'PUT /env/legacy-update',
          'PUT /services',
        ],
      );
      await app.close();
    });

    it('answers 501 for every route that is not served, without touching Docker', async () => {
      const { app, routes, dockerUses } = await buildReal();
      const { KUBERNETES_SUPPORTED_ROUTES } = load(true);
      const refused = routes.filter(
        r => !KUBERNETES_SUPPORTED_ROUTES.has(`${r.method} ${r.url}`),
      );

      const responses = await Promise.all(
        refused.map(async route => {
          const response = await inject(
            app,
            route,
            route.method === 'GET' ? undefined : {},
          );
          return {
            route: `${route.method} ${route.url}`,
            status: response.statusCode,
            error: response.json().error,
            code: response.json().diagnosis?.code,
          };
        }),
      );

      assert.deepEqual(
        responses,
        refused.map(route => ({
          route: `${route.method} ${route.url}`,
          status: 501,
          error: `${route.method} ${route.url} is not supported on Kubernetes yet`,
          code: 'KUBERNETES_UNSUPPORTED',
        })),
      );
      assert.deepEqual(dockerUses, []);
      await app.close();
    });

    it('answers 501 for every container action', async () => {
      const { app } = await buildReal();
      const actions = [
        'kill',
        'pull',
        'remove',
        'removeNetwork',
        'restart',
        'start',
        'stop',
        'update',
        'undeploy',
      ];

      const responses = await Promise.all(
        actions.map(action =>
          app.inject({
            method: 'POST',
            url: '/containers',
            payload: { action, ids: ['gluesync-core-hub'] },
          }),
        ),
      );

      assert.deepEqual(
        responses.map(r => [r.statusCode, r.json().error]),
        actions.map(action => [
          501,
          `POST /containers (${action}) is not supported on Kubernetes yet`,
        ]),
      );
      await app.close();
    });
  });
});
