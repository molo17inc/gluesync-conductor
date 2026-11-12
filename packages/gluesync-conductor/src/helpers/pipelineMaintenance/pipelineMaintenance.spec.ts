import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import createPipelineMaintenance from './pipelineMaintenance';
import {
  CoreHubApiError,
  CoreHubUnreachableError,
  UpdateRefusedByPipelinesError,
} from './pipelineMaintenance.errors';
import { CoreHubPipelinesApi } from './coreHubPipelinesApi.model';
import {
  PausedPipelinesRecord,
  PausedPipelinesStore,
} from './pipelineMaintenance.model';

type FakePipeline = {
  id: string;
  running: boolean;
  maintenance: boolean;
  configured?: boolean;
};

// A Core Hub whose pipelines change state the way the real one's do: enter
// stops a running pipeline and marks it, exit restarts it
const fakeCoreHub = (pipelines: FakePipeline[]) => {
  const calls: string[] = [];
  const faults = {
    list: [] as Error[],
    status: undefined as Error | undefined,
    enter: new Map<string, Error>(),
    exit: new Map<string, Error[]>(),
    // enter answers only once release(id) is called
    slow: new Set<string>(),
  };
  const releases = new Map<string, () => void>();
  const byId = (id: string) => {
    const p = pipelines.find(x => x.id === id);
    if (!p) {
      throw new CoreHubApiError(`pipeline ${id} not found`, 404);
    }
    return p;
  };
  const api: CoreHubPipelinesApi = {
    listPipelines: async () => {
      calls.push('list');
      const fault = faults.list.shift();
      if (fault) {
        throw fault;
      }
      return pipelines.map(p => ({
        id: p.id,
        configurationCompleted: p.configured !== false,
        isInMaintenanceMode: p.maintenance,
      }));
    },
    isRunning: async id => {
      calls.push(`status ${id}`);
      if (faults.status) {
        throw faults.status;
      }
      return byId(id).running;
    },
    enterMaintenance: async id => {
      calls.push(`enter ${id}`);
      const fault = faults.enter.get(id);
      if (fault) {
        throw fault;
      }
      if (faults.slow.has(id)) {
        await new Promise<void>(resolve => {
          releases.set(id, resolve);
        });
      }
      const p = byId(id);
      p.running = false;
      p.maintenance = true;
    },
    exitMaintenance: async id => {
      calls.push(`exit ${id}`);
      const fault = faults.exit.get(id)?.shift();
      if (fault) {
        throw fault;
      }
      const p = byId(id);
      p.maintenance = false;
      p.running = true;
    },
  };
  return {
    api,
    calls,
    faults,
    release: (id: string) => releases.get(id)?.(),
  };
};

const memoryStore = (initial: PausedPipelinesRecord | null = null) => {
  const cell: { record: PausedPipelinesRecord | null; writes: string[][] } = {
    record: initial,
    writes: [],
  };
  const store: PausedPipelinesStore = {
    read: async () => cell.record,
    write: async record => {
      cell.record = record;
      cell.writes.push([...record.pipelineIds]);
    },
    clear: async () => {
      cell.record = null;
    },
  };
  return { store, cell };
};

// Time only moves when the code under test sleeps
const fakeClock = (onSleep: (now: number) => void = () => {}) => {
  const t = { now: 0 };
  return {
    now: () => t.now,
    sleep: async (ms: number) => {
      t.now += Math.max(ms, 1);
      onSleep(t.now);
      await new Promise(resolve => {
        setImmediate(resolve);
      });
    },
  };
};

const options = {
  drainTimeoutMs: 10_000,
  resumeTimeoutMs: 10_000,
  pollMs: 1000,
};

