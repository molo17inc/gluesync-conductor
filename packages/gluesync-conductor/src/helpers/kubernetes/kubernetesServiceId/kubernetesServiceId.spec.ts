import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { kubernetesServiceType, toServiceId } from './kubernetesServiceId';

const release = (name: string) => ({ 'app.kubernetes.io/instance': name });

describe('toServiceId', () => {
  it('takes the release off the front of the workload name', () => {
    assert.equal(
      toServiceId('gluesync-gluesync-core-hub', release('gluesync')),
      'gluesync-core-hub',
    );
    assert.equal(
      toServiceId('prod-gluesync-chronos', release('prod')),
      'gluesync-chronos',
    );
    assert.equal(
      toServiceId('my-app-eu-gluesync-conductor', release('my-app-eu')),
      'gluesync-conductor',
    );
  });

  it('never assumes the release is called gluesync', () => {
    assert.equal(
      toServiceId('gluesync-core-hub', release('prod')),
      'gluesync-core-hub',
    );
    assert.equal(
      toServiceId('gluesync-gluesync-core-hub'),
      'gluesync-gluesync-core-hub',
    );
  });

  it('gives the third-party services the id of a Docker kit', () => {
    assert.equal(
      toServiceId('prod-gluesync-grafana', release('prod')),
      'grafana',
    );
    assert.equal(
      toServiceId('prod-gluesync-prometheus', release('prod')),
      'prometheus',
    );
    assert.equal(toServiceId('prod-grafana', release('prod')), 'grafana');
  });

  it('keeps a name that is only the release, or does not start with it', () => {
    assert.equal(toServiceId('prod-', release('prod')), 'prod-');
    assert.equal(toServiceId('other-thing', release('prod')), 'other-thing');
    assert.equal(toServiceId('conductor-k8s-test', {}), 'conductor-k8s-test');
  });
});

describe('kubernetesServiceType', () => {
  const type = (value: string) => ({ 'com.molo17.conductor.type': value });

  it('reads the Conductor type label of the workload', () => {
    assert.equal(
      kubernetesServiceType('custom', 'registry.local/custom:1', type('agent')),
      'agent',
    );
  });

  it('types a third-party id as in a Docker kit, whatever the chart labels it', () => {
    assert.equal(
      kubernetesServiceType('grafana', 'molo17/grafana:13', type('module')),
      'third-party',
    );
  });

  it('falls back to agents.json by image', () => {
    assert.equal(
      kubernetesServiceType(
        'gluesync-core-hub',
        'molo17/gluesync-core-hub:2.3.1',
      ),
      'core-hub',
    );
    assert.equal(
      kubernetesServiceType(
        'gluesync-chronos',
        'molo17/gluesync-chronos:0.0.72',
      ),
      'module',
    );
  });

  it('ignores a label that is not a Conductor type', () => {
    assert.equal(
      kubernetesServiceType(
        'gluesync-operator',
        'registry.local/not-in-catalog:1',
        type('operator'),
      ),
      'unknown',
    );
  });
});
