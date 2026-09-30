import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHRONOS_ROUTER_RULE_KEY,
  HEALED_CHRONOS_ROUTER_RULE,
  rewriteChronosRouterLabels,
} from './chronosRouterRule';

const chronosImage = 'molo17/gluesync-chronos:1.2.3';

describe('rewriteChronosRouterLabels', () => {
  it('rewrites a rule that contains standalone PathPrefix(`/api/`)', () => {
    const rule =
      'PathPrefix(`/chronos/`) || PathPrefix(`/api/`) || PathPrefix(`/chronos/api/`)';
    const { services, updatedIds } = rewriteChronosRouterLabels({
      'gluesync-chronos': {
        image: chronosImage,
        labels: [`${CHRONOS_ROUTER_RULE_KEY}=${rule}`],
      },
    });

    assert.deepEqual(updatedIds, ['gluesync-chronos']);
    assert.deepEqual(services['gluesync-chronos']?.labels, [
      `${CHRONOS_ROUTER_RULE_KEY}=${HEALED_CHRONOS_ROUTER_RULE}`,
    ]);
    assert.equal(services['gluesync-chronos']?.image, chronosImage);
  });

  it('leaves a rule that only has PathPrefix(`/chronos/api/`) unchanged', () => {
    const rule = 'PathPrefix(`/chronos/`) || PathPrefix(`/chronos/api/`)';
    const labels = [`${CHRONOS_ROUTER_RULE_KEY}=${rule}`];
    const { services, updatedIds } = rewriteChronosRouterLabels({
      'gluesync-chronos': {
        image: chronosImage,
        labels,
      },
    });

    assert.deepEqual(updatedIds, []);
    assert.equal(services['gluesync-chronos']?.labels, labels);
    assert.equal(services['gluesync-chronos']?.image, chronosImage);
  });
});
