import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type Docker from 'dockerode';

import getOrchestrator, {
  getDecidedOrchestrator,
  isSwarm,
  resetOrchestratorCache,
} from '../getOrchestrator/getOrchestrator';
import getKubernetesOrchestrator from './getKubernetesOrchestrator';

const ENV_KEYS = [
  'CONDUCTOR_ORCHESTRATOR',
  'POD_NAMESPACE',
  'KUBERNETES_SERVICE_HOST',
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

// Any call would be a use of the container engine
const noDocker = () => {
  const calls: string[] = [];
  const docker = new Proxy(
    {},
    {
      get: (_target, property) => {
        calls.push(String(property));
        throw new Error(`docker.${String(property)} must not be used`);
      },
    },
  ) as Docker;

  return { docker, calls };
};

describe('getKubernetesOrchestrator', () => {
  it('answers kubernetes with the namespace, without asking Docker', async () => {
    process.env.CONDUCTOR_ORCHESTRATOR = 'kubernetes';
    process.env.POD_NAMESPACE = 'kit-test';
    const { docker, calls } = noDocker();

    const expected = { mode: 'kubernetes', namespace: 'kit-test' };

    assert.deepEqual(await getOrchestrator(docker), expected);
    assert.deepEqual(await getDecidedOrchestrator(docker), expected);
    assert.deepEqual(getKubernetesOrchestrator(), expected);
    assert.equal(await isSwarm(docker), false);
    assert.deepEqual(calls, []);
  });

  it('decides once per process', async () => {
    process.env.CONDUCTOR_ORCHESTRATOR = 'kubernetes';
    process.env.POD_NAMESPACE = 'first';
    assert.equal(getKubernetesOrchestrator()?.namespace, 'first');

    process.env.POD_NAMESPACE = 'second';
    delete process.env.CONDUCTOR_ORCHESTRATOR;
    assert.equal(getKubernetesOrchestrator()?.namespace, 'first');

    resetOrchestratorCache();
    assert.equal(getKubernetesOrchestrator(), undefined);
  });

  it('is not kubernetes when compose is forced, and compose is still decided as before', async () => {
    process.env.CONDUCTOR_ORCHESTRATOR = 'compose';
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1';
    const { docker, calls } = noDocker();

    assert.equal(getKubernetesOrchestrator(), undefined);
    assert.deepEqual(await getOrchestrator(docker), { mode: 'compose' });
    assert.deepEqual(calls, []);
  });
});
