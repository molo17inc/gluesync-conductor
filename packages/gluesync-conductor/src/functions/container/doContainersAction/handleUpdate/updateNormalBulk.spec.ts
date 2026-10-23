/* eslint-disable no-throw-literal -- docker-compose rejects with plain { err } objects */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { RawComposeFile } from '../../../../models/composeFile.model';
import type { RollbackOutcome } from '../../../../helpers/rollbackServiceImages/rollbackServiceImages.model';
import loadWithStubs from '../../../../testing/loadWithStubs';
import type { UpdateNormalBulk } from './updateNormalBulk.model';

const here = (p: string): string => path.resolve(__dirname, p);

const originalCoreHub = process.env.CORE_HUB_NAME;
afterEach(() => {
  if (originalCoreHub === undefined) {
    delete process.env.CORE_HUB_NAME;
  } else {
    process.env.CORE_HUB_NAME = originalCoreHub;
  }
});

const compose = {
  services: {
    'gluesync-core-hub': { image: 'hub:1' },
    grafana: { image: 'grafana:1' },
    chronos: { image: 'chronos:1' },
    noimage: {},
  },
} as unknown as RawComposeFile;

const load = (
  prepared: {
    effectiveIds: readonly string[];
    skipped?: ReadonlyArray<{ id: string; reason: string }>;
  },
  outcomes: ReadonlyArray<RollbackOutcome> = [],
) => {
  const rollbackCalls: unknown[][] = [];
  const prepareCalls: unknown[][] = [];
  const bulk = loadWithStubs<{ default: UpdateNormalBulk }>(
    here('./updateNormalBulk'),
    {
      [here('../prepareComposeUpdate/prepareComposeUpdate')]: {
        default: async (...args: unknown[]) => {
          prepareCalls.push(args);
          return { skipped: [], ...prepared };
        },
      },
      [here('../../../../helpers/rollbackServiceImages/rollbackServiceImages')]:
        {
          default: async (...args: unknown[]) => {
            rollbackCalls.push(args);
            return outcomes;
          },
        },
    },
  ).default;
  return { bulk, rollbackCalls, prepareCalls };
};

describe('updateNormalBulk', () => {
  it('updates the core hub first and does not roll back on success', async () => {
    const { bulk, rollbackCalls } = load({
      effectiveIds: ['grafana', 'gluesync-core-hub', 'chronos'],
    });
    const order: string[] = [];
    const { orderedIds, results } = await bulk(
      async id => {
        order.push(id);
        return `${id} done`;
      },
      compose,
      [],
      'ga',
    );
    assert.deepEqual(order, ['gluesync-core-hub', 'grafana', 'chronos']);
    assert.deepEqual(orderedIds, order);
    assert.deepEqual(
      results.map(r => (r.status === 'fulfilled' ? r.value : null)),
      ['gluesync-core-hub done', 'grafana done', 'chronos done'],
    );
    assert.deepEqual(rollbackCalls, [[[], { recreate: true }]]);
  });

  it('honours CORE_HUB_NAME when ordering', async () => {
    process.env.CORE_HUB_NAME = 'my-hub';
    const { bulk } = load({ effectiveIds: ['grafana', 'my-hub'] });
    const { orderedIds } = await bulk(async id => id, compose, [], 'ga');
    assert.deepEqual(orderedIds, ['my-hub', 'grafana']);
  });

  it('rolls failed services back and says so in their result', async () => {
    const { bulk, rollbackCalls } = load(
      { effectiveIds: ['grafana', 'chronos', 'noimage', 'gluesync-core-hub'] },
      [
        { id: 'grafana', image: 'grafana:1', ok: true },
        { id: 'chronos', image: 'chronos:1', ok: false, error: 'up failed' },
      ],
    );
    const { orderedIds, results } = await bulk(
      async id => {
        if (id === 'gluesync-core-hub') {
          return 'ok';
        }
        if (id === 'grafana') {
          throw { exitCode: 1, err: 'pull failed' };
        }
        if (id === 'chronos') {
          throw new Error('did not stay up');
        }
        throw 'plain failure';
      },
      compose,
      [],
      'ga',
    );
    assert.deepEqual(orderedIds, [
      'gluesync-core-hub',
      'grafana',
      'chronos',
      'noimage',
    ]);
    assert.deepEqual(rollbackCalls, [
      [
        [
          { id: 'grafana', image: 'grafana:1' },
          { id: 'chronos', image: 'chronos:1' },
        ],
        { recreate: true },
      ],
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.deepEqual(results.slice(1), [
      {
        status: 'rejected',
        reason: { err: 'pull failed Rolled back to grafana:1.' },
      },
      {
        status: 'rejected',
        reason: {
          err: 'did not stay up Rollback to chronos:1 failed: up failed',
        },
      },
      { status: 'rejected', reason: { err: 'plain failure' } },
    ]);
  });

  it('reports skipped services as not updated after the rest', async () => {
    const { bulk } = load({
      effectiveIds: ['grafana'],
      skipped: [
        { id: 'redis', reason: 'Could not get the latest version of redis' },
      ],
    });
    const { orderedIds, results } = await bulk(
      async id => id,
      compose,
      ['grafana', 'redis'],
      'ga',
    );
    assert.deepEqual(orderedIds, ['grafana', 'redis']);
    assert.equal(results[0].status, 'fulfilled');
    assert.deepEqual(results[1], {
      status: 'rejected',
      reason: {
        err: 'Could not get the latest version of redis. Not updated.',
      },
    });
  });

  it('only puts the stack file back on Swarm, where the update action rolled the service back', async () => {
    const { bulk, rollbackCalls } = load({ effectiveIds: ['grafana'] });
    await bulk(
      async () => {
        throw new Error('not stable');
      },
      compose,
      [],
      'ga',
      { swarm: true },
    );
    assert.deepEqual(rollbackCalls, [
      [[{ id: 'grafana', image: 'grafana:1' }], { recreate: false }],
    ]);
  });

  it('passes the orchestrator on, so the types are read the way it needs', async () => {
    const swarm = load({ effectiveIds: [] });
    const onCompose = load({ effectiveIds: [] });

    await swarm.bulk(async id => id, compose, [], 'ga', { swarm: true });
    await onCompose.bulk(async id => id, compose, [], 'ga');

    assert.deepEqual(swarm.prepareCalls[0][3], { swarm: true });
    assert.deepEqual(onCompose.prepareCalls[0][3], { swarm: false });
  });
});
