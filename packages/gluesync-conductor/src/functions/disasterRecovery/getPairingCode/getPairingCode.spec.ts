/* eslint-disable functional/immutable-data, functional/no-let, functional/prefer-immutable-types -- fake Fastify objects and recorders for the test */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';

import {
  decodePairingCode,
  encodePairingCode,
  rebuildPairingPayload,
} from '../../../helpers/disasterRecoveryPairing/disasterRecoveryPairing';
import { renderDisasterRecoveryEnvFile } from '../../../helpers/disasterRecoveryCompose/disasterRecoveryCompose';
import type { SiteVariables } from '../../../helpers/disasterRecoveryCompose/disasterRecoveryCompose.model';
import type {
  DisasterRecoveryInspection,
  DisasterRecoveryState,
} from '../../../helpers/disasterRecoverySetup/disasterRecoverySetup.model';
import parseEnvFile from '../../../helpers/swarm/parseEnvFile/parseEnvFile';
import loadWithStubs from '../../../testing/loadWithStubs';
import errorHandlerPlugin from '../../../plugins/errorHandlerPlugin';
import type { DisasterRecoveryHandler } from '../disasterRecovery.model';

const here = (p: string): string => path.resolve(__dirname, p);
const helper = (p: string): string =>
  path.resolve(__dirname, '../../../helpers', p);

const TARGETS = {
  coreHub: 'gluesync-core-hub',
  chronos: 'gluesync-chronos',
  windows: false,
  controlScheme: 'https',
} as const;

const MANAGED: DisasterRecoveryState = {
  supported: true,
  reason: null,
  enabled: true,
  managedByConductor: true,
  nodeId: 'site-a',
  peerUrl: 'http://10.0.0.2:1717',
  failoverMode: 'manual',
  witnessUrl: null,
  bootstrapActive: true,
};

const FIRST_BODIES = [
  {
    thisSite: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
    peerSite: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
    failoverMode: 'manual',
  },
  {
    thisSite: { nodeId: 'site-a', url: 'https://HQ.example.com:1717/' },
    peerSite: { nodeId: 'dr-1', url: 'https://dr.example.com:1717' },
    failoverMode: 'manual',
    leaseTtlSeconds: 90,
  },
  {
    thisSite: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
    peerSite: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
    failoverMode: 'witness',
    witnessUrl: 'https://witness.example.com:8443/lease',
    leaseTtlSeconds: 40,
  },
];

type Answer = {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
};

// What setup/first answers for a body, and the variables it writes
const firstSite = async (
  body: unknown,
): Promise<{ pairingCode: string; variables: SiteVariables }> => {
  const captured: { plan?: any } = {};
  const handler = loadWithStubs<{ default: DisasterRecoveryHandler }>(
    here('../setupFirstSite/setupFirstSite'),
    {
      [here('../runDisasterRecoveryChange/runDisasterRecoveryChange')]: {
        default: async (_request: unknown, _reply: unknown, plan: any) => {
          captured.plan = plan;
        },
      },
    },
  ).default;

  await handler({ body } as never, {} as never);

  const { plan } = captured;

  return {
    pairingCode: plan.accepted([]).pairingCode,
    variables: {
      ...plan.change.variables,
      chronosDir: '/opt/gluesync/chronos',
    },
  };
};

type Setup = {
  inspection?: Partial<DisasterRecoveryInspection>;
  state?: DisasterRecoveryState;
  env?: Record<string, string> | undefined;
  inspectError?: unknown;
};

const build = async (setup: Setup = {}) => {
  const lines: string[] = [];
  const logger = pino(
    { level: 'trace' },
    { write: (line: string) => lines.push(line) },
  );
  const handler = loadWithStubs<{ default: DisasterRecoveryHandler }>(
    here('./getPairingCode'),
    {
      [helper('disasterRecoverySetup/disasterRecoverySetup')]: {
        inspectDisasterRecovery: async () => {
          if (setup.inspectError) {
            throw setup.inspectError;
          }
          return {
            state: setup.state ?? MANAGED,
            dockerUnknown: false,
            mode: 'compose',
            targets: TARGETS,
            compose: {},
            ...setup.inspection,
          };
        },
        readDisasterRecoveryEnv: async () => setup.env,
      },
      [here('../../../utils/logger')]: { getLogger: () => logger },
    },
  ).default;
  const app = fastify({ loggerInstance: logger }) as unknown as FastifyInstance;

  await app.register(errorHandlerPlugin);
  app.decorate('docker', { getter: () => ({}) } as never);
  app.post('/disaster-recovery/setup/pairing-code', handler);
  await app.ready();

  const call = async (): Promise<Answer> => {
    const res = await app.inject({
      method: 'POST',
      url: '/disaster-recovery/setup/pairing-code',
    });

    return {
      statusCode: res.statusCode,
      body: res.json(),
      headers: res.headers as Record<string, string>,
    };
  };

  return { app, call, logs: () => lines.join('') };
};

const envOf = (variables: SiteVariables): Record<string, string> =>
  parseEnvFile(renderDisasterRecoveryEnvFile(variables));

