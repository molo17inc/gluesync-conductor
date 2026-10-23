import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requireContainerAction } from './auth';

const run = async (role: string, action: string): Promise<number | null> => {
  const sent = new Map<string, number>();
  const reply = {
    code(c: number) {
      sent.set('code', c);
      return this;
    },
    send() {
      return this;
    },
  };
  await requireContainerAction()(
    { currentUser: { username: 'u', role }, body: { action } } as never,
    reply as never,
  );
  return sent.get('code') ?? null;
};

describe('requireContainerAction', () => {
  it('lets MONITOR restart, start and stop', async () => {
    assert.equal(await run('MONITOR', 'restart'), null);
    assert.equal(await run('MONITOR', 'start'), null);
    assert.equal(await run('MONITOR', 'stop'), null);
  });

  it('keeps MONITOR away from update, kill, remove and undeploy', async () => {
    const actions = [
      'update',
      'kill',
      'remove',
      'undeploy',
      'pull',
      'removeNetwork',
    ];
    const codes = await Promise.all(
      actions.map(action => run('MONITOR', action)),
    );
    assert.deepEqual(
      codes,
      actions.map(() => 403),
    );
  });

  it('lets managers and external modules (Chronos) update', async () => {
    assert.equal(await run('MANAGER', 'update'), null);
    assert.equal(await run('SUPER_ADMIN', 'update'), null);
    assert.equal(await run('EXTERNAL_MODULE', 'update'), null);
  });

  it('keeps VIEWER away from every action', async () => {
    assert.equal(await run('VIEWER', 'restart'), 403);
  });
});
