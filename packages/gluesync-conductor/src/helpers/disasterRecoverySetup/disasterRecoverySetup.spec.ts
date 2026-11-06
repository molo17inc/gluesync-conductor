/* eslint-disable functional/immutable-data, functional/no-let, functional/prefer-immutable-types, no-param-reassign -- the spec points the Conductor at a temporary project and records what the Docker layer was asked */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { DiskFullError } from '../file/safeWriteFile/safeWriteFile.errors';
import type { DisasterRecoveryTargets } from '../disasterRecoveryCompose/disasterRecoveryCompose.model';
import type {
  InspectDisasterRecovery,
  PrepareDisasterRecoveryChange,
  ReadDisasterRecoveryEnv,
} from './disasterRecoverySetup.model';

const here = (p: string): string => path.resolve(__dirname, p);

const KIT = `# kit header: keep me
name: gluesync

services:
  gluesync-core-hub:
    restart: unless-stopped
    image: molo17/gluesync-core-hub:2.3.1.0
    labels:
      - com.molo17.conductor.type=core-hub
    environment:
      - SSL_ENABLED=true # the kit runs Core Hub over TLS
    volumes:
      - ./shared:/opt/gluesync/shared
      - ./data/core-hub:/opt/gluesync/data
    env_file:
      - path: .env
        required: false
      - path: /opt/gluesync-conductor/root-folder/.env
        required: false
    networks:
      - gluesync-net

  gluesync-chronos:
    restart: unless-stopped
    image: molo17/gluesync-chronos:0.3.3
    environment:
      - TIMEZONE=UTC
    volumes:
      - ./shared:/opt/gluesync/shared:ro
      - ./data/chronos:/app/data
    env_file:
      - path: .env
        required: false
    networks:
      - gluesync-net

  gluesync-conductor:
    restart: unless-stopped
    image: molo17/gluesync-conductor:0.14.1

networks:
  gluesync-net:
    name: gluesync-net
`;

const DR_FILE = 'gluesync-dr.env';

type Recorder = {
  commands: string[][];
  verified: string[];
  logs: string[];
  mode: 'compose' | 'swarm' | undefined;
  /** 1-based numbers of the recreate commands that fail */
  failRecreates: number[];
  failVerify: boolean;
  failOwnership: boolean;
  ownership: string[];
  failComposeWrite: unknown;
  attempts: number;
};

type Subject = Readonly<{
  inspectDisasterRecovery: InspectDisasterRecovery;
  prepareDisasterRecoveryChange: PrepareDisasterRecoveryChange;
  readDisasterRecoveryEnv: ReadDisasterRecoveryEnv;
  getDisasterRecoveryTargets: (
    compose: object,
  ) => Promise<DisasterRecoveryTargets>;
}>;

const load = (recorder: Recorder): Subject =>
  loadWithStubs<Subject>(here('./disasterRecoverySetup'), {
    'docker-compose': { upAll: 'upAll' },
    [here('../dockerode/createActions/createActions')]: {
      runCmd: async (
        command: string,
        id: string,
        file: string,
        extra: ReadonlyArray<string>,
      ) => {
        recorder.attempts += 1;
        if (recorder.failRecreates.includes(recorder.attempts)) {
          throw new Error('compose exploded');
        }
        recorder.commands.push([command, id, file, ...extra]);
        return '';
      },
    },
    [here('../orchestrator/getOrchestrator/getOrchestrator')]: {
      getDecidedOrchestrator: async () =>
        recorder.mode ? { mode: recorder.mode } : undefined,
    },
    [here('../../utils/docker/getDocker')]: {
      getDocker: () => ({ docker: true }),
    },
    [here('../verifyServiceStable/verifyServiceStable')]: {
      default: async (_docker: unknown, id: string) => {
        recorder.verified.push(id);
        if (recorder.failVerify) {
          throw new Error(`${id} is not staying up after the update`);
        }
      },
    },
    [here('../disasterRecoveryOwnership/disasterRecoveryOwnership')]: {
      default: async (
        _docker: unknown,
        _compose: unknown,
        targets: { chronos: string },
      ) => {
        recorder.ownership.push(
          `${targets.chronos}:${existsSync(path.join(process.env.PROJECT_CWD ?? '', 'gluesync-dr.env')) ? 'after' : 'before'}-write`,
        );
        if (recorder.failOwnership) {
          throw new Error(
            'Could not give the Chronos data directory to Core Hub',
          );
        }
      },
    },
    ...(recorder.failComposeWrite
      ? {
          [here('../composeFile/writeComposeFile/writeComposeFile')]: {
            default: async () => {
              throw recorder.failComposeWrite;
            },
          },
        }
      : {}),
    [here('../../utils/logger')]: {
      getLogger: () => {
        const log =
          (level: string) =>
          (...args: unknown[]) =>
            recorder.logs.push(`${level} ${String(args[args.length - 1])}`);

        return {
          info: log('info'),
          warn: log('warn'),
          error: log('error'),
          debug: log('debug'),
        };
      },
    },
  });

