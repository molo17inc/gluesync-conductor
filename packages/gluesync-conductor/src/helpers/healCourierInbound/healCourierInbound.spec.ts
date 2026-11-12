/* eslint-disable functional/immutable-data, functional/no-let, no-param-reassign -- temp files and a recorder for the test */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { makeComposeSandbox } from '../../testing/composeSandbox';
import {
  COURIER_LABEL_LIST,
  COURIER_TRAEFIK,
  PRE_COURIER_TRAEFIK,
  courierKitComposeText,
} from '../../testing/courierInboundFixtures';
import loadWithStubs from '../../testing/loadWithStubs';
import realSafeWriteFile from '../file/safeWriteFile/safeWriteFile';
import type { HealCourierInbound } from './healCourierInbound.model';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = Readonly<{ default: HealCourierInbound }>;

type Recorder = {
  commands: string[][];
  writes: string[];
  logs: string[];
  mode: 'compose' | 'swarm' | undefined;
  /** The proxy recreate fails (every attempt). */
  failRecreate: boolean;
  /** The Core Hub recreate fails (every attempt). */
  failCoreHubRecreate: boolean;
  failComposeWrite: boolean;
  recreateAttempts: number;
  /** Labels of the running container of each service; none: not running. */
  containers: Record<string, Record<string, string> | 'error'>;
};

const COREHUB = [
  'traefik.enable=true',
  'traefik.http.routers.corehub.rule=PathPrefix(`/`)',
  'com.molo17.conductor.type=core-hub',
];

const recordingLogger = (recorder: Recorder) => ({
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
});

const orchestrator = (recorder: Recorder) => ({
  getDecidedOrchestrator: async () =>
    recorder.mode ? { mode: recorder.mode } : undefined,
});

// The shared file writes and recreate of the proxy heals, with Docker Compose
// replaced: they live in healProxyErrorPages, loaded here with its own stubs.
const proxyHeals = (recorder: Recorder): unknown =>
  loadWithStubs(here('../healProxyErrorPages/healProxyErrorPages'), {
    'docker-compose': { upAll: 'upAll' },
    [here('../dockerode/createActions/createActions')]: {
      runCmd: async (
        command: string,
        id: string,
        file: string,
        extra: ReadonlyArray<string>,
      ) => {
        recorder.recreateAttempts += 1;
        if (
          (recorder.failRecreate && id === 'reverse-proxy') ||
          (recorder.failCoreHubRecreate && id === 'gluesync-core-hub')
        ) {
          throw new Error('compose exploded');
        }
        recorder.commands.push([command, id, file, ...extra]);
        return '';
      },
    },
    [here('../orchestrator/getOrchestrator/getOrchestrator')]:
      orchestrator(recorder),
    [here('../../utils/docker/getDocker')]: {
      getDocker: () => ({
        listContainers: async ({
          filters,
        }: Readonly<{ filters: { label: string[] } }>) => {
          const service = filters.label[0].split('=')[1];
          const labels = recorder.containers[service];
          if (labels === 'error') {
            throw new Error('docker is gone');
          }
          return labels ? [{ Labels: labels }] : [];
        },
      }),
    },
    ...(recorder.failComposeWrite
      ? {
          [here('../composeFile/writeComposeFile/writeComposeFile')]: {
            default: async () => {
              throw new Error('disk said no');
            },
          },
        }
      : {}),
    [here('../file/safeWriteFile/safeWriteFile')]: {
      default: async (
        file: string,
        content: string | Buffer,
        options: object,
      ) => {
        recorder.writes.push(file);
        await realSafeWriteFile(file, content, options);
      },
    },
    [here('../../utils/logger')]: recordingLogger(recorder),
  });

const load = (recorder: Recorder): Subject =>
  loadWithStubs<Subject>(here('./healCourierInbound'), {
    [here('../healProxyErrorPages/healProxyErrorPages')]: proxyHeals(recorder),
    [here('../orchestrator/getOrchestrator/getOrchestrator')]:
      orchestrator(recorder),
    [here('../../utils/docker/getDocker')]: { getDocker: () => ({}) },
    [here('../../utils/logger')]: recordingLogger(recorder),
  });

