import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as security from './index';

describe('security index', () => {
  it('exposes the Fastify auth plugin next to the role guards', () => {
    assert.equal(typeof security.authPlugin, 'function');
    assert.equal(typeof security.requireContainerAction, 'function');
    assert.equal(typeof security.getIntrospector, 'function');
    assert.equal(security.parseRole('MANAGER'), security.UserRole.MANAGER);
  });
});
