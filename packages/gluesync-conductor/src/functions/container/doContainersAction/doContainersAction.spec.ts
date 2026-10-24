import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AxiosError } from 'axios';

import { ComposeFileCorruptError } from '../../../helpers/composeFile/ensureValidCompose/composeFile.errors';
import { DiskFullError } from '../../../helpers/file/safeWriteFile/safeWriteFile.errors';
import loadWithStubs from '../../../testing/loadWithStubs';
import type { DoContainersActionHandler } from './doContainersAction.model';

const root = path.resolve(__dirname, '../../..');
const helper = (p: string): string => path.join(root, 'helpers', p);
const here = (p: string): string => path.resolve(__dirname, p);

type Info = { needsUpdate: boolean; id: string; availableVersion: string };
type Call = readonly unknown[];

type Options = {
  env?: Record<string, string>;
  updateMode?: boolean;
  actions?: Record<string, (id: string) => Promise<unknown>>;
  compose?: unknown;
  composeError?: unknown;
  modules?: Record<string, Info | null | Error>;
  needsMigration?: boolean;
  migrationError?: unknown;
  grafana?: { applied: boolean; serviceId?: string };
  conductorOnly?: { id: string; results: PromiseSettledResult<unknown>[] };
  bulk?: { orderedIds: string[]; results: PromiseSettledResult<unknown>[] };
  rebootError?: unknown;
  restartError?: unknown;
  availableBytes?: number;
};

const ENV_KEYS = ['IS_WINDOWS', 'HELPER_IMAGE_BASE', 'CORE_HUB_NAME'];
const saved = new Map(ENV_KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  ENV_KEYS.forEach(k => {
    const value = saved.get(k);
    if (value === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = value;
    }
  });
});

const pending = (): Promise<void> =>
  new Promise<void>(resolve => {
    setImmediate(resolve);
  });

const ok = (id: string): Info => ({
  needsUpdate: false,
  id,
  availableVersion: '2.2.5',
});

