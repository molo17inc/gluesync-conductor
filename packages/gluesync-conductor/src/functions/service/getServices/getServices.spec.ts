/* eslint-disable no-template-curly-in-string -- the `${VAR}` strings are the interpolations the stack file keeps as written */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import fastify, { type RouteHandlerMethod } from 'fastify';
import { parse } from 'yaml';

import { labStackYaml } from '../../../testing/labStack';
import loadWithStubs from '../../../testing/loadWithStubs';
import stackFileOnDisk from '../../../testing/stackFileOnDisk';

// The lab stack has no agent: add one, the way the Conductor writes it
const withAgent = labStackYaml.replace(
  '\nnetworks:\n  gluesync-net:',
  `
  gluesync-mssql-ct:
    image: molo17/gluesync-mssql-ct:2.3.0@sha256:0123456789abcdef
    environment:
      INITIAL_AGENT_ID: 7
    ports:
      - target: 1717
        published: 17171
        protocol: udp
    networks:
      - gluesync-net
    labels:
      - com.molo17.conductor.type=agent
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure

networks:
  gluesync-net:`,
);

let cleanup: () => Promise<void>;
let handler: RouteHandlerMethod;

before(async () => {
  const stack = await stackFileOnDisk(withAgent);

  cleanup = stack.cleanup;
  handler = loadWithStubs<{ default: RouteHandlerMethod }>(
    path.resolve(__dirname, './getServices'),
    {
      [path.resolve(
        __dirname,
        '../../../helpers/composeFile/readComposeFile/readComposeFile',
      )]: { readComposeFile: stack.readComposeFile },
    },
  ).default;
});

after(async () => {
  await cleanup();
});

const get = async (url: string) => {
  const app = fastify();

  app.get('/services', handler);
  app.get('/services/:id', handler);
  await app.ready();

  const res = await app.inject({ method: 'GET', url });
  await app.close();

  return res;
};

describe('GET /services on a swarm stack file', () => {
  it('lists the agents with long-syntax ports parsed', async () => {
    const res = await get('/services');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.json().data), ['gluesync-mssql-ct']);
    assert.deepEqual(res.json().data['gluesync-mssql-ct'].ports, [
      { host: '17171', container: '1717/udp' },
    ]);
    assert.equal(
      res.json().data['gluesync-mssql-ct'].image,
      'molo17/gluesync-mssql-ct:2.3.0@sha256:0123456789abcdef',
    );
  });

  it('lists agents and modules written as a label list when raw', async () => {
    const res = await get('/services?raw=true');

    assert.deepEqual(Object.keys(res.json().data), [
      'gluesync-conductor',
      'gluesync-mssql-ct',
    ]);
    // The long syntax is untouched
    assert.deepEqual(res.json().data['gluesync-mssql-ct'].ports, [
      { target: 1717, published: 17171, protocol: 'udp' },
    ]);
  });

  it('gives one service by id, with its swarm keys', async () => {
    const res = await get('/services/gluesync-core-hub');
    const hub = res.json().data['gluesync-core-hub'];

    assert.equal(res.statusCode, 200);
    assert.equal(hub.image, 'molo17/gluesync-core-hub:${CORE_HUB_TAG:-2.3.0}');
    assert.deepEqual(hub.deploy.placement.constraints, [
      'node.labels.gluesync.data == true',
    ]);
    assert.deepEqual(hub.sysctls, ['net.core.somaxconn=1024']);
    assert.deepEqual(hub.volumes, [
      { host: '/srv/gluesync/data', container: '/opt/gluesync/data' },
      { host: '/srv/gluesync/logs', container: '/opt/gluesync/logs:ro' },
    ]);
  });

  it('gives a service of any type by id, raw', async () => {
    const res = await get('/services/reverse-proxy?raw=true');
    const proxy = res.json().data['reverse-proxy'];

    assert.equal(res.statusCode, 200);
    assert.equal(proxy.ports.length, 2);
    assert.equal(proxy.ports[0].mode, 'ingress');
    assert.deepEqual(proxy.deploy.placement.constraints, [
      'node.role == manager',
    ]);
  });

  it('gives the YAML text with the interpolations untouched', async () => {
    const res = await get('/services/gluesync-core-hub?raw=true&format=string');
    const text = res.json().data as string;

    assert.equal(typeof text, 'string');
    assert.match(text, /\$\{CORE_HUB_TAG:-2\.3\.0\}/);
    assert.match(text, /\$\{HUB_HOST:-hub\.local\}/);
    assert.equal(
      parse(text)['gluesync-core-hub'].environment.JAVA_OPTS,
      '-Xmx${CORE_HUB_HEAP:-4g}',
    );
  });

  it('answers 404 for a service that is not in the stack file', async () => {
    const res = await get('/services/ghost');

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'Service ghost not found in docker file');
  });
});
