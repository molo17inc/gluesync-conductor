import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import fakeKubernetesClient from '../../../testing/fakeKubernetesClient';
import { resetKubernetesNodeCache } from '../getKubernetesSystemInfo/getKubernetesSystemInfo';
import {
  getKubernetesInfo,
  getKubernetesVersion,
} from './kubernetesClusterInfo';

const version = {
  major: '1',
  minor: '34',
  gitVersion: 'v1.34.0',
  gitCommit: 'abc123',
  buildDate: '2026-08-27T00:00:00Z',
  goVersion: 'go1.24.6',
  platform: 'linux/arm64',
};

const deps = { podName: 'conductor-0', now: () => 0 };

beforeEach(() => {
  resetKubernetesNodeCache();
});

describe('kubernetesClusterInfo', () => {
  it('answers GET /version from the API server, under the keys of Docker', async () => {
    const client = fakeKubernetesClient({ paths: { '/version': version } });

    assert.deepEqual(await getKubernetesVersion(client), {
      orchestrator: 'kubernetes',
      Platform: { Name: 'Kubernetes' },
      Version: 'v1.34.0',
      GitCommit: 'abc123',
      GoVersion: 'go1.24.6',
      Os: 'linux',
      Arch: 'arm64',
      BuildTime: '2026-08-27T00:00:00Z',
    });
  });

  it('answers GET /info with the orchestrator, the namespace and the node', async () => {
    const client = fakeKubernetesClient({
      paths: {
        '/version': version,
        '/api/v1/namespaces/gluesync/pods/conductor-0': {
          metadata: { name: 'conductor-0' },
          spec: { nodeName: 'node-a' },
        },
        '/api/v1/nodes/node-a': {
          metadata: { name: 'node-a' },
          status: {
            capacity: { cpu: '4', memory: '8Gi' },
            nodeInfo: {
              architecture: 'arm64',
              operatingSystem: 'linux',
              osImage: 'Ubuntu 22.04',
              kernelVersion: '6.10.14',
              containerRuntimeVersion: 'docker://28.0.4',
            },
          },
        },
      },
    });

    assert.deepEqual(await getKubernetesInfo(client, deps), {
      orchestrator: 'kubernetes',
      namespace: 'gluesync',
      ServerVersion: 'v1.34.0',
      Name: 'node-a',
      NCPU: 4,
      MemTotal: 8 * 1024 ** 3,
      OSType: 'linux',
      Architecture: 'arm64',
      OperatingSystem: 'Ubuntu 22.04',
      KernelVersion: '6.10.14',
      ContainerRuntime: 'docker://28.0.4',
    });
  });

  it('leaves the node out of GET /info when it cannot be read', async () => {
    const client = fakeKubernetesClient({ paths: { '/version': version } });

    const info = await getKubernetesInfo(client, deps);

    assert.deepEqual(JSON.parse(JSON.stringify(info)), {
      orchestrator: 'kubernetes',
      namespace: 'gluesync',
      ServerVersion: 'v1.34.0',
    });
  });

  it('rejects when the API server does not answer', async () => {
    await assert.rejects(getKubernetesVersion(fakeKubernetesClient()), /404/);
    await assert.rejects(
      getKubernetesInfo(fakeKubernetesClient(), deps),
      /404/,
    );
  });
});
