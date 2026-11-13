import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  conductorRestartRequested,
  requestConductorRestart,
  takeConductorRestart,
} from './conductorRestartAfterUpdate';

describe('conductorRestartAfterUpdate', () => {
  it('keeps one request until it is taken', () => {
    assert.equal(takeConductorRestart(), false);
    requestConductorRestart();
    requestConductorRestart();
    assert.equal(conductorRestartRequested(), true);
    assert.equal(takeConductorRestart(), true);
    assert.equal(conductorRestartRequested(), false);
    assert.equal(takeConductorRestart(), false);
  });
});
