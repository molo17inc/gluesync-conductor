/* eslint-disable functional/immutable-data, functional/no-let, no-template-curly-in-string -- records what the stubs were asked; the `${VAR}` strings are the interpolations the stack file keeps as written */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import fastify, { type RouteHandlerMethod } from 'fastify';

import { labStack } from '../../testing/labStack';
import loadWithStubs from '../../testing/loadWithStubs';
import stackFileOnDisk from '../../testing/stackFileOnDisk';

const helpers = path.resolve(__dirname, '../../helpers');

const written: Array<readonly [unknown, string | undefined]> = [];
let cleanup: () => Promise<void>;
let handler: RouteHandlerMethod;

before(async () => {
  const stack = await stackFileOnDisk();

  cleanup = stack.cleanup;
  handler = loadWithStubs<{ default: RouteHandlerMethod }>(
    path.resolve(__dirname, './composeToJSON'),
    {
      [`${helpers}/composeFile/readComposeFile/readComposeFile`]: {
        readComposeFile: stack.readComposeFile,
      },
      [`${helpers}/composeFile/writeComposeFile/writeComposeFile`]: {
        default: async (json: unknown, filename?: string) => {
          written.push([json, filename]);
        },
      },
      [path.resolve(__dirname, '../../security')]: {
        canModifyConfiguration: (role: string) => role === 'admin',
      },
    },
  ).default;
});

after(async () => {
  await cleanup();
});

const get = async (url: string, role = 'admin') => {
  const app = fastify();

  app.addHook('onRequest', async req => {
    Object.assign(req, { currentUser: { role } });
  });
  app.get('/compose-to-json', handler);
  await app.ready();

  const res = await app.inject({ method: 'GET', url });
  await app.close();

  return res;
};

describe('GET /compose-to-json on a swarm stack file', () => {
  it('parses every service, long-syntax ports and volumes included', async () => {
    const res = await get('/compose-to-json');
    const { services } = res.json().data;

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(services), [
      'reverse-proxy',
      'gluesync-core-hub',
      'gluesync-chronos',
      'prometheus',
      'grafana',
      'gluesync-conductor',
    ]);
    assert.deepEqual(services['reverse-proxy'].ports, [
      { host: '80', container: '80' },
      { host: '443', container: '443' },
    ]);
    assert.deepEqual(services['gluesync-core-hub'].volumes, [
      { host: '/srv/gluesync/data', container: '/opt/gluesync/data' },
      { host: '/srv/gluesync/logs', container: '/opt/gluesync/logs:ro' },
    ]);
    assert.deepEqual(services['gluesync-conductor'].volumes, [
      { host: '/var/run/docker.sock', container: '/var/run/docker.sock' },
      { host: '.', container: '/opt/gluesync-conductor/root-folder' },
    ]);
  });

  it('leaves the swarm keys and the interpolations as written', async () => {
    const { data } = (await get('/compose-to-json')).json();
    const hub = data.services['gluesync-core-hub'];

    assert.equal(hub.image, 'molo17/gluesync-core-hub:${CORE_HUB_TAG:-2.3.0}');
    assert.equal(hub.environment.JAVA_OPTS, '-Xmx${CORE_HUB_HEAP:-4g}');
    assert.deepEqual(hub.sysctls, ['net.core.somaxconn=1024']);
    assert.deepEqual(hub.ulimits, { nofile: { soft: 65536, hard: 65536 } });
    assert.deepEqual(hub.deploy.placement.constraints, [
      'node.labels.gluesync.data == true',
    ]);
    assert.equal(
      hub.deploy.labels[1],
      'traefik.http.routers.hub.rule=Host(`${HUB_HOST:-hub.local}`)',
    );
    assert.equal(data.services.grafana.user, '472:472');
    assert.deepEqual(data.services.prometheus.configs, [
      { source: 'prometheus-yml', target: '/etc/prometheus/prometheus.yml' },
    ]);
    const [secret] = data.services['reverse-proxy'].secrets;

    assert.equal(secret.source, 'proxy-cert');
    assert.equal(secret.target, 'proxy.crt');
  });

  it('keeps the top-level keys of the stack file', async () => {
    const { data } = (await get('/compose-to-json')).json();

    assert.equal(data.name, 'gluesync');
    assert.deepEqual(data.networks, {
      'gluesync-net': { driver: 'overlay', attachable: true },
    });
    assert.deepEqual(Object.keys(data.volumes), [
      'prometheus-data',
      'grafana-data',
    ]);
    assert.deepEqual(data.secrets, {
      'proxy-cert': { file: './secrets/proxy.crt' },
    });
    assert.deepEqual(data.configs, {
      'prometheus-yml': { file: './prometheus.yml' },
    });
  });

  it('gives the raw file as it is with raw=true', async () => {
    const res = await get('/compose-to-json?raw=true');

    assert.deepEqual(res.json().data, JSON.parse(JSON.stringify(labStack)));
  });

  it('redacts secrets in the environment for a role that cannot see them', async () => {
    const admin = (await get('/compose-to-json')).json().data.services[
      'gluesync-core-hub'
    ];
    const viewer = (await get('/compose-to-json', 'viewer')).json().data
      .services['gluesync-core-hub'];

    assert.equal(
      admin.environment.GLUESYNC_ADMIN_PASSWORD,
      '${ADMIN_PASSWORD}',
    );
    assert.equal(viewer.environment.GLUESYNC_ADMIN_PASSWORD, '***REDACTED***');
    assert.equal(viewer.environment.JAVA_OPTS, '-Xmx${CORE_HUB_HEAP:-4g}');
  });

  it('writes the generated copy next to the stack file, not over it', async () => {
    written.length = 0;

    await get('/compose-to-json');

    assert.equal(written.length, 1);
    assert.equal(written[0][1], 'compose.generated.yml');
  });
});
