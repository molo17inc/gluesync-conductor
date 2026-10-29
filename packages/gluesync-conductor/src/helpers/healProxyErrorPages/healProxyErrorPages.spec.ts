/* eslint-disable functional/immutable-data, functional/no-let -- temp files and a recorder for the test */
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
import * as realFsPromises from 'node:fs/promises';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import makeComposeSandbox from '../../testing/composeSandbox';
import loadWithStubs from '../../testing/loadWithStubs';
import {
  CERTS_YML,
  KIT_TRAEFIK,
  LEGACY_PROXY_LABELS,
  LEGACY_TRAEFIK,
  kitComposeText,
} from '../../testing/proxyErrorPagesFixtures';
import type { HealProxyErrorPages } from './healProxyErrorPages.model';

const here = (p: string): string => path.resolve(__dirname, p);

const CAPABLE = 'molo17/traefik:3.7.16.3';
const OLD = 'molo17/traefik:3.6.2';
const TYPE = 'com.molo17.conductor.type=third-party';

type Subject = Readonly<{
  default: HealProxyErrorPages;
}>;

type Recorder = {
  commands: string[][];
  writes: string[];
  logs: string[];
  failRecreate: boolean;
  failComposeWrite: boolean;
};

const load = (recorder: Recorder): Subject =>
  loadWithStubs<Subject>(here('./healProxyErrorPages'), {
    'docker-compose': { upAll: 'upAll' },
    [here('../dockerode/createActions/createActions')]: {
      runCmd: async (
        command: string,
        id: string,
        file: string,
        extra: ReadonlyArray<string>,
      ) => {
        if (recorder.failRecreate) {
          throw new Error('compose exploded');
        }
        recorder.commands.push([command, id, file, ...extra]);
        return '';
      },
    },
    // only the failure test replaces the compose write: the real one reads DKR_COMPOSE_FILE when it loads
    ...(recorder.failComposeWrite
      ? {
          [here('../composeFile/writeComposeFile/writeComposeFile')]: {
            default: async () => {
              throw new Error('disk said no');
            },
          },
        }
      : {}),
    // records the writes made by the subject itself (traefik.yml); the compose
    // file goes through its own writer
    'node:fs/promises': {
      ...realFsPromises,
      writeFile: async (
        file: string,
        data: string,
        encoding: BufferEncoding,
      ) => {
        recorder.writes.push(file);
        await realFsPromises.writeFile(file, data, encoding);
      },
    },
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

describe('healProxyErrorPages', () => {
  // One sandbox: the compose helpers read DKR_COMPOSE_FILE when they load
  const sandbox = makeComposeSandbox();
  const saved = process.env.IS_WINDOWS;
  let recorder: Recorder;
  let subject: Subject;
  let traefik: string;
  let certs: string;

  const composeText = (image: string, labels: ReadonlyArray<string> = []) =>
    kitComposeText(image, labels).replaceAll(
      '/PROXY_DIR',
      path.dirname(traefik),
    );

  const setUp = (
    image: string,
    traefikText = KIT_TRAEFIK,
    labels: ReadonlyArray<string> = [],
  ) => {
    writeFileSync(traefik, traefikText);
    sandbox.setCompose(composeText(image, labels));
  };

  beforeEach(() => {
    rmSync(path.join(sandbox.dir, '.conductor'), {
      recursive: true,
      force: true,
    });
    const proxyDir = path.join(sandbox.dir, 'proxy');
    mkdirSync(proxyDir, { recursive: true });
    traefik = path.join(proxyDir, 'traefik.yml');
    certs = path.join(proxyDir, 'certs.yml');
    writeFileSync(certs, CERTS_YML);
    recorder = {
      commands: [],
      writes: [],
      logs: [],
      failRecreate: false,
      failComposeWrite: false,
    };
    delete process.env.IS_WINDOWS;
    subject = load(recorder);
  });

  after(() => sandbox.restore());

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.IS_WINDOWS;
    } else {
      process.env.IS_WINDOWS = saved;
    }
  });

  const backups = (): string[] => {
    const dir = path.join(sandbox.dir, '.conductor', 'proxy-backup');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it('adds the wiring to a kit whose image can serve it, backs up first and recreates the proxy once', async () => {
    setUp(CAPABLE);
    const composeBefore = sandbox.read(sandbox.compose);
    const inode = statSync(traefik).ino;
    const certsStat = statSync(certs);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'add');
    assert.equal(outcome.recreated, 'reverse-proxy');

    // backup of both files, as they were
    const [stamp] = backups();
    assert.match(stamp, /^\d{8}T\d{6}Z$/);
    const dir = path.join(sandbox.dir, '.conductor', 'proxy-backup', stamp);
    assert.equal(
      readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8'),
      composeBefore,
    );
    assert.equal(
      readFileSync(path.join(dir, 'traefik.yml'), 'utf8'),
      KIT_TRAEFIK,
    );
    assert.deepEqual(readdirSync(dir).sort(), [
      'docker-compose.yml',
      'traefik.yml',
    ]);

    // traefik.yml: written in place (same inode), only ours added
    assert.equal(statSync(traefik).ino, inode);
    assert.match(sandbox.read(traefik), /- gluesync-pages@docker/);
    assert.match(
      sandbox.read(traefik),
      /moduleName: github\.com\/molo17\/gluesyncerrorpages/,
    );
    assert.match(sandbox.read(traefik), /^# api:$/m);

    // compose: the labels are appended, comments and the rest stay
    const composeAfter = sandbox.read(sandbox.compose);
    assert.match(composeAfter, /^# kit header: keep me$/m);
    assert.match(composeAfter, /# core hub router/);
    assert.match(composeAfter, /# the proxy is third-party/);
    assert.match(
      composeAfter,
      /- traefik\.http\.middlewares\.gluesync-pages\.plugin\.gluesyncerrorpages\.mode=wrap/,
    );
    assert.match(
      composeAfter,
      /- traefik\.http\.routers\.gluesync-unavailable\.middlewares=gluesync-unavailable@docker/,
    );
    assert.match(composeAfter, /image: molo17\/traefik:3\.7\.16\.3/);

    // certs.yml: never written, never touched
    assert.ok(!recorder.writes.includes(certs));
    assert.equal(readFileSync(certs, 'utf8'), CERTS_YML);
    assert.equal(statSync(certs).mtimeMs, certsStat.mtimeMs);
    assert.equal(statSync(certs).ino, certsStat.ino);

    // only traefik.yml was written by the heal itself here (compose has its own writer)
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
  });

  it('does nothing the second time: no backup, no write, no recreate', async () => {
    setUp(CAPABLE);
    await subject.default({ reason: 'startup' });
    const compose = sandbox.read(sandbox.compose);
    const conf = sandbox.read(traefik);

    const again = await subject.default({ reason: 'event' });

    assert.equal(again.action, 'none');
    assert.equal(again.recreated, undefined);
    assert.equal(backups().length, 1);
    assert.equal(recorder.commands.length, 1);
    assert.equal(recorder.writes.length, 1);
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.equal(sandbox.read(traefik), conf);
  });

  it('cannot oscillate: after its own recreate (either direction) every further run plans none and recreates nothing', async () => {
    setUp(CAPABLE);

    assert.equal((await subject.default({ reason: 'startup' })).action, 'add');
    // the start event of the proxy the heal just recreated comes back to the heal, again and again
    assert.equal((await subject.default({ reason: 'event' })).action, 'none');
    assert.equal((await subject.default({ reason: 'event' })).action, 'none');
    assert.equal((await subject.default({ reason: 'update' })).action, 'none');
    assert.equal(recorder.commands.length, 1);

    // the downgrade half: the wiring goes, and the heal then leaves the old tag alone
    sandbox.setCompose(sandbox.read(sandbox.compose).replace(CAPABLE, OLD));
    assert.equal((await subject.default({ reason: 'event' })).action, 'remove');
    assert.equal((await subject.default({ reason: 'event' })).action, 'none');
    assert.equal((await subject.default({ reason: 'event' })).action, 'none');
    assert.equal((await subject.default({ reason: 'update' })).action, 'none');
    assert.equal(recorder.commands.length, 2);
  });

  it('removes it again when the image goes back to one that cannot serve it, restoring both files byte for byte', async () => {
    setUp(CAPABLE);
    const originalCompose = composeText(OLD);
    await subject.default({ reason: 'startup' });

    // the customer (or a downgrade) puts the old image back
    sandbox.setCompose(sandbox.read(sandbox.compose).replace(CAPABLE, OLD));
    const outcome = await subject.default({ reason: 'event' });

    assert.equal(outcome.action, 'remove');
    assert.equal(sandbox.read(traefik), KIT_TRAEFIK);
    assert.equal(sandbox.read(sandbox.compose), originalCompose);
    assert.equal(recorder.commands.length, 2);
    assert.equal(readFileSync(certs, 'utf8'), CERTS_YML);
  });

  it('leaves the customer settings, ACME resolver and log level alone', async () => {
    const customer = `# mine\nentryPoints:\n  web:\n    address: ":80"\n  websecure:\n    address: ":443"\n    http:\n      tls:\n        certResolver: le\n      middlewares:\n        - sec@file\ncertificatesResolvers:\n  le:\n    acme:\n      email: a@b.c\nlog:\n  level: DEBUG # keep\n`;
    setUp(CAPABLE, customer);

    await subject.default({ reason: 'startup' });
    const added = sandbox.read(traefik);

    assert.match(added, /^# mine$/m);
    assert.match(added, /certResolver: le/);
    assert.match(added, /email: a@b\.c/);
    assert.match(added, /level: DEBUG # keep/);
    assert.match(added, /- sec@file\n {8}- gluesync-pages@docker/);

    sandbox.setCompose(sandbox.read(sandbox.compose).replace(CAPABLE, OLD));
    await subject.default({ reason: 'event' });
    assert.equal(sandbox.read(traefik), customer);
  });

  it('keeps a v0.0.286 kit as it is on an image that serves it: nothing written, nothing recreated', async () => {
    setUp(CAPABLE, LEGACY_TRAEFIK, LEGACY_PROXY_LABELS);
    sandbox.setCompose(
      sandbox
        .read(sandbox.compose)
        .replace(
          '      - com.molo17.conductor.type=core-hub\n',
          '      - com.molo17.conductor.type=core-hub\n      - traefik.http.routers.corehub.priority=2\n      - traefik.http.routers.corehub-html.rule=(PathPrefix(`/`)) && HeaderRegexp(`Accept`, `text/html`)\n      - traefik.http.routers.corehub-html.priority=3\n      - traefik.http.routers.corehub-html.entrypoints=websecure\n      - traefik.http.routers.corehub-html.tls=true\n      - traefik.http.routers.corehub-html.service=corehub\n      - traefik.http.routers.corehub-html.middlewares=gluesync-errors@docker\n',
        ),
    );
    const compose = sandbox.read(sandbox.compose);

    const outcome = await subject.default({ reason: 'update' });

    assert.equal(outcome.action, 'none');
    assert.equal(
      outcome.reason,
      'v0.0.286 wiring kept: the image still serves it',
    );
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.equal(sandbox.read(traefik), LEGACY_TRAEFIK);
    assert.deepEqual(recorder.commands, []);
    assert.deepEqual(recorder.writes, []);
    assert.deepEqual(backups(), []);
  });

  it('ignores the opt-out label on a v0.0.286 kit whose image serves it, and warns', async () => {
    setUp(CAPABLE, LEGACY_TRAEFIK, [
      ...LEGACY_PROXY_LABELS,
      'com.molo17.conductor.error-pages=false',
    ]);
    const compose = sandbox.read(sandbox.compose);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'skip');
    assert.match(outcome.reason, /^opt-out ignored for v0\.0\.286 wiring/);
    assert.ok(recorder.logs.some(l => l.startsWith('warn ')));
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.equal(sandbox.read(traefik), LEGACY_TRAEFIK);
    assert.deepEqual(recorder.commands, []);
    assert.deepEqual(recorder.writes, []);
  });

  it('leaves everything as it is when a label of ours was customised', async () => {
    setUp(CAPABLE, KIT_TRAEFIK, [
      'traefik.http.middlewares.gluesync-pages.plugin.gluesyncerrorpages.root=/srv/pages',
    ]);
    const compose = sandbox.read(sandbox.compose);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'skip');
    assert.equal(sandbox.read(sandbox.compose), compose);
    assert.equal(sandbox.read(traefik), KIT_TRAEFIK);
    assert.deepEqual(backups(), []);
    assert.deepEqual(recorder.commands, []);
    assert.ok(recorder.logs.some(l => l.includes('left as it is')));
  });

  it('honours the opt-out label', async () => {
    setUp(CAPABLE, KIT_TRAEFIK, ['com.molo17.conductor.error-pages=false']);

    assert.equal((await subject.default({ reason: 'startup' })).action, 'none');
    assert.deepEqual(recorder.commands, []);
    assert.equal(sandbox.read(traefik), KIT_TRAEFIK);
  });

  it('skips without traefik.yml', async () => {
    setUp(CAPABLE);
    writeFileSync(traefik, KIT_TRAEFIK);
    sandbox.setCompose(
      composeText(CAPABLE).replaceAll(path.dirname(traefik), '/nowhere'),
    );
    assert.equal((await subject.default({ reason: 'startup' })).action, 'skip');
    assert.deepEqual(recorder.commands, []);
    assert.deepEqual(backups(), []);
  });

  it('skips a traefik.yml without websecure and an interpolated tag', async () => {
    setUp(CAPABLE, 'entryPoints:\n  web:\n    address: ":80"\n');
    assert.equal((await subject.default({ reason: 'startup' })).action, 'skip');
    setUp(`molo17/traefik:\${TRAEFIK_TAG}`);
    assert.equal((await subject.default({ reason: 'startup' })).action, 'skip');
    assert.deepEqual(recorder.commands, []);
  });

  it('never throws: a failed recreate is logged and the files stay as they were written', async () => {
    setUp(CAPABLE);
    recorder.failRecreate = true;

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'skip');
    assert.ok(recorder.logs.some(l => l.startsWith('error')));
  });

  it('puts the traefik.yml back when the compose file cannot be written', async () => {
    setUp(CAPABLE);
    // a stubbed write failure: file modes do not stop root, which runs CI
    recorder.failComposeWrite = true;
    subject = load(recorder);

    const outcome = await subject.default({ reason: 'startup' });

    assert.equal(outcome.action, 'skip');
    assert.equal(sandbox.read(traefik), KIT_TRAEFIK);
    assert.deepEqual(recorder.commands, []);
  });

  it('runs one at a time: two triggers at once recreate the proxy once', async () => {
    setUp(CAPABLE);

    const [a, b] = await Promise.all([
      subject.default({ reason: 'startup' }),
      subject.default({ reason: 'event' }),
    ]);

    assert.deepEqual([a.action, b.action].sort(), ['add', 'none']);
    assert.equal(recorder.commands.length, 1);
  });

  it('uses the Windows pages folder on Windows', async () => {
    process.env.IS_WINDOWS = 'true';
    setUp('molo17/traefik:3.7.16.3-win-nanoserver-ltsc2022');

    await subject.default({ reason: 'startup' });

    assert.ok(
      sandbox
        .read(sandbox.compose)
        .includes(String.raw`gluesyncerrorpages.root=C:\gluesync\error-pages`),
    );
  });

  it('keeps the TYPE label of the proxy', () => {
    assert.equal(TYPE, 'com.molo17.conductor.type=third-party');
  });
});
