import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import { makeComposeSandbox } from '../../../testing/composeSandbox';
import loadWithStubs from '../../../testing/loadWithStubs';
import type { ReconcileRunningImages } from './reconcileRunningImages.model';

// readComposeFile and writeComposeFile take DKR_COMPOSE_FILE when they load
const sandbox = makeComposeSandbox();
const reconcileRunningImages = loadWithStubs<{
  default: ReconcileRunningImages;
}>(path.join(__dirname, 'reconcileRunningImages.ts'), {}).default;

after(() => sandbox.restore());
beforeEach(() => rmSync(sandbox.lastGood, { force: true }));

const compose = (
  coreHub: string,
  conductor = 'molo17/gluesync-conductor:0.14.5',
  agent = 'molo17/gluesync-mssql-ee:2.3.2.1',
): string => `services:
  gluesync-core-hub:
    image: molo17/gluesync-core-hub:${coreHub}
  gluesync-mssql-ee:
    image: ${agent}
  gluesync-conductor:
    image: ${conductor}
`;

type Live = Readonly<Record<string, string>>;

// One running container per service, created from the given image
const docker = (live: Live): Docker =>
  ({
    listContainers: async ({
      filters,
    }: Readonly<{ filters: Readonly<{ label: ReadonlyArray<string> }> }>) => {
      const service = filters.label[0].split('=')[1];
      return live[service]
        ? [{ Id: service, State: 'running', Created: 1 }]
        : [];
    },
    getContainer: (id: string) => ({
      inspect: async () => ({
        State: { Running: true, Restarting: false, Status: 'running' },
        Config: { Image: live[id] },
      }),
    }),
  }) as unknown as Docker;

const running = (coreHub: string): Live => ({
  'gluesync-core-hub': `molo17/gluesync-core-hub:${coreHub}`,
  'gluesync-mssql-ee': 'molo17/gluesync-mssql-ee:2.3.2.1',
  'gluesync-conductor': 'molo17/gluesync-conductor:0.14.5',
});

describe('reconcileRunningImages', () => {
  it('writes the running tag when it is higher (GS-1485: compose 2.3.2.0, running 2.3.2.1)', async () => {
    sandbox.setCompose(compose('2.3.2.0'));

    const stale = await reconcileRunningImages(docker(running('2.3.2.1')));

    assert.deepEqual(
      stale.map(pin => [pin.service, pin.composeImage, pin.runningImage]),
      [
        [
          'gluesync-core-hub',
          'molo17/gluesync-core-hub:2.3.2.0',
          'molo17/gluesync-core-hub:2.3.2.1',
        ],
      ],
    );
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.2.1'));
    // The last-good copy follows the main file through writeComposeFile
    assert.equal(sandbox.read(sandbox.lastGood), compose('2.3.2.1'));
  });

  it('compares versions of different lengths as numbers', async () => {
    sandbox.setCompose(compose('2.3.9'));

    assert.equal(
      (await reconcileRunningImages(docker(running('2.3.10.0')))).length,
      1,
    );
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.10.0'));
  });

  it('never lowers a tag: a higher compose tag is the update that did not finish', async () => {
    sandbox.setCompose(compose('2.3.3.0'));

    assert.deepEqual(
      await reconcileRunningImages(docker(running('2.3.2.1'))),
      [],
    );
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.3.0'));
    assert.equal(existsSync(sandbox.lastGood), false);
  });

  it('writes nothing when the tags are equal', async () => {
    sandbox.setCompose(compose('2.3.2.1'));

    assert.deepEqual(
      await reconcileRunningImages(docker(running('2.3.2.1'))),
      [],
    );
    assert.equal(existsSync(sandbox.lastGood), false);
  });

  it('leaves tags that are not plain versions alone', async () => {
    const original = compose('latest');
    sandbox.setCompose(original);
    assert.deepEqual(
      await reconcileRunningImages(docker(running('2.3.2.1'))),
      [],
    );

    // A variant suffix only follows the same variant
    sandbox.setCompose(compose('2.3.2.0-win-nanoserver-ltsc2022'));
    assert.deepEqual(
      await reconcileRunningImages(docker(running('2.3.2.1'))),
      [],
    );
    assert.equal(
      sandbox.read(sandbox.compose),
      compose('2.3.2.0-win-nanoserver-ltsc2022'),
    );

    // Same variant on both sides compares cleanly
    sandbox.setCompose(compose('2.3.2.0-win-nanoserver-ltsc2022'));
    const stale = await reconcileRunningImages(
      docker(running('2.3.2.1-win-nanoserver-ltsc2022')),
    );
    assert.equal(stale.length, 1);

    // Two builds of one release cannot be ordered
    sandbox.setCompose(compose('2.3.2.0.0c1f2e3a9b'));
    assert.deepEqual(
      await reconcileRunningImages(docker(running('2.3.2.0.4dbdd8aa7e'))),
      [],
    );
  });

  it('never touches the Conductor service, nor a service of another repository', async () => {
    sandbox.setCompose(
      compose(
        '2.3.2.1',
        'molo17/gluesync-conductor:0.14.4',
        'acme/agent:1.0.0',
      ),
    );
    const live = {
      ...running('2.3.2.1'),
      'gluesync-mssql-ee': 'acme/agent:1.2.0',
      'gluesync-conductor': 'molo17/gluesync-conductor:0.14.5',
    };

    assert.deepEqual(await reconcileRunningImages(docker(live)), []);
    assert.equal(
      sandbox.read(sandbox.compose),
      compose(
        '2.3.2.1',
        'molo17/gluesync-conductor:0.14.4',
        'acme/agent:1.0.0',
      ),
    );
  });

  it('never touches a service without a container', async () => {
    sandbox.setCompose(compose('2.3.2.0'));
    const others = Object.fromEntries(
      Object.entries(running('2.3.2.1')).filter(
        ([service]) => service !== 'gluesync-core-hub',
      ),
    );

    assert.deepEqual(await reconcileRunningImages(docker(others)), []);
    assert.equal(sandbox.read(sandbox.compose), compose('2.3.2.0'));
  });
});
