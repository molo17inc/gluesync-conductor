import assert from 'node:assert/strict';
import os from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import getOrchestrator, {
  getDecidedOrchestrator,
  isSwarm,
  resetOrchestratorCache,
} from './getOrchestrator';

const ENV_KEYS = [
  'CONDUCTOR_ORCHESTRATOR',
  'SWARM_STACK_NAMESPACE',
  'CONDUCTOR_NAME',
] as const;

const saved = ENV_KEYS.map(key => [key, process.env[key]] as const);

beforeEach(() => {
  ENV_KEYS.forEach(key => {
    delete process.env[key];
  });
  resetOrchestratorCache();
});

afterEach(() => {
  saved.forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  resetOrchestratorCache();
});

const SWARM_LABELS = {
  'com.docker.swarm.service.name': 'gs_gluesync-conductor',
  'com.docker.stack.namespace': 'gs',
};

type Setup = Readonly<{
  labels?: Record<string, string>;
  inspectError?: unknown;
  controlAvailable?: boolean;
  infoError?: Error;
}>;

const fakeDocker = ({
  labels = {},
  inspectError,
  controlAvailable = true,
  infoError,
}: Setup = {}) => {
  const inspected: string[] = [];
  const counts = { info: 0 };
  const docker = {
    getContainer: (id: string) => ({
      inspect: async () => {
        inspected.push(id);
        if (inspectError) {
          throw inspectError;
        }
        return { Config: { Labels: labels } };
      },
    }),
    info: async () => {
      counts.info += 1;
      if (infoError) {
        throw infoError;
      }
      return { Swarm: { ControlAvailable: controlAvailable } };
    },
  } as unknown as Docker;

  return { docker, inspected, counts };
};

describe('getOrchestrator', () => {
  it('is compose when the container has no swarm labels', async () => {
    const { docker, counts } = fakeDocker({ labels: { foo: 'bar' } });

    assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
    assert.equal(counts.info, 0);
  });

  it('inspects its own container by hostname', async () => {
    const { docker, inspected } = fakeDocker();

    await getOrchestrator(docker);

    assert.deepEqual(inspected, [os.hostname()]);
  });

  it('is swarm with namespace and service name from the labels', async () => {
    const { docker } = fakeDocker({ labels: SWARM_LABELS });

    assert.deepEqual(await getOrchestrator(docker), {
      mode: 'swarm',
      namespace: 'gs',
      selfService: 'gluesync-conductor',
      isManager: true,
    });
  });

  it('keeps a service name that has no namespace prefix', async () => {
    const { docker } = fakeDocker({
      labels: { ...SWARM_LABELS, 'com.docker.swarm.service.name': 'conductor' },
    });

    assert.deepEqual(await getOrchestrator(docker), {
      mode: 'swarm',
      namespace: 'gs',
      selfService: 'conductor',
      isManager: true,
    });
  });

  it('is not a manager when the node has no swarm control', async () => {
    const { docker } = fakeDocker({
      labels: SWARM_LABELS,
      controlAvailable: false,
    });

    const orchestrator = await getOrchestrator(docker);

    assert.equal(
      orchestrator.mode === 'swarm' && orchestrator.isManager,
      false,
    );
    assert.equal(orchestrator.mode, 'swarm');
  });

  it('is compose when it has a service label but no stack', async () => {
    const { docker } = fakeDocker({
      labels: { 'com.docker.swarm.service.name': 'lonely' },
    });

    assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
  });

  describe('forced by CONDUCTOR_ORCHESTRATOR', () => {
    it('compose skips every Docker call', async () => {
      process.env.CONDUCTOR_ORCHESTRATOR = 'compose';
      const { docker, inspected } = fakeDocker({ labels: SWARM_LABELS });

      assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
      assert.deepEqual(inspected, []);
    });

    it('swarm takes the namespace from SWARM_STACK_NAMESPACE', async () => {
      process.env.CONDUCTOR_ORCHESTRATOR = 'Swarm';
      process.env.SWARM_STACK_NAMESPACE = 'kit';
      const { docker } = fakeDocker({
        inspectError: Object.assign(new Error('no such container'), {
          statusCode: 404,
        }),
      });

      assert.deepEqual(await getOrchestrator(docker), {
        mode: 'swarm',
        namespace: 'kit',
        selfService: 'gluesync-conductor',
        isManager: true,
      });
    });

    it('swarm falls back to the stack label of the container', async () => {
      process.env.CONDUCTOR_ORCHESTRATOR = 'swarm';
      process.env.CONDUCTOR_NAME = 'my-conductor';
      const { docker } = fakeDocker({ labels: SWARM_LABELS });

      assert.deepEqual(await getOrchestrator(docker), {
        mode: 'swarm',
        namespace: 'gs',
        selfService: 'my-conductor',
        isManager: true,
      });
    });

    it('swarm without any namespace falls back to compose', async () => {
      process.env.CONDUCTOR_ORCHESTRATOR = 'swarm';
      const { docker } = fakeDocker();

      assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
    });
  });

  describe('failures', () => {
    it('is compose, and cached, when the hostname is not a container', async () => {
      const { docker, inspected } = fakeDocker({
        inspectError: Object.assign(new Error('no such container'), {
          statusCode: 404,
        }),
      });

      assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
      await getOrchestrator(docker);
      assert.equal(inspected.length, 1);
    });

    it('is compose, and not cached, when Docker cannot be asked', async () => {
      const { docker, inspected } = fakeDocker({
        inspectError: new Error('socket hang up'),
      });

      assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
      await getOrchestrator(docker);
      assert.equal(inspected.length, 2);
    });

    it('is compose when docker.info fails in a swarm container', async () => {
      const { docker } = fakeDocker({
        labels: SWARM_LABELS,
        infoError: new Error('daemon down'),
      });

      assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
    });

    it('detects again after a failure once Docker answers', async () => {
      const failing = fakeDocker({
        infoError: new Error('x'),
        labels: SWARM_LABELS,
      });
      await getOrchestrator(failing.docker);

      const { docker } = fakeDocker({ labels: SWARM_LABELS });

      assert.equal((await getOrchestrator(docker)).mode, 'swarm');
    });
  });

  describe('cache', () => {
    it('detects once and reuses the answer', async () => {
      const { docker, inspected, counts } = fakeDocker({
        labels: SWARM_LABELS,
      });

      const first = await getOrchestrator(docker);
      const second = await getOrchestrator(docker);

      assert.equal(first, second);
      assert.equal(inspected.length, 1);
      assert.equal(counts.info, 1);
    });

    it('can be reset', async () => {
      const { docker, inspected } = fakeDocker();

      await getOrchestrator(docker);
      resetOrchestratorCache();
      await getOrchestrator(docker);

      assert.equal(inspected.length, 2);
    });
  });
});

