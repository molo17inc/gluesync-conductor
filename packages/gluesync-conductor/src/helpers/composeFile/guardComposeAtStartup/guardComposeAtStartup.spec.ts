import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { COMPOSE, makeComposeSandbox } from '../../../testing/composeSandbox';
import { guardComposeAtStartup, runStartupStep } from './guardComposeAtStartup';

let sandbox = makeComposeSandbox();
afterEach(() => sandbox.restore());

describe('guardComposeAtStartup', () => {
  it('makes a valid compose file the last-good copy', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose(COMPOSE);
    await guardComposeAtStartup();
    assert.equal(sandbox.read(sandbox.lastGood), COMPOSE);
    assert.equal(sandbox.read(sandbox.compose), COMPOSE);
  });

  it('restores a blanked compose file from the last-good copy', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setLastGood(COMPOSE);
    sandbox.setCompose('');
    await guardComposeAtStartup();
    assert.equal(sandbox.read(sandbox.compose), COMPOSE);
    assert.equal(sandbox.read(sandbox.lastGood), COMPOSE);
  });

  it('does not throw when there is nothing to restore from, and writes nothing', async () => {
    sandbox = makeComposeSandbox();
    sandbox.setCompose('');
    await guardComposeAtStartup();
    assert.equal(sandbox.read(sandbox.compose), '');
    assert.equal(existsSync(sandbox.lastGood), false);
  });

  it('does not throw when there is no compose file', async () => {
    sandbox = makeComposeSandbox();
    await guardComposeAtStartup();
    assert.equal(existsSync(sandbox.lastGood), false);
  });
});

describe('runStartupStep', () => {
  it('returns what the step returns', async () => {
    assert.equal(await runStartupStep('x', async () => 7, 0), 7);
  });

  it('logs a failing step and carries on with the fallback', async () => {
    assert.equal(
      await runStartupStep(
        'x',
        async () => {
          throw new Error('disk full');
        },
        'fallback',
      ),
      'fallback',
    );
  });
});