describe('pipelineMaintenance', () => {
  it('pauses only the running pipelines and waits until they report maintenance', async () => {
    const hub = fakeCoreHub([
      { id: 'p1', running: true, maintenance: false },
      { id: 'p2', running: false, maintenance: false },
      { id: 'p3', running: false, maintenance: true },
      { id: 'draft', running: true, maintenance: false, configured: false },
      { id: 'p4', running: true, maintenance: false },
    ]);
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    const outcome = await m.pause();

    assert.deepEqual(outcome.paused, ['p1', 'p4']);
    assert.deepEqual(outcome.alreadyInMaintenance, ['p3']);
    assert.equal(outcome.notPausedReason, undefined);
    // On disk before the first enter command
    assert.deepEqual(cell.writes, [['p1', 'p4']]);
    const firstEnter = hub.calls.indexOf('enter p1');
    assert.ok(firstEnter > hub.calls.indexOf('status p4'));
    assert.ok(!hub.calls.includes('enter p2'));
    assert.ok(!hub.calls.includes('enter p3'));
    assert.ok(!hub.calls.includes('enter draft'));
    // Core Hub answers enter once the pipeline is drained: no list after it
    assert.deepEqual(hub.calls.slice(firstEnter), ['enter p1', 'enter p4']);
  });

  it('resumes only what it paused and leaves the pipelines already in maintenance there', async () => {
    const hub = fakeCoreHub([
      { id: 'p1', running: true, maintenance: false },
      { id: 'p3', running: false, maintenance: true },
    ]);
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    await m.pause();
    const resumed = await m.resume();

    assert.deepEqual(resumed, { resumed: ['p1'], notResumed: [] });
    assert.ok(!hub.calls.includes('exit p3'));
    assert.equal(cell.record, null);
  });

  it('does nothing when no pipeline is running', async () => {
    const hub = fakeCoreHub([{ id: 'p2', running: false, maintenance: false }]);
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    assert.deepEqual(await m.pause(), { paused: [], alreadyInMaintenance: [] });
    assert.deepEqual(cell.writes, []);
    assert.deepEqual(await m.resume(), { resumed: [], notResumed: [] });
    assert.ok(!hub.calls.some(c => c.startsWith('exit')));
  });

  it('refuses after the drain timeout, resumes what was paused, the late one too once it is in', async () => {
    const hub = fakeCoreHub([
      { id: 'fast', running: true, maintenance: false },
      { id: 'slow', running: true, maintenance: false },
    ]);
    hub.faults.slow.add('slow');
    const { store, cell } = memoryStore();
    // The slow drain ends 3 s after the drain timeout
    const clock = fakeClock(now => {
      if (now >= 13_000) {
        hub.release('slow');
      }
    });
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock,
      ...options,
    });

    const error = await m.pause().then(
      () => assert.fail('the update must be refused'),
      (e: unknown) => e,
    );

    assert.ok(error instanceof UpdateRefusedByPipelinesError);
    assert.equal(error.statusCode, 409);
    assert.match(error.title, /did not enter maintenance mode in time/);
    assert.match(error.message, /within 10s/);
    assert.match(error.message, /slow/);
    assert.match(error.message, /No image was changed/);
    assert.deepEqual([...error.resumed].sort(), ['fast', 'slow']);
    assert.deepEqual(error.notResumed, []);
    assert.equal(cell.record, null);
    // The slow one was only taken out once it had reached maintenance mode
    assert.ok(
      hub.calls.lastIndexOf('exit slow') > hub.calls.indexOf('exit fast'),
    );
  });

  it('refuses when Core Hub cannot put a pipeline in maintenance, and resumes the others', async () => {
    const hub = fakeCoreHub([
      { id: 'p1', running: true, maintenance: false },
      { id: 'p2', running: true, maintenance: false },
    ]);
    hub.faults.enter.set(
      'p2',
      new CoreHubApiError(
        'putting pipeline p2 in maintenance mode: Core Hub answered 500',
        500,
      ),
    );
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    const error = await m.pause().catch((e: unknown) => e);

    assert.ok(error instanceof UpdateRefusedByPipelinesError);
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /answered 500/);
    assert.deepEqual(error.resumed, ['p1']);
    assert.ok(!hub.calls.includes('exit p2'));
    assert.equal(cell.record, null);
  });

  it('refuses without pausing anything when Core Hub answers the list with an error', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    hub.faults.list.push(
      new CoreHubApiError('listing the pipelines: Core Hub answered 401', 401),
    );
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    const error = await m.pause().catch((e: unknown) => e);

    assert.ok(error instanceof UpdateRefusedByPipelinesError);
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /401.*No pipeline was paused/);
    assert.deepEqual(cell.writes, []);
    assert.ok(!hub.calls.some(c => c.startsWith('enter')));
  });

  it('refuses without pausing anything when a pipeline status cannot be read', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    hub.faults.status = new CoreHubApiError(
      'reading the status: Core Hub answered 500',
      500,
    );
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    const error = await m.pause().catch((e: unknown) => e);

    assert.ok(error instanceof UpdateRefusedByPipelinesError);
    assert.deepEqual(cell.writes, []);
  });

  it('refuses with 503 when Core Hub does not answer within the drain timeout, nothing paused', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    hub.faults.list.push(
      ...Array.from(
        { length: 50 },
        () =>
          new CoreHubUnreachableError(
            'listing the pipelines: Core Hub unreachable (ECONNREFUSED)',
          ),
      ),
    );
    const { store, cell } = memoryStore();
    const clock = fakeClock();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock,
      ...options,
    });

    const error = await m.pause().catch((e: unknown) => e);

    assert.ok(error instanceof UpdateRefusedByPipelinesError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.title, 'Update refused: Core Hub did not answer');
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /Within 10s/);
    assert.match(error.message, /no image was changed/);
    assert.match(error.message, /UPDATE_PIPELINE_MAINTENANCE=false/);
    // Kept trying for the whole drain timeout, not less
    assert.ok(clock.now() >= options.drainTimeoutMs);
    assert.deepEqual(error.resumed, []);
    assert.deepEqual(cell.writes, []);
    assert.ok(!hub.calls.some(c => c.startsWith('enter')));
  });

  it('a Core Hub that does not answer the status of a pipeline refuses with 503 too', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    hub.faults.status = new CoreHubUnreachableError(
      'reading the status: Core Hub unreachable (socket hang up)',
    );
    const { store, cell } = memoryStore();
    const clock = fakeClock();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock,
      ...options,
    });

    const error = await m.pause().catch((e: unknown) => e);

    assert.ok(error instanceof UpdateRefusedByPipelinesError);
    assert.equal(error.statusCode, 503);
    assert.deepEqual(cell.writes, []);
    // Waited like for the list: the whole drain timeout
    assert.ok(clock.now() >= options.drainTimeoutMs);
  });

  it('pauses once Core Hub answers the status again', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    hub.faults.status = new CoreHubUnreachableError(
      'reading the status: Core Hub unreachable (socket hang up)',
    );
    const { store } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(now => {
        if (now >= 3000) {
          hub.faults.status = undefined;
        }
      }),
      ...options,
    });

    const outcome = await m.pause();

    assert.deepEqual(outcome.paused, ['p1']);
    assert.ok(hub.calls.includes('enter p1'));
  });

  it('goes on without pausing on a Core Hub without the pipeline API (404)', async () => {
    const hub = fakeCoreHub([]);
    hub.faults.list.push(
      new CoreHubApiError('listing the pipelines: Core Hub answered 404', 404),
    );
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    const outcome = await m.pause();

    assert.deepEqual(outcome.paused, []);
    assert.match(outcome.notPausedReason ?? '', /no pipeline API/);
    assert.deepEqual(cell.writes, []);
  });

  it('waits for a Core Hub that is reconnecting before it decides', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    hub.faults.list.push(new CoreHubUnreachableError('no module token'));
    const m = createPipelineMaintenance({
      api: hub.api,
      store: memoryStore().store,
      clock: fakeClock(),
      ...options,
    });

    assert.deepEqual((await m.pause()).paused, ['p1']);
  });

  it('resumes once Core Hub answers again after its restart', async () => {
    const hub = fakeCoreHub([{ id: 'p1', running: true, maintenance: false }]);
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });
    await m.pause();
    hub.faults.list.push(
      new CoreHubUnreachableError('ECONNREFUSED'),
      new CoreHubApiError('listing the pipelines: Core Hub answered 401', 401),
    );

    assert.deepEqual(await m.resume(), { resumed: ['p1'], notResumed: [] });
    assert.equal(cell.record, null);
  });

  it('keeps on disk what could not be resumed before the resume timeout', async () => {
    const hub = fakeCoreHub([
      { id: 'p1', running: true, maintenance: false },
      { id: 'p2', running: true, maintenance: false },
    ]);
    const { store, cell } = memoryStore();
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });
    await m.pause();
    hub.faults.exit.set(
      'p2',
      Array.from(
        { length: 100 },
        () => new CoreHubApiError('Core Hub answered 500', 500),
      ),
    );

    const outcome = await m.resume();

    assert.deepEqual(outcome.resumed, ['p1']);
    assert.deepEqual(outcome.notResumed, [
      { id: 'p2', error: 'Core Hub answered 500' },
    ]);
    assert.deepEqual(cell.record?.pipelineIds, ['p2']);
  });

  it('a Conductor restarted mid-update resumes the pipelines from the persisted list', async () => {
    const hub = fakeCoreHub([
      { id: 'p1', running: true, maintenance: false },
      { id: 'p3', running: false, maintenance: true },
    ]);
    const { store } = memoryStore();
    await createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    }).pause();

    // A new process: nothing in memory, only the file
    const afterRestart = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    assert.deepEqual(await afterRestart.resume(), {
      resumed: ['p1'],
      notResumed: [],
    });
    assert.ok(!hub.calls.includes('exit p3'));
  });

  it('a pipeline left paused by an earlier update is held and resumed by the next one', async () => {
    const hub = fakeCoreHub([
      { id: 'old', running: false, maintenance: true },
      { id: 'p1', running: true, maintenance: false },
    ]);
    const { store, cell } = memoryStore({
      pausedAt: 'x',
      pipelineIds: ['old'],
    });
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    const outcome = await m.pause();
    assert.deepEqual(outcome.paused, ['old', 'p1']);
    assert.deepEqual(outcome.alreadyInMaintenance, []);
    assert.deepEqual((await m.resume()).resumed, ['old', 'p1']);
    assert.equal(cell.record, null);
  });

  it('forgets a pipeline left paused earlier that is no longer in maintenance', async () => {
    const hub = fakeCoreHub([{ id: 'old', running: true, maintenance: false }]);
    const { store, cell } = memoryStore({
      pausedAt: 'x',
      pipelineIds: ['old', 'gone'],
    });
    hub.faults.status = undefined;
    const m = createPipelineMaintenance({
      api: hub.api,
      store,
      clock: fakeClock(),
      ...options,
    });

    // 'old' runs again (resumed by hand): this update pauses it as a running one
    assert.deepEqual((await m.pause()).paused, ['old']);
    assert.deepEqual(cell.record?.pipelineIds, ['old']);
  });
});