describe('isSwarm', () => {
  it('tells swarm from compose', async () => {
    assert.equal(
      await isSwarm(fakeDocker({ labels: SWARM_LABELS }).docker),
      true,
    );

    resetOrchestratorCache();

    assert.equal(await isSwarm(fakeDocker().docker), false);
  });
});

describe('getDecidedOrchestrator', () => {
  it('does not guess compose when Docker cannot be asked', async () => {
    const { docker, inspected } = fakeDocker({
      inspectError: new Error('socket hang up'),
    });

    assert.equal(await getDecidedOrchestrator(docker), undefined);
    assert.equal(await getDecidedOrchestrator(docker), undefined);
    assert.equal(inspected.length, 2, 'it is not cached');
  });

  it('does not guess compose when docker.info fails in a swarm container', async () => {
    const { docker } = fakeDocker({
      labels: SWARM_LABELS,
      infoError: new Error('daemon down'),
    });

    assert.equal(await getDecidedOrchestrator(docker), undefined);
  });

  it('answers once Docker answers, and caches the answer', async () => {
    const failing = fakeDocker({ inspectError: new Error('x') });
    assert.equal(await getDecidedOrchestrator(failing.docker), undefined);

    const { docker, inspected } = fakeDocker({ labels: SWARM_LABELS });
    const first = await getDecidedOrchestrator(docker);
    const second = await getDecidedOrchestrator(docker);

    assert.equal(first?.mode, 'swarm');
    assert.equal(first, second);
    assert.equal(inspected.length, 1);
  });

  it('treats a hostname Docker does not know as a decided compose', async () => {
    const { docker } = fakeDocker({
      inspectError: Object.assign(new Error('no such container'), {
        statusCode: 404,
      }),
    });

    assert.deepEqual(await getDecidedOrchestrator(docker), { mode: 'compose' });
  });
});
