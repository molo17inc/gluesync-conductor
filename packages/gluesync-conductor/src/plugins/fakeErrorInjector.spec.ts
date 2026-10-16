import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fastify from 'fastify';

import fakeErrorInjectorPlugin, {
  buildFakeErrorReply,
  findFakeError,
  findFakeUpdate,
  parseFakeErrorRules,
  parseFakeUpdateRules,
  withFakeUpdate,
} from './fakeErrorInjector';

const update = (ids: ReadonlyArray<string>) => ({
  method: 'POST',
  path: '/containers',
  body: { action: 'update', ids },
});

describe('parseFakeErrorRules', () => {
  it('reads scope, service and code', () => {
    assert.deepEqual(
      parseFakeErrorRules(
        'update:gluesync-core-hub:MOLO17_HOSTS_BLOCKED, version:*:OTA_SERVICE_DOWN',
      ),
      [
        {
          scope: 'update',
          service: 'gluesync-core-hub',
          code: 'MOLO17_HOSTS_BLOCKED',
        },
        { scope: 'version', service: '*', code: 'OTA_SERVICE_DOWN' },
      ],
    );
  });

  it('drops entries that are wrong instead of failing', () => {
    assert.deepEqual(
      parseFakeErrorRules(
        'oops,update:svc:NOT_A_CODE,restart:svc:UNKNOWN,update::UNKNOWN,update:svc:UNKNOWN:extra,update:svc:UNKNOWN',
      ),
      [{ scope: 'update', service: 'svc', code: 'UNKNOWN' }],
    );
  });

  it('is empty when nothing is set', () => {
    assert.deepEqual(parseFakeErrorRules(undefined), []);
    assert.deepEqual(parseFakeErrorRules(''), []);
  });
});

describe('findFakeError', () => {
  const rules = parseFakeErrorRules(
    'update:gluesync-core-hub:PROXY_UNREACHABLE,version:gluesync-chronos:DNS_FAILURE,update:*:UNKNOWN',
  );

  it('matches the update of a named service', () => {
    assert.equal(
      findFakeError(rules, update(['gluesync-core-hub']))?.code,
      'PROXY_UNREACHABLE',
    );
  });

  it('falls through to a wildcard rule', () => {
    assert.equal(
      findFakeError(rules, update(['gluesync-chronos']))?.code,
      'UNKNOWN',
    );
  });

  it('matches a version check by service id', () => {
    assert.equal(
      findFakeError(rules, {
        method: 'GET',
        path: '/services/gluesync-chronos/version/beta',
        body: undefined,
      })?.code,
      'DNS_FAILURE',
    );
  });

  it('leaves everything else alone', () => {
    const only = parseFakeErrorRules(
      'update:gluesync-core-hub:PROXY_UNREACHABLE',
    );

    assert.equal(findFakeError(only, update(['gluesync-chronos'])), undefined);
    assert.equal(
      findFakeError(only, {
        method: 'POST',
        path: '/containers',
        body: { action: 'restart', ids: ['gluesync-core-hub'] },
      }),
      undefined,
    );
    assert.equal(
      findFakeError(only, {
        method: 'GET',
        path: '/services/gluesync-core-hub/version',
        body: undefined,
      }),
      undefined,
    );
    assert.equal(
      findFakeError(only, {
        method: 'GET',
        path: '/containers',
        body: undefined,
      }),
      undefined,
    );
  });
});

describe('parseFakeUpdateRules', () => {
  it('reads the service and the version to report, 0.0.0 by default', () => {
    assert.deepEqual(
      parseFakeUpdateRules(
        'update:*:OTA_SERVICE_DOWN,available:gluesync-core-hub:2.2.11.10,available:*',
      ),
      [
        { service: 'gluesync-core-hub', currentVersion: '2.2.11.10' },
        { service: '*', currentVersion: '0.0.0' },
      ],
    );
  });

  it('drops entries that are wrong instead of failing', () => {
    assert.deepEqual(
      parseFakeUpdateRules('available,available::1.0,available:svc:1.0:x'),
      [],
    );
  });

  it('is not read as a failure rule', () => {
    assert.deepEqual(parseFakeErrorRules('available:gluesync-core-hub'), []);
  });
});

describe('findFakeUpdate', () => {
  const rules = parseFakeUpdateRules('available:gluesync-core-hub:1.0');

  it('matches the version check of the named service only', () => {
    assert.equal(
      findFakeUpdate(rules, {
        method: 'GET',
        path: '/services/gluesync-core-hub/version/ga',
      })?.currentVersion,
      '1.0',
    );
    assert.equal(
      findFakeUpdate(rules, {
        method: 'GET',
        path: '/services/gluesync-chronos/version',
      }),
      undefined,
    );
    assert.equal(
      findFakeUpdate(rules, { method: 'POST', path: '/containers' }),
      undefined,
    );
  });
});

