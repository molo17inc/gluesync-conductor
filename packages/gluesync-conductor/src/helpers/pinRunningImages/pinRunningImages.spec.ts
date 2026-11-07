/* eslint-disable no-template-curly-in-string -- the `${VAR}` string is the interpolation a compose file keeps as written */
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import { makeComposeSandbox } from '../../testing/composeSandbox';
import loadWithStubs from '../../testing/loadWithStubs';
import type { PinRunningImages } from './pinRunningImages.model';

// readComposeFile and writeComposeFile take DKR_COMPOSE_FILE when they load:
// the sandbox comes first, or the package's own docker-compose.yml is written
const sandbox = makeComposeSandbox();
const pinRunningImages = loadWithStubs<{ default: PinRunningImages }>(
  path.join(__dirname, 'pinRunningImages.ts'),
  {},
).default;

after(() => sandbox.restore());
beforeEach(() => rmSync(sandbox.lastGood, { force: true }));

// The HQ compose file of 2026-11-07, cut down
const compose = (
  coreHubTag: string,
  agentImage = 'molo17/gluesync-mssql-ee:2.3.1.4',
): string => `# kit header
services:
  gluesync-core-hub:
    image: molo17/gluesync-core-hub:${coreHubTag}
    labels:
      - com.molo17.conductor.type=core-hub
  gluesync-mssql-ee:
    # an agent
    image: ${agentImage}
    labels:
      com.molo17.conductor.type: agent
  gluesync-conductor:
    image: molo17/gluesync-conductor:0.13.4
`;

type Live = Readonly<
  Record<string, Readonly<{ image: string; state?: string }>>
>;

// One container per service, created from `image`
const docker = (live: Live): Docker =>
  ({
    listContainers: async ({
      filters,
    }: Readonly<{ filters: Readonly<{ label: ReadonlyArray<string> }> }>) => {
      const service = filters.label[0].split('=')[1];
      const container = live[service];
      return container
        ? [{ Id: service, State: container.state ?? 'running', Created: 1 }]
        : [];
    },
    getContainer: (id: string) => ({
      inspect: async () => ({
        State: {
          Running: (live[id].state ?? 'running') === 'running',
          Restarting: false,
          Status: live[id].state ?? 'running',
        },
        Config: { Image: live[id].image },
      }),
    }),
  }) as unknown as Docker;

const running = (coreHub: string): Live => ({
  'gluesync-core-hub': { image: `molo17/gluesync-core-hub:${coreHub}` },
  'gluesync-mssql-ee': { image: 'molo17/gluesync-mssql-ee:2.3.1.4' },
  'gluesync-conductor': { image: 'molo17/gluesync-conductor:0.13.4' },
});

describe('pinRunningImages', () => {
  it('pins CoreHub to the running tag when the compose file names an older one', async () => {
    sandbox.setCompose(compose('2.3.1.3'));

    const pins = await pinRunningImages(docker(running('2.3.1.4')));

    assert.deepEqual(pins, [
      {
        service: 'gluesync-core-hub',
        coreHub: true,
        composeImage: 'molo17/gluesync-core-hub:2.3.1.3',
        runningImage: 'molo17/gluesync-core-hub:2.3.1.4',
      },
    ]);
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.1.4'));
    assert.equal(sandbox.read(sandbox.lastGood), compose('2.3.1.4'));
  });

  it('leaves the compose file alone when tags are equal', async () => {
    sandbox.setCompose(compose('2.3.1.4'));

    assert.deepEqual(await pinRunningImages(docker(running('2.3.1.4'))), []);
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.1.4'));
    assert.equal(existsSync(sandbox.lastGood), false);
  });

  it('leaves a newer compose tag alone: the restart is the upgrade', async () => {
    sandbox.setCompose(compose('2.3.2.0'));

    assert.deepEqual(await pinRunningImages(docker(running('2.3.1.4'))), []);
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.2.0'));
  });

  it('pins a running beta over its older release', async () => {
    sandbox.setCompose(compose('2.3.1.4'));

    const pins = await pinRunningImages(docker(running('2.3.2.0.4dbdd8aa7e')));

    assert.equal(
      pins[0]?.runningImage,
      'molo17/gluesync-core-hub:2.3.2.0.4dbdd8aa7e',
    );
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.2.0.4dbdd8aa7e'));
  });

  it('counts a stopped container: its database was migrated all the same', async () => {
    sandbox.setCompose(compose('2.3.1.3'));

    const live = {
      ...running('2.3.1.4'),
      'gluesync-core-hub': {
        image: 'molo17/gluesync-core-hub:2.3.1.4',
        state: 'exited',
      },
    };

    assert.equal((await pinRunningImages(docker(live))).length, 1);
  });

  it('pins any service, not only CoreHub', async () => {
    sandbox.setCompose(compose('2.3.1.4', 'molo17/gluesync-mssql-ee:2.3.1.3'));

    const pins = await pinRunningImages(docker(running('2.3.1.4')));

    assert.deepEqual(
      pins.map(pin => [pin.service, pin.coreHub]),
      [['gluesync-mssql-ee', false]],
    );
  });

  it('matches Podman, which names the image fully qualified', async () => {
    sandbox.setCompose(compose('2.3.1.3'));

    const live = {
      ...running('2.3.1.4'),
      'gluesync-core-hub': {
        image: 'docker.io/molo17/gluesync-core-hub:2.3.1.4',
      },
    };

    const pins = await pinRunningImages(docker(live));
    assert.equal(pins[0]?.runningImage, 'molo17/gluesync-core-hub:2.3.1.4');
  });

  it('leaves an interpolated tag, another image, or no container alone', async () => {
    const interpolated = compose('${CORE_HUB_TAG:-2.3.1.3}');
    sandbox.setCompose(interpolated);

    assert.deepEqual(await pinRunningImages(docker(running('2.3.1.4'))), []);
    assert.equal(sandbox.read(sandbox.compose), interpolated);

    sandbox.setCompose(compose('2.3.1.3'));
    const otherImage = {
      ...running('2.3.1.4'),
      'gluesync-core-hub': { image: 'registry.local/core-hub:2.3.1.4' },
    };
    assert.deepEqual(await pinRunningImages(docker(otherImage)), []);

    const withoutCoreHub = Object.fromEntries(
      Object.entries(running('2.3.1.4')).filter(
        ([service]) => service !== 'gluesync-core-hub',
      ),
    );
    assert.deepEqual(await pinRunningImages(docker(withoutCoreHub)), []);
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.1.3'));
  });
});
