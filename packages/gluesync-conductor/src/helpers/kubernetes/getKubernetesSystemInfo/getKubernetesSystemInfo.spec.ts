import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import fakeKubernetesClient, {
  apiError,
} from '../../../testing/fakeKubernetesClient';
import getKubernetesSystemInfo, {
  parseQuantity,
  readOwnNode,
  resetKubernetesNodeCache,
} from './getKubernetesSystemInfo';

const POD_PATH = '/api/v1/namespaces/gluesync/pods/conductor-0';
const NODE_PATH = '/api/v1/nodes/node-a';

const node = {
  metadata: { name: 'node-a' },
  status: { capacity: { cpu: '8', memory: '16374572Ki' } },
};

const cluster = (nodeAnswer: unknown = node) =>
  fakeKubernetesClient({
    paths: {
      [POD_PATH]: {
        metadata: { name: 'conductor-0' },
        spec: { nodeName: 'node-a' },
      },
      [NODE_PATH]: nodeAnswer,
    },
  });

const deps = (now = 0) => ({ podName: 'conductor-0', now: () => now });

beforeEach(() => {
  resetKubernetesNodeCache();
});

describe('getKubernetesSystemInfo', () => {
  it('reports the CPUs and memory of the node the pod runs on', async () => {
    const client = cluster();

    assert.deepEqual(await getKubernetesSystemInfo(client, deps()), {
      ncpu: 8,
      memTotal: 16374572 * 1024,
    });
    assert.deepEqual(client.calls, [POD_PATH, NODE_PATH]);
  });

  it('asks for the node once', async () => {
    const client = cluster();

    await getKubernetesSystemInfo(client, deps());
    await getKubernetesSystemInfo(client, deps(10 * 60_000));

    assert.equal(client.calls.length, 2);
  });

  it('leaves both out when the Role does not let it read nodes', async () => {
    const client = cluster(apiError(403, NODE_PATH));

    assert.deepEqual(await getKubernetesSystemInfo(client, deps()), {
      ncpu: undefined,
      memTotal: undefined,
    });
  });

  it('remembers that for five minutes, then asks again', async () => {
    const client = cluster(apiError(403, NODE_PATH));

    await readOwnNode(client, deps(0));
    await readOwnNode(client, deps(4 * 60_000));
    assert.equal(client.calls.length, 2);

    await readOwnNode(client, deps(5 * 60_000));
    assert.equal(client.calls.length, 4);
  });

  it('leaves both out when its own pod cannot be read or has no node yet', async () => {
    assert.deepEqual(
      await getKubernetesSystemInfo(fakeKubernetesClient(), deps()),
      { ncpu: undefined, memTotal: undefined },
    );

    resetKubernetesNodeCache();
    const unscheduled = fakeKubernetesClient({
      paths: { [POD_PATH]: { metadata: { name: 'conductor-0' }, spec: {} } },
    });

    assert.equal(await readOwnNode(unscheduled, deps()), undefined);
    assert.deepEqual(unscheduled.calls, [POD_PATH]);
  });

  it('parses Kubernetes quantities', () => {
    assert.equal(parseQuantity('8'), 8);
    assert.equal(parseQuantity('7910m'), 7.91);
    assert.equal(parseQuantity('16374572Ki'), 16374572 * 1024);
    assert.equal(parseQuantity('32Gi'), 32 * 1024 ** 3);
    assert.equal(parseQuantity('4G'), 4e9);
    assert.equal(parseQuantity('1e3'), 1000);
    assert.equal(parseQuantity('lots'), undefined);
    assert.equal(parseQuantity('5Xi'), undefined);
    assert.equal(parseQuantity(undefined), undefined);
  });

  it('rounds a fractional CPU count down, as Docker reports whole CPUs', async () => {
    const client = cluster({
      metadata: { name: 'node-a' },
      status: { capacity: { cpu: '3920m', memory: '1Gi' } },
    });

    assert.deepEqual(await getKubernetesSystemInfo(client, deps()), {
      ncpu: 3,
      memTotal: 1024 ** 3,
    });
  });
});
