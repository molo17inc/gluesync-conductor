import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import fakeSwarmDocker, {
  buildService,
} from '../../../testing/fakeSwarmDocker';
import loadWithStubs from '../../../testing/loadWithStubs';
import type { RestartSwarmStack } from './restartSwarmStack.model';

const here = (p: string): string => path.resolve(__dirname, p);

const ORCHESTRATOR = {
  mode: 'swarm',
  namespace: 'gs',
  selfService: 'gluesync-conductor',
  isManager: true,
} as const;

const load = (failing: ReadonlySet<string> = new Set()) => {
  const order: string[] = [];
  const restartSwarmStack = loadWithStubs<{ default: RestartSwarmStack }>(
    here('./restartSwarmStack'),
    {
      [here('../forceUpdateService/forceUpdateService')]: {
        default: async (_docker: unknown, name: string) => {
          order.push(`update ${name}`);
        },
      },
      [here('../waitForServiceConverged/waitForServiceConverged')]: {
        default: async (_docker: unknown, name: string) => {
          order.push(`wait ${name}`);
          return failing.has(name)
            ? { ok: false, reason: `${name} did not converge` }
            : { ok: true };
        },
      },
      [here('../../../utils/logger')]: {
        getLogger: () => ({ info: () => undefined, error: () => undefined }),
      },
    },
  ).default;

  return { restartSwarmStack, order };
};

const stack = () =>
  fakeSwarmDocker({
    services: [
      buildService('gluesync-conductor'),
      buildService('gluesync-core-hub'),
      buildService('grafana'),
      {
        ...buildService('foreign'),
        Spec: { ...buildService('foreign').Spec, Labels: {} },
      },
    ],
  }).docker;

describe('restartSwarmStack', () => {
  it('restarts every stack service, the conductor last', async () => {
    const { restartSwarmStack, order } = load();

    const results = await restartSwarmStack(stack(), ORCHESTRATOR);

    assert.deepEqual(results, [
      { id: 'gluesync-core-hub', ok: true },
      { id: 'grafana', ok: true },
      { id: 'gluesync-conductor', ok: true },
    ]);
    assert.equal(order[order.length - 1], 'update gs_gluesync-conductor');
    assert.deepEqual(
      order.filter(step => step.startsWith('wait')).sort(),
      ['wait gs_gluesync-core-hub', 'wait gs_grafana'],
      'the conductor is not waited for',
    );
    assert.equal(order.includes('update gs_foreign'), false);
  });

  it('restarts the conductor even when a service fails', async () => {
    const { restartSwarmStack, order } = load(new Set(['gs_grafana']));

    const results = await restartSwarmStack(stack(), ORCHESTRATOR);

    assert.deepEqual(results[1], {
      id: 'grafana',
      ok: false,
      error: 'gs_grafana did not converge',
    });
    assert.deepEqual(results[2], { id: 'gluesync-conductor', ok: true });
    assert.equal(order[order.length - 1], 'update gs_gluesync-conductor');
  });
});
