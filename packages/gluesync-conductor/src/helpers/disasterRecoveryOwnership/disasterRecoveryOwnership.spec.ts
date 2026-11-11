/* eslint-disable functional/immutable-data, functional/no-let, functional/prefer-immutable-types, no-param-reassign -- a fake Docker that records what it was asked */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import type { DisasterRecoveryTargets } from '../disasterRecoveryCompose/disasterRecoveryCompose.model';
import type {
  GiveChronosDataToCoreHub,
  ResolveCoreHubOwner,
} from './disasterRecoveryOwnership.model';

const here = (p: string): string => path.resolve(__dirname, p);

const targets: DisasterRecoveryTargets = {
  coreHub: 'gluesync-core-hub',
  chronos: 'gluesync-chronos',
  windows: false,
  controlScheme: 'http',
};

const compose = (extra: Record<string, unknown> = {}) => ({
  services: {
    'gluesync-core-hub': {
      image: 'molo17/gluesync-core-hub:2.3.1.0',
      ...extra,
    },
    'gluesync-chronos': {
      image: 'molo17/gluesync-chronos:0.3.3',
      volumes: ['./data/chronos:/app/data'],
    },
  },
});

type Fake = {
  created: any[];
  removed: number;
  started: number;
  logs: string[];
  listed: any[];
  imageUser: string | undefined;
  inspectFails: boolean;
  exitCode: number;
  containers: any[];
  startFails: boolean;
};

const build = (fake: Fake) => {
  const docker = {
    getImage: () => ({
      inspect: async () => {
        if (fake.inspectFails) {
          throw new Error('no such image');
        }
        return { Config: { User: fake.imageUser } };
      },
    }),
    listContainers: async (options: unknown) => {
      fake.listed.push(options);
      return fake.containers;
    },
    createContainer: async (options: unknown) => {
      fake.created.push(options);
      return {
        start: async () => {
          if (fake.startFails) {
            throw new Error('cannot start');
          }
          fake.started += 1;
        },
        wait: async () => ({ StatusCode: fake.exitCode }),
        logs: async () => Buffer.from('chown: read-only file system'),
        remove: async () => {
          fake.removed += 1;
        },
      };
    },
  };
  const subject = loadWithStubs<{
    default: GiveChronosDataToCoreHub;
    resolveCoreHubOwner: ResolveCoreHubOwner;
  }>(here('./disasterRecoveryOwnership'), {
    [here('../../utils/logger')]: {
      getLogger: () => {
        const log =
          (level: string) =>
          (...args: unknown[]) =>
            fake.logs.push(`${level} ${String(args[args.length - 1])}`);

        return {
          info: log('info'),
          warn: log('warn'),
          error: log('error'),
          debug: log('debug'),
        };
      },
    },
  });

  return { docker: docker as never, subject };
};

