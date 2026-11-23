import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fakeKubernetesClient, {
  buildWorkload,
  chartCluster,
} from '../../../../testing/fakeKubernetesClient';
import { AgentInfoResponse } from '../../../../helpers/agentInfo/agentInfo.model';
import performKubernetesAction from './kubernetesActions';

const rollout = {
  timeoutMs: 1000,
  stabilityMs: 0,
  clock: { now: () => 0, sleep: async () => undefined },
};

const fetchAgentInfo = async (): Promise<AgentInfoResponse> =>
  ({ latestVersionGA: '9.9.9' }) as AgentInfoResponse;

describe('performKubernetesAction', () => {
  it('updates through the Kubernetes API and answers the items of a Docker kit', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const outcome = await performKubernetesAction(
      { action: 'update', ids: ['gluesync-chronos'], releaseChannel: 'ga' },
      { client, rollout, fetchAgentInfo, pipelineMaintenance: undefined },
    );

    assert.equal(outcome.statusCode, 200);
    assert.deepEqual(outcome.body, {
      success: true,
      data: {
        containers: [
          { id: 'gluesync-chronos', status: 'OK', message: 'Updated to 9.9.9' },
        ],
      },
    });
    assert.equal(client.patches.length, 1);
  });

  it('refuses an update where the Gluesync operator runs, and changes nothing', async () => {
    const cluster = chartCluster();
    const client = fakeKubernetesClient({
      ...cluster,
      deployments: [
        ...cluster.deployments,
        buildWorkload('prod-gluesync-operator', {
          image: 'molo17/gluesync-operator:1.0.0',
          type: 'operator',
        }),
      ],
    });

    const outcome = await performKubernetesAction(
      { action: 'update', ids: ['gluesync-chronos'], releaseChannel: 'ga' },
      { client, rollout, fetchAgentInfo },
    );

    assert.equal(outcome.statusCode, 409);
    assert.equal(
      (outcome.body as { error: string }).error,
      'Updates are applied by the Gluesync operator',
    );
    assert.deepEqual(client.patches, []);
  });

  it('restarts through the Kubernetes API', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const outcome = await performKubernetesAction(
      { action: 'restart', ids: ['grafana'], releaseChannel: 'ga' },
      { client, rollout },
    );

    assert.equal(outcome.statusCode, 200);
    assert.equal(client.patches.length, 1);
  });

  it('answers 501 for the other actions', async () => {
    const client = fakeKubernetesClient(chartCluster());

    const outcome = await performKubernetesAction(
      { action: 'stop', ids: ['grafana'], releaseChannel: 'ga' },
      { client },
    );

    assert.equal(outcome.statusCode, 501);
    assert.deepEqual(client.calls, []);
  });
});
