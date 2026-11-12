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

const docker = {} as never;

const load = (
  prepared: {
    effectiveIds: readonly string[];
    skipped?: ReadonlyArray<{ id: string; reason: string }>;
  },
  outcomes: ReadonlyArray<RollbackOutcome> = [],
  snapshot: () => Promise<Record<string, string>> = async () => ({
    grafana: 'before',
  }),
) => {
  const rollbackCalls: unknown[][] = [];
  const prepareCalls: unknown[][] = [];
  const swarmSnapshots: string[] = [];
  const bulk = loadWithStubs<{ default: UpdateNormalBulk }>(
    here('./updateNormalBulk'),
    {
      [here('../prepareComposeUpdate/prepareComposeUpdate')]: {
        default: async (...args: unknown[]) => {
          prepareCalls.push(args);
          return { skipped: [], ...prepared };
        },
      },
      [here('../../../../helpers/serviceContainers/serviceContainers')]: {
        fingerprintServices: snapshot,
      },
      [here(
        '../../../../helpers/swarm/fingerprintSwarmServices/fingerprintSwarmServices',
      )]: {
        default: async (_docker: unknown, namespace: string) => {
          swarmSnapshots.push(namespace);
          return { grafana: 'swarm-before' };
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
  return { bulk, rollbackCalls, prepareCalls, swarmSnapshots };
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
      { docker },
    );
    assert.deepEqual(order, ['gluesync-core-hub', 'grafana', 'chronos']);
    assert.deepEqual(orderedIds, order);
    assert.deepEqual(
      results.map(r => (r.status === 'fulfilled' ? r.value : null)),
      ['gluesync-core-hub done', 'grafana done', 'chronos done'],
    );
    assert.deepEqual(rollbackCalls, [
      [
        [],
        {
          recreate: true,
          docker,
          before: { grafana: 'before' },
          services: ['gluesync-core-hub', 'grafana', 'chronos'],
        },
      ],
    ]);
  });

  it('honours CORE_HUB_NAME when ordering', async () => {
    process.env.CORE_HUB_NAME = 'my-hub';
    const { bulk } = load({ effectiveIds: ['grafana', 'my-hub'] });
    const { orderedIds } = await bulk(async id => id, compose, [], 'ga', {
      docker,
    });
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
      { docker },
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
        {
          recreate: true,
          docker,
          before: { grafana: 'before' },
          services: ['gluesync-core-hub', 'grafana', 'chronos', 'noimage'],
        },
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
      { docker },
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

  it('says nothing was changed when Docker was down and no container was touched', async () => {
    const { bulk } = load({ effectiveIds: ['grafana', 'chronos'] }, [
      { id: 'grafana', image: 'grafana:1', ok: true, untouched: true },
      { id: 'chronos', image: 'chronos:1', ok: true, untouched: true },
    ]);
    const { results } = await bulk(
      async id => {
        if (id === 'grafana') {
          throw {
            exitCode: 1,
            err: 'error during connect: Get "http://docker.sock/v1.47/info": EOF',
          };
        }
        throw { exitCode: 1, err: 'pull access denied for chronos' };
      },
      compose,
      [],
      'ga',
      { docker },
    );
    assert.equal(
      (results[0] as PromiseRejectedResult).reason.err,
      'error during connect: Get "http://docker.sock/v1.47/info": EOF Docker was unavailable; nothing was changed.',
    );
    // Not a Docker failure: the compose file went back, the container was never touched.
    assert.equal(
      (results[1] as PromiseRejectedResult).reason.err,
      'pull access denied for chronos Compose file restored to chronos:1; the running container was not touched.',
    );
  });

  it('carries on without a snapshot when Docker does not answer before the update', async () => {
    const { bulk, rollbackCalls } = load(
      { effectiveIds: ['grafana'] },
      [{ id: 'grafana', image: 'grafana:1', ok: true }],
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
    );
    await bulk(
      async () => {
        throw new Error('did not stay up');
      },
      compose,
      [],
      'ga',
      { docker },
    );
    const options = rollbackCalls[0][1] as { before?: unknown };
    assert.equal(options.before, undefined);
  });

  it('never reports OK for a service that is broken after the rollback', async () => {
    const { bulk } = load({ effectiveIds: ['grafana', 'chronos'] }, [
      { id: 'grafana', image: 'grafana:1', ok: true },
      {
        id: 'chronos',
        image: '',
        ok: false,
        error: 'chronos is not running (exited)',
      },
    ]);
    const { results } = await bulk(
      async id => {
        if (id === 'grafana') {
          throw new Error('did not stay up');
        }
        return 'chronos updated';
      },
      compose,
      [],
      'ga',
      { docker },
    );
    assert.deepEqual(results[1], {
      status: 'rejected',
      reason: {
        err: 'chronos updated But now: chronos is not running (exited)',
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
      { swarm: true, docker },
    );
    assert.deepEqual(rollbackCalls, [
      [[{ id: 'grafana', image: 'grafana:1' }], { recreate: false }],
    ]);
  });

  it('restores the services through the Swarm API when it knows the stack', async () => {
    const { bulk, rollbackCalls, swarmSnapshots } = load({
      effectiveIds: ['grafana'],
    });
    await bulk(
      async () => {
        throw new Error('not stable');
      },
      compose,
      [],
      'ga',
      { swarm: true, namespace: 'gs', docker },
    );
    assert.deepEqual(swarmSnapshots, ['gs']);
    assert.deepEqual(rollbackCalls, [
      [
        [{ id: 'grafana', image: 'grafana:1' }],
        {
          recreate: true,
          docker,
          before: { grafana: 'swarm-before' },
          services: ['grafana'],
          swarm: { namespace: 'gs' },
        },
      ],
    ]);
  });

  it('passes the orchestrator on, so the types are read the way it needs', async () => {
    const swarm = load({ effectiveIds: [] });
    const onCompose = load({ effectiveIds: [] });

    await swarm.bulk(async id => id, compose, [], 'ga', { swarm: true });
    await onCompose.bulk(async id => id, compose, [], 'ga', { docker });

    const optionsOf = (call: unknown[]) => call[3] as { swarm: boolean };
    assert.equal(optionsOf(swarm.prepareCalls[0]).swarm, true);
    assert.equal(optionsOf(onCompose.prepareCalls[0]).swarm, false);
  });
});

describe('updateNormalBulk: pipelines in maintenance mode', () => {
  type Events = string[];

  const fakeMaintenance = (
    events: Events,
    pause: () => Promise<{
      paused: string[];
      alreadyInMaintenance: string[];
      coreHubUnreachable?: string;
    }> = async () => ({ paused: ['p1', 'p2'], alreadyInMaintenance: ['p9'] }),
  ) => ({
    pause: async () => {
      events.push('pause');
      return pause();
    },
    resume: async () => {
      events.push('resume');
      return { resumed: ['p1', 'p2'], notResumed: [] };
    },
  });

  // prepareComposeUpdate as it really behaves: the hook runs before the
  // compose file is written, and a throw stops it there
  const loadWithHook = (
    effectiveIds: readonly string[],
    events: Events,
    outcomes: ReadonlyArray<RollbackOutcome> = [],
  ) =>
    loadWithStubs<{ default: UpdateNormalBulk }>(here('./updateNormalBulk'), {
      [here('../prepareComposeUpdate/prepareComposeUpdate')]: {
        default: async (
          _compose: unknown,
          _ids: unknown,
          _channel: unknown,
          options: {
            beforeImagesChange?: (ids: readonly string[]) => Promise<void>;
          },
        ) => {
          await options.beforeImagesChange?.(effectiveIds);
          events.push('compose written');
          return { effectiveIds, skipped: [] };
        },
      },
      [here('../../../../helpers/serviceContainers/serviceContainers')]: {
        fingerprintServices: async () => ({}),
      },
      [here('../../../../helpers/rollbackServiceImages/rollbackServiceImages')]:
        {
          default: async (rollbacks: ReadonlyArray<{ id: string }>) => {
            events.push(`rollback ${rollbacks.map(r => r.id).join(',')}`);
            return outcomes;
          },
        },
    }).default;

  it('pauses before the compose file changes and resumes as soon as Core Hub is stable, before the modules finish', async () => {
    const events: Events = [];
    const bulk = loadWithHook(['grafana', 'gluesync-core-hub'], events);
    const grafanaDone = { release: () => {} };

    const update = bulk(
      async id => {
        events.push(`update ${id}`);
        if (id === 'grafana') {
          await new Promise<void>(resolve => {
            grafanaDone.release = resolve;
          });
        }
        events.push(`stable ${id}`);
        return `${id} done`;
      },
      compose,
      [],
      'ga',
      { docker, pipelineMaintenance: fakeMaintenance(events) },
    );
    // Core Hub's pipelines come back while grafana is still updating
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    assert.ok(events.includes('resume'));
    assert.ok(!events.includes('stable grafana'));
    grafanaDone.release();
    const result = await update;

    assert.deepEqual(events.slice(0, 2), ['pause', 'compose written']);
    assert.ok(
      events.indexOf('resume') > events.indexOf('stable gluesync-core-hub'),
    );
    // Resumed once
    assert.equal(events.filter(e => e === 'resume').length, 1);
    assert.deepEqual(result.pipelines, {
      service: 'gluesync-core-hub',
      paused: ['p1', 'p2'],
      resumed: ['p1', 'p2'],
      notResumed: [],
      alreadyInMaintenance: ['p9'],
    });
  });

  it('a failed Core Hub resumes its pipelines only after its rollback', async () => {
    const events: Events = [];
    const bulk = loadWithHook(['gluesync-core-hub'], events, [
      { id: 'gluesync-core-hub', ok: true, image: 'hub:1' },
    ]);

    const result = await bulk(
      async id => {
        events.push(`update ${id}`);
        throw new Error('gluesync-core-hub is not staying up after the update');
      },
      compose,
      [],
      'ga',
      { docker, pipelineMaintenance: fakeMaintenance(events) },
    );

    assert.deepEqual(events, [
      'pause',
      'compose written',
      'update gluesync-core-hub',
      'rollback gluesync-core-hub',
      'resume',
    ]);
    assert.equal(result.results[0].status, 'rejected');
    assert.deepEqual(result.pipelines?.resumed, ['p1', 'p2']);
  });

  it('a modules-only update does not pause the pipelines', async () => {
    const events: Events = [];
    const bulk = loadWithHook(['grafana', 'prometheus'], events);

    const result = await bulk(async id => id, compose, [], 'ga', {
      docker,
      pipelineMaintenance: fakeMaintenance(events),
    });

    assert.ok(!events.includes('pause'));
    assert.ok(!events.includes('resume'));
    assert.equal(result.pipelines, undefined);
  });

  it('a refused pause stops the update before the compose file is written or any service touched', async () => {
    const events: Events = [];
    const bulk = loadWithHook(['gluesync-core-hub', 'grafana'], events);
    const refusal = new Error('Update refused: drain timeout');

    await assert.rejects(
      bulk(
        async id => {
          events.push(`update ${id}`);
          return id;
        },
        compose,
        [],
        'ga',
        {
          docker,
          pipelineMaintenance: fakeMaintenance(events, async () => {
            throw refusal;
          }),
        },
      ),
      refusal,
    );
    assert.deepEqual(events, ['pause']);
  });

  it('reports a Core Hub that did not answer before the update', async () => {
    const events: Events = [];
    const bulk = loadWithHook(['gluesync-core-hub'], events);

    const result = await bulk(async id => id, compose, [], 'ga', {
      docker,
      pipelineMaintenance: fakeMaintenance(events, async () => ({
        paused: [],
        alreadyInMaintenance: [],
        coreHubUnreachable: 'ECONNREFUSED',
      })),
    });

    assert.equal(result.pipelines?.coreHubUnreachable, 'ECONNREFUSED');
  });

  it('without a pipelineMaintenance (Conductor self-update path) nothing is paused', async () => {
    const events: Events = [];
    const bulk = loadWithHook(['gluesync-core-hub'], events);

    const result = await bulk(async id => id, compose, [], 'ga', { docker });

    assert.equal(result.pipelines, undefined);
    assert.deepEqual(events, ['compose written', 'rollback ']);
  });
});