describe('giveChronosDataToCoreHub', () => {
  const saved = process.env.GS_COREHUB_USERNS;
  let fake: Fake;

  beforeEach(() => {
    delete process.env.GS_COREHUB_USERNS;
    fake = {
      created: [],
      removed: 0,
      started: 0,
      logs: [],
      listed: [],
      imageUser: undefined,
      inspectFails: false,
      exitCode: 0,
      containers: [
        {
          Id: 'chronos-id',
          Image: 'molo17/gluesync-chronos:0.3.3',
          ImageID: 'sha256:abc',
        },
      ],
      startFails: false,
    };
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.GS_COREHUB_USERNS;
    } else {
      process.env.GS_COREHUB_USERNS = saved;
    }
  });

  it('chowns the data directory of Chronos to 1017 in a helper that shares its volumes, from the image Chronos runs on', async () => {
    const { docker, subject } = build(fake);

    await subject.default(docker, compose(), targets);

    assert.equal(fake.created.length, 1);
    assert.deepEqual(fake.created[0], {
      Image: 'sha256:abc',
      User: '0:0',
      Entrypoint: ['chown'],
      Cmd: ['-R', '1017:1017', '/app/data'],
      NetworkDisabled: true,
      HostConfig: { VolumesFrom: ['chronos-id'] },
    });
    assert.equal(fake.started, 1);
    assert.equal(fake.removed, 1);
    assert.deepEqual(fake.listed, [
      {
        all: true,
        filters: { label: ['com.docker.compose.service=gluesync-chronos'] },
      },
    ]);
    assert.ok(
      fake.logs.some(
        l => l.startsWith('info') && /belongs to 1017:1017/.test(l),
      ),
    );
  });

  it('uses the user of the Core Hub image when it sets one, uid and gid', async () => {
    fake.imageUser = '2000:3000';
    const { docker, subject } = build(fake);

    await subject.default(docker, compose(), targets);

    assert.deepEqual(fake.created[0].Cmd, ['-R', '2000:3000', '/app/data']);
  });

  it('follows DATA_DIR of Chronos', async () => {
    const { docker, subject } = build(fake);
    const custom = compose();

    Object.assign(custom.services['gluesync-chronos'], {
      environment: ['DATA_DIR=/srv/chronos'],
      volumes: ['chronos-data:/srv/chronos'],
    });
    await subject.default(docker, custom, targets);

    assert.deepEqual(fake.created[0].Cmd, ['-R', '1017:1017', '/srv/chronos']);
  });

  it('fails the setup with a clear message and log when the chown fails, and still removes the helper', async () => {
    fake.exitCode = 1;
    const { docker, subject } = build(fake);

    await assert.rejects(
      subject.default(docker, compose(), targets),
      /Could not give the Chronos data directory to Core Hub \(1017:1017\): .*chown exited with code 1: chown: read-only file system/,
    );
    assert.equal(fake.removed, 1);
    assert.ok(
      fake.logs.some(
        l =>
          l.startsWith('error') &&
          /could not make \/app\/data of gluesync-chronos belong to 1017:1017/.test(
            l,
          ),
      ),
    );
  });

  it('fails the setup when the helper cannot start, or there is no Chronos container', async () => {
    fake.startFails = true;
    const first = build(fake);

    await assert.rejects(
      first.subject.default(first.docker, compose(), targets),
      /cannot start/,
    );
    assert.equal(fake.removed, 1);

    fake.containers = [];
    const second = build(fake);

    await assert.rejects(
      second.subject.default(second.docker, compose(), targets),
      /no container of gluesync-chronos/,
    );
  });

  it('changes nothing when Core Hub starts as the host user (GS_COREHUB_USERNS or userns_mode keep-id)', async () => {
    const { docker, subject } = build(fake);

    process.env.GS_COREHUB_USERNS = 'keep-id:uid=1017,gid=1017';
    await subject.default(docker, compose(), targets);
    delete process.env.GS_COREHUB_USERNS;
    await subject.default(
      docker,
      compose({ userns_mode: 'keep-id:uid=1017,gid=1017' }),
      targets,
    );

    assert.deepEqual(fake.created, []);
    assert.deepEqual(fake.listed, []);
  });

  it('changes nothing on Windows containers', async () => {
    const { docker, subject } = build(fake);

    await subject.default(docker, compose(), { ...targets, windows: true });

    assert.deepEqual(fake.created, []);
  });
});

describe('resolveCoreHubOwner', () => {
  it('reads Config.User, falls back to 1017 when it is unset, unreadable or a name', async () => {
    const fake = (user: string | undefined, fails = false): Fake => ({
      created: [],
      removed: 0,
      started: 0,
      logs: [],
      listed: [],
      imageUser: user,
      inspectFails: fails,
      exitCode: 0,
      containers: [],
      startFails: false,
    });
    const owner = (f: Fake, image: string | null = 'x') => {
      const { docker, subject } = build(f);

      return subject.resolveCoreHubOwner(docker, image ?? undefined);
    };

    assert.deepEqual(await owner(fake('1500')), { uid: 1500, gid: 1500 });
    assert.deepEqual(await owner(fake('1500:1600')), { uid: 1500, gid: 1600 });
    assert.deepEqual(await owner(fake('')), { uid: 1017, gid: 1017 });
    assert.deepEqual(await owner(fake(undefined)), { uid: 1017, gid: 1017 });
    assert.deepEqual(await owner(fake('gluesync')), { uid: 1017, gid: 1017 });
    assert.deepEqual(await owner(fake('1500', true)), { uid: 1017, gid: 1017 });
    assert.deepEqual(await owner(fake('1500'), null), {
      uid: 1017,
      gid: 1017,
    });
  });
});
