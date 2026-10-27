import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RawComposeService } from '../../models/composeFile.model';
import addStackMountToCoreHub, {
  STACK_TARGET_LINUX,
  STACK_TARGET_WINDOWS,
} from './addStackMountToCoreHub';

const windowsCoreHub: RawComposeService = {
  image: 'molo17/gluesync-core-hub:2.3.1.1-win-nanoserver-ltsc2022',
  volumes: [
    './shared:C:\\opt\\gluesync\\shared',
    './data/core-hub:C:\\opt\\gluesync\\data',
    './logs/core-hub:C:\\opt\\gluesync\\logs',
  ],
};

const linuxCoreHub: RawComposeService = {
  image: 'molo17/gluesync-core-hub:2.3.1.1',
  volumes: [
    './shared:/opt/gluesync/shared',
    './data/core-hub:/opt/gluesync/data:rw',
  ],
};

describe('addStackMountToCoreHub', () => {
  it('adds the platform data folder next to Core Hub own mounts on Windows, which stay as they are', () => {
    const services = {
      'gluesync-core-hub': windowsCoreHub,
      'gluesync-chronos': { image: 'chronos' },
    };
    const result = addStackMountToCoreHub(
      services,
      Object.keys(services),
      true,
    );

    assert.deepEqual(result.updatedIds, ['gluesync-core-hub']);
    assert.deepEqual(result.services['gluesync-core-hub'].volumes, [
      ...(windowsCoreHub.volumes ?? []),
      `./data:${STACK_TARGET_WINDOWS}`,
    ]);
    assert.equal(
      result.services['gluesync-chronos'],
      services['gluesync-chronos'],
    );
  });

  it('adds it on Linux, keeping a mode on the other mounts', () => {
    const result = addStackMountToCoreHub(
      { 'gluesync-core-hub': linuxCoreHub },
      ['gluesync-core-hub'],
      false,
    );

    assert.deepEqual(result.services['gluesync-core-hub'].volumes, [
      './shared:/opt/gluesync/shared',
      './data/core-hub:/opt/gluesync/data:rw',
      `./data:${STACK_TARGET_LINUX}`,
    ]);
  });

  it('does nothing when the folder is already mounted, whatever its source, mode, case or syntax', () => {
    const cases: ReadonlyArray<[RawComposeService, boolean]> = [
      [{ image: 'x', volumes: [`./data:${STACK_TARGET_WINDOWS}`] }, true],
      [
        {
          image: 'x',
          volumes: ['D:\\Gluesync\\data:c:\\opt\\gluesync\\stack\\:ro'],
        },
        true,
      ],
      [{ image: 'x', volumes: [`./data:${STACK_TARGET_LINUX}:ro`] }, false],
      [
        {
          image: 'x',
          volumes: [
            { type: 'bind', source: './data', target: STACK_TARGET_LINUX },
          ],
        },
        false,
      ],
    ];
    cases.forEach(([svc, isWindows]) => {
      const services = { 'gluesync-core-hub': svc };
      const result = addStackMountToCoreHub(
        services,
        ['gluesync-core-hub'],
        isWindows,
      );
      assert.deepEqual(result.updatedIds, []);
      assert.equal(
        result.services,
        services,
        'the same object: nothing to write',
      );
    });
  });

  it('leaves alone a compose file without Core Hub, and a Core Hub this run does not handle', () => {
    const noCoreHub = { 'gluesync-chronos': { image: 'chronos' } };
    assert.deepEqual(
      addStackMountToCoreHub(noCoreHub, ['gluesync-chronos'], false).updatedIds,
      [],
    );

    const notHandled = { 'gluesync-core-hub': linuxCoreHub };
    assert.deepEqual(
      addStackMountToCoreHub(notHandled, [], false).updatedIds,
      [],
    );
  });

  it('creates the volume list of a Core Hub that has none', () => {
    const result = addStackMountToCoreHub(
      { 'gluesync-core-hub': { image: 'x' } },
      ['gluesync-core-hub'],
      false,
    );
    assert.deepEqual(result.services['gluesync-core-hub'].volumes, [
      `./data:${STACK_TARGET_LINUX}`,
    ]);
  });
});
