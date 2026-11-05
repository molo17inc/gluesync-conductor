import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import {
  detectContainerEngine,
  getContainerEngine,
  isPodmanEngine,
  resetContainerEngineCache,
} from './containerEngine';

beforeEach(resetContainerEngineCache);

const PODMAN_VERSION = {
  Version: '5.8.2',
  ApiVersion: '1.44',
  Components: [
    { Name: 'Podman Engine', Version: '5.8.2' },
    { Name: 'Conmon', Version: '2.1.12' },
  ],
};
const DOCKER_VERSION = {
  Version: '29.0.1',
  Components: [{ Name: 'Engine', Version: '29.0.1' }],
};

describe('detectContainerEngine', () => {
  it('knows Podman by its engine component, and takes its version', () => {
    assert.deepEqual(
      detectContainerEngine(PODMAN_VERSION, {
        SecurityOptions: ['name=seccomp,profile=default', 'name=selinux'],
      }),
      { engine: 'podman', rootless: false, version: '5.8.2' },
    );
  });

  it('knows a rootless engine by name=rootless', () => {
    assert.equal(
      detectContainerEngine(PODMAN_VERSION, {
        SecurityOptions: ['name=rootless', 'name=selinux'],
      }).rootless,
      true,
    );
    assert.equal(
      detectContainerEngine(DOCKER_VERSION, {
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
      }).rootless,
      true,
    );
  });

  it('takes anything else for Docker', () => {
    assert.deepEqual(
      detectContainerEngine(DOCKER_VERSION, {
        SecurityOptions: ['name=seccomp,profile=builtin'],
      }),
      { engine: 'docker', rootless: false, version: '29.0.1' },
    );
  });

  it('copes with answers that lack fields', () => {
    assert.deepEqual(detectContainerEngine(undefined, undefined), {
      engine: 'docker',
      rootless: false,
      version: '',
    });
    assert.equal(
      detectContainerEngine({}, { ServerVersion: '27.1.0' }).version,
      '27.1.0',
    );
  });
});

const fakeDocker = (version: unknown, info: unknown) => {
  const calls = { version: 0, info: 0 };
  const docker = {
    version: async () => {
      calls.version += 1;
      if (version instanceof Error) {
        throw version;
      }
      return version;
    },
    info: async () => {
      calls.info += 1;
      if (info instanceof Error) {
        throw info;
      }
      return info;
    },
  } as unknown as Docker;
  return { docker, calls };
};

describe('getContainerEngine', () => {
  it('asks the engine once and remembers the answer', async () => {
    const { docker, calls } = fakeDocker(PODMAN_VERSION, {
      SecurityOptions: ['name=rootless'],
    });

    const first = await getContainerEngine(docker);
    const second = await getContainerEngine(docker);

    assert.deepEqual(first, {
      engine: 'podman',
      rootless: true,
      version: '5.8.2',
    });
    assert.deepEqual(second, first);
    assert.deepEqual(calls, { version: 1, info: 1 });
    assert.equal(await isPodmanEngine(docker), true);
  });

  it('answers undefined, without remembering, when the engine does not answer', async () => {
    const down = fakeDocker(new Error('ECONNREFUSED'), {});
    assert.equal(await getContainerEngine(down.docker), undefined);

    const up = fakeDocker(DOCKER_VERSION, { SecurityOptions: [] });
    assert.equal((await getContainerEngine(up.docker))?.engine, 'docker');
    assert.equal(await isPodmanEngine(up.docker), false);
  });

  it('does not remember an answer that lacks /info', async () => {
    const noInfo = fakeDocker(PODMAN_VERSION, new Error('no info'));

    assert.equal((await getContainerEngine(noInfo.docker))?.rootless, false);

    const withInfo = fakeDocker(PODMAN_VERSION, {
      SecurityOptions: ['name=rootless'],
    });

    assert.equal((await getContainerEngine(withInfo.docker))?.rootless, true);
  });
});
