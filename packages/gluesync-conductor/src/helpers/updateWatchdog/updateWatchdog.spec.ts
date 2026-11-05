import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';
import type Docker from 'dockerode';

import loadWithStubs from '../../testing/loadWithStubs';
import { helperRunning, imageExists } from './updateWatchdog';
import {
  HealthStatus,
  StartUpdateWatchdog,
  WatchdogOptions,
  WatchdogResult,
} from './updateWatchdog.model';

type World = {
  updateMode: boolean;
  disableCalls: number;
  status: () => HealthStatus;
  imageExists: () => boolean;
  version: () => string | null;
  composeBroken: boolean;
  helperRunning: boolean;
  serviceContainers: ReadonlyArray<{ Id: string }>;
};

const IMAGE = 'molo17/svc:1.0';

const newWorld = (overrides: Partial<World> = {}): World => ({
  updateMode: true,
  disableCalls: 0,
  status: () => ({ running: true, health: 'none' }),
  imageExists: () => true,
  version: () => '1.0',
  composeBroken: false,
  helperRunning: false,
  serviceContainers: [{ Id: 'cid' }],
  ...overrides,
});

type ListFilters = Readonly<{
  filters?: Readonly<Record<string, ReadonlyArray<string>>>;
}>;

const fakeDocker = (world: World): Docker =>
  ({
    listContainers: async (opts: ListFilters) => {
      if (opts.filters?.label) {
        return world.serviceContainers;
      }
      if (opts.filters?.ancestor) {
        return world.helperRunning ? [{ Id: 'helper' }] : [];
      }
      return [];
    },
    getContainer: () => ({
      inspect: async () => {
        const { running, health } = world.status();
        return {
          State: {
            Running: running,
            Health:
              health && health !== 'none' ? { Status: health } : undefined,
          },
        };
      },
    }),
    getImage: () => ({
      inspect: async () => {
        if (!world.imageExists()) {
          throw new Error('No such image');
        }
        return {};
      },
    }),
    getEvents: async () => Readable.from([]),
  }) as unknown as Docker;

const load = (world: World): StartUpdateWatchdog =>
  loadWithStubs<{ startUpdateWatchdog: StartUpdateWatchdog }>(
    path.resolve(__dirname, './updateWatchdog'),
    {
      [path.resolve(
        __dirname,
        '../composeFile/readComposeFile/readComposeFile',
      )]: {
        readComposeFile: async () => {
          if (world.composeBroken) {
            throw new Error('compose unreadable');
          }
          return { services: { svc: { image: IMAGE } } };
        },
      },
      [path.resolve(__dirname, '../getCurrentVersion/getCurrentVersion')]: {
        default: async () => world.version(),
      },
      [path.resolve(__dirname, '../../plugins/apiBlockerAsUpdating')]: {
        isUpdateMode: () => world.updateMode,
        disableUpdateMode: () => {
          Object.assign(world, {
            updateMode: false,
            disableCalls: world.disableCalls + 1,
          });
        },
      },
    },
  ).startUpdateWatchdog;

const BASE_OPTS: WatchdogOptions = {
  serviceName: 'svc',
  pollIntervalMs: 1000,
  timeoutMs: 60_000,
  updateModeGraceMs: 3000,
};

// One mocked clock step per event-loop turn, until `isDone`
const pump = async (isDone: () => boolean, stepMs: number): Promise<void> => {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
  if (isDone()) {
    return;
  }
  mock.timers.tick(stepMs);
  await pump(isDone, stepMs);
};

// Advances the mocked clock while the watchdog is waiting on its timers
const run = async (
  world: World,
  opts: Partial<WatchdogOptions> = {},
): Promise<WatchdogResult> => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const watchdog = load(world)(fakeDocker(world), { ...BASE_OPTS, ...opts });
  const state = { settled: false };
  const guarded = watchdog.finally(() => {
    state.settled = true;
  });
  guarded.catch(() => undefined);

  await pump(() => state.settled, 500);

  return watchdog;
};

