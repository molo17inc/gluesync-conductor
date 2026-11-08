/* eslint-disable functional/immutable-data, functional/no-let, functional/prefer-immutable-types -- fake Fastify objects and recorders for the test */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import createActionGate from '../../helpers/actionGate/actionGate';
import { decodePairingCode } from '../../helpers/disasterRecoveryPairing/disasterRecoveryPairing';
import {
  witnessJoinRefusal,
  witnessWarnings,
} from '../../helpers/disasterRecoveryWitness/disasterRecoveryWitness';
import type {
  WitnessCredentials,
  WitnessProbe,
} from '../../helpers/disasterRecoveryWitness/disasterRecoveryWitness.model';
import { DiskFullError } from '../../helpers/file/safeWriteFile/safeWriteFile.errors';
import deferred from '../../utils/deferred';
import loadWithStubs from '../../testing/loadWithStubs';
import type {
  DisasterRecoveryChange,
  DisasterRecoveryInspection,
  DisasterRecoveryState,
} from '../../helpers/disasterRecoverySetup/disasterRecoverySetup.model';
import type { DisasterRecoveryHandler } from './disasterRecovery.model';

const here = (p: string): string => path.resolve(__dirname, p);
const helper = (p: string): string =>
  path.resolve(__dirname, '../../helpers', p);

const TARGETS = {
  coreHub: 'gluesync-core-hub',
  chronos: 'gluesync-chronos',
  windows: false,
  controlScheme: 'https',
} as const;

const DISABLED: DisasterRecoveryState = {
  supported: true,
  reason: null,
  enabled: false,
  managedByConductor: false,
  nodeId: null,
  peerUrl: null,
  failoverMode: null,
  witnessUrl: null,
  bootstrapActive: false,
};

const MANAGED: DisasterRecoveryState = {
  ...DISABLED,
  enabled: true,
  managedByConductor: true,
  nodeId: 'site-a',
  peerUrl: 'http://10.0.0.2:1717',
  failoverMode: 'manual',
};

const FIRST_BODY = {
  thisSite: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
  peerSite: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
  failoverMode: 'witness',
  witnessUrl: 'https://witness.example.com:8443',
  leaseTtlSeconds: 40,
};

type Options = {
  state?: DisasterRecoveryState;
  mode?: 'compose' | 'swarm';
  dockerUnknown?: boolean;
  prepareError?: unknown;
  recreateError?: unknown;
  /** Holds the recreate until released */
  recreateGate?: Promise<void>;
  inspectError?: unknown;
  /** What the witness answers to the probe, default a witness that answers */
  witness?: WitnessProbe;
};

type Recorder = {
  events: string[];
  changes: DisasterRecoveryChange[];
  logs: string[];
  probes: { url: string; credentials?: WitnessCredentials }[];
};

type Reply = {
  statusCode?: number;
  headers: Record<string, string>;
  sent: unknown[];
  raw: EventEmitter & { writableFinished: boolean };
  code: (n: number) => Reply;
  header: (k: string, v: string) => Reply;
  send: (body: unknown) => Reply;
};

const ENV = 'CONDUCTOR_DR_RECREATE_DELAY_MS';
const savedDelay = process.env[ENV];

beforeEach(() => {
  process.env[ENV] = '0';
});

afterEach(() => {
  if (savedDelay === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = savedDelay;
  }
});

