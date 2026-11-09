import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContainerInfo } from 'dockerode';

import containerInfoMapper from './containerInfoMapper';

const dockerList = (overrides: Record<string, unknown> = {}): ContainerInfo =>
  ({
    Id: 'abc',
    Names: ['/gluesync-core-hub'],
    Image: 'molo17/gluesync-core-hub:2.3.0.0',
    ImageID: 'sha256:1',
    Command: 'run',
    Created: 1,
    Ports: [],
    Labels: { 'com.molo17.conductor.type': 'core-hub' },
    State: 'running',
    Status: 'Up 1 minute',
    HostConfig: { NetworkMode: 'gluesync-net' },
    NetworkSettings: {
      Networks: { 'gluesync-net': { IPAddress: '172.19.0.2' } },
    },
    Mounts: [],
    ...overrides,
  }) as unknown as ContainerInfo;

describe('containerInfoMapper', () => {
  it('maps a Docker container list entry', () => {
    const info = containerInfoMapper(dockerList());

    assert.equal(info?.name, 'gluesync-core-hub');
    assert.equal(info?.hostConfig.networkMode, 'gluesync-net');
    assert.equal(
      info?.networkSettings.networks['gluesync-net'].iPAddress,
      '172.19.0.2',
    );
    assert.equal(info?.tag, '2.3.0.0');
    assert.equal(info?.parsedImage.registry, '');
  });

  it('keeps no registry for a plain molo17 image Podman reports as docker.io/...', () => {
    const info = containerInfoMapper(
      dockerList({ Image: 'docker.io/molo17/gluesync-core-hub:2.3.0.0' }),
    );

    assert.equal(info?.image, 'molo17/gluesync-core-hub:2.3.0.0');
    assert.equal(info?.parsedImage.registry, '');
    assert.equal(info?.parsedImage.repository, 'molo17/gluesync-core-hub');
    assert.equal(info?.parsedImage.imageName, 'gluesync-core-hub');
    assert.equal(info?.tag, '2.3.0.0');
  });

  it('strips docker.io/library for an official image', () => {
    const info = containerInfoMapper(
      dockerList({ Image: 'docker.io/library/busybox:1.36' }),
    );

    assert.equal(info?.image, 'busybox:1.36');
    assert.equal(info?.parsedImage.registry, '');
  });

  it('keeps the registry of an image that is not on Docker Hub', () => {
    const info = containerInfoMapper(
      dockerList({ Image: 'registry.example.com/molo17/x:1' }),
    );

    assert.equal(info?.parsedImage.registry, 'registry.example.com');
  });

  it('copes with Podman: no HostConfig NetworkMode, nothing at all, or null', () => {
    assert.equal(
      containerInfoMapper(dockerList({ HostConfig: {} }))?.hostConfig
        .networkMode,
      undefined,
    );
    assert.equal(
      containerInfoMapper(dockerList({ HostConfig: undefined }))?.hostConfig
        .networkMode,
      undefined,
    );
    assert.equal(
      containerInfoMapper(dockerList({ HostConfig: null }))?.hostConfig
        .networkMode,
      undefined,
    );
  });

  it('copes with missing or null NetworkSettings', () => {
    [undefined, null, {}, { Networks: null }].forEach(networkSettings => {
      assert.deepEqual(
        containerInfoMapper(dockerList({ NetworkSettings: networkSettings }))
          ?.networkSettings,
        { networks: {} },
      );
    });
  });

  it('copes with null labels, names and ports', () => {
    const info = containerInfoMapper(
      dockerList({ Labels: null, Names: null, Ports: null, Mounts: null }),
    );

    assert.equal(info?.name, '');
    assert.deepEqual(info?.ports, []);
    assert.deepEqual(info?.mounts, []);
  });

  it('is undefined without a container', () => {
    assert.equal(containerInfoMapper(undefined), undefined);
  });
});
