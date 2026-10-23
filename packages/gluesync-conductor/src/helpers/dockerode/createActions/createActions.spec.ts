import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { CreateActions } from './createActions.model';

const here = (p: string): string => path.resolve(__dirname, p);

const originalWindows = process.env.IS_WINDOWS;
afterEach(() => {
  if (originalWindows === undefined) {
    delete process.env.IS_WINDOWS;
  } else {
    process.env.IS_WINDOWS = originalWindows;
  }
});

type Result = { out: string; err: string; exitCode: number | null };

type Setup = Readonly<{
  failing?: ReadonlySet<string>;
  stableError?: Error;
  rebootError?: Error;
}>;

const load = ({
  failing = new Set(),
  stableError,
  rebootError,
}: Setup = {}) => {
  const calls: string[] = [];
  const stable: string[] = [];
  const reboots: unknown[] = [];
  const logs: Array<{ level: string; args: unknown[] }> = [];
  const windowsRestarts: unknown[][] = [];
  let updateModes = 0;

  const compose =
    (name: string) =>
    async (options: { commandOptions: string[] }): Promise<Result> => {
      calls.push(`${name} ${options.commandOptions.join(' ')}`);
      return failing.has(name)
        ? { out: '', err: `${name} broke`, exitCode: 1 }
        : { out: `${name} ok`, err: '', exitCode: 0 };
    };

  const createActions = loadWithStubs<{ default: CreateActions }>(
    here('./createActions'),
    {
      'docker-compose': {
        kill: compose('kill'),
        pullAll: compose('pullAll'),
        restartAll: compose('restartAll'),
        stop: compose('stop'),
        upAll: compose('upAll'),
        rm: compose('rm'),
      },
      [here('../../getRootPath/getRootPath')]: {
        default: () => '/srv/gs',
      },
      [here('../cleanupOrphanNetworkByName/cleanupOrphanNetworkByName')]: {
        default: async () => 'net',
      },
      [here('../../composeFile/readComposeFile/readComposeFile')]: {
        readComposeFile: async () => ({ services: {} }),
      },
      [here('../../composeFile/writeComposeFile/writeComposeFile')]: {
        default: async () => undefined,
      },
      [here('../../../utils/logger')]: {
        getLogger: () => ({
          info: (...args: unknown[]) => logs.push({ level: 'info', args }),
          error: (...args: unknown[]) => logs.push({ level: 'error', args }),
        }),
      },
      [here('../../autoReboot/autoReboot')]: {
        autoReboot: async (options: unknown) => {
          reboots.push(options);
          if (rebootError) {
            throw rebootError;
          }
          return true;
        },
      },
      [here('../../ensureVolumeDirs/ensureVolumeDirs')]: {
        default: async () => undefined,
      },
      [here('../../../plugins/apiBlockerAsUpdating')]: {
        enableUpdateMode: () => {
          updateModes += 1;
        },
      },
      [here(
        '../restartWindowsDependentServices/restartWindowsDependentServices',
      )]: {
        default: async (...args: unknown[]) => {
          windowsRestarts.push(args);
          return 'windows restarted';
        },
      },
      [here('../retryHelper/retryHelper')]: {
        retryCmd: (
          _attempt: number,
          _max: number,
          exec: () => Promise<unknown>,
        ) => exec(),
        shouldRetryError: () => false,
      },
      [here('../../verifyServiceStable/verifyServiceStable')]: {
        default: async (_docker: unknown, id: string) => {
          stable.push(id);
          if (stableError) {
            throw stableError;
          }
        },
      },
    },
  ).default;

  return {
    createActions,
    calls,
    stable,
    reboots,
    logs,
    windowsRestarts,
    updateModes: () => updateModes,
  };
};

const docker = {} as never;
const flush = (): Promise<void> =>
  new Promise(resolve => {
    setImmediate(resolve);
  });