describe('startUpdateWatchdog', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  describe('exit conditions', () => {
    it('stops when update mode is not active', async () => {
      const world = newWorld({ updateMode: false });

      assert.deepEqual(await run(world), {
        ok: true,
        reason: 'update-mode-disabled',
      });
    });

    it('gives up once the timeout elapsed', async () => {
      const world = newWorld();

      assert.deepEqual(await run(world, { timeoutMs: 0 }), {
        ok: false,
        reason: 'timeout',
      });
    });
  });

  describe('container running', () => {
    it('disables update mode once the service is healthy', async () => {
      const world = newWorld({
        status: () => ({ running: true, health: 'healthy' }),
      });

      assert.deepEqual(await run(world), { ok: true, reason: 'healthy' });
      assert.equal(world.disableCalls, 1);
    });

    it('accepts a validated service without healthcheck', async () => {
      const world = newWorld();

      assert.deepEqual(await run(world), {
        ok: true,
        reason: 'running-validated-no-healthcheck',
      });
      assert.equal(world.disableCalls, 1);
    });

    it('waits while the healthcheck is still starting', async () => {
      const statuses: ReadonlyArray<HealthStatus> = [
        { running: true, health: 'starting' },
        { running: true, health: 'starting' },
        { running: true, health: 'healthy' },
      ];
      const calls = { count: 0 };
      const world = newWorld({
        status: () => {
          const current = statuses[Math.min(calls.count, statuses.length - 1)];
          calls.count += 1;
          return current;
        },
      });

      assert.deepEqual(await run(world), { ok: true, reason: 'healthy' });
      assert.equal(calls.count, 3);
    });

    it('waits while the expected image is being pulled', async () => {
      const calls = { count: 0 };
      const world = newWorld({
        imageExists: () => {
          calls.count += 1;
          return calls.count > 1;
        },
      });

      assert.deepEqual(await run(world), {
        ok: true,
        reason: 'running-validated-no-healthcheck',
      });
    });

    it('waits inside the grace window on a version mismatch', async () => {
      const world = newWorld({ version: () => '0.9' });

      assert.deepEqual(await run(world, { timeoutMs: 2000 }), {
        ok: false,
        reason: 'timeout',
      });
    });

    it('keeps polling after the grace window when there is no recovery function', async () => {
      const world = newWorld({ version: () => '0.9' });

      assert.deepEqual(await run(world, { timeoutMs: 8000 }), {
        ok: false,
        reason: 'timeout',
      });
      assert.equal(world.disableCalls, 0);
    });

    it('recovers a stale version once the grace window passed', async () => {
      const recovered = { count: 0 };
      const world = newWorld({ version: () => '0.9' });
      const recoveryFunction = async (): Promise<boolean> => {
        recovered.count += 1;
        world.version = () => '1.0';
        return true;
      };

      assert.deepEqual(await run(world, { recoveryFunction }), {
        ok: true,
        reason: 'running-validated-no-healthcheck',
      });
      assert.equal(recovered.count, 1);
    });

    it('recovers when the runtime validation fails', async () => {
      const recovered = { count: 0 };
      const world = newWorld({ composeBroken: true });
      const recoveryFunction = async (): Promise<boolean> => {
        recovered.count += 1;
        world.composeBroken = false;
        return true;
      };

      assert.deepEqual(await run(world, { recoveryFunction }), {
        ok: true,
        reason: 'running-validated-no-healthcheck',
      });
      assert.equal(recovered.count, 1);
    });

    it('keeps polling a failed validation without recovery function', async () => {
      const world = newWorld({ composeBroken: true });

      assert.deepEqual(await run(world, { timeoutMs: 4000 }), {
        ok: false,
        reason: 'timeout',
      });
    });
  });

  describe('container not running', () => {
    const down = (): HealthStatus => ({ running: false, health: 'none' });

    it('defers recovery inside the grace window, then keeps polling without recovery function', async () => {
      const world = newWorld({ status: down });

      assert.deepEqual(await run(world, { timeoutMs: 8000 }), {
        ok: false,
        reason: 'timeout',
      });
    });

    it('defers recovery while the image is being pulled', async () => {
      const world = newWorld({ status: down, imageExists: () => false });
      const recoveryFunction = async (): Promise<boolean> => true;

      assert.deepEqual(
        await run(world, { timeoutMs: 8000, recoveryFunction }),
        { ok: false, reason: 'timeout' },
      );
    });

    it('defers recovery while the helper is running', async () => {
      const world = newWorld({ status: down, helperRunning: true });
      const recoveryFunction = async (): Promise<boolean> => true;

      assert.deepEqual(
        await run(world, {
          timeoutMs: 8000,
          recoveryFunction,
          helperImageOrName: 'helper',
        }),
        { ok: false, reason: 'timeout' },
      );
    });

    it('reports a recovered service', async () => {
      const calls = { count: 0 };
      const world = newWorld({ status: down });
      const recoveryFunction = async (): Promise<boolean> => {
        calls.count += 1;
        world.status = () => ({ running: true, health: 'healthy' });
        return true;
      };

      assert.deepEqual(await run(world, { recoveryFunction }), {
        ok: true,
        reason: 'recovered',
      });
      assert.equal(calls.count, 1);
    });

    it('backs off and retries while the recovered service is still down', async () => {
      const calls = { count: 0 };
      const world = newWorld({ status: down });
      const recoveryFunction = async (): Promise<boolean> => {
        calls.count += 1;
        if (calls.count > 1) {
          world.status = () => ({ running: true, health: 'none' });
        }
        return true;
      };

      assert.deepEqual(await run(world, { recoveryFunction }), {
        ok: true,
        reason: 'recovered',
      });
      assert.equal(calls.count, 2);
    });

    it('keeps polling after a failed recovery attempt', async () => {
      const calls = { count: 0 };
      const world = newWorld({ status: down });
      const recoveryFunction = async (): Promise<boolean> => {
        calls.count += 1;
        if (calls.count === 1) {
          throw new Error('boom');
        }
        world.status = () => ({ running: true, health: 'healthy' });
        return true;
      };

      assert.deepEqual(await run(world, { recoveryFunction }), {
        ok: true,
        reason: 'recovered',
      });
      assert.equal(calls.count, 2);
    });
  });
});

