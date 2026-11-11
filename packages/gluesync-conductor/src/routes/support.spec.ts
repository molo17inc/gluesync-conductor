import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import fastify, { type FastifyPluginAsync } from 'fastify';

import {
  FakeSupportPortal,
  startFakeSupportPortal,
} from '../testing/fakeSupportPortal';
import loadWithStubs from '../testing/loadWithStubs';

type Subject = Readonly<{ default: FastifyPluginAsync }>;

const guard = () => async () => undefined;
const collectLogsModule = path.resolve(
  __dirname,
  '../functions/utility/collectLogs/collectLogs',
);

// The real handler, with the orchestrator probe out of the way
const realHandler = () =>
  loadWithStubs<{ default: unknown }>(collectLogsModule, {
    [path.resolve(
      __dirname,
      '../helpers/orchestrator/getOrchestrator/getOrchestrator',
    )]: { default: async () => ({ mode: 'compose' }) },
  }).default;

// The real route (its body and response schemas), on a Fastify configured as
// Conductor's: ajv drops what a schema does not list.
const app = async (handler: unknown) => {
  const subject = loadWithStubs<Subject>(path.resolve(__dirname, './support'), {
    [collectLogsModule]: { default: handler },
    [path.resolve(__dirname, '../security')]: { requireManage: guard },
  });
  const instance = fastify({ ajv: { customOptions: { strict: false } } });
  await instance.register(subject.default);
  await instance.ready();
  return instance;
};

const VOUCHER = 'GSV-ABCD-EFGH-JKMN';

describe('POST /collect-logs schemas', () => {
  it('keeps voucher in the body and every new field in the 200 reply', async () => {
    const seen = { body: undefined as unknown };
    const server = await app(async (req: any, reply: any) => {
      seen.body = req.body;
      return reply.code(200).send({
        success: true,
        output: 'done',
        archivePath: '/tmp/a.tar.xz',
        uploadedVia: 'portal',
        ticketKey: 'GSSD-1234',
        size: 4096,
        verified: false,
        leaked: 'dropped',
      });
    });

    const res = await server.inject({
      method: 'POST',
      url: '/collect-logs',
      payload: { voucher: VOUCHER },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen.body, { voucher: VOUCHER });
    assert.deepEqual(res.json(), {
      success: true,
      output: 'done',
      archivePath: '/tmp/a.tar.xz',
      uploadedVia: 'portal',
      ticketKey: 'GSSD-1234',
      size: 4096,
      verified: false,
    });
  });

  it('keeps code and maxBytes in the 400, 429 and 502 replies', async () => {
    const statuses: ReadonlyArray<readonly [number, string]> = [
      [400, 'file_too_large'],
      [429, 'rate_limited'],
      [502, 'portal_unreachable'],
    ];

    await Promise.all(
      statuses.map(async ([status, code]) => {
        const server = await app(async (_req: unknown, reply: any) =>
          reply.code(status).send({
            success: false,
            error: 'nope',
            details: 'kept at /x',
            code,
            maxBytes: 99,
          }),
        );

        const res = await server.inject({
          method: 'POST',
          url: '/collect-logs',
          payload: { voucher: VOUCHER },
        });

        assert.equal(res.statusCode, status);
        assert.deepEqual(res.json(), {
          success: false,
          error: 'nope',
          details: 'kept at /x',
          code,
          maxBytes: 99,
        });
      }),
    );
  });
});

describe('POST /collect-logs with the real handler', () => {
  let portal: FakeSupportPortal;
  const saved = process.env.GLUESYNC_SUPPORT_API_URL;

  beforeEach(async () => {
    portal = await startFakeSupportPortal();
    process.env.GLUESYNC_SUPPORT_API_URL = portal.url;
  });

  afterEach(async () => {
    await portal.close();
    if (saved === undefined) {
      delete process.env.GLUESYNC_SUPPORT_API_URL;
    } else {
      process.env.GLUESYNC_SUPPORT_API_URL = saved;
    }
  });

  const post = async (payload: object) =>
    (await app(realHandler())).inject({
      method: 'POST',
      url: '/collect-logs',
      payload,
    });

  const refusals: ReadonlyArray<
    readonly [number, unknown, number, string, number | undefined]
  > = [
    [
      401,
      { error: { code: 'voucher_invalid' } },
      400,
      'voucher_invalid',
      undefined,
    ],
    [
      410,
      { error: { code: 'voucher_expired' } },
      400,
      'voucher_expired',
      undefined,
    ],
    [
      413,
      { error: { code: 'file_too_large', maxBytes: 1234 } },
      400,
      'file_too_large',
      1234,
    ],
    [429, { error: { code: 'rate_limited' } }, 429, 'rate_limited', undefined],
  ];

  refusals.forEach(([status, body, httpStatus, code, maxBytes]) => {
    it(`answers ${httpStatus} ${code} when the portal answers ${status} at the check`, async () => {
      portal.intercept(() => ({ status, body }));

      const res = await post({ voucher: VOUCHER });

      assert.equal(res.statusCode, httpStatus);
      assert.equal(res.json().success, false);
      assert.equal(res.json().code, code);
      assert.equal(res.json().maxBytes, maxBytes);
      assert.equal(res.body.includes(VOUCHER), false);
    });
  });

  it('answers 502 portal_unreachable when the portal is down', async () => {
    portal.intercept(() => ({ status: 503 }));
    process.env.GLUESYNC_SUPPORT_API_URL = portal.url;

    const res = await post({ voucher: VOUCHER });

    assert.equal(res.statusCode, 502);
    assert.equal(res.json().code, 'portal_unreachable');
  });

  it('answers 400 voucher_format without calling the portal', async () => {
    const res = await post({ voucher: 'GSV-NOPE' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'voucher_format');
    assert.equal(portal.requests.length, 0);
  });

  it('answers 400 validation when the voucher comes with ticketId or email', async () => {
    const res = await post({ voucher: VOUCHER, ticketId: 'GSSD-1' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'validation');
    assert.match(res.json().error, /voucher/);
    assert.equal(portal.requests.length, 0);
  });
});