describe('createActions', () => {
  it('runs the plain compose actions and reports their output', async () => {
    const { createActions, calls } = load();
    const actions = createActions({ docker });
    assert.equal(await actions.kill('svc'), 'kill ok');
    assert.equal(await actions.pull('svc'), 'pullAll ok');
    assert.equal(await actions.remove('svc'), 'rm ok');
    assert.equal(await actions.restart('svc'), 'restartAll ok');
    assert.equal(await actions.start('svc'), 'upAll ok');
    assert.equal(await actions.stop('svc'), 'stop ok');
    assert.deepEqual(calls, [
      'kill svc',
      'pullAll --include-deps svc',
      'rm -s -v svc',
      'restartAll --no-deps svc',
      'upAll --no-deps svc',
      'stop svc',
    ]);
  });

  it('rejects with the compose error output', async () => {
    const { createActions } = load({ failing: new Set(['stop']) });
    await assert.rejects(createActions({ docker }).stop('svc'), /stop broke/);
  });

  it('removes the service from the compose file on undeploy', async () => {
    const { createActions, calls } = load();
    assert.equal(
      await createActions({ docker }).undeploy('svc'),
      'Agent svc not found',
    );
    assert.deepEqual(calls, ['rm -s -v svc']);
  });

  it('pulls, recreates and checks a service stays up on update', async () => {
    const { createActions, calls, stable, reboots } = load();
    const result = await createActions({ docker }).update('grafana');
    assert.equal(result, 'Agent grafana updated and restarted.');
    assert.deepEqual(calls, [
      'pullAll --include-deps grafana',
      'upAll --remove-orphans grafana',
    ]);
    assert.deepEqual(stable, ['grafana']);
    assert.equal(reboots.length, 0);
  });

  it('fails the update when the new container does not stay up', async () => {
    const { createActions, stable } = load({
      stableError: new Error('grafana is not staying up after the update'),
    });
    await assert.rejects(
      createActions({ docker }).update('grafana'),
      /grafana is not staying up/,
    );
    assert.deepEqual(stable, ['grafana']);
  });

  it('does not recreate or verify a service whose pull failed', async () => {
    const { createActions, calls, stable } = load({
      failing: new Set(['pullAll']),
    });
    await assert.rejects(
      createActions({ docker }).update('grafana'),
      /pullAll broke/,
    );
    assert.deepEqual(calls, ['pullAll --include-deps grafana']);
    assert.equal(stable.length, 0);
  });

  it('self-updates the conductor with its previous image to roll back to', async () => {
    const { createActions, calls, stable, reboots, updateModes } = load();
    const result = await createActions({
      docker,
      previousImages: { 'gluesync-conductor': 'conductor:1', other: 'x:1' },
    }).update('gluesync-conductor');
    assert.equal(result, 'Conductor gluesync-conductor updated and restarted.');
    assert.deepEqual(calls, ['pullAll --include-deps gluesync-conductor']);
    assert.equal(updateModes(), 1);
    assert.equal(reboots.length, 0, 'the helper starts after the response');
    await flush();
    assert.equal(reboots.length, 1);
    assert.deepEqual(
      { ...(reboots[0] as Record<string, unknown>), log: undefined },
      {
        hostProjectDir: '/srv/gs',
        serviceName: 'gluesync-conductor',
        helperImage: 'docker:cli',
        rollbackImage: 'conductor:1',
        log: undefined,
      },
    );
    assert.equal(stable.length, 0);
  });

  it('self-updates without a rollback image when none was recorded', async () => {
    const { createActions, reboots, logs } = load();
    await createActions({ docker }).update('gluesync-conductor');
    await flush();
    const options = reboots[0] as {
      rollbackImage?: string;
      log: (msg: string) => void;
    };
    assert.equal(options.rollbackImage, undefined);
    options.log('hello');
    assert.deepEqual(logs[logs.length - 1], {
      level: 'info',
      args: [{ msg: 'hello' }, '[conductor-updater] self-update log'],
    });
  });

  it('logs when the self-update helper fails to start', async () => {
    const error = new Error('docker missing');
    const { createActions, logs } = load({ rebootError: error });
    await createActions({ docker }).update('gluesync-conductor');
    await flush();
    await flush();
    assert.deepEqual(logs[logs.length - 1], {
      level: 'error',
      args: [{ error }, '[conductor-updater] autoReboot failed'],
    });
  });

  it('restarts the dependent services after a core-hub update on Windows', async () => {
    process.env.IS_WINDOWS = 'true';
    const { createActions, stable, windowsRestarts } = load();
    const result = await createActions({
      docker,
      filename: 'compose.yml',
    }).update('gluesync-core-hub');
    assert.equal(result, 'windows restarted');
    assert.equal(windowsRestarts.length, 1);
    assert.deepEqual(
      [
        windowsRestarts[0][2],
        windowsRestarts[0][3],
        windowsRestarts[0][4],
        windowsRestarts[0][5],
      ],
      [
        'compose.yml',
        'gluesync-core-hub',
        'gluesync-chronos',
        'gluesync-conductor',
      ],
    );
    assert.deepEqual(stable, ['gluesync-core-hub']);
  });

  it('ensures volume directories before starting a service on Windows', async () => {
    process.env.IS_WINDOWS = 'true';
    const { createActions, calls } = load();
    assert.equal(await createActions({ docker }).start('svc'), 'upAll ok');
    assert.deepEqual(calls, ['upAll --no-deps svc']);
  });
});
