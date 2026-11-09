/* eslint-disable functional/immutable-data, functional/no-let -- the spec sets the orchestrator environment, which is process state */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fastify, { type RouteHandlerMethod } from 'fastify';

import asSwarmManager from '../../../testing/asSwarmManager';
import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import { labStack, labStackWithoutTypes } from '../../../testing/labStack';
import loadWithStubs from '../../../testing/loadWithStubs';
import parseComposeFile from '../../../helpers/composeFile/parseComposeFile/parseComposeFile';
import { RawComposeFile } from '../../../models/composeFile.model';
import { resetOrchestratorCache } from '../../../helpers/orchestrator/getOrchestrator/getOrchestrator';

const helpers = path.resolve(__dirname, '../../../helpers');

// What the backoffice publishes per short image name
const published: Readonly<Record<string, string>> = {
  'core-hub': '2.3.1',
  chronos: '0.2.5',
  conductor: '3.2.0',
  whisperer: '1.1.0',
  grafana: '13.0.2.dashboard3',
  prometheus: 'v2.54.1',
};

// The stack file the handler reads; a spec swaps it
let stack: RawComposeFile = labStack;

const handler = loadWithStubs<{ default: RouteHandlerMethod }>(
  path.resolve(__dirname, './getServiceVersion'),
  {
    [`${helpers}/composeFile/readComposeFile/readComposeFile`]: {
      readComposeFile: async () => parseComposeFile(stack),
    },
    [`${helpers}/agentInfo/agentInfo`]: {
      default: async (imageName: string) => ({
        latestVersionGA: published[imageName],
      }),
    },
    [`${helpers}/fetchChangelogInfo/fetchChangelogInfo`]: {
      default: async () => ({ id: 'x', notes: 'changes' }),
    },
    [`${helpers}/dockerode/waitForDockerDaemon/waitForDockerDaemon`]: {
      default: async () => undefined,
    },
  },
).default;

const saved = {
  mode: process.env.CONDUCTOR_ORCHESTRATOR,
  namespace: process.env.SWARM_STACK_NAMESPACE,
};

beforeEach(() => {
  stack = labStack;
  process.env.CONDUCTOR_ORCHESTRATOR = 'swarm';
  process.env.SWARM_STACK_NAMESPACE = 'gs';
  resetOrchestratorCache();
});

afterEach(() => {
  [
    ['CONDUCTOR_ORCHESTRATOR', saved.mode],
    ['SWARM_STACK_NAMESPACE', saved.namespace],
  ].forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key as string];
    } else {
      process.env[key as string] = value;
    }
  });
  resetOrchestratorCache();
});

const versionOf = async (
  services: Parameters<typeof fakeSwarmDocker>[0],
  id: string,
) => {
  const app = fastify();
  app.decorate('docker', asSwarmManager(fakeSwarmDocker(services).docker));
  app.get('/services/:id/version/:releaseChannel?', handler);
  await app.ready();

  const res = await app.inject({
    method: 'GET',
    url: `/services/${id}/version/ga`,
  });
  await app.close();

  return res;
};

