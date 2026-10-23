import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import describeFailure from './describeFailure';

describe('describeFailure', () => {
  it('reads docker-compose rejections', () => {
    assert.equal(
      describeFailure({ exitCode: 1, err: 'no such service: x\n', out: '' }),
      'no such service: x',
    );
  });

  it('reads Error objects, which used to give an empty message', () => {
    assert.equal(
      describeFailure(new Error('grafana is unhealthy')),
      'grafana is unhealthy',
    );
  });

  it('falls back to out, strings and JSON', () => {
    assert.equal(describeFailure({ err: '', out: 'pulled' }), 'pulled');
    assert.equal(describeFailure('plain'), 'plain');
    assert.equal(describeFailure({ code: 7 }), '{"code":7}');
    assert.equal(describeFailure(undefined), 'unknown error');
  });
});
