import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import createActionGate from './actionGate';
import { ActionOutcome } from './actionGate.model';

type Settle = Readonly<{
  resolve: (outcome: ActionOutcome<string>) => void;
  reject: (error: unknown) => void;
}>;

// A promise settled by the test, standing in for a running container action.
const deferred = (): Readonly<{
  promise: Promise<ActionOutcome<string>>;
  settle: Settle;
}> => {
  const cell = new Map<string, (v: never) => void>();
  const promise = new Promise<ActionOutcome<string>>((resolve, reject) => {
    cell.set('resolve', resolve);
    cell.set('reject', reject);
  });
  return {
    promise,
    settle: {
      resolve: outcome => cell.get('resolve')?.(outcome as never),
      reject: error => cell.get('reject')?.(error as never),
    },
  };
};

const update = (ids: ReadonlyArray<string>) => ({ action: 'update', ids });

describe('actionGate', () => {
  it('runs the first request and releases the lock when it finishes', async () => {
    const gate = createActionGate<string>();
    const first = deferred();
    const entry = gate.enter(update(['grafana']), () => first.promise);

    assert.equal(entry.kind, 'started');
    assert.equal(gate.current()?.action, 'update');

    first.settle.resolve({ statusCode: 200, body: 'done' });
    assert.deepEqual(await entry.outcome, { statusCode: 200, body: 'done' });
    // The lock goes on the next microtask after the outcome settles.
    await Promise.resolve();
    assert.equal(gate.current(), undefined);
  });

  it('lets a retry of the same action and ids join the running one', async () => {
    const gate = createActionGate<string>();
    const first = deferred();
    const calls = new Map<string, number>([['perform', 0]]);
    const perform = () => {
      calls.set('perform', (calls.get('perform') ?? 0) + 1);
      return first.promise;
    };

    const started = gate.enter(update(['reverse-proxy']), perform);
    const retry = gate.enter(update(['reverse-proxy']), perform);

    assert.equal(started.kind, 'started');
    assert.equal(retry.kind, 'joined');
    assert.equal(calls.get('perform'), 1, 'the action runs once');

    first.settle.resolve({ statusCode: 200, body: 'proxy updated' });
    assert.deepEqual(await retry.outcome, {
      statusCode: 200,
      body: 'proxy updated',
    });
  });

  it('ignores the order of ids when matching a retry', () => {
    const gate = createActionGate<string>();
    const first = deferred();
    gate.enter(update(['a', 'b']), () => first.promise);
    assert.equal(
      gate.enter(update(['b', 'a']), () => first.promise).kind,
      'joined',
    );
    first.settle.resolve({ statusCode: 200, body: '' });
  });

  it('refuses a different action while one is running', () => {
    const gate = createActionGate<string>();
    const first = deferred();
    gate.enter(update(['grafana']), () => first.promise);

    const otherIds = gate.enter(update(['prometheus']), () => first.promise);
    const otherAction = gate.enter(
      { action: 'restart', ids: ['grafana'] },
      () => first.promise,
    );
    const updateAll = gate.enter(update([]), () => first.promise);

    assert.equal(otherIds.kind, 'busy');
    assert.equal(otherAction.kind, 'busy');
    assert.equal(updateAll.kind, 'busy');
    assert.equal(otherIds.kind === 'busy' && otherIds.running.action, 'update');
    first.settle.resolve({ statusCode: 200, body: '' });
  });

  it('releases the lock and maps a thrown error for joiners', async () => {
    const gate = createActionGate<string>({
      onThrow: error => ({ statusCode: 500, body: String(error) }),
    });
    const first = deferred();
    const started = gate.enter(update(['grafana']), () => first.promise);
    const joined = gate.enter(update(['grafana']), () => first.promise);

    first.settle.reject(new Error('boom'));
    assert.equal(started.kind, 'started');
    assert.deepEqual(started.kind === 'started' && (await started.outcome), {
      statusCode: 500,
      body: 'Error: boom',
    });
    assert.equal(joined.kind, 'joined');
    assert.deepEqual(joined.kind === 'joined' && (await joined.outcome), {
      statusCode: 500,
      body: 'Error: boom',
    });
    await Promise.resolve();
    assert.equal(gate.current(), undefined);
    assert.equal(
      gate.enter(update(['grafana']), () => first.promise).kind,
      'started',
    );
  });
});
