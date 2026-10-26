import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPOSE, CORRUPT_SHAPES } from '../../../testing/composeSandbox';
import inspectCompose from './inspectCompose';

describe('inspectCompose', () => {
  it('accepts a compose file and returns what it parsed', () => {
    const { problem, value } = inspectCompose(COMPOSE);
    assert.equal(problem, null);
    assert.deepEqual(Object.keys(value?.services), [
      'gluesync-core-hub',
      'gluesync-conductor',
    ]);
  });

  CORRUPT_SHAPES.forEach(([name, text]) => {
    it(`rejects ${name}`, () => {
      const { problem, value } = inspectCompose(text);
      assert.equal(typeof problem, 'string');
      assert.equal(value, undefined);
    });
  });
});