const load = (options: Options = {}) => {
  ENV_KEYS.forEach(k => delete process.env[k]);
  Object.assign(process.env, options.env);

  const calls = {
    createActions: [] as Call[],
    checked: [] as string[],
    bulk: [] as Call[],
    conductorOnly: [] as Call[],
    migration: [] as Call[],
    reboot: [] as Call[],
    restartLinux: [] as Call[],
    restartWindows: [] as Call[],
    updateMode: 0,
    freeSpace: [] as Call[],
    logs: [] as string[],
  };
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      calls.logs.push(
        `${level}: ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
      );
    };
  const logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };

  const actions = options.actions ?? {};
  const handler = loadWithStubs<{ default: DoContainersActionHandler }>(
    here('./doContainersAction'),
    {
      [helper('dockerode/createActions/createActions')]: {
        default: (...args: unknown[]) => {
          calls.createActions.push(args);
          return {
            ...actions,
            update: actions.update ?? (async () => 'updated'),
            restart: actions.restart ?? (async () => 'restarted'),
          };
        },
      },
      [helper('composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => {
          if (options.composeError) {
            throw options.composeError;
          }
          return options.compose ?? { services: {} };
        },
      },
      [helper('checkModuleUpdate/checkModuleUpdate')]: {
        default: async (
          _d: unknown,
          _c: unknown,
          _r: unknown,
          name: string,
        ) => {
          calls.checked.push(name);
          const info =
            options.modules && name in options.modules
              ? options.modules[name]
              : ok(name);
          if (info instanceof Error) {
            throw info;
          }
          return info;
        },
      },
      [here('./handleUpdate/updateConductorOnly')]: {
        default: async (...args: unknown[]) => {
          calls.conductorOnly.push(args);
          return (
            options.conductorOnly ?? {
              id: 'gluesync-conductor',
              results: [{ status: 'fulfilled', value: 'conductor updated' }],
            }
          );
        },
      },
      [here('./handleUpdate/updateNormalBulk')]: {
        default: async (...args: unknown[]) => {
          calls.bulk.push(args);
          return (
            options.bulk ?? {
              orderedIds: ['a'],
              results: [{ status: 'fulfilled', value: 'a updated' }],
            }
          );
        },
      },
      [here('./migrationWithUpdate/migrationWithUpdate')]: {
        default: async (...args: unknown[]) => {
          calls.migration.push(args);
          if (options.migrationError) {
            throw options.migrationError;
          }
        },
      },
      [path.join(root, 'plugins/apiBlockerAsUpdating')]: {
        enableUpdateMode: () => {
          calls.updateMode += 1;
        },
        isUpdateMode: () => options.updateMode ?? false,
      },
      [helper('autoReboot/autoReboot')]: {
        autoReboot: async (...args: unknown[]) => {
          calls.reboot.push(args);
          if (options.rebootError) {
            throw options.rebootError;
          }
        },
      },
      [helper('getRootPath/getRootPath')]: { default: () => '/host/project' },
      [helper('composeFile/composeBackup/composeBackup')]: {
        composeFilePath: () => '/host/project/docker-compose.yml',
      },
      [helper('file/ensureFreeSpace/ensureFreeSpace')]: {
        getUpdateMinFreeBytes: () => 1000,
        default: async (paths: readonly string[], needed: number) => {
          calls.freeSpace.push([paths, needed]);
          const available = options.availableBytes ?? 1e12;
          if (available < needed) {
            throw new DiskFullError(paths[0], needed, available);
          }
        },
      },
      [helper('restartAllServices/windowsRestart')]: {
        default: async (...args: unknown[]) => {
          calls.restartWindows.push(args);
          if (options.restartError) {
            throw options.restartError;
          }
        },
      },
      [helper('restartAllServices/linuxRestart')]: {
        default: async (...args: unknown[]) => {
          calls.restartLinux.push(args);
          if (options.restartError) {
            throw options.restartError;
          }
        },
      },
      [helper('migrationNeeded/migrationNeeded')]: {
        migrationNeeded: async () => options.needsMigration ?? false,
      },
      [helper('handleGrafanaEmbeddedDashboard/handleGrafanaEmbeddedDashboard')]:
        {
          default: async () => options.grafana ?? { applied: false },
        },
      [path.join(root, 'utils/logger')]: { getLogger: () => logger },
    },
  ).default;

  return { handler, calls };
};

type Reply = {
  statusCode?: number;
  headers: Record<string, string>;
  sent: unknown[];
  code: (n: number) => Reply;
  header: (k: string, v: string) => Reply;
  send: (body: unknown) => Reply;
};

const fakeReply = (): Reply => {
  const reply: Reply = {
    headers: {},
    sent: [],
    code: n => {
      reply.statusCode = n;
      return reply;
    },
    header: (k, v) => {
      reply.headers[k] = v;
      return reply;
    },
    send: body => {
      reply.sent.push(body);
      return reply;
    },
  };
  return reply;
};

type Docker = {
  ping?: () => Promise<unknown>;
  pruneImages?: (opts: unknown) => Promise<unknown>;
};

const run = async (
  loaded: ReturnType<typeof load>,
  body: Record<string, unknown>,
  docker: Docker = {},
) => {
  const reply = fakeReply();
  const req = {
    body,
    server: {
      docker: {
        ping: async () => 'OK',
        pruneImages: async () => ({ ImagesDeleted: [], SpaceReclaimed: 0 }),
        ...docker,
      },
    },
    log: {
      debug: (...a: unknown[]) => loaded.calls.logs.push(`debug: ${a[0]}`),
      info: (...a: unknown[]) => loaded.calls.logs.push(`info: ${a.length}`),
      warn: (...a: unknown[]) => loaded.calls.logs.push(`warn: ${a.at(-1)}`),
      error: (...a: unknown[]) => loaded.calls.logs.push(`error: ${a.at(-1)}`),
    },
  };
  const invoke = loaded.handler as unknown as (
    request: unknown,
    response: unknown,
  ) => Promise<void>;
  await invoke(req, reply);
  return reply;
};

const body = (reply: Reply): any => reply.sent[0];

describe('doContainersAction generic actions', () => {
  it('reports one item per id, with the failure text of rejected ones', async () => {
    const loaded = load({
      actions: {
        stop: async (id: string) => {
          if (id === 'bad') {
            throw new Error('cannot stop');
          }
          return `${id} stopped`;
        },
      },
    });
    const reply = await run(loaded, { action: 'stop', ids: ['good', 'bad'] });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(body(reply), {
      success: true,
      data: {
        containers: [
          { id: 'good', status: 'OK', message: 'good stopped' },
          { id: 'bad', status: 'ERROR', message: 'cannot stop' },
        ],
      },
    });
  });

  it('treats a missing ids list as empty', async () => {
    const reply = await run(load({ actions: { stop: async () => 'x' } }), {
      action: 'stop',
    });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(body(reply).data.containers, []);
  });

  it('refuses everything but restart while the conductor is updating', async () => {
    const reply = await run(
      load({ updateMode: true, actions: { stop: async () => 'x' } }),
      { action: 'stop', ids: ['a'] },
    );
    assert.equal(reply.statusCode, 503);
    const { diagnosis, ...rest } = body(reply);
    assert.deepEqual(rest, {
      success: false,
      error: 'Conductor is updating',
      details: 'Only restart operations are allowed during update mode',
    });
    // The UI reads the diagnosis to wait instead of retrying.
    assert.equal(diagnosis.code, 'CONDUCTOR_UPDATING');
    assert.equal(diagnosis.owner, 'local');
    assert.deepEqual(diagnosis.resolutionCodes, ['WAIT_FOR_CONDUCTOR_UPDATE']);
  });

  it('answers 500 for an unknown action and checks that docker is up', async () => {
    const loaded = load();
    let pinged = 0;
    const reply = await run(
      loaded,
      { action: 'explode', ids: [] },
      {
        ping: async () => {
          pinged += 1;
        },
      },
    );
    assert.equal(pinged, 1);
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(body(reply), {
      success: false,
      error: 'Failed to do containers action',
      details: 'Unknown action: explode',
    });
    assert.ok(
      loaded.calls.logs.includes('debug: Docker daemon is responding to ping'),
    );
  });

  it('logs when docker does not answer the ping after a failure', async () => {
    const loaded = load();
    const reply = await run(
      loaded,
      { action: 'explode', ids: [] },
      {
        ping: async () => {
          throw new Error('socket closed');
        },
      },
    );
    assert.equal(reply.statusCode, 500);
    assert.ok(
      loaded.calls.logs.includes(
        'error: Docker daemon ping failed: socket closed',
      ),
    );
  });

  it('logs a non-Error failure as JSON and answers with its text', async () => {
    const loaded = load({ composeError: 'disk gone' });
    const reply = await run(loaded, { action: 'update', ids: [] });
    assert.equal(reply.statusCode, 500);
    assert.equal(body(reply).details, 'disk gone');
    assert.ok(
      loaded.calls.logs.includes(
        'error: Error do containers action: "disk gone"',
      ),
    );
  });
});

describe('doContainersAction failure details', () => {
  const axiosFailure = (status: number | undefined, data?: unknown) =>
    new AxiosError(
      'request failed',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      status === undefined
        ? undefined
        : ({ status, data, statusText: '', headers: {}, config: {} } as never),
    );

  const cases: ReadonlyArray<
    readonly [string, number | undefined, unknown, number, string]
  > = [
    ['a string body', 502, 'bad gateway', 502, 'bad gateway'],
    [
      'a message field',
      404,
      { message: 'no such thing' },
      404,
      'no such thing',
    ],
    ['an error field', 400, { error: 'bad input' }, 400, 'bad input'],
    ['an unknown object', 500, { code: 7 }, 500, '{"code":7}'],
    ['no response at all', undefined, undefined, 500, 'request failed'],
  ];

  cases.forEach(([name, status, data, expectedStatus, expectedDetails]) => {
    it(`uses the upstream status and ${name} for an axios error`, async () => {
      const failure = axiosFailure(status, data);
      const loaded = load({ composeError: failure });
      const reply = await run(loaded, { action: 'update', ids: [] });
      assert.equal(reply.statusCode, expectedStatus);
      assert.deepEqual(body(reply), {
        success: false,
        error: 'Failed to do containers action',
        details: expectedDetails,
      });
    });
  });
});

describe('doContainersAction action gate', () => {
  const deferred = () => {
    const state = { release: () => {} };
    const promise = new Promise<string>(resolve => {
      state.release = () => resolve('done');
    });
    return { promise, state };
  };

  it('refuses a different action while one runs, with Retry-After', async () => {
    const { promise, state } = deferred();
    const loaded = load({
      actions: { stop: () => promise, start: async () => 'started' },
    });
    const first = run(loaded, { action: 'stop', ids: ['a'] });
    const refused = await run(loaded, { action: 'start', ids: ['a'] });

    assert.equal(refused.statusCode, 409);
    assert.equal(refused.headers['Retry-After'], '30');
    assert.equal(
      body(refused).error,
      'Another container action is in progress',
    );
    assert.match(
      body(refused).details,
      /^"stop" started at \d{4}-\d{2}-\d{2}T.*; try again when it has finished$/,
    );
    assert.ok(loaded.calls.logs.some(l => l.startsWith('warn:')));

    state.release();
    assert.equal((await first).statusCode, 200);

    const after = await run(loaded, { action: 'start', ids: ['a'] });
    assert.equal(after.statusCode, 200);
  });

  it('lets the same action on the same ids join the running one', async () => {
    const { promise, state } = deferred();
    const loaded = load({ actions: { stop: () => promise } });
    const first = run(loaded, { action: 'stop', ids: ['b', 'a'] });
    const joined = run(loaded, { action: 'stop', ids: ['a', 'b'] });
    state.release();
    const [one, two] = await Promise.all([first, joined]);

    assert.equal(one.statusCode, 200);
    assert.equal(two.statusCode, 200);
    assert.deepEqual(body(two), body(one));
    assert.ok(loaded.calls.logs.includes('info: 2'));
  });
});

describe('doContainersAction restart', () => {
  it('restarts the whole stack on Linux once the reply has gone out', async () => {
    const loaded = load();
    const reply = await run(loaded, { action: 'restart', ids: [] });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(body(reply).data.containers, [
      { id: 'ALL', status: 'OK', message: 'Full stack restart initiated.' },
    ]);
    assert.equal(loaded.calls.updateMode, 1);
    assert.equal(loaded.calls.restartLinux.length, 0);

    await pending();
    assert.deepEqual(loaded.calls.restartLinux, [
      [{ hostProjectDir: '/host/project', helperImage: 'docker:28' }],
    ]);
    assert.equal(loaded.calls.restartWindows.length, 0);
  });

  it('restarts the whole stack on Windows with the helper image', async () => {
    const loaded = load({
      env: { IS_WINDOWS: 'TRUE', HELPER_IMAGE_BASE: 'helper:win' },
    });
    await run(loaded, { action: 'restart', ids: [] });
    await pending();
    assert.deepEqual(loaded.calls.restartWindows, [
      [{ hostProjectDir: '/host/project', helperImage: 'helper:win' }],
    ]);
    assert.equal(loaded.calls.restartLinux.length, 0);
  });

  it('logs a failed full restart instead of crashing', async () => {
    const loaded = load({ restartError: new Error('helper failed') });
    const reply = await run(loaded, { action: 'restart', ids: [] });
    await pending();
    await pending();
    assert.equal(reply.statusCode, 200);
    assert.equal(loaded.calls.restartLinux.length, 1);
    assert.ok(
      loaded.calls.logs.includes(
        'error: [conductor-restart] full restart failed',
      ),
    );
  });

  it('reboots only the conductor after the reply when it is the only id', async () => {
    const loaded = load();
    const reply = await run(loaded, {
      action: 'restart',
      ids: ['gluesync-conductor'],
    });
    assert.deepEqual(body(reply).data.containers, [
      {
        id: 'gluesync-conductor',
        status: 'OK',
        message: 'Conductor gluesync-conductor restart initiated.',
      },
    ]);
    assert.equal(loaded.calls.updateMode, 1);
    assert.equal(loaded.calls.reboot.length, 0);

    await pending();
    assert.equal(loaded.calls.reboot.length, 1);
    const [params] = loaded.calls.reboot[0] as [Record<string, unknown>];
    assert.equal(params.hostProjectDir, '/host/project');
    assert.equal(params.serviceName, 'gluesync-conductor');
    assert.equal(params.helperImage, 'docker:cli');
    (params.log as (m: string) => void)('rebooting');
    assert.ok(loaded.calls.logs.includes('info: 2'));
  });

  it('uses the Windows helper image for the conductor reboot', async () => {
    const loaded = load({
      env: { IS_WINDOWS: 'true', HELPER_IMAGE_BASE: 'helper:win' },
    });
    await run(loaded, { action: 'restart', ids: ['gluesync-conductor'] });
    await pending();
    const [params] = loaded.calls.reboot[0] as [Record<string, unknown>];
    assert.equal(params.helperImage, 'helper:win');
  });

  it('logs a failed conductor reboot', async () => {
    const loaded = load({ rebootError: new Error('no docker') });
    await run(loaded, { action: 'restart', ids: ['gluesync-conductor'] });
    await pending();
    await pending();
    assert.ok(
      loaded.calls.logs.includes(
        'error: [conductor-restart] autoReboot failed',
      ),
    );
  });

  it('restarts the other services now and reports their failures', async () => {
    const restarted: string[] = [];
    const loaded = load({
      actions: {
        restart: async (id: string) => {
          if (id === 'bad') {
            throw new Error('no such container');
          }
          restarted.push(id);
          return `${id} restarted`;
        },
      },
    });
    const reply = await run(loaded, { action: 'restart', ids: ['a', 'bad'] });
    assert.deepEqual(restarted, ['a']);
    assert.deepEqual(body(reply).data.containers, [
      { id: 'a', status: 'OK', message: 'a restarted' },
      { id: 'bad', status: 'ERROR', message: 'no such container' },
    ]);
    await pending();
    assert.equal(loaded.calls.updateMode, 0);
    assert.equal(loaded.calls.reboot.length, 0);
  });

  it('restarts the listed services, then the conductor after the reply', async () => {
    const restarted: string[] = [];
    const loaded = load({
      actions: {
        restart: async (id: string) => {
          restarted.push(id);
          return `${id} restarted`;
        },
      },
    });
    const reply = await run(loaded, {
      action: 'restart',
      ids: ['a', 'gluesync-conductor', 'b'],
    });
    assert.deepEqual(restarted, ['a', 'b']);
    assert.deepEqual(
      body(reply).data.containers.map((c: { id: string }) => c.id),
      ['a', 'b', 'gluesync-conductor'],
    );
    assert.equal(loaded.calls.updateMode, 1);
    await pending();
    assert.equal(loaded.calls.reboot.length, 1);
  });
});

describe('doContainersAction update', () => {
  const prune = (result: unknown) => ({ pruneImages: async () => result });

  it('updates the requested ids and keeps the previous images for rollback', async () => {
    const loaded = load({
      compose: {
        services: { grafana: { image: 'grafana:1' }, odd: undefined },
      },
      bulk: {
        orderedIds: ['grafana', 'chronos'],
        results: [
          { status: 'fulfilled', value: 'grafana updated' },
          { status: 'rejected', reason: { err: 'pull failed' } },
        ],
      },
    });
    const reply = await run(
      loaded,
      { action: 'update', ids: ['grafana', 'chronos'], releaseChannel: 'beta' },
      prune({ ImagesDeleted: [{}, {}], SpaceReclaimed: 3 * 1024 * 1024 }),
    );

    assert.equal(reply.statusCode, 200);
    assert.deepEqual(body(reply), {
      success: true,
      data: {
        pruneResult:
          'Pruned 2 images, and reclaimed 3.00 MB disk space successfully',
        containers: [
          { id: 'grafana', status: 'OK', message: 'grafana updated' },
          { id: 'chronos', status: 'ERROR', message: 'pull failed' },
        ],
      },
    });
    const [, , bulkIds, channel] = loaded.calls.bulk[0] as [
      unknown,
      unknown,
      string[],
      string,
    ];
    assert.deepEqual(bulkIds, ['grafana', 'chronos']);
    assert.equal(channel, 'beta');
    const [withImages] = loaded.calls.createActions[1] as [
      { previousImages: unknown },
    ];
    assert.deepEqual(withImages.previousImages, {
      grafana: 'grafana:1',
      odd: undefined,
    });
    assert.equal(loaded.calls.conductorOnly.length, 0);
  });

  it('defaults to the ga channel and copes with a compose file without services', async () => {
    const loaded = load({ compose: {} });
    const reply = await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(reply.statusCode, 200);
    const [, , , channel] = loaded.calls.bulk[0] as [
      unknown,
      unknown,
      unknown,
      string,
    ];
    assert.equal(channel, 'ga');
    const [withImages] = loaded.calls.createActions[1] as [
      { previousImages: unknown },
    ];
    assert.deepEqual(withImages.previousImages, {});
  });

  it('updates only chronos for "update all" when a chronos release is out', async () => {
    const loaded = load({
      modules: {
        'gluesync-chronos': {
          needsUpdate: true,
          id: 'gluesync-chronos',
          availableVersion: '0.2.3',
        },
      },
    });
    await run(loaded, { action: 'update', ids: [] });
    const [, , bulkIds] = loaded.calls.bulk[0] as [unknown, unknown, string[]];
    assert.deepEqual(bulkIds, ['gluesync-chronos']);
  });

  it('keeps an empty id list for "update all" when chronos is current', async () => {
    const loaded = load();
    await run(loaded, { action: 'update', ids: [] });
    const [, , bulkIds] = loaded.calls.bulk[0] as [unknown, unknown, string[]];
    assert.deepEqual(bulkIds, []);
  });

  const conductorOut = {
    'gluesync-conductor': {
      needsUpdate: true,
      id: 'gluesync-conductor',
      availableVersion: '1.9.0',
    },
  };

  it('updates the conductor alone for "update all" while a conductor release is out', async () => {
    const loaded = load({ modules: conductorOut });
    const reply = await run(loaded, { action: 'update', ids: [] });
    assert.equal(loaded.calls.bulk.length, 0);
    assert.equal(loaded.calls.conductorOnly.length, 1);
    assert.deepEqual(body(reply).data.containers, [
      { id: 'gluesync-conductor', status: 'OK', message: 'conductor updated' },
    ]);
  });

  it('updates the conductor alone when it is the only id', async () => {
    const loaded = load({ modules: conductorOut });
    await run(loaded, { action: 'update', ids: ['gluesync-conductor'] });
    assert.equal(loaded.calls.conductorOnly.length, 1);
    assert.equal(loaded.calls.bulk.length, 0);
  });

  it('goes through the bulk update when other ids come with the conductor', async () => {
    const loaded = load({ modules: conductorOut });
    await run(loaded, {
      action: 'update',
      ids: ['gluesync-conductor', 'grafana'],
    });
    assert.equal(loaded.calls.conductorOnly.length, 0);
    assert.equal(loaded.calls.bulk.length, 1);
  });

  it('goes through the bulk update for another single id while the conductor is out', async () => {
    const loaded = load({ modules: conductorOut });
    await run(loaded, { action: 'update', ids: ['grafana'] });
    assert.equal(loaded.calls.conductorOnly.length, 0);
    assert.equal(loaded.calls.bulk.length, 1);
  });

  it('adds nothing to the reply when the prune removed no image', async () => {
    const reply = await run(
      load(),
      { action: 'update', ids: ['a'] },
      prune({ SpaceReclaimed: 0 }),
    );
    assert.equal('pruneResult' in body(reply).data, false);
    assert.equal('pruneError' in body(reply).data, false);
  });

  it('reports a failed prune without failing the update', async () => {
    const reply = await run(
      load(),
      { action: 'update', ids: ['a'] },
      {
        pruneImages: async () => {
          throw new Error('prune denied');
        },
      },
    );
    assert.equal(reply.statusCode, 200);
    assert.equal(body(reply).data.pruneError, 'prune denied');
    assert.equal(body(reply).data.containers.length, 1);
  });

  it('prunes unused images, not only dangling ones', async () => {
    const seen: unknown[] = [];
    await run(
      load(),
      { action: 'update', ids: ['a'] },
      {
        pruneImages: async opts => {
          seen.push(opts);
          return { SpaceReclaimed: 0 };
        },
      },
    );
    assert.deepEqual(seen, [
      { force: true, filters: { dangling: { false: true } } },
    ]);
  });

  it('adds an item when grafana was recreated with the embedded dashboard', async () => {
    const loaded = load({ grafana: { applied: true, serviceId: 'grafana' } });
    const reply = await run(loaded, { action: 'update', ids: ['a'] });
    assert.deepEqual(body(reply).data.containers, [
      { id: 'a', status: 'OK', message: 'a updated' },
      {
        id: 'grafana',
        status: 'OK',
        message: 'Grafana recreated with embedded dashboard (volumes removed).',
      },
    ]);
  });
});

describe('doContainersAction migration', () => {
  const eligible = {
    'gluesync-core-hub': ok('gluesync-core-hub'),
  };

  it('runs the v2 migration when every module is current and one is needed', async () => {
    const loaded = load({
      modules: {
        'gluesync-core-hub': {
          needsUpdate: true,
          id: 'gluesync-core-hub',
          availableVersion: '2.2.1-ga',
        },
      },
      needsMigration: true,
    });
    const reply = await run(loaded, {
      action: 'update',
      ids: ['a'],
      releaseChannel: 'ga',
    });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(body(reply), {
      success: true,
      data: {
        containers: [
          { id: 'ALL', status: 'OK', message: 'v2 Migration complete' },
        ],
      },
    });
    const [ids, channel, isWindows, helperImage] = loaded.calls
      .migration[0] as [string[], string, boolean, string];
    assert.deepEqual(ids, ['a']);
    assert.equal(channel, 'ga');
    assert.equal(isWindows, false);
    assert.equal(helperImage, '');
    assert.equal(loaded.calls.bulk.length, 0);
  });

  it('passes the Windows settings to the migration', async () => {
    const loaded = load({
      env: { IS_WINDOWS: 'true', HELPER_IMAGE_BASE: 'helper:win' },
      modules: eligible,
      needsMigration: true,
    });
    await run(loaded, { action: 'update', ids: [] });
    const [, , isWindows, helperImage] = loaded.calls.migration[0] as [
      unknown,
      unknown,
      boolean,
      string,
    ];
    assert.equal(isWindows, true);
    assert.equal(helperImage, 'helper:win');
  });

  it('answers 500 when the migration fails', async () => {
    const loaded = load({
      needsMigration: true,
      migrationError: new Error('compose down failed'),
    });
    const reply = await run(loaded, { action: 'update', ids: [] });
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(body(reply), {
      success: false,
      error: 'Migration failed',
      details: 'compose down failed',
    });
  });

  it('answers 500 with the text of a non-Error migration failure', async () => {
    const loaded = load({ needsMigration: true, migrationError: 'boom' });
    const reply = await run(loaded, { action: 'update', ids: [] });
    assert.equal(body(reply).details, 'boom');
  });

  it('updates normally when no migration is needed', async () => {
    const loaded = load({ needsMigration: false });
    await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(loaded.calls.migration.length, 0);
    assert.equal(loaded.calls.bulk.length, 1);
  });

  it('does not migrate while the conductor itself needs an update', async () => {
    const loaded = load({
      needsMigration: true,
      modules: {
        'gluesync-conductor': {
          needsUpdate: true,
          id: 'gluesync-conductor',
          availableVersion: '1.9.0',
        },
      },
    });
    await run(loaded, { action: 'update', ids: [] });
    assert.equal(loaded.calls.migration.length, 0);
    assert.equal(loaded.calls.conductorOnly.length, 1);
  });

  it('does not migrate while chronos needs an update', async () => {
    const loaded = load({
      needsMigration: true,
      modules: {
        'gluesync-chronos': {
          needsUpdate: true,
          id: 'gluesync-chronos',
          availableVersion: '0.2.3',
        },
      },
    });
    await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(loaded.calls.migration.length, 0);
    assert.equal(loaded.calls.bulk.length, 1);
  });

  it('does not migrate to a core hub older than 2.2.0', async () => {
    const loaded = load({
      needsMigration: true,
      modules: {
        'gluesync-core-hub': {
          needsUpdate: true,
          id: 'gluesync-core-hub',
          availableVersion: '2.1.9',
        },
      },
    });
    await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(loaded.calls.migration.length, 0);
    assert.equal(loaded.calls.bulk.length, 1);
  });

  it('looks the core hub up under CORE_HUB_NAME', async () => {
    const loaded = load({ env: { CORE_HUB_NAME: 'custom-hub' } });
    await run(loaded, { action: 'update', ids: ['a'] });
    assert.deepEqual(loaded.calls.checked, [
      'gluesync-conductor',
      'gluesync-chronos',
      'custom-hub',
    ]);
  });

  it('assumes no migration when the core hub lookup fails', async () => {
    const loaded = load({
      needsMigration: true,
      modules: { 'gluesync-core-hub': new Error('registry down') },
    });
    const reply = await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(reply.statusCode, 200);
    assert.equal(loaded.calls.migration.length, 0);
    assert.ok(
      loaded.calls.logs.some(
        l => l.startsWith('warn:') && l.includes('registry down'),
      ),
    );
  });

  it('assumes no migration when the core hub has no version on offer', async () => {
    const loaded = load({
      needsMigration: true,
      modules: { 'gluesync-core-hub': null },
    });
    await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(loaded.calls.migration.length, 0);
    assert.equal(loaded.calls.bulk.length, 1);
  });

  it('logs the lookup failure text even when it is not an Error', async () => {
    const loaded = load({
      modules: { 'gluesync-core-hub': 'offline' as unknown as Error },
    });
    const reply = await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(reply.statusCode, 200);
  });
});

describe('doContainersAction update disk pre-flight', () => {
  const full = () =>
    load({
      availableBytes: 10,
      modules: {
        'gluesync-conductor': {
          needsUpdate: true,
          id: 'gluesync-conductor',
          availableVersion: '3.0.0',
        },
      },
    });

  it('checks the compose file system before reading anything', async () => {
    const loaded = load();
    const reply = await run(loaded, { action: 'update', ids: ['a'] });
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(loaded.calls.freeSpace, [
      [['/host/project/docker-compose.yml'], 1000],
    ]);
  });

  it('refuses the update when the disk is too full, touching nothing', async () => {
    const loaded = full();
    const reply = await run(loaded, { action: 'update', ids: [] });
    assert.equal(reply.statusCode, 507);
    assert.equal(body(reply).success, false);
    assert.equal(body(reply).error, 'Failed to do containers action');
    assert.match(body(reply).details, /not enough free disk space/);
    assert.match(body(reply).details, /docker-compose\.yml/);
    assert.equal(body(reply).diagnosis.code, 'DISK_FULL');
    assert.deepEqual(body(reply).diagnosis.params, {
      path: '/host/project/docker-compose.yml',
      neededBytes: 1000,
      availableBytes: 10,
    });
    assert.equal(loaded.calls.createActions.length, 1); // the generic action lookup only
    assert.deepEqual(loaded.calls.checked, []);
    assert.equal(loaded.calls.bulk.length, 0);
    assert.equal(loaded.calls.conductorOnly.length, 0);
    assert.equal(loaded.calls.migration.length, 0);
    assert.equal(loaded.calls.updateMode, 0);
  });

  it('does not pre-flight other actions', async () => {
    const loaded = load({
      availableBytes: 10,
      actions: { stop: async () => 'stopped' },
    });
    const reply = await run(loaded, { action: 'stop', ids: ['a'] });
    assert.equal(reply.statusCode, 200);
    assert.equal(loaded.calls.freeSpace.length, 0);
  });
});

describe('doContainersAction failures on this install', () => {
  it('answers a kernel EDQUOT with the disk-full diagnosis', async () => {
    const quota = Object.assign(new Error('write EDQUOT'), {
      code: 'EDQUOT',
    });
    const reply = await run(load({ composeError: quota }), {
      action: 'update',
      ids: [],
    });

    assert.equal(reply.statusCode, 507);
    assert.equal(body(reply).diagnosis.code, 'DISK_FULL');
    assert.match(body(reply).details, /not enough free disk space/);
  });

  it('answers a corrupt compose file with its diagnosis', async () => {
    const reply = await run(
      load({
        composeError: new ComposeFileCorruptError(
          '/host/project/docker-compose.yml',
          'the file is empty',
        ),
      }),
      { action: 'update', ids: [] },
    );

    assert.equal(reply.statusCode, 500);
    assert.equal(body(reply).error, 'Failed to do containers action');
    assert.equal(body(reply).diagnosis.code, 'COMPOSE_FILE_CORRUPT');
    assert.deepEqual(body(reply).diagnosis.params, {
      path: '/host/project/docker-compose.yml',
      problem: 'the file is empty',
    });
  });

  it('keeps the disk-full diagnosis when the migration runs out of space', async () => {
    const reply = await run(
      load({
        needsMigration: true,
        migrationError: new DiskFullError('/host/project/.env', 4096, 0),
      }),
      { action: 'update', ids: [] },
    );

    assert.equal(reply.statusCode, 507);
    assert.equal(body(reply).error, 'Migration failed');
    assert.equal(body(reply).diagnosis.code, 'DISK_FULL');
  });
});
