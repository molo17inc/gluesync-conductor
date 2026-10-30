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
  dockerDown?: Error;
  stableError?: Error;
  rebootError?: Error;
  // Compose unless told otherwise; `null` is "Docker not answering"
  orchestrator?: unknown;
}>;

const load = ({
  failing = new Set(),
  dockerDown,
  stableError,
  rebootError,
  orchestrator = { mode: 'compose' },
}: Setup = {}) => {
  const calls: string[] = [];
  const ensured: Array<{ id: string; composeCallsBefore: number }> = [];
  const swarmCalls: Array<{ options: unknown; action: string; id: string }> =
    [];
  const stable: string[] = [];
  const dockerWaits: number[] = [];
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
        default: async (id: string) => {
          // compose calls made before the folders were prepared
          ensured.push({ id, composeCallsBefore: calls.length });
        },
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
      [here('../../orchestrator/getOrchestrator/getOrchestrator')]: {
        getDecidedOrchestrator: async () => orchestrator ?? undefined,
      },
      [here('../../swarm/createSwarmActions/createSwarmActions')]: {
        default: (options: unknown) =>
          new Proxy(
            {},
            {
              get: (_target, action: string) => async (id: string) => {
                swarmCalls.push({ options, action, id });
                return `swarm ${action} ${id}`;
              },
            },
          ),
      },
      [here('../waitForDockerOutage/waitForDockerOutage')]: {
        default: async (_docker: unknown, budgetMs: number) => {
          dockerWaits.push(budgetMs);
          if (dockerDown) {
            throw dockerDown;
          }
        },
        dockerWaitMs: () => 60000,
      },
      [here('../../../utils/docker/getDocker')]: {
        getDocker: () => ({}),
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
    ensured,
    swarmCalls,
    stable,
    dockerWaits,
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

  it('prepares the bind folders of a service before it starts, on Linux too', async () => {
    delete process.env.IS_WINDOWS;
    const { createActions, ensured } = load();

    await createActions({ docker }).start('gs-agent-1');

    assert.deepEqual(ensured, [{ id: 'gs-agent-1', composeCallsBefore: 0 }]);
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

  it('checks the Docker API answers before it touches anything on update', async () => {
    const { createActions, calls, dockerWaits } = load();
    await createActions({ docker }).update('grafana');
    // A short wait, not the full outage budget.
    assert.deepEqual(dockerWaits, [15000]);
    assert.equal(calls[0], 'pullAll --include-deps grafana');
  });

  it('does not pull or recreate while Docker is down', async () => {
    const down = Object.assign(
      new Error('Docker daemon not ready within 15000ms'),
      {
        code: 'ETIMEDOUT',
      },
    );
    const { createActions, calls } = load({ dockerDown: down });
    await assert.rejects(
      createActions({ docker }).update('grafana'),
      /Docker daemon not ready/,
    );
    assert.deepEqual(calls, []);
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
        helperImage: 'docker.io/library/docker:cli',
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

  describe('on Docker Swarm', () => {
    const orchestrator = {
      mode: 'swarm',
      namespace: 'gs',
      selfService: 'gluesync-conductor',
      isManager: true,
    };

    it('runs the swarm implementation of every action but removeNetwork', async () => {
      const { createActions, calls, swarmCalls } = load({ orchestrator });
      const actions = createActions({ docker, filename: 'stack.yml' });

      assert.equal(await actions.kill('svc'), 'swarm kill svc');
      assert.equal(await actions.pull('svc'), 'swarm pull svc');
      assert.equal(await actions.remove('svc'), 'swarm remove svc');
      assert.equal(await actions.restart('svc'), 'swarm restart svc');
      assert.equal(await actions.start('svc'), 'swarm start svc');
      assert.equal(await actions.stop('svc'), 'swarm stop svc');
      assert.equal(await actions.undeploy('svc'), 'swarm undeploy svc');
      assert.equal(await actions.update('svc'), 'swarm update svc');
      assert.equal(await actions.removeNetwork('svc'), 'net');
      assert.deepEqual(calls, [], 'no docker compose command runs');
      assert.equal(swarmCalls.length, 8);
      assert.deepEqual(swarmCalls[0].options, {
        docker,
        orchestrator,
        filename: 'stack.yml',
      });
    });

    it('never enables update mode nor starts the helper container', async () => {
      const { createActions, reboots, updateModes, stable } = load({
        orchestrator,
      });

      await createActions({ docker }).update('gluesync-conductor');
      await flush();

      assert.equal(updateModes(), 0);
      assert.equal(reboots.length, 0);
      assert.equal(stable.length, 0);
    });
  });

  describe('when the mode is not known', () => {
    it('refuses to act instead of assuming compose', async () => {
      const { createActions, calls, swarmCalls } = load({
        orchestrator: null,
      });
      const actions = createActions({ docker });

      await assert.rejects(
        actions.start('svc'),
        /Docker daemon is not answering/,
      );
      await assert.rejects(
        actions.update('svc'),
        /Docker daemon is not answering/,
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(swarmCalls, []);
    });
  });
});