describe('withFakeUpdate', () => {
  const rule = { service: '*', currentVersion: '1.0' };

  it('replaces the running version and keeps the rest', () => {
    assert.deepEqual(
      withFakeUpdate(
        {
          success: true,
          data: { currentVersion: '2.0', latestVersionGA: '2.0' },
        },
        rule,
      ),
      {
        success: true,
        data: { currentVersion: '1.0', latestVersionGA: '2.0' },
      },
    );
  });

  it('leaves a failed reply alone', () => {
    const failed = { success: false, error: 'down' };

    assert.equal(withFakeUpdate(failed, rule), failed);
    assert.equal(withFakeUpdate(undefined, rule), undefined);
  });
});

describe('buildFakeErrorReply', () => {
  it('answers like the real path: 502 for the customer side, 503 for MOLO17', () => {
    assert.equal(
      buildFakeErrorReply({
        scope: 'update',
        service: '*',
        code: 'PROXY_UNREACHABLE',
      }).statusCode,
      502,
    );
    assert.equal(
      buildFakeErrorReply({
        scope: 'update',
        service: '*',
        code: 'OTA_SERVICE_DOWN',
      }).statusCode,
      503,
    );
  });

  it('carries the diagnosis and says it is fake', () => {
    const { body } = buildFakeErrorReply({
      scope: 'update',
      service: 'svc',
      code: 'MOLO17_HOSTS_BLOCKED',
    });

    assert.equal(body.success, false);
    assert.equal(body.error, 'Failed to do containers action');
    assert.equal(body.diagnosis.code, 'MOLO17_HOSTS_BLOCKED');
    assert.equal(body.diagnosis.owner, 'customer');
    assert.match(body.details, /FAKE error injected/);
  });

  it('never answers a failing request with a 2xx', () => {
    assert.equal(
      buildFakeErrorReply({
        scope: 'version',
        service: '*',
        code: 'CONNECTIVITY_OK',
      }).statusCode,
      502,
    );
  });
});

describe('fakeErrorInjectorPlugin on a real server', () => {
  afterEach(() => {
    // eslint-disable-next-line functional/immutable-data
    delete process.env.GLUESYNC_FAKE_ERROR;
  });

  const build = async (rules: string) => {
    // eslint-disable-next-line functional/immutable-data
    process.env.GLUESYNC_FAKE_ERROR = rules;
    const app = fastify();
    await app.register(fakeErrorInjectorPlugin);
    app.post('/containers', async () => ({ success: true, real: true }));
    app.get('/services/:id/version', async () => ({
      success: true,
      real: true,
      data: { currentVersion: '2.0', latestVersionGA: '2.0' },
    }));
    return app;
  };

  it('signals an update by reporting an older running version', async () => {
    const app = await build(
      'update:*:OTA_SERVICE_DOWN,available:gluesync-core-hub:1.0',
    );
    const faked = await app.inject({
      method: 'GET',
      url: '/services/gluesync-core-hub/version',
    });
    const other = await app.inject({
      method: 'GET',
      url: '/services/gluesync-chronos/version',
    });
    await app.close();

    assert.equal(faked.statusCode, 200);
    assert.equal(faked.json().data.currentVersion, '1.0');
    assert.equal(faked.json().data.latestVersionGA, '2.0');
    assert.equal(other.json().data.currentVersion, '2.0');
  });

  it('fails the matching update before the real handler runs', async () => {
    const app = await build('update:gluesync-core-hub:OTA_SERVICE_DOWN');
    const response = await app.inject({
      method: 'POST',
      url: '/containers',
      payload: { action: 'update', ids: ['gluesync-core-hub'] },
    });
    await app.close();

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(response.json().real, undefined);
  });

  it('lets other requests through to the real handler', async () => {
    const app = await build('update:gluesync-core-hub:OTA_SERVICE_DOWN');
    const other = await app.inject({
      method: 'POST',
      url: '/containers',
      payload: { action: 'update', ids: ['gluesync-chronos'] },
    });
    const version = await app.inject({
      method: 'GET',
      url: '/services/gluesync-core-hub/version',
    });
    await app.close();

    assert.equal(other.statusCode, 200);
    assert.equal(other.json().real, true);
    assert.equal(version.json().real, true);
  });

  it('fails a version check when asked to', async () => {
    const app = await build('version:*:BACKOFFICE_UNREACHABLE_FROM_HOST');
    const response = await app.inject({
      method: 'GET',
      url: '/services/gluesync-chronos/version/beta?x=1',
    });
    await app.close();

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().diagnosis.owner, 'customer');
  });
});