const build = (options: Options = {}) => {
  const recorder: Recorder = {
    events: [],
    changes: [],
    logs: [],
    probes: [],
  };
  const gate = createActionGate<any>();
  const log =
    (level: string) =>
    (...args: unknown[]) =>
      recorder.logs.push(`${level} ${String(args[args.length - 1])}`);
  const logger = {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  };

  const inspection = (): DisasterRecoveryInspection => ({
    state: options.state ?? DISABLED,
    dockerUnknown: options.dockerUnknown ?? false,
    mode: options.mode ?? 'compose',
    targets: TARGETS,
    compose: {
      services: { 'gluesync-core-hub': {}, 'gluesync-chronos': {} },
    } as never,
  });

  const runner = loadWithStubs<{ default: unknown }>(
    here('./runDisasterRecoveryChange/runDisasterRecoveryChange'),
    {
      [helper('disasterRecoverySetup/disasterRecoverySetup')]: {
        inspectDisasterRecovery: async () => {
          recorder.events.push('inspect');
          if (options.inspectError) {
            throw options.inspectError;
          }
          return inspection();
        },
        prepareDisasterRecoveryChange: async (
          change: DisasterRecoveryChange,
        ) => {
          recorder.events.push('prepare');
          recorder.changes.push(change);
          if (options.prepareError) {
            throw options.prepareError;
          }
          return {
            restarting: ['gluesync-core-hub', 'gluesync-chronos'],
            recreate: async () => {
              recorder.events.push('recreate:start');
              await options.recreateGate;
              if (options.recreateError) {
                recorder.events.push('recreate:failed');
                throw options.recreateError;
              }
              recorder.events.push('recreate:done');
            },
          };
        },
      },
      [here('../container/doContainersAction/doContainersAction')]: {
        enterContainerAction: (key: any, perform: any) =>
          gate.enter(key, perform),
      },
      [path.resolve(__dirname, '../../utils/logger')]: {
        getLogger: () => logger,
      },
    },
  ).default;

  const handlerOf = (name: string): DisasterRecoveryHandler =>
    loadWithStubs<{ default: DisasterRecoveryHandler }>(here(name), {
      [here('./runDisasterRecoveryChange/runDisasterRecoveryChange')]: {
        default: runner,
      },
      // the real texts, a probe that never touches the network
      [helper('disasterRecoveryWitness/disasterRecoveryWitness')]: {
        witnessWarnings,
        witnessJoinRefusal,
        probeWitness: async (url: string, credentials?: WitnessCredentials) => {
          recorder.probes.push({ url, credentials });
          recorder.events.push('probe');
          return options.witness ?? { kind: 'answers' };
        },
      },
      [path.resolve(__dirname, '../../utils/logger')]: {
        getLogger: () => logger,
      },
    }).default;

  const fakeReply = (): Reply => {
    const reply: Reply = {
      headers: {},
      sent: [],
      raw: Object.assign(new EventEmitter(), { writableFinished: false }),
      code: n => {
        reply.statusCode = n;
        return reply;
      },
      header: (k, v) => {
        reply.headers[k] = v;
        return reply;
      },
      send: body => {
        recorder.events.push(`reply:${reply.statusCode}`);
        reply.sent.push(body);
        // the socket takes the answer a moment later
        setImmediate(() => {
          reply.raw.writableFinished = true;
          recorder.events.push('flushed');
          reply.raw.emit('finish');
        });
        return reply;
      },
    };
    return reply;
  };

  const call = async (name: string, body: unknown): Promise<Reply> => {
    const reply = fakeReply();
    await handlerOf(name)(
      { body, server: { docker: {} } } as never,
      reply as never,
    );
    return reply;
  };

  const waitUntil = async (
    done: () => boolean,
    until = Date.now() + 1000,
  ): Promise<void> => {
    if (done() || Date.now() >= until) {
      return;
    }

    await new Promise(resolve => {
      setTimeout(resolve, 5);
    });
    await waitUntil(done, until);
  };

  // Until the action has ended and let go of the lock
  const settled = (): Promise<void> =>
    waitUntil(() => gate.current() === undefined);

  // Until the services are being recreated
  const started = (): Promise<void> =>
    waitUntil(() => recorder.events.includes('recreate:start'));

  return { recorder, call, settled, started, handlerOf, fakeReply };
};

const FIRST = './setupFirstSite/setupFirstSite';
const JOIN = './joinSecondSite/joinSecondSite';
const DISABLE = './disableDisasterRecovery/disableDisasterRecovery';