describe('GET /services/:id/version in swarm mode', () => {
  it('reports the tag of the service spec as the current version', async () => {
    const res = await versionOf(
      {
        services: [
          buildService('grafana', {
            image: 'molo17/grafana:13.0.1@sha256:0123456789abcdef',
          }),
        ],
      },
      'grafana',
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.currentVersion, '13.0.1');
    assert.equal(res.json().data.latestVersionGA, '13.0.2.dashboard3');
  });

  it('falls back to the stack file tag when the service is not deployed', async () => {
    const res = await versionOf({}, 'gluesync-chronos');

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.currentVersion, '0.2.4');
  });

  it('flags the modules whose spec is behind when asked for Core Hub', async () => {
    const res = await versionOf(
      {
        services: [
          buildService('gluesync-core-hub', {
            image: 'molo17/gluesync-core-hub:2.3.1',
          }),
          // Up to date, although the stack file has 0.2.4
          buildService('gluesync-chronos', {
            image: 'molo17/gluesync-chronos:0.2.5',
          }),
          buildService('gluesync-conductor', {
            image: 'molo17/gluesync-conductor:3.1.0',
          }),
          buildService('grafana', {
            image: 'molo17/grafana:13.0.2.dashboard3',
          }),
        ],
      },
      'gluesync-core-hub',
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.currentVersion, '2.3.1');
    assert.equal(res.json().data.mandatoryUpdate, true);
    // Prometheus is not deployed: it is judged on the stack file tag, which
    // is the published one
    assert.deepEqual(res.json().data.servicesToUpdate, ['gluesync-conductor']);
  });

  describe('on a Core Hub with disaster recovery enabled', () => {
    const deployed = {
      services: [
        buildService('gluesync-core-hub', {
          image: 'molo17/gluesync-core-hub:2.3.0',
        }),
        buildService('gluesync-chronos', {
          image: 'molo17/gluesync-chronos:0.2.4',
        }),
        buildService('grafana', { image: 'molo17/grafana:13.0.2.dashboard3' }),
      ],
    };

    const withDr = (value: string): RawComposeFile =>
      ({
        ...labStack,
        services: {
          ...labStack.services,
          'gluesync-core-hub': {
            ...labStack.services?.['gluesync-core-hub'],
            environment: [`GS_DR_ENABLED=${value}`],
          },
        },
      }) as RawComposeFile;

    it('blocks the update of Core Hub and Chronos with the reason, still listing versions', async () => {
      stack = withDr('true');

      const hub = await versionOf(deployed, 'gluesync-core-hub');
      const chronos = await versionOf(deployed, 'gluesync-chronos');

      assert.equal(hub.statusCode, 200);
      assert.equal(hub.json().data.updateBlocked, true);
      assert.match(
        hub.json().data.reason,
        /^Disaster recovery is enabled on this Core Hub: update the sites one at a time with Gluesync Control/,
      );
      assert.match(hub.json().data.reason, /gluesync\/latest\//);
      assert.equal(hub.json().data.latestVersionGA, '2.3.1');
      assert.ok(hub.json().data.servicesToUpdate.includes('gluesync-chronos'));
      assert.equal(chronos.json().data.updateBlocked, true);
      assert.equal(chronos.json().data.latestVersionGA, '0.2.5');
    });

    it('leaves the other services unblocked', async () => {
      stack = withDr('true');

      const res = await versionOf(deployed, 'grafana');

      assert.equal(res.json().data.updateBlocked, false);
      assert.equal(res.json().data.reason, undefined);
    });

    it('blocks nothing when disaster recovery is off', async () => {
      stack = withDr('false');

      const res = await versionOf(deployed, 'gluesync-core-hub');

      assert.equal(res.json().data.updateBlocked, false);
      assert.equal(res.json().data.reason, undefined);
    });
  });

  it('answers 404 for a service that is not in the stack file', async () => {
    const res = await versionOf({}, 'ghost');

    assert.equal(res.statusCode, 404);
  });

  it('finds the modules to update of a stack file with no type label', async () => {
    stack = {
      ...labStackWithoutTypes,
      services: {
        ...labStackWithoutTypes.services,
        // Only its image says it is a module
        'whisperer-1': { image: 'molo17/gluesync-whisperer:1.0.0' },
      },
    } as RawComposeFile;

    const res = await versionOf(
      {
        services: [
          buildService('gluesync-core-hub', {
            image: 'molo17/gluesync-core-hub:2.3.1',
          }),
          buildService('gluesync-chronos', {
            image: 'molo17/gluesync-chronos:0.2.5',
          }),
          buildService('gluesync-conductor', {
            image: 'molo17/gluesync-conductor:3.2.0',
          }),
          buildService('grafana', {
            image: 'molo17/grafana:13.0.2.dashboard3',
          }),
          buildService('whisperer-1', {
            image: 'molo17/gluesync-whisperer:1.0.0',
          }),
        ],
      },
      'gluesync-core-hub',
    );

    assert.deepEqual(res.json().data.servicesToUpdate, ['whisperer-1']);
  });

  describe('a Conductor that would be a downgrade', () => {
    const conductorAt = (tag: string) => ({
      services: [
        buildService('gluesync-core-hub', {
          image: 'molo17/gluesync-core-hub:2.3.1',
        }),
        buildService('gluesync-chronos', {
          image: 'molo17/gluesync-chronos:0.2.5',
        }),
        buildService('grafana', { image: 'molo17/grafana:13.0.2.dashboard3' }),
        buildService('gluesync-conductor', {
          image: `gluesync-conductor:${tag}`,
        }),
      ],
    });

    it('offers no version to a dev build', async () => {
      const res = await versionOf(
        conductorAt('swarm-dev'),
        'gluesync-conductor',
      );

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.latestVersionGA, undefined);
      assert.equal(res.json().data.changelogData, undefined);
    });

    it('offers no version older than the running release', async () => {
      const res = await versionOf(conductorAt('4.0.0'), 'gluesync-conductor');

      assert.equal(res.json().data.currentVersion, '4.0.0');
      assert.equal(res.json().data.latestVersionGA, undefined);
    });

    it('still offers a newer release', async () => {
      const res = await versionOf(conductorAt('3.1.0'), 'gluesync-conductor');

      assert.equal(res.json().data.latestVersionGA, '3.2.0');
    });

    it('is not a mandatory update of Core Hub', async () => {
      const dev = await versionOf(
        conductorAt('swarm-dev'),
        'gluesync-core-hub',
      );
      const newer = await versionOf(conductorAt('4.0.0'), 'gluesync-core-hub');

      assert.equal(dev.json().data.mandatoryUpdate, false);
      assert.deepEqual(dev.json().data.servicesToUpdate, []);
      assert.deepEqual(newer.json().data.servicesToUpdate, []);
    });

    it('is left alone on compose', async () => {
      process.env.CONDUCTOR_ORCHESTRATOR = 'compose';
      resetOrchestratorCache();
      const docker = {
        listContainers: async () => [],
        getContainer: () => ({}),
      };
      const app = fastify();
      app.decorate('docker', docker as never);
      app.get('/services/:id/version/:releaseChannel?', handler);
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/services/gluesync-conductor/version/ga',
      });
      await app.close();

      // The stack file says 3.1.0: the published 3.2.0 is offered
      assert.equal(res.json().data.latestVersionGA, '3.2.0');
    });
  });
});