describe('the image names the watchdog looks for', () => {
  // A Podman engine knows a pulled molo17/svc:1.0 as docker.io/molo17/svc:1.0
  const engineKnowing = (known: ReadonlyArray<string>) => {
    const inspected: string[] = [];
    const listed: unknown[] = [];
    const docker = {
      getImage: (name: string) => ({
        inspect: async () => {
          inspected.push(name);
          if (!known.includes(name)) {
            throw new Error('No such image');
          }
          return {};
        },
      }),
      listContainers: async (options: {
        filters?: { ancestor?: string[] };
      }) => {
        listed.push(options);
        return options.filters?.ancestor?.some(name => known.includes(name))
          ? [{ Id: 'helper' }]
          : [];
      },
    } as unknown as Docker;
    return { docker, inspected, listed };
  };

  it('finds an image the engine only has fully qualified', async () => {
    const { docker } = engineKnowing(['docker.io/molo17/svc:1.0']);

    assert.equal(await imageExists(docker, 'molo17/svc:1.0'), true);
  });

  it('finds an image the engine has as written, and misses one it lacks', async () => {
    assert.equal(
      await imageExists(
        engineKnowing(['molo17/svc:1.0']).docker,
        'molo17/svc:1.0',
      ),
      true,
    );
    assert.equal(
      await imageExists(engineKnowing([]).docker, 'molo17/svc:1.0'),
      false,
    );
  });

  it('finds a running helper by either spelling of its image', async () => {
    const { docker, listed } = engineKnowing(['docker.io/library/docker:cli']);

    assert.equal(await helperRunning(docker, 'docker:cli'), true);
    assert.deepEqual(listed[0], {
      filters: { ancestor: ['docker:cli', 'docker.io/library/docker:cli'] },
    });
  });

  it('finds a helper by its name when no container has that ancestor', async () => {
    const docker = {
      listContainers: async (options: { filters?: { name?: string[] } }) =>
        options.filters?.name ? [{ Id: 'named' }] : [],
    } as unknown as Docker;

    assert.equal(await helperRunning(docker, 'conductor-helper'), true);
  });
});