const bodyOf = (reply: Reply): any => reply.sent[0];

describe('setup of the first site', () => {
  it('answers 202 with the pairing code, and only after the answer is out recreates the services', async () => {
    const { recorder, call, settled } = build();
    const reply = await call(FIRST, FIRST_BODY);

    assert.equal(reply.statusCode, 202);
    assert.equal(bodyOf(reply).success, true);
    assert.deepEqual(bodyOf(reply).data.restarting, [
      'gluesync-core-hub',
      'gluesync-chronos',
    ]);

    await settled();

    // the services are not touched before the answer has left the socket
    assert.deepEqual(recorder.events, [
      'inspect',
      'probe',
      'prepare',
      'reply:202',
      'flushed',
      'recreate:start',
      'recreate:done',
    ]);
  });

  it('writes the first site as the one that keeps its data, with the secret of the code', async () => {
    const { recorder, call } = build();
    const reply = await call(FIRST, FIRST_BODY);
    const { pairingCode, operatorToken } = bodyOf(reply).data;
    const [change] = recorder.changes;

    assert.equal(change.kind, 'enable');
    assert.ok(change.kind === 'enable');
    assert.deepEqual(
      { ...change.variables, sharedSecret: '*', adminToken: '*' },
      {
        nodeId: 'site-a',
        peerUrl: 'http://10.0.0.2:1717',
        failoverMode: 'witness',
        witnessUrl: 'https://witness.example.com:8443',
        leaseTtlSeconds: 40,
        sharedSecret: '*',
        adminToken: '*',
        bootstrapActive: true,
        pairing: { thisSiteUrl: 'http://10.0.0.1:1717', peerNodeId: 'site-b' },
      },
    );
    assert.equal(operatorToken, change.variables.adminToken);
    assert.notEqual(change.variables.sharedSecret, operatorToken);
    assert.match(change.variables.sharedSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(operatorToken, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(decodePairingCode(pairingCode), {
      v: 1,
      secret: change.variables.sharedSecret,
      failoverMode: 'witness',
      witnessUrl: 'https://witness.example.com:8443',
      leaseTtlSeconds: 40,
      first: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
      joiner: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
    });
  });

  it('probes the witness without a signature, and answers an empty list of warnings when it answers', async () => {
    const { recorder, call } = build();
    const reply = await call(FIRST, FIRST_BODY);

    assert.equal(reply.statusCode, 202);
    assert.deepEqual(bodyOf(reply).data.warnings, []);
    assert.deepEqual(recorder.probes, [
      { url: 'https://witness.example.com:8443', credentials: undefined },
    ]);
  });

  it('still sets up, with a warning that names the witness, when the witness does not answer yet', async () => {
    const { recorder, call, settled } = build({
      witness: { kind: 'unreachable', reason: 'ECONNREFUSED' },
    });
    const reply = await call(FIRST, FIRST_BODY);

    await settled();

    assert.equal(reply.statusCode, 202);
    assert.equal(bodyOf(reply).success, true);
    assert.deepEqual(bodyOf(reply).data.warnings, [
      'The witness at https://witness.example.com:8443 does not answer yet. This site serves meanwhile; start the witness with the shared secret of gluesync-dr.env before the second site joins: the join is refused while the witness does not answer.',
    ]);
    assert.equal(recorder.changes.length, 1);
    assert.ok(recorder.events.includes('recreate:done'));
  });

  it('warns, and still sets up, when the witness url answers as something else than a witness', async () => {
    const { call } = build({
      witness: { kind: 'not-a-witness', role: 'NODE' },
    });
    const reply = await call(FIRST, FIRST_BODY);

    assert.equal(reply.statusCode, 202);
    assert.equal(bodyOf(reply).data.warnings.length, 1);
    assert.match(
      bodyOf(reply).data.warnings[0],
      /^The service at https:\/\/witness\.example\.com:8443 answers as a Core Hub with the role "NODE", not as a witness\./,
    );
  });

  it('does not probe anything in manual mode, and answers an empty list of warnings', async () => {
    const { recorder, call } = build({
      witness: { kind: 'unreachable', reason: 'x' },
    });
    const reply = await call(FIRST, {
      ...FIRST_BODY,
      failoverMode: 'manual',
      witnessUrl: undefined,
    });

    assert.equal(reply.statusCode, 202);
    assert.deepEqual(bodyOf(reply).data.warnings, []);
    assert.deepEqual(recorder.probes, []);
  });

  it('refuses a malformed witness url with 400 and probes nothing', async () => {
    const malformed = [
      'ftp://witness.example.com:1719',
      'witness.example.com:1719',
      'https://witness.example.com:0',
      'https://witness.example.com:70000',
      'https://:1719',
      'https://user:pw@witness.example.com',
      'https://wit ness.example.com',
    ];

    await Promise.all(
      malformed.map(async witnessUrl => {
        const { recorder, call } = build();
        const reply = await call(FIRST, { ...FIRST_BODY, witnessUrl });

        assert.equal(reply.statusCode, 400, witnessUrl);
        assert.equal(bodyOf(reply).error, 'Invalid disaster recovery setup');
        assert.match(
          bodyOf(reply).details,
          /witnessUrl is required with failoverMode "witness" and must be an http:\/\/ or https:\/\/ URL with a host/,
        );
        assert.deepEqual(recorder.probes, []);
        assert.deepEqual(recorder.events, ['reply:400']);
      }),
    );
  });

  it('never logs the secret, the token or the code', async () => {
    const { recorder, call, settled } = build();
    const reply = await call(FIRST, FIRST_BODY);
    const { pairingCode, operatorToken } = bodyOf(reply).data;

    await settled();

    const logs = recorder.logs.join('\n');

    assert.ok(!logs.includes(pairingCode));
    assert.ok(!logs.includes(operatorToken));
    assert.ok(!logs.includes(decodePairingCode(pairingCode).secret));
  });

  it('answers 400 for a request that Core Hub would refuse, with every problem, and writes nothing', async () => {
    const { recorder, call } = build();
    const reply = await call(FIRST, {
      ...FIRST_BODY,
      thisSite: { nodeId: 'Site A', url: 'http://10.0.0.1' },
      witnessUrl: undefined,
    });

    assert.equal(reply.statusCode, 400);
    assert.equal(bodyOf(reply).success, false);
    assert.equal(bodyOf(reply).error, 'Invalid disaster recovery setup');
    assert.match(bodyOf(reply).details, /thisSite\.nodeId/);
    assert.match(bodyOf(reply).details, /thisSite\.url/);
    assert.match(bodyOf(reply).details, /witnessUrl is required/);
    // answered at once: not even the host was looked at
    assert.deepEqual(recorder.events, ['reply:400']);
  });

  it('answers 409 when DR is already enabled, by this Conductor or by hand', async () => {
    const managed = build({ state: MANAGED });
    const byHand = build({ state: { ...MANAGED, managedByConductor: false } });
    const first = await managed.call(FIRST, FIRST_BODY);
    const second = await byHand.call(FIRST, FIRST_BODY);

    assert.equal(first.statusCode, 409);
    assert.equal(
      bodyOf(first).error,
      'Disaster recovery is already enabled on this Core Hub',
    );
    assert.match(bodyOf(first).details, /Disable it first/);
    assert.equal(second.statusCode, 409);
    assert.match(bodyOf(second).details, /set up by hand/);
    assert.deepEqual(managed.recorder.events, ['inspect', 'reply:409']);
    assert.deepEqual(byHand.recorder.events, ['inspect', 'reply:409']);
  });

  it('answers 409 with the reason when the host is not supported', async () => {
    const { recorder, call } = build({
      state: { ...DISABLED, supported: false, reason: 'Docker Swarm: by hand' },
    });
    const reply = await call(FIRST, FIRST_BODY);

    assert.equal(reply.statusCode, 409);
    assert.equal(
      bodyOf(reply).error,
      'Disaster recovery cannot be set up here',
    );
    assert.equal(bodyOf(reply).details, 'Docker Swarm: by hand');
    assert.deepEqual(recorder.events, ['inspect', 'reply:409']);
  });

  it('refuses a host that cannot take the setup for that, not for a witness that does not answer, and probes nothing', async () => {
    const dead = { kind: 'unreachable', reason: 'ETIMEDOUT' } as const;
    const enabled = build({ state: MANAGED, witness: dead });
    const unsupported = build({
      state: { ...DISABLED, supported: false, reason: 'no Chronos' },
      witness: dead,
    });
    const release = deferred<undefined>();
    const running = build({ recreateGate: release.promise, witness: dead });

    const first = await enabled.call(FIRST, FIRST_BODY);
    const second = await unsupported.call(FIRST, FIRST_BODY);

    assert.equal(
      bodyOf(first).error,
      'Disaster recovery is already enabled on this Core Hub',
    );
    assert.equal(
      bodyOf(second).error,
      'Disaster recovery cannot be set up here',
    );
    assert.deepEqual(enabled.recorder.probes, []);
    assert.deepEqual(unsupported.recorder.probes, []);

    // another container action holds the lock: the witness is not asked a second time
    await running.call(FIRST, FIRST_BODY);
    await running.started();
    const refused = await running.call(FIRST, FIRST_BODY);

    assert.equal(
      bodyOf(refused).error,
      'Another container action is in progress',
    );
    assert.equal(running.recorder.probes.length, 1);
    release.resolve(undefined);
    await running.settled();
  });

  it('answers 503 while Docker does not answer', async () => {
    const { call } = build({ dockerUnknown: true });
    const reply = await call(FIRST, FIRST_BODY);

    assert.equal(reply.statusCode, 503);
    assert.equal(bodyOf(reply).error, 'Docker is not ready');
  });

  it('answers 507 for a full disk, restores nothing more, and recreates nothing', async () => {
    const { recorder, call, settled } = build({
      prepareError: new DiskFullError('/kit/docker-compose.yml', 4096, 0),
    });
    const reply = await call(FIRST, FIRST_BODY);

    await settled();

    assert.equal(reply.statusCode, 507);
    assert.equal(bodyOf(reply).diagnosis.code, 'DISK_FULL');
    assert.ok(!recorder.events.includes('recreate:start'));
  });

  it('answers 500 for any other failure of the files', async () => {
    const { call } = build({ prepareError: new Error('cannot write') });
    const reply = await call(FIRST, FIRST_BODY);

    assert.equal(reply.statusCode, 500);
    assert.equal(bodyOf(reply).error, 'Failed to change disaster recovery');
    assert.match(bodyOf(reply).details, /cannot write/);
  });

  it('holds the container action lock while the services are recreated, then lets go', async () => {
    const release = deferred<undefined>();
    const { recorder, call, settled, started } = build({
      recreateGate: release.promise,
    });
    const accepted = await call(FIRST, FIRST_BODY);

    await started();

    // the recreate is running: an update (or another setup) is refused with the usual 409
    const refused = await call(DISABLE, { confirm: true });

    assert.equal(accepted.statusCode, 202);
    assert.equal(refused.statusCode, 409);
    assert.equal(
      bodyOf(refused).error,
      'Another container action is in progress',
    );
    assert.match(bodyOf(refused).details, /^"dr-setup-first" started at /);
    assert.ok(refused.headers['Retry-After']);
    assert.deepEqual(
      recorder.events.filter(e => e.startsWith('recreate')),
      ['recreate:start'],
    );

    release.resolve(undefined);
    await settled();

    const after = await call(FIRST, FIRST_BODY);

    assert.equal(after.statusCode, 202);
  });

  it('logs a recreate that fails after the 202 and lets go of the lock', async () => {
    const { recorder, call, settled } = build({
      recreateError: new Error('compose exploded'),
    });
    const reply = await call(FIRST, FIRST_BODY);

    await settled();

    // the answer was the 202: the failure cannot reach the caller any more
    assert.equal(reply.statusCode, 202);
    assert.equal(reply.sent.length, 1);
    assert.ok(
      recorder.logs.some(
        l => l.startsWith('error') && /Failed to change/.test(l),
      ),
    );

    const next = await call(FIRST, FIRST_BODY);

    assert.equal(next.statusCode, 202);
  });
});

describe('setup of the second site', () => {
  const pairingCode = async (): Promise<{
    code: string;
    secret: string;
    token: string;
  }> => {
    const first = build();
    const reply = await first.call(FIRST, FIRST_BODY);

    return {
      code: bodyOf(reply).data.pairingCode,
      secret: decodePairingCode(bodyOf(reply).data.pairingCode).secret,
      token: bodyOf(reply).data.operatorToken,
    };
  };

  it('joins as the standby: node id and peer from the code, same secret and mode, a token of its own, no bootstrap', async () => {
    const { code, secret, token } = await pairingCode();
    const { recorder, call, settled } = build();
    const reply = await call(JOIN, {
      pairingCode: code,
      confirmDataMovedAside: true,
    });

    await settled();

    assert.equal(reply.statusCode, 202);
    const { data } = bodyOf(reply);
    const [change] = recorder.changes;

    assert.ok(change.kind === 'enable');
    assert.deepEqual(Object.keys(data).sort(), [
      'nodeId',
      'operatorToken',
      'peerUrl',
      'restarting',
    ]);
    // the witness was probed with the signature of this site, from the secret of the code
    assert.deepEqual(recorder.probes, [
      {
        url: 'https://witness.example.com:8443',
        credentials: { nodeId: 'site-b', secret },
      },
    ]);
    assert.equal(data.nodeId, 'site-b');
    assert.equal(data.peerUrl, 'http://10.0.0.1:1717');
    assert.deepEqual(
      { ...change.variables, adminToken: '*' },
      {
        nodeId: 'site-b',
        peerUrl: 'http://10.0.0.1:1717',
        failoverMode: 'witness',
        witnessUrl: 'https://witness.example.com:8443',
        leaseTtlSeconds: 40,
        sharedSecret: secret,
        adminToken: '*',
        bootstrapActive: false,
      },
    );
    assert.equal(data.operatorToken, change.variables.adminToken);
    assert.notEqual(data.operatorToken, token);
    assert.deepEqual(recorder.events.filter(e => e !== 'inspect').slice(0, 5), [
      'probe',
      'prepare',
      'reply:202',
      'flushed',
      'recreate:start',
    ]);
  });

  it('refuses the join with 409 before anything is changed when the witness does not answer', async () => {
    const { code } = await pairingCode();
    const { recorder, call } = build({
      witness: { kind: 'unreachable', reason: 'ETIMEDOUT' },
    });
    const reply = await call(JOIN, {
      pairingCode: code,
      confirmDataMovedAside: true,
    });

    assert.equal(reply.statusCode, 409);
    assert.equal(bodyOf(reply).success, false);
    assert.equal(bodyOf(reply).error, 'The witness does not answer');
    assert.equal(
      bodyOf(reply).details,
      'The witness at https://witness.example.com:8443 does not answer (ETIMEDOUT). It must be running with the shared secret of the pair before this site joins: start it, then join again.',
    );
    // the host was looked at first, and nothing was written
    assert.deepEqual(recorder.events, ['inspect', 'probe', 'reply:409']);
    assert.deepEqual(recorder.changes, []);
  });

  it('refuses the join with 409 when the witness rejects the signature of the shared secret', async () => {
    const { code, secret } = await pairingCode();
    const { recorder, call } = build({ witness: { kind: 'rejected' } });
    const reply = await call(JOIN, {
      pairingCode: code,
      confirmDataMovedAside: true,
    });

    assert.equal(reply.statusCode, 409);
    assert.equal(
      bodyOf(reply).error,
      'The witness refuses the shared secret of the pair',
    );
    assert.match(
      bodyOf(reply).details,
      /^The witness at https:\/\/witness\.example\.com:8443 rejected the signature of this site\. It must be running with the shared secret of the pair/,
    );
    assert.match(bodyOf(reply).details, /GS_DR_NODE_ID.*"site-b"/);
    assert.deepEqual(recorder.events, ['inspect', 'probe', 'reply:409']);
    assert.deepEqual(recorder.changes, []);
    assert.ok(!JSON.stringify(reply.sent).includes(secret));
    assert.ok(!recorder.logs.join('\n').includes(secret));
  });

  it('refuses the join with 409 when the witness url answers as something else than a witness', async () => {
    const { code } = await pairingCode();
    const { recorder, call } = build({
      witness: { kind: 'not-a-witness', role: null },
    });
    const reply = await call(JOIN, {
      pairingCode: code,
      confirmDataMovedAside: true,
    });

    assert.equal(reply.statusCode, 409);
    assert.equal(bodyOf(reply).error, 'The witness is not a witness');
    assert.match(bodyOf(reply).details, /witness\.example\.com:8443/);
    assert.deepEqual(recorder.changes, []);
  });

  it('does not probe a witness in manual mode', async () => {
    const first = build();
    const created = await first.call(FIRST, {
      ...FIRST_BODY,
      failoverMode: 'manual',
      witnessUrl: undefined,
    });
    const { recorder, call, settled } = build({
      witness: { kind: 'unreachable', reason: 'x' },
    });
    const reply = await call(JOIN, {
      pairingCode: bodyOf(created).data.pairingCode,
      confirmDataMovedAside: true,
    });

    await settled();

    assert.equal(reply.statusCode, 202);
    assert.deepEqual(recorder.probes, []);
  });

  it('answers 400 for a malformed code, a code of another version and a damaged one', async () => {
    const { code } = await pairingCode();
    const bad = [
      'not-a-code',
      '',
      'GSDR2.abc',
      `GSDR1.${Buffer.from(JSON.stringify({ v: 2 })).toString('base64url')}`,
      code.slice(0, -10),
      `${code}!`,
    ];

    await Promise.all(
      bad.map(async pairing => {
        const { recorder, call } = build();
        const reply = await call(JOIN, {
          pairingCode: pairing,
          confirmDataMovedAside: true,
        });

        assert.equal(reply.statusCode, 400, pairing);
        assert.equal(bodyOf(reply).error, 'Invalid pairing code');
        assert.deepEqual(recorder.events, ['reply:400']);
      }),
    );
  });

  it('answers 409 when DR is already enabled or the host is not supported', async () => {
    const { code } = await pairingCode();
    const enabled = build({ state: MANAGED });
    const unsupported = build({
      state: { ...DISABLED, supported: false, reason: 'no Chronos' },
    });
    const body = { pairingCode: code, confirmDataMovedAside: true };

    assert.equal((await enabled.call(JOIN, body)).statusCode, 409);
    assert.equal((await unsupported.call(JOIN, body)).statusCode, 409);
    assert.deepEqual(enabled.recorder.changes, []);
    assert.deepEqual(unsupported.recorder.changes, []);
  });

  it('refuses a host that cannot take the join for that, not for a witness that does not answer, and probes nothing', async () => {
    const { code } = await pairingCode();
    const dead = { kind: 'unreachable', reason: 'ETIMEDOUT' } as const;
    const enabled = build({ state: MANAGED, witness: dead });
    const unsupported = build({
      state: { ...DISABLED, supported: false, reason: 'no Chronos' },
      witness: dead,
    });
    const body = { pairingCode: code, confirmDataMovedAside: true };
    const first = await enabled.call(JOIN, body);
    const second = await unsupported.call(JOIN, body);

    assert.equal(
      bodyOf(first).error,
      'Disaster recovery is already enabled on this Core Hub',
    );
    assert.equal(
      bodyOf(second).error,
      'Disaster recovery cannot be set up here',
    );
    assert.deepEqual(enabled.recorder.events, ['inspect', 'reply:409']);
    assert.deepEqual(unsupported.recorder.events, ['inspect', 'reply:409']);
    assert.deepEqual(enabled.recorder.probes, []);
    assert.deepEqual(unsupported.recorder.probes, []);
  });
});

describe('disable', () => {
  it('answers 202 and removes the setup of this Conductor, recreating after the answer', async () => {
    const { recorder, call, settled } = build({ state: MANAGED });
    const reply = await call(DISABLE, { confirm: true });

    await settled();

    assert.equal(reply.statusCode, 202);
    assert.deepEqual(bodyOf(reply), {
      success: true,
      data: { restarting: ['gluesync-core-hub', 'gluesync-chronos'] },
    });
    assert.deepEqual(recorder.changes, [{ kind: 'disable' }]);
    assert.deepEqual(recorder.events, [
      'inspect',
      'prepare',
      'reply:202',
      'flushed',
      'recreate:start',
      'recreate:done',
    ]);
  });

  it('answers 409 when DR is not enabled', async () => {
    const { recorder, call } = build();
    const reply = await call(DISABLE, { confirm: true });

    assert.equal(reply.statusCode, 409);
    assert.equal(
      bodyOf(reply).error,
      'Disaster recovery is not enabled on this Core Hub',
    );
    assert.deepEqual(recorder.changes, []);
  });

  it("answers 409 for DR enabled by hand: that is the operator's to remove", async () => {
    const { recorder, call } = build({
      state: { ...MANAGED, managedByConductor: false },
    });
    const reply = await call(DISABLE, { confirm: true });

    assert.equal(reply.statusCode, 409);
    assert.equal(
      bodyOf(reply).error,
      'Disaster recovery was not set up by this Conductor',
    );
    assert.deepEqual(recorder.changes, []);
  });

  it('answers 409 on Docker Swarm', async () => {
    const { call } = build({ state: MANAGED, mode: 'swarm' });

    assert.equal((await call(DISABLE, { confirm: true })).statusCode, 409);
  });
});

describe('GET setup', () => {
  const get = async (options: Options) => {
    const { handlerOf, fakeReply } = build(options);
    const reply = fakeReply();
    const handler = loadWithStubs<{ default: DisasterRecoveryHandler }>(
      here('./getDisasterRecoverySetup/getDisasterRecoverySetup'),
      {
        [helper('disasterRecoverySetup/disasterRecoverySetup')]: {
          inspectDisasterRecovery: async () => {
            if (options.inspectError) {
              throw options.inspectError;
            }
            return { state: options.state ?? DISABLED };
          },
        },
      },
    ).default;

    assert.ok(handlerOf);
    await handler({ server: { docker: {} } } as never, reply as never);

    return reply;
  };

  it('returns the state as it is, nothing else', async () => {
    const reply = await get({ state: MANAGED });

    assert.equal(reply.statusCode, 200);
    assert.deepEqual(bodyOf(reply), { success: true, data: MANAGED });
    assert.deepEqual(Object.keys(bodyOf(reply).data).sort(), [
      'bootstrapActive',
      'enabled',
      'failoverMode',
      'managedByConductor',
      'nodeId',
      'peerUrl',
      'reason',
      'supported',
      'witnessUrl',
    ]);
  });

  it('answers 507 or 500 when the compose file cannot be read', async () => {
    const full = await get({ inspectError: new DiskFullError('/kit', 1, 0) });
    const other = await get({ inspectError: new Error('unreadable') });

    assert.equal(full.statusCode, 507);
    assert.equal(other.statusCode, 500);
    assert.equal(
      bodyOf(other).error,
      'Failed to read the disaster recovery setup',
    );
  });
});
