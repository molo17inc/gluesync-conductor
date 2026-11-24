import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import createActionGate from '../actionGate/actionGate';
import runStartupHeals, { STARTUP_HEAL_ACTION } from './runStartupHeals';

const done = { statusCode: 200, body: 'idle' };

const later = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

// A promise the test settles, standing in for a running update
const held = () => {
  const cell = new Map<string, () => void>();
  const promise = new Promise<void>(resolve => {
    cell.set('release', resolve);
  });
  return { promise, release: () => cell.get('release')?.() };
};

describe('runStartupHeals', () => {
  it('runs the steps in order inside the gate, which refuses an update meanwhile', async () => {
    const gate = createActionGate<string>();
    const events: string[] = [];
    const inStep = held();

    const startup = runStartupHeals(
      [
        async () => {
          events.push(`first in ${gate.current()?.action}`);
          await inStep.promise;
        },
        async () => {
          events.push(`second in ${gate.current()?.action}`);
        },
      ],
      { enter: gate.enter, idleBody: () => 'idle' },
    );

    const update = gate.enter({ action: 'update', ids: [] }, async () => done);
    assert.equal(update.kind, 'busy');
    assert.equal(
      update.kind === 'busy' && update.running.action,
      STARTUP_HEAL_ACTION,
    );

    inStep.release();
    await startup;

    assert.deepEqual(events, [
      `first in ${STARTUP_HEAL_ACTION}`,
      `second in ${STARTUP_HEAL_ACTION}`,
    ]);
    assert.equal(gate.current(), undefined);
    assert.equal(
      gate.enter({ action: 'update', ids: [] }, async () => done).kind,
      'started',
    );
  });

  it('waits for an action that holds the gate, then runs: never concurrently, never skipped', async () => {
    const gate = createActionGate<string>();
    const update = held();
    const events: string[] = [];
    const waits: string[] = [];

    gate.enter({ action: 'update', ids: [] }, async () => {
      events.push('update start');
      await update.promise;
      events.push('update end');
      return done;
    });

    const startup = runStartupHeals(
      [
        async () => {
          events.push('startup step');
        },
      ],
      {
        enter: gate.enter,
        idleBody: () => 'idle',
        pause: () => later(1),
        onWait: running => waits.push(running.action),
      },
    );

    await later(20);
    assert.deepEqual(events, ['update start']);

    update.release();
    await startup;

    assert.deepEqual(events, ['update start', 'update end', 'startup step']);
    assert.deepEqual(waits, ['update']);
    assert.equal(gate.current(), undefined);
  });

  it('releases the gate when a step throws', async () => {
    const gate = createActionGate<string>({
      onThrow: () => ({ statusCode: 500, body: 'failed' }),
    });

    await runStartupHeals(
      [
        async () => {
          throw new Error('boom');
        },
      ],
      { enter: gate.enter, idleBody: () => 'idle' },
    );

    await later(1);
    assert.equal(gate.current(), undefined);
  });
});
