import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

import authPlugin, {
  requireConfig,
  requireContainerAction,
  requireControl,
  requireManage,
} from './auth';
import { type Introspector, setIntrospector } from './corehubIntrospect';
import type { CurrentUser } from './types';

const run = async (role: string, action: string): Promise<number | null> => {
  const sent = new Map<string, number>();
  const reply = {
    code(c: number) {
      sent.set('code', c);
      return this;
    },
    send() {
      return this;
    },
  };
  await requireContainerAction()(
    { currentUser: { username: 'u', role }, body: { action } } as never,
    reply as never,
  );
  return sent.get('code') ?? null;
};

describe('requireContainerAction', () => {
  it('lets MONITOR restart, start and stop', async () => {
    assert.equal(await run('MONITOR', 'restart'), null);
    assert.equal(await run('MONITOR', 'start'), null);
    assert.equal(await run('MONITOR', 'stop'), null);
  });

  it('keeps MONITOR away from update, kill, remove and undeploy', async () => {
    const actions = [
      'update',
      'kill',
      'remove',
      'undeploy',
      'pull',
      'removeNetwork',
    ];
    const codes = await Promise.all(
      actions.map(action => run('MONITOR', action)),
    );
    assert.deepEqual(
      codes,
      actions.map(() => 403),
    );
  });

  it('lets managers and external modules (Chronos) update', async () => {
    assert.equal(await run('MANAGER', 'update'), null);
    assert.equal(await run('SUPER_ADMIN', 'update'), null);
    assert.equal(await run('EXTERNAL_MODULE', 'update'), null);
  });

  it('keeps VIEWER away from every action', async () => {
    assert.equal(await run('VIEWER', 'restart'), 403);
  });
});

type Guard = ReturnType<typeof requireManage>;

type Outcome = Readonly<{ code: number | null; body: unknown }>;

const guard = async (
  middleware: Guard,
  user: CurrentUser | undefined,
): Promise<Outcome> => {
  const sent: { code: number | null; body: unknown } = {
    code: null,
    body: undefined,
  };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  await middleware({ currentUser: user } as never, reply as never);

  return sent;
};

const as = (role: string): CurrentUser => ({ username: 'u', role }) as never;

describe('role guards', () => {
  const cases: ReadonlyArray<
    Readonly<{
      name: string;
      middleware: () => Guard;
      allowed: ReadonlyArray<string>;
      denied: ReadonlyArray<string>;
      message: string;
    }>
  > = [
    {
      name: 'requireManage',
      middleware: requireManage,
      allowed: ['SUPER_ADMIN', 'MANAGER', 'EXTERNAL_MODULE'],
      denied: ['MONITOR', 'VIEWER'],
      message: 'cannot manage',
    },
    {
      name: 'requireControl',
      middleware: requireControl,
      allowed: ['SUPER_ADMIN', 'MANAGER', 'MONITOR', 'EXTERNAL_MODULE'],
      denied: ['VIEWER'],
      message: 'cannot control',
    },
    {
      name: 'requireConfig',
      middleware: requireConfig,
      allowed: ['SUPER_ADMIN', 'MANAGER'],
      denied: ['MONITOR', 'VIEWER', 'EXTERNAL_MODULE'],
      message: 'cannot modify configuration',
    },
  ];

  cases.forEach(({ name, middleware, allowed, denied, message }) => {
    describe(name, () => {
      it('answers 401 without a current user', async () => {
        const outcome = await guard(middleware(), undefined);

        assert.equal(outcome.code, 401);
        assert.deepEqual(outcome.body, {
          success: false,
          error: 'Not authenticated',
        });
      });

      it('lets the allowed roles through', async () => {
        const outcomes = await Promise.all(
          allowed.map(role => guard(middleware(), as(role))),
        );

        assert.deepEqual(
          outcomes.map(o => o.code),
          allowed.map(() => null),
        );
      });

      it('answers 403 naming the role for the others', async () => {
        const outcomes = await Promise.all(
          denied.map(role => guard(middleware(), as(role))),
        );

        assert.deepEqual(
          outcomes.map(o => o.code),
          denied.map(() => 403),
        );
        assert.deepEqual(outcomes[0].body, {
          success: false,
          error: `Role ${denied[0]} ${message}`,
        });
      });
    });
  });
});

const fakeIntrospector = (
  introspect: Introspector['introspect'],
): Introspector => ({ introspect }) as unknown as Introspector;

const buildApp = async () => {
  const app = Fastify();
  await app.register(authPlugin);
  app.get('/health', async () => ({ ok: true }));
  app.get('/docs/static/x', async () => ({ ok: true }));
  app.get('/whoami', async req => ({
    user: (req as unknown as { currentUser?: CurrentUser }).currentUser,
  }));

  return app;
};

describe('authPlugin', () => {
  afterEach(() => {
    mock.restoreAll();
    setIntrospector(null);
    delete process.env.CONDUCTOR_AUTH_FAIL_OPEN;
  });

  it('skips authentication on the bypass paths', async () => {
    setIntrospector(
      fakeIntrospector(() => {
        throw new Error('must not be called');
      }),
    );
    const app = await buildApp();

    assert.equal((await app.inject('/health?x=1')).statusCode, 200);
    assert.equal((await app.inject('/docs/static/x')).statusCode, 200);
    await app.close();
  });

  it('exposes the introspected user to the routes', async () => {
    setIntrospector(fakeIntrospector(async () => as('MANAGER')));
    const app = await buildApp();

    const response = await app.inject('/whoami');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { user: as('MANAGER') });
    await app.close();
  });

  it('answers 401 when CoreHub does not know the caller', async () => {
    setIntrospector(fakeIntrospector(async () => null));
    const app = await buildApp();

    const response = await app.inject('/whoami');

    assert.equal(response.statusCode, 401);
    await app.close();
  });

  it('answers 503 with a diagnosis when introspection fails', async () => {
    mock.method(console, 'warn', () => undefined);
    setIntrospector(
      fakeIntrospector(async () => {
        throw new Error('boom');
      }),
    );
    const app = await buildApp();

    const response = await app.inject('/whoami');

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'CoreHub unavailable');
    assert.equal(response.json().details, 'boom');
    assert.ok(response.json().diagnosis);
    await app.close();
  });

  it('acts as a super admin when fail-open is enabled', async () => {
    process.env.CONDUCTOR_AUTH_FAIL_OPEN = 'true';
    const app = await buildApp();

    const response = await app.inject('/whoami');

    assert.deepEqual(response.json(), {
      user: { username: '__fail_open__', role: 'SUPER_ADMIN' },
    });
    await app.close();
  });
});
