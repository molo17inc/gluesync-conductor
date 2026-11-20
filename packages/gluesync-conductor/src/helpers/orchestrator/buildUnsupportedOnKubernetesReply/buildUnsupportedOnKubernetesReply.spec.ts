import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import buildUnsupportedOnKubernetesReply from './buildUnsupportedOnKubernetesReply';

describe('buildUnsupportedOnKubernetesReply', () => {
  it('is an error body that names the route and carries the KUBERNETES_UNSUPPORTED diagnosis', () => {
    const reply = buildUnsupportedOnKubernetesReply(
      'POST /containers (update)',
    );

    assert.equal(reply.success, false);
    assert.equal(
      reply.error,
      'POST /containers (update) is not supported on Kubernetes yet',
    );
    assert.match(reply.details ?? '', /nothing was changed/);
    assert.equal(reply.diagnosis?.code, 'KUBERNETES_UNSUPPORTED');
    assert.equal(reply.diagnosis?.owner, 'local');
    assert.equal(reply.diagnosis?.params?.feature, 'POST /containers (update)');
    assert.equal(
      reply.diagnosis?.fallback.summary,
      'POST /containers (update) is not supported yet when Gluesync runs on Kubernetes.',
    );
  });
});
