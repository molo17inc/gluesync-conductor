import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { servicesToStart } from './upAdoptedServices';

describe('servicesToStart', () => {
  it('starts a service reported by several adoption steps once', () => {
    assert.deepEqual(
      servicesToStart(
        [
          'gluesync-core-hub',
          'gluesync-chronos',
          'reverse-proxy',
          'gluesync-core-hub',
          'gluesync-core-hub',
        ],
        'gluesync-conductor',
      ),
      ['gluesync-core-hub', 'gluesync-chronos', 'reverse-proxy'],
    );
  });

  it('never starts the conductor itself', () => {
    assert.deepEqual(
      servicesToStart(
        ['gluesync-conductor', 'gluesync-core-hub', 'gluesync-conductor'],
        'gluesync-conductor',
      ),
      ['gluesync-core-hub'],
    );
  });
});