const ENV_NAMES = [
  'DKR_COMPOSE_FILE',
  'CONDUCTOR_COMPOSE_BACKUP_DIR',
  'PROJECT_CWD',
  'CORE_HUB_NAME',
  'CHRONOS_NAME',
  'IS_WINDOWS',
];

const VARIABLES = {
  nodeId: 'site-a',
  peerUrl: 'http://10.0.0.2:1717',
  failoverMode: 'manual',
  witnessUrl: null,
  leaseTtlSeconds: 30,
  sharedSecret: 'q8Zr0yKc-mP3v_XtN2bHsLw9aUeD5fGjR7oIiYkTnVA',
  adminToken: 'Zt3kLw9aUeD5fGjR7oIiYkTnVAq8Zr0yKc-mP3v_XtN',
  bootstrapActive: true,
} as const;

describe('disasterRecoverySetup', () => {
  const saved = new Map(ENV_NAMES.map(name => [name, process.env[name]]));
  let dir = '';
  let recorder: Recorder;
  let subject: Subject;

  const composePath = (): string => path.join(dir, 'docker-compose.yml');
  const envPath = (): string => path.join(dir, DR_FILE);
  const readCompose = (): string => readFileSync(composePath(), 'utf8');
  const backups = (): string[] => {
    const root = path.join(dir, '.conductor', 'dr-backup');

    return existsSync(root) ? readdirSync(root) : [];
  };
  const backupDir = (): string =>
    path.join(dir, '.conductor', 'dr-backup', backups()[0]);

  // a function, so that a deepEqual above does not narrow the list to `never[]`
  const recreated = (): string[] =>
    recorder.commands.map(command => command[1]);

  const targets = (): Promise<DisasterRecoveryTargets> =>
    subject.getDisasterRecoveryTargets(JSON.parse('{}'));

  const prepareEnable = async (variables = VARIABLES) =>
    subject.prepareDisasterRecoveryChange(
      { kind: 'enable', variables },
      {
        coreHub: 'gluesync-core-hub',
        chronos: 'gluesync-chronos',
        windows: false,
        controlScheme: 'https',
      },
    );

  const prepareDisable = async () =>
    subject.prepareDisasterRecoveryChange(
      { kind: 'disable' },
      {
        coreHub: 'gluesync-core-hub',
        chronos: 'gluesync-chronos',
        windows: false,
        controlScheme: 'https',
      },
    );

  const inspect = () => subject.inspectDisasterRecovery({} as never);

  before(() => {
    // The compose helpers read DKR_COMPOSE_FILE when they load
    process.env.DKR_COMPOSE_FILE = 'docker-compose.yml';
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'conductor-dr-setup-'));
    process.env.PROJECT_CWD = dir;
    process.env.CONDUCTOR_COMPOSE_BACKUP_DIR = path.join(dir, '.conductor');
    delete process.env.CORE_HUB_NAME;
    delete process.env.CHRONOS_NAME;
    delete process.env.IS_WINDOWS;
    writeFileSync(composePath(), KIT);
    recorder = {
      commands: [],
      verified: [],
      logs: [],
      mode: 'compose',
      failRecreates: [],
      failVerify: false,
      failOwnership: false,
      ownership: [],
      failComposeWrite: undefined,
      attempts: 0,
    };
    subject = load(recorder);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  after(() =>
    saved.forEach((value, name) => {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }),
  );

  describe('readDisasterRecoveryEnv', () => {
    it('is undefined without the file, and reads what the setup wrote once there is one', async () => {
      assert.equal(await subject.readDisasterRecoveryEnv(), undefined);

      await prepareEnable({
        ...VARIABLES,
        pairing: { thisSiteUrl: 'http://10.0.0.1:1717', peerNodeId: 'site-b' },
      } as never);

      const variables = await subject.readDisasterRecoveryEnv();

      assert.equal(variables?.GS_DR_MANAGED_BY, 'conductor');
      assert.equal(variables?.GS_DR_SHARED_SECRET, VARIABLES.sharedSecret);
      assert.equal(variables?.GS_DR_PAIRING_FIRST_URL, 'http://10.0.0.1:1717');
    });
  });

  describe('inspectDisasterRecovery', () => {
    it('reports a kit without DR as supported and not enabled', async () => {
      const { state } = await inspect();

      assert.deepEqual(state, {
        supported: true,
        reason: null,
        enabled: false,
        managedByConductor: false,
        nodeId: null,
        peerUrl: null,
        failoverMode: null,
        witnessUrl: null,
        bootstrapActive: false,
      });
    });

    it('takes https for the control port from the SSL of Core Hub', async () => {
      assert.equal((await targets()).controlScheme, 'http');
      assert.equal((await inspect()).targets.controlScheme, 'https');
    });

    it('is not supported on Swarm, and says why', async () => {
      recorder.mode = 'swarm';
      const { state } = await inspect();

      assert.equal(state.supported, false);
      assert.match(state.reason ?? '', /Docker Swarm/);
    });

    it('does not guess while Docker is not answering', async () => {
      recorder.mode = undefined;
      const result = await inspect();

      assert.equal(result.dockerUnknown, true);
      assert.equal(result.state.supported, false);
      assert.match(result.state.reason ?? '', /Docker daemon is not answering/);
    });

    it('is not supported without a Chronos service', async () => {
      writeFileSync(
        composePath(),
        KIT.replace(/ {2}gluesync-chronos:[\s\S]*?\n\n/, ''),
      );
      const { state } = await inspect();

      assert.equal(state.supported, false);
      assert.match(state.reason ?? '', /Chronos service "gluesync-chronos"/);
    });

    it('reports DR enabled by hand as enabled and not managed, with its settings', async () => {
      writeFileSync(
        path.join(dir, '.env'),
        'GS_DR_ENABLED=true\nGS_DR_NODE_ID=hand-a\nGS_DR_PEER_URL=http://10.9.9.9:1717\nGS_DR_FAILOVER_MODE=witness\nGS_DR_WITNESS_URL=https://w.example.com\nGS_DR_SHARED_SECRET=top-secret-value-0123456789abcdefgh\nGS_DR_ADMIN_TOKEN=top-token-value-0123456789abcdefghij\n',
      );
      const { state } = await inspect();

      assert.equal(state.enabled, true);
      assert.equal(state.managedByConductor, false);
      assert.equal(state.nodeId, 'hand-a');
      assert.equal(state.peerUrl, 'http://10.9.9.9:1717');
      assert.equal(state.failoverMode, 'witness');
      assert.equal(state.witnessUrl, 'https://w.example.com');
      assert.equal(state.bootstrapActive, false);
      assert.ok(!JSON.stringify(state).includes('top-secret'));
      assert.ok(!JSON.stringify(state).includes('top-token'));
    });
  });

  describe('enable', () => {
    it('backs up, writes the env file and the compose file, and only then lets the caller recreate', async () => {
      const prepared = await prepareEnable();

      // nothing was recreated yet: the caller answers its request first
      assert.deepEqual(recorder.commands, []);
      assert.deepEqual(prepared.restarting, [
        'gluesync-core-hub',
        'gluesync-chronos',
      ]);

      // the compose file as it was, and no env file to back up
      assert.equal(backups().length, 1);
      assert.match(backups()[0], /^\d{8}T\d{6}Z$/);
      assert.equal(
        readFileSync(path.join(backupDir(), 'docker-compose.yml'), 'utf8'),
        KIT,
      );
      assert.deepEqual(readdirSync(backupDir()), ['docker-compose.yml']);

      // the env file: variables of this site, private
      const env = readFileSync(envPath(), 'utf8');

      assert.match(env, /^GS_DR_MANAGED_BY=conductor$/m);
      assert.match(env, /^GS_DR_ENABLED=true$/m);
      assert.match(env, /^GS_DR_NODE_ID=site-a$/m);
      assert.match(env, /^GS_DR_BOOTSTRAP_ACTIVE=true$/m);
      assert.match(env, /^GS_DR_CHRONOS_DIR=\/opt\/gluesync\/chronos$/m);
      assert.match(env, /^GS_DR_SHARED_SECRET=q8Zr0yKc/m);
      assert.equal(statSync(envPath()).mode % 0o1000, 0o600);

      // the compose file: edited in place, comments kept, secrets never in it
      const compose = readCompose();

      assert.match(compose, /^# kit header: keep me$/m);
      assert.match(compose, /# the kit runs Core Hub over TLS/);
      assert.match(compose, /- 1718:1718/);
      assert.match(compose, /- 1719:1719/);
      assert.match(compose, /\.\/data\/chronos:\/opt\/gluesync\/chronos/);
      assert.match(compose, /stop_grace_period: 60s/);
      assert.match(
        compose,
        /GS_DR_CONTROL_URL=https:\/\/gluesync-core-hub:1719/,
      );
      assert.match(compose, /path: gluesync-dr\.env/);
      assert.ok(!compose.includes('q8Zr0yKc'));
      assert.ok(!compose.includes('Zt3kLw9a'));
    });

    it('gives the Chronos data directory to Core Hub before anything is written', async () => {
      await prepareEnable();

      assert.deepEqual(recorder.ownership, ['gluesync-chronos:before-write']);
    });

    it('fails the setup, writing nothing and recreating nothing, when the owner cannot be changed', async () => {
      recorder.failOwnership = true;

      await assert.rejects(
        prepareEnable(),
        /Could not give the Chronos data directory/,
      );

      assert.equal(readCompose(), KIT);
      assert.ok(!existsSync(envPath()));
      assert.deepEqual(recorder.commands, []);
      assert.ok(
        recorder.logs.some(l =>
          /writing the files failed, restoring them/.test(l),
        ),
      );
    });

    it('does not change the owner back on a disable', async () => {
      await prepareEnable();
      recorder.ownership.length = 0;
      await prepareDisable();

      assert.deepEqual(recorder.ownership, []);
    });

    it('recreates Chronos then Core Hub with the existing recreate helper, and checks Core Hub stays up', async () => {
      const prepared = await prepareEnable();

      await prepared.recreate();

      assert.deepEqual(recorder.commands, [
        [
          'upAll',
          'gluesync-chronos',
          'docker-compose.yml',
          '--no-deps',
          '--force-recreate',
        ],
        [
          'upAll',
          'gluesync-core-hub',
          'docker-compose.yml',
          '--no-deps',
          '--force-recreate',
        ],
      ]);
      assert.deepEqual(recorder.verified, ['gluesync-core-hub']);
    });

    it('is seen by the DR detection of the update guard, and by the GET state, without a secret', async () => {
      await (await prepareEnable()).recreate();
      const { state } = await inspect();

      assert.deepEqual(state, {
        supported: true,
        reason: null,
        enabled: true,
        managedByConductor: true,
        nodeId: 'site-a',
        peerUrl: 'http://10.0.0.2:1717',
        failoverMode: 'manual',
        witnessUrl: null,
        bootstrapActive: true,
      });
      assert.ok(!JSON.stringify(state).includes(VARIABLES.sharedSecret));
      assert.ok(!JSON.stringify(state).includes(VARIABLES.adminToken));
    });

    it('is applied once: a second pass over the same files adds nothing', async () => {
      await prepareEnable();
      const once = readCompose();

      await prepareEnable();

      assert.equal(readCompose(), once);
    });

    it('rolls back when a recreate fails: files put back byte for byte, both services recreated again, the error kept', async () => {
      const prepared = await prepareEnable();

      // the second command is Core Hub; the two of the roll back are numbers 3 and 4
      recorder.failRecreates = [2];

      await assert.rejects(prepared.recreate(), /compose exploded/);

      assert.equal(readCompose(), KIT);
      assert.ok(!existsSync(envPath()));
      assert.deepEqual(recreated(), [
        'gluesync-chronos',
        'gluesync-chronos',
        'gluesync-core-hub',
      ]);
      assert.ok(
        recorder.logs.some(
          l => l.startsWith('error') && /files restored/.test(l),
        ),
      );
      assert.equal((await inspect()).state.enabled, false);
    });

    it('rolls back when Core Hub does not stay up after the recreate', async () => {
      const prepared = await prepareEnable();

      recorder.failVerify = true;

      await assert.rejects(prepared.recreate(), /not staying up/);

      assert.equal(readCompose(), KIT);
      assert.ok(!existsSync(envPath()));
      assert.equal(recorder.commands.length, 4);
    });

    it('puts the previous env file back when there was one', async () => {
      writeFileSync(envPath(), 'GS_DR_LEFTOVER=1\n');
      const prepared = await prepareEnable();

      assert.ok(
        readFileSync(envPath(), 'utf8').includes('GS_DR_NODE_ID=site-a'),
      );
      assert.equal(
        readFileSync(path.join(backupDir(), DR_FILE), 'utf8'),
        'GS_DR_LEFTOVER=1\n',
      );

      recorder.failRecreates = [1];
      await assert.rejects(prepared.recreate(), /compose exploded/);

      assert.equal(readFileSync(envPath(), 'utf8'), 'GS_DR_LEFTOVER=1\n');
    });

    it('says what happened and still reports the original error when the recreate after the roll back fails too', async () => {
      const prepared = await prepareEnable();

      recorder.failRecreates = [1, 2, 3];

      await assert.rejects(prepared.recreate(), /compose exploded/);

      assert.equal(readCompose(), KIT);
      assert.ok(
        recorder.logs.some(l => /with the restored files failed too/.test(l)),
      );
    });

    it('leaves nothing behind when the compose file cannot be written, and recreates nothing', async () => {
      recorder.failComposeWrite = new DiskFullError(composePath(), 4096, 0);
      subject = load(recorder);

      await assert.rejects(prepareEnable(), DiskFullError);

      assert.equal(readCompose(), KIT);
      assert.ok(!existsSync(envPath()));
      assert.deepEqual(recorder.commands, []);
    });

    it('refuses a compose file the setup cannot be applied to, before anything is written', async () => {
      writeFileSync(
        composePath(),
        KIT.replace('./data/chronos:/app/data', '/app/data'),
      );

      await assert.rejects(prepareEnable(), /Chronos does not keep its data/);

      assert.ok(!existsSync(envPath()));
      assert.deepEqual(backups(), []);
    });
  });

  describe('disable', () => {
    it('restores the compose file and removes the env file, and the secrets with their backup', async () => {
      await (await prepareEnable()).recreate();
      recorder.commands.length = 0;

      const prepared = await prepareDisable();

      assert.deepEqual(recorder.commands, []);
      assert.equal(readCompose(), KIT);
      assert.ok(!existsSync(envPath()));
      assert.deepEqual(prepared.restarting, [
        'gluesync-core-hub',
        'gluesync-chronos',
      ]);

      await prepared.recreate();

      assert.deepEqual(recreated(), ['gluesync-chronos', 'gluesync-core-hub']);
      // no copy of the secrets of the pair stays behind
      backups().forEach(stamp =>
        assert.ok(
          !existsSync(
            path.join(dir, '.conductor', 'dr-backup', stamp, DR_FILE),
          ),
        ),
      );
      assert.equal((await inspect()).state.enabled, false);
    });

    it('is idempotent: disabling again changes nothing', async () => {
      await prepareEnable();
      await prepareDisable();
      await prepareDisable();

      assert.equal(readCompose(), KIT);
      assert.ok(!existsSync(envPath()));
    });

    it('rolls back to the enabled site when the recreate fails', async () => {
      await prepareEnable();
      const enabled = readCompose();
      const env = readFileSync(envPath(), 'utf8');
      const prepared = await prepareDisable();

      recorder.failRecreates = [1];
      await assert.rejects(prepared.recreate(), /compose exploded/);

      assert.equal(readCompose(), enabled);
      assert.equal(readFileSync(envPath(), 'utf8'), env);
    });

    it('keeps what the customer has, apart from what the setup added', async () => {
      writeFileSync(
        composePath(),
        KIT.replace(
          '  gluesync-conductor:',
          '  mine:\n    image: busybox # mine\n\n  gluesync-conductor:',
        ),
      );
      const before = readCompose();

      await prepareEnable();
      await prepareDisable();

      assert.equal(readCompose(), before);
    });
  });
});