describe('healCourierInbound', () => {
  // One sandbox: the compose helpers read DKR_COMPOSE_FILE when they load
  const sandbox = makeComposeSandbox();
  let recorder: Recorder;
  let subject: Subject;
  let traefik: string;

  const composeText = (
    coreHubLabels: ReadonlyArray<string> = COREHUB,
    proxyPorts: ReadonlyArray<string> = ['80:80', '443:443'],
  ) =>
    courierKitComposeText(coreHubLabels, proxyPorts).replaceAll(
      '/PROXY_DIR',
      path.dirname(traefik),
    );

  const setUp = (
    traefikText = PRE_COURIER_TRAEFIK,
    coreHubLabels: ReadonlyArray<string> = COREHUB,
    proxyPorts: ReadonlyArray<string> = ['80:80', '443:443'],
  ) => {
    writeFileSync(traefik, traefikText);
    sandbox.setCompose(composeText(coreHubLabels, proxyPorts));
  };

  const backups = (): string[] => {
    const dir = path.join(sandbox.dir, '.conductor', 'proxy-backup');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  beforeEach(() => {
    rmSync(path.join(sandbox.dir, '.conductor'), {
      recursive: true,
      force: true,
    });
    const proxyDir = path.join(sandbox.dir, 'proxy');
    mkdirSync(proxyDir, { recursive: true });
    traefik = path.join(proxyDir, 'traefik.yml');
    recorder = {
      commands: [],
      writes: [],
      logs: [],
      mode: 'compose',
      failRecreate: false,
      failCoreHubRecreate: false,
      failComposeWrite: false,
      recreateAttempts: 0,
      containers: {},
    };
    subject = load(recorder);
  });

  after(() => sandbox.restore());

  it('wires a kit made before Courier: backup first, every piece added, the proxy recreated once', async () => {
    setUp();
    const composeBefore = sandbox.read(sandbox.compose);
    const inode = statSync(traefik).ino;

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'add');
    assert.deepEqual(outcome.missing, [
      'entry point',
      'proxy port',
      'Core Hub labels',
    ]);
    assert.equal(outcome.recreated, 'reverse-proxy');

    // backup of both files, as they were
    const [stamp] = backups();
    const dir = path.join(sandbox.dir, '.conductor', 'proxy-backup', stamp);
    assert.equal(outcome.backupDir, dir);
    assert.equal(
      readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'),
      composeBefore,
    );
    assert.equal(
      readFileSync(path.join(dir, 'traefik.yml'), 'utf8'),
      PRE_COURIER_TRAEFIK,
    );

    // traefik.yml: in place, exactly the kit's
    assert.equal(statSync(traefik).ino, inode);
    assert.equal(sandbox.read(traefik), COURIER_TRAEFIK);

    // compose: port and labels appended, comments and the rest kept
    const composeAfter = sandbox.read(sandbox.compose);
    assert.match(composeAfter, /^# kit header: keep me$/m);
    assert.match(composeAfter, /# core hub router/);
    assert.match(composeAfter, /# the published ports/);
    assert.match(composeAfter, /- 443:443\n\s+- 8090:8090\n/);
    assert.match(composeAfter, /- 8765:8765/);
    COURIER_LABEL_LIST.forEach(label =>
      assert.ok(composeAfter.includes(label), label),
    );

    assert.deepEqual(recorder.writes, [traefik]);
    assert.deepEqual(recorder.commands, [
      [
        'upAll',
        'reverse-proxy',
        sandbox.compose,
        '--no-deps',
        '--force-recreate',
      ],
    ]);
    // no running Core Hub container here: nothing to recreate
    assert.equal(outcome.coreHub, undefined);
  });

  it('does nothing the second time: no backup, no write, no recreate', async () => {
    setUp();
    await subject.default({ reason: 'startup' });
    const compose = sandbox.read(sandbox.compose);

    const again = await subject.default({ reason: 'update' });

    assert.deepEqual(again, {
      action: 'none',
      reason: 'wiring already in place',
    });
    assert.equal(backups().length, 1);
    assert.equal(recorder.commands.length, 1);
    assert.equal(recorder.writes.length, 1);
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.equal(sandbox.read(traefik), COURIER_TRAEFIK);
  });

  it('leaves a kit that ships the wiring untouched', async () => {
    setUp(
      COURIER_TRAEFIK,
      [...COREHUB, ...COURIER_LABEL_LIST],
      ['80:80', '443:443', '8090:8090'],
    );
    const compose = sandbox.read(sandbox.compose);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'none');
    assert.deepEqual(backups(), []);
    assert.deepEqual(recorder.writes, []);
    assert.deepEqual(recorder.commands, []);
    assert.equal(sandbox.read(sandbox.compose), compose);
  });

  it('writes only the labels of Core Hub when that is all that is missing, and recreates nothing', async () => {
    setUp(COURIER_TRAEFIK, COREHUB, ['80:80', '443:443', '8090:8090']);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'add');
    assert.deepEqual(outcome.missing, ['Core Hub labels']);
    assert.equal(outcome.recreated, undefined);
    assert.deepEqual(recorder.commands, []);
    // traefik.yml is not written, the compose file is
    assert.deepEqual(recorder.writes, []);
    assert.equal(sandbox.read(traefik), COURIER_TRAEFIK);
    assert.ok(
      sandbox
        .read(sandbox.compose)
        .includes('traefik.http.routers.courier.entrypoints=courier'),
    );
    assert.equal(backups().length, 1);
  });

  it('adds only the port when that is all that is missing', async () => {
    setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST]);

    const outcome = await subject.default({ reason: 'update' });

    assert.deepEqual(outcome.missing, ['proxy port']);
    assert.equal(outcome.recreated, 'reverse-proxy');
    assert.equal(sandbox.read(traefik), COURIER_TRAEFIK);
    assert.deepEqual(recorder.writes, []);
    assert.equal(recorder.commands.length, 1);
  });

  it('honours the opt-out label', async () => {
    setUp(PRE_COURIER_TRAEFIK, [
      ...COREHUB,
      'com.molo17.conductor.courier-inbound=false',
    ]);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'none');
    assert.deepEqual(recorder.commands, []);
    assert.equal(sandbox.read(traefik), PRE_COURIER_TRAEFIK);
  });

  it('leaves the install alone, with the reason logged, when the plan skips', async () => {
    setUp(PRE_COURIER_TRAEFIK, COREHUB, ['80:80', '8090:8443']);
    const compose = sandbox.read(sandbox.compose);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'skip');
    assert.equal(
      outcome.reason,
      'reverse-proxy already publishes host port 8090 to its port 8443',
    );
    assert.ok(
      recorder.logs.some(l =>
        l.startsWith(
          'warn [courier-inbound] left as it is: reverse-proxy already publishes',
        ),
      ),
    );
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.equal(sandbox.read(traefik), PRE_COURIER_TRAEFIK);
    assert.deepEqual(backups(), []);
  });

  it('leaves a traefik.yml it cannot splice alone, and the compose file with it', async () => {
    const flow = 'entryPoints: {websecure: {address: ":443"}}\n';
    setUp(flow);
    const compose = sandbox.read(sandbox.compose);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'skip');
    assert.match(outcome.reason, /^traefik\.yml layout: /);
    assert.equal(sandbox.read(traefik), flow);
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.deepEqual(backups(), []);
  });

  it('skips in swarm mode, when Docker is not known yet, without a proxy and without traefik.yml', async () => {
    setUp();
    recorder.mode = 'swarm';
    assert.equal(
      (await subject.default({ reason: 'startup' })).reason,
      'not compose mode',
    );
    recorder.mode = undefined;
    assert.equal(
      (await subject.default({ reason: 'startup' })).reason,
      'Docker mode not known yet',
    );
    recorder.mode = 'compose';

    sandbox.setCompose(
      composeText().replaceAll(path.dirname(traefik), '/nowhere'),
    );
    assert.equal(
      (await subject.default({ reason: 'startup' })).reason,
      'traefik.yml not found',
    );

    sandbox.setCompose(
      'services:\n  gluesync-core-hub:\n    image: molo17/gluesync-core-hub:2.3.0.0\n',
    );
    assert.equal(
      (await subject.default({ reason: 'startup' })).reason,
      'no reverse-proxy service',
    );
    assert.deepEqual(recorder.commands, []);
    assert.deepEqual(backups(), []);
  });

  it('uses CORE_HUB_NAME for the Core Hub service', async () => {
    const saved = process.env.CORE_HUB_NAME;
    process.env.CORE_HUB_NAME = 'my-core-hub';
    setUp();

    try {
      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.action, 'skip');
      assert.equal(outcome.reason, 'no Core Hub service (my-core-hub)');
    } finally {
      if (saved === undefined) {
        delete process.env.CORE_HUB_NAME;
      } else {
        process.env.CORE_HUB_NAME = saved;
      }
    }
  });

  it('never throws: a failed recreate puts both files back byte for byte', async () => {
    setUp();
    const composeBefore = readFileSync(sandbox.compose);
    recorder.failRecreate = true;

    const outcome = await subject.default({ reason: 'startup' });

    assert.deepEqual(outcome, {
      action: 'skip',
      reason: 'recreate failed, files restored',
    });
    assert.equal(readFileSync(traefik, 'utf8'), PRE_COURIER_TRAEFIK);
    assert.ok(readFileSync(sandbox.compose).equals(composeBefore));
    // the failed one after the writes, then one against the restored files
    assert.equal(recorder.recreateAttempts, 2);
    assert.ok(
      recorder.logs.some(l =>
        l.includes('[courier-inbound] recreate failed, files restored from'),
      ),
    );
  });

  it('never throws: a compose write that fails puts traefik.yml back', async () => {
    setUp();
    recorder.failComposeWrite = true;
    subject = load(recorder);

    const outcome = await subject.default({ reason: 'startup' });

    assert.deepEqual(outcome, { action: 'skip', reason: 'failed' });
    assert.equal(sandbox.read(traefik), PRE_COURIER_TRAEFIK);
    assert.deepEqual(recorder.commands, []);
    assert.ok(
      recorder.logs.some(l =>
        l.startsWith('error [courier-inbound] failed, nothing more is changed'),
      ),
    );
  });

  describe('the running Core Hub', () => {
    const CORE_HUB = 'gluesync-core-hub';
    const OLD_CONTAINER = { 'traefik.enable': 'true' };
    const WIRED_CONTAINER = Object.fromEntries(
      COURIER_LABEL_LIST.map(l => [
        l.slice(0, l.indexOf('=')),
        l.slice(l.indexOf('=') + 1),
      ]),
    );
    const WIRED_PORTS = ['80:80', '443:443', '8090:8090'];
    const recreateOf = (service: string) => [
      'upAll',
      service,
      sandbox.compose,
      '--no-deps',
      '--force-recreate',
    ];

    it('is recreated once, after the proxy, when the heal adds its labels', async () => {
      setUp();
      recorder.containers[CORE_HUB] = OLD_CONTAINER;

      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.action, 'add');
      assert.equal(outcome.recreated, 'reverse-proxy');
      assert.equal(outcome.coreHub, 'recreated');
      assert.deepEqual(recorder.commands, [
        recreateOf('reverse-proxy'),
        recreateOf(CORE_HUB),
      ]);
      const before = recorder.logs.findIndex(l =>
        l.endsWith(
          '[courier-inbound] recreating gluesync-core-hub to apply the courier route labels',
        ),
      );
      const done = recorder.logs.findIndex(l =>
        l.endsWith(
          '[courier-inbound] gluesync-core-hub recreated, the courier route labels are applied',
        ),
      );
      assert.ok(before >= 0 && done > before);

      // the recreated container has the labels: nothing more, ever
      recorder.containers[CORE_HUB] = WIRED_CONTAINER;
      const again = await subject.default({ reason: 'update' });
      assert.deepEqual(again, {
        action: 'none',
        reason: 'wiring already in place',
      });
      assert.equal(recorder.commands.length, 2);
    });

    it('is not touched on a wired install whose container has the labels', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST], WIRED_PORTS);
      recorder.containers[CORE_HUB] = {
        ...WIRED_CONTAINER,
        'com.docker.compose.service': CORE_HUB,
      };

      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.action, 'none');
      assert.equal(outcome.coreHub, undefined);
      assert.deepEqual(recorder.commands, []);
    });

    it('is not touched when only the proxy side changes and the container has the labels', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST]);
      recorder.containers[CORE_HUB] = WIRED_CONTAINER;

      const outcome = await subject.default({ reason: 'update' });

      assert.deepEqual(outcome.missing, ['proxy port']);
      assert.equal(outcome.coreHub, undefined);
      assert.deepEqual(recorder.commands, [recreateOf('reverse-proxy')]);
    });

    it('is recreated, nothing written, when the file has the labels and the running container does not', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST], WIRED_PORTS);
      recorder.containers[CORE_HUB] = OLD_CONTAINER;
      const compose = sandbox.read(sandbox.compose);

      const outcome = await subject.default({ reason: 'startup' });

      assert.deepEqual(outcome, {
        action: 'none',
        reason: 'wiring already in place',
        coreHub: 'recreated',
      });
      assert.deepEqual(recorder.commands, [recreateOf(CORE_HUB)]);
      assert.deepEqual(recorder.writes, []);
      assert.deepEqual(backups(), []);
      assert.equal(sandbox.read(sandbox.compose), compose);
    });

    it('is not recreated again within the cooldown when the container still lacks the labels', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST], WIRED_PORTS);
      recorder.containers[CORE_HUB] = OLD_CONTAINER;

      assert.equal(
        (await subject.default({ reason: 'startup' })).coreHub,
        'recreated',
      );
      assert.equal(
        (await subject.default({ reason: 'update' })).coreHub,
        'cooldown',
      );
      assert.equal(
        (await subject.default({ reason: 'update' })).coreHub,
        'cooldown',
      );
      assert.equal(recorder.commands.length, 1);
      assert.ok(
        recorder.logs.some(l =>
          l.endsWith(
            '[courier-inbound] running gluesync-core-hub still lacks the courier route labels after a recreate, not trying again yet',
          ),
        ),
      );
    });

    it('is never recreated when opted out', async () => {
      setUp(
        COURIER_TRAEFIK,
        [
          ...COREHUB,
          ...COURIER_LABEL_LIST,
          'com.molo17.conductor.courier-inbound=false',
        ],
        WIRED_PORTS,
      );
      recorder.containers[CORE_HUB] = OLD_CONTAINER;

      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.action, 'none');
      assert.equal(outcome.coreHub, undefined);
      assert.deepEqual(recorder.commands, []);
    });

    it('is left alone when it is not running or cannot be inspected', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST], WIRED_PORTS);

      assert.equal(
        (await subject.default({ reason: 'startup' })).coreHub,
        undefined,
      );
      recorder.containers[CORE_HUB] = 'error';
      assert.equal(
        (await subject.default({ reason: 'startup' })).coreHub,
        undefined,
      );
      assert.deepEqual(recorder.commands, []);
    });

    it('is not recreated when the proxy recreate failed and the files were restored', async () => {
      setUp();
      recorder.containers[CORE_HUB] = OLD_CONTAINER;
      recorder.failRecreate = true;

      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.reason, 'recreate failed, files restored');
      assert.equal(outcome.coreHub, undefined);
      // the two proxy attempts only
      assert.equal(recorder.recreateAttempts, 2);
      assert.ok(
        !recorder.logs.some(l => l.includes('recreating gluesync-core-hub')),
      );
    });

    it('is not recreated when the compose file cannot be written', async () => {
      setUp();
      recorder.containers[CORE_HUB] = OLD_CONTAINER;
      recorder.failComposeWrite = true;
      subject = load(recorder);

      const outcome = await subject.default({ reason: 'startup' });

      assert.deepEqual(outcome, { action: 'skip', reason: 'failed' });
      assert.equal(recorder.recreateAttempts, 0);
    });

    it('reports a failed recreate, tries once more, and keeps the files', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST], WIRED_PORTS);
      recorder.containers[CORE_HUB] = OLD_CONTAINER;
      recorder.failCoreHubRecreate = true;
      const compose = sandbox.read(sandbox.compose);

      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.coreHub, 'failed');
      assert.equal(recorder.recreateAttempts, 2);
      assert.equal(sandbox.read(sandbox.compose), compose);
      assert.ok(
        recorder.logs.some(l =>
          l.endsWith(
            '[courier-inbound] recreating gluesync-core-hub failed again; start it with docker compose up -d gluesync-core-hub',
          ),
        ),
      );

      // the cooldown holds for a failed one too
      assert.equal(
        (await subject.default({ reason: 'update' })).coreHub,
        'cooldown',
      );
      assert.equal(recorder.recreateAttempts, 2);
    });

    it('recovers when only the first recreate attempt fails', async () => {
      setUp(COURIER_TRAEFIK, [...COREHUB, ...COURIER_LABEL_LIST], WIRED_PORTS);
      recorder.containers[CORE_HUB] = OLD_CONTAINER;
      recorder.failCoreHubRecreate = true;
      const original = recorder.logs.push.bind(recorder.logs);
      recorder.logs.push = (...lines: string[]) => {
        // the first failure is logged: let the retry succeed
        if (
          lines.some(l => l.endsWith('recreating gluesync-core-hub failed'))
        ) {
          recorder.failCoreHubRecreate = false;
        }
        return original(...lines);
      };

      const outcome = await subject.default({ reason: 'startup' });

      assert.equal(outcome.coreHub, 'recreated');
      assert.deepEqual(recorder.commands, [recreateOf(CORE_HUB)]);
      assert.ok(!recorder.logs.some(l => l.includes('failed again')));
    });
  });

  it('runs one at a time: two triggers at once recreate the proxy once', async () => {
    setUp();

    const [a, b] = await Promise.all([
      subject.default({ reason: 'startup' }),
      subject.default({ reason: 'update' }),
    ]);

    assert.deepEqual([a.action, b.action].sort(), ['add', 'none']);
    assert.equal(recorder.commands.length, 1);
  });
});