describe('POST /disaster-recovery/setup/pairing-code', () => {
  it('gives back the code setup/first returned, for every kind of pair', async () => {
    await Promise.all(
      FIRST_BODIES.map(async body => {
        const { pairingCode, variables } = await firstSite(body);
        const { app, call } = await build({ env: envOf(variables) });
        const answer = await call();

        assert.equal(answer.statusCode, 200);
        assert.deepEqual(Object.keys(answer.body.data), ['pairingCode']);
        assert.equal(answer.body.data.pairingCode, pairingCode);
        assert.equal(answer.headers['cache-control'], 'no-store');
        assert.deepEqual(
          decodePairingCode(answer.body.data.pairingCode),
          decodePairingCode(pairingCode),
        );
        await app.close();
      }),
    );
  });

  it('is built by the encoder of the setup: the payload goes through encodePairingCode unchanged', async () => {
    const { variables, pairingCode } = await firstSite(FIRST_BODIES[2]);
    const rebuilt = rebuildPairingPayload(envOf(variables));

    assert.ok(rebuilt.ok);
    assert.equal(encodePairingCode(rebuilt.payload), pairingCode);
    assert.deepEqual(Object.keys(rebuilt.payload), [
      'v',
      'secret',
      'failoverMode',
      'witnessUrl',
      'leaseTtlSeconds',
      'first',
      'joiner',
    ]);
  });

  it('answers 409 when disaster recovery is not enabled', async () => {
    const { app, call } = await build({
      state: { ...MANAGED, enabled: false, managedByConductor: false },
    });
    const answer = await call();

    assert.equal(answer.statusCode, 409);
    assert.equal(answer.body.success, false);
    assert.match(answer.body.error, /not enabled/);
    await app.close();
  });

  it('answers 409 when it was enabled by hand or the env file is not the Conductor’s', async () => {
    const { variables } = await firstSite(FIRST_BODIES[0]);
    const cases: ReadonlyArray<Setup> = [
      {
        state: { ...MANAGED, managedByConductor: false },
        env: envOf(variables),
      },
      { env: undefined },
      { env: { ...envOf(variables), GS_DR_MANAGED_BY: 'someone' } },
    ];

    await Promise.all(
      cases.map(async setup => {
        const { app, call } = await build(setup);
        const answer = await call();

        assert.equal(answer.statusCode, 409);
        assert.match(answer.body.error, /not set up by this Conductor/);
        await app.close();
      }),
    );
  });

  it('answers 409 naming the variables the env file lacks (a joiner, or a setup of an older version)', async () => {
    const { variables } = await firstSite(FIRST_BODIES[0]);
    const joiner = envOf({ ...variables, pairing: undefined });
    const { app, call } = await build({ env: joiner });
    const answer = await call();

    assert.equal(answer.statusCode, 409);
    assert.equal(answer.body.success, false);
    assert.match(answer.body.error, /cannot be rebuilt/);
    assert.match(answer.body.details, /GS_DR_PAIRING_FIRST_URL/);
    assert.match(answer.body.details, /GS_DR_PAIRING_JOINER_NODE_ID/);
    assert.ok(!JSON.stringify(answer.body).includes(variables.sharedSecret));
    await app.close();
  });

  it('answers 409 for a value in the file that is not valid, without echoing it', async () => {
    const { variables } = await firstSite(FIRST_BODIES[0]);
    const { app, call } = await build({
      env: { ...envOf(variables), GS_DR_NODE_ID: 'Not Valid' },
    });
    const answer = await call();

    assert.equal(answer.statusCode, 409);
    assert.match(answer.body.details, /not valid/);
    assert.ok(!JSON.stringify(answer.body).includes('Not Valid'));
    await app.close();
  });

  it('answers 500 with no secret when the files cannot be read', async () => {
    const { app, call } = await build({ inspectError: new Error('disk gone') });
    const answer = await call();

    assert.equal(answer.statusCode, 500);
    assert.equal(answer.body.success, false);
    await app.close();
  });

  it('never writes the code, the secret or the token to the log, on any answer', async () => {
    const { pairingCode, variables } = await firstSite(FIRST_BODIES[2]);
    const secret = variables.sharedSecret;
    const joiner = envOf({ ...variables, pairing: undefined });
    const setups: ReadonlyArray<Setup> = [
      { env: envOf(variables) },
      { env: joiner },
      { env: { ...envOf(variables), GS_DR_SHARED_SECRET: 'x' } },
      { env: undefined },
      { state: { ...MANAGED, enabled: false } },
      { inspectError: new Error('boom') },
    ];

    await Promise.all(
      setups.map(async setup => {
        const { app, call, logs } = await build(setup);

        await call();
        await app.close();

        const text = logs();

        assert.ok(text.length > 0, 'the request itself is logged');
        assert.ok(!text.includes(pairingCode));
        assert.ok(!text.includes(secret));
        assert.ok(!text.includes(variables.adminToken));
        assert.ok(!text.includes(pairingCode.slice('GSDR1.'.length, 40)));
      }),
    );
  });
});
