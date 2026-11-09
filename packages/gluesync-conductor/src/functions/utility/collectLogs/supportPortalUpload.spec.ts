import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import loadWithStubs from '../../../testing/loadWithStubs';
import {
  FakeSupportPortal,
  startFakeSupportPortal,
} from '../../../testing/fakeSupportPortal';
import {
  SupportPortalError,
  contentTypeForArchive,
  createSupportPortalClient,
  createSupportPortalError,
  isSupportPortalError,
  resolveConductorVersion,
  resolveSupportApiUrl,
  SUPPORT_API_DEFAULT_URL,
} from './supportPortalUpload';

const VOUCHER = 'GSV-ABCD-EFGH-JKMN';
const GIB = 1024 * 1024 * 1024;

type Logged = { level: string; text: string };

let portal: FakeSupportPortal;
let workDir: string;
let pauses: number[];
let logged: Logged[];

const logger = {
  info: (obj: unknown, msg?: string) => {
    logged.push({ level: 'info', text: `${JSON.stringify(obj)} ${msg ?? ''}` });
  },
  warn: (obj: unknown, msg?: string) => {
    logged.push({ level: 'warn', text: `${JSON.stringify(obj)} ${msg ?? ''}` });
  },
};

const makeClient = (baseUrl?: string) =>
  createSupportPortalClient({
    baseUrl: baseUrl ?? portal.url,
    version: '9.9.9',
    backoffMs: 10,
    pause: async ms => {
      pauses.push(ms);
    },
    logger,
  });

// Bytes that differ from one position to the next, so a misplaced slice shows
const patterned = (size: number): Buffer =>
  Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251));

const makeFile = (size: number, name = 'support-logs.tar.gz') => {
  const file = path.join(workDir, name);
  const content = patterned(size);
  writeFileSync(file, content);
  return { file, content };
};

const failureOf = async (
  work: Promise<unknown>,
): Promise<SupportPortalError> => {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(
    isSupportPortalError(error),
    `expected a portal error, got ${error}`,
  );
  return error;
};

const s3Expired = {
  status: 403,
  body: '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
};

const errorBody = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: `${code} message`, ...extra },
});

beforeEach(async () => {
  portal = await startFakeSupportPortal({ partBytes: 4096 });
  workDir = mkdtempSync(path.join(tmpdir(), 'support-portal-spec-'));
  pauses = [];
  logged = [];
});

afterEach(async () => {
  await portal.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('configuration', () => {
  it('defaults to production and tolerates a trailing slash on the override', () => {
    assert.equal(resolveSupportApiUrl({}), SUPPORT_API_DEFAULT_URL);
    assert.equal(
      resolveSupportApiUrl({ GLUESYNC_SUPPORT_API_URL: '  ' }),
      SUPPORT_API_DEFAULT_URL,
    );
    assert.equal(
      resolveSupportApiUrl({
        GLUESYNC_SUPPORT_API_URL: ' https://staging.example/stage/// ',
      }),
      'https://staging.example/stage',
    );
  });

  it('reads the override from the environment', () => {
    const saved = process.env.GLUESYNC_SUPPORT_API_URL;
    process.env.GLUESYNC_SUPPORT_API_URL = 'http://localhost:9/x/';
    try {
      assert.equal(resolveSupportApiUrl(), 'http://localhost:9/x');
    } finally {
      if (saved === undefined) {
        delete process.env.GLUESYNC_SUPPORT_API_URL;
      } else {
        process.env.GLUESYNC_SUPPORT_API_URL = saved;
      }
    }
  });

  it('takes the version from CONDUCTOR_VERSION, then from the package', () => {
    assert.equal(
      resolveConductorVersion({ CONDUCTOR_VERSION: ' 0.14.0 ' }),
      '0.14.0',
    );
    assert.ok(resolveConductorVersion({}).length > 0);
  });

  it('names the content type after the extension of the archive', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/tmp/a.zip', 'application/zip'],
      ['/tmp/a.ZIP', 'application/zip'],
      ['/tmp/a.tar.gz', 'application/gzip'],
      ['/tmp/a.tgz', 'application/gzip'],
      ['/tmp/a.tar.zst', 'application/zstd'],
      ['/tmp/a.tar.xz', 'application/x-xz'],
      ['/tmp/a.tar', 'application/octet-stream'],
      ['/tmp/a', 'application/octet-stream'],
    ];
    cases.forEach(([file, expected]) => {
      assert.equal(contentTypeForArchive(file), expected, file);
    });
  });

  it('builds portal errors that say what they are', () => {
    const error = createSupportPortalError('boom', {
      code: 'rate_limited',
      httpStatus: 429,
    });
    assert.equal(isSupportPortalError(error), true);
    assert.equal(isSupportPortalError(new Error('boom')), false);
    assert.equal(isSupportPortalError('boom'), false);
  });
});

describe('check', () => {
  it('sends the voucher in the header only, as JSON, with the Conductor user agent', async () => {
    const result = await makeClient(`${portal.url}/`).check(VOUCHER);

    assert.deepEqual(result, {
      ticketKey: 'GSSD-1234',
      voucherExpiresAt: null,
      maxBytes: 5 * GIB,
      partBytes: 4096,
    });
    const [request] = portal.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/support/log-uploads/check');
    assert.equal(request.headers['x-gluesync-voucher'], VOUCHER);
    assert.equal(request.headers['user-agent'], 'GluesyncConductor/9.9.9');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.body.toString(), '{}');
    assert.equal(request.path.includes('GSV'), false);
  });

  it('reads the expiry of the voucher', async () => {
    portal.intercept(() => ({
      status: 200,
      body: { ticketKey: 'GSSD-9', voucherExpiresAt: '2026-12-01T00:00:00Z' },
    }));

    const result = await makeClient().check(VOUCHER);

    assert.equal(result.voucherExpiresAt, '2026-12-01T00:00:00Z');
    assert.equal(result.maxBytes, 0);
    assert.equal(result.partBytes, 0);
  });

  const refusals: ReadonlyArray<
    readonly [string, number, unknown, string | undefined, number]
  > = [
    [
      '401 is an unknown voucher',
      401,
      errorBody('voucher_invalid'),
      'voucher_invalid',
      400,
    ],
    [
      '410 is an expired voucher',
      410,
      errorBody('voucher_expired'),
      'voucher_expired',
      400,
    ],
    [
      '413 is a file too large',
      413,
      errorBody('file_too_large', { maxBytes: 1000 }),
      'file_too_large',
      400,
    ],
    [
      '429 without Retry-After is rate limiting',
      429,
      errorBody('rate_limited'),
      'rate_limited',
      429,
    ],
    [
      'a body code wins over an odd status',
      403,
      errorBody('voucher_invalid'),
      'voucher_invalid',
      400,
    ],
    [
      'a body that is not JSON still maps by status',
      401,
      'Unauthorized',
      'voucher_invalid',
      400,
    ],
    [
      '400 validation has no code of its own',
      400,
      errorBody('validation', { fieldErrors: { x: 'bad' } }),
      undefined,
      500,
    ],
    [
      '404 has no code of its own',
      404,
      errorBody('upload_not_found'),
      undefined,
      500,
    ],
  ];

  refusals.forEach(([name, status, body, code, httpStatus]) => {
    it(`maps ${name}`, async () => {
      portal.intercept(() => ({ status, body }));

      const error = await failureOf(makeClient().check(VOUCHER));

      assert.equal(error.code, code);
      assert.equal(error.httpStatus, httpStatus);
      assert.equal(portal.requests.length, 1, 'a refusal is not retried');
      assert.equal(error.message.includes(VOUCHER), false);
    });
  });

  it('reports the limit of a file too large', async () => {
    const answer = {
      current: errorBody('file_too_large', { maxBytes: 1000 }) as unknown,
    };
    portal.intercept(() => ({ status: 413, body: answer.current }));
    assert.equal((await failureOf(makeClient().check(VOUCHER))).maxBytes, 1000);

    answer.current = undefined;
    assert.equal(
      (await failureOf(makeClient().check(VOUCHER))).maxBytes,
      5 * GIB,
    );
  });

  it('keeps vouchers out of the message of an unknown refusal', async () => {
    portal.intercept(() => ({
      status: 422,
      body: { error: { code: 'odd', message: `nope for ${VOUCHER}` } },
    }));

    const error = await failureOf(makeClient().check(VOUCHER));

    assert.equal(error.code, undefined);
    assert.match(error.message, /HTTP 422, odd/);
    assert.equal(error.message.includes(VOUCHER), false);
  });

  it('waits once for Retry-After, then goes on', async () => {
    let answered = 0;
    portal.intercept(() => {
      answered += 1;
      return answered === 1
        ? {
            status: 429,
            body: errorBody('rate_limited'),
            headers: { 'Retry-After': '2' },
          }
        : undefined;
    });

    const result = await makeClient().check(VOUCHER);

    assert.equal(result.ticketKey, 'GSSD-1234');
    assert.deepEqual(pauses, [2000]);
  });

  it('fails when it is rate limited a second time', async () => {
    portal.intercept(() => ({
      status: 429,
      body: errorBody('rate_limited'),
      headers: { 'Retry-After': '1' },
    }));

    const error = await failureOf(makeClient().check(VOUCHER));

    assert.equal(error.code, 'rate_limited');
    assert.equal(error.httpStatus, 429);
    assert.match(error.message, /try again in 1 seconds/);
    assert.deepEqual(pauses, [1000]);
    assert.equal(portal.requests.length, 2);
  });

  it('does not wait for a Retry-After beyond 30 seconds', async () => {
    portal.intercept(() => ({
      status: 429,
      headers: { 'Retry-After': '3600' },
    }));

    const error = await failureOf(makeClient().check(VOUCHER));

    assert.equal(error.code, 'rate_limited');
    assert.deepEqual(pauses, []);
  });

  it('retries a server error with a growing back-off', async () => {
    let answered = 0;
    portal.intercept(() => {
      answered += 1;
      return answered <= 2 ? { status: 503 } : undefined;
    });

    const result = await makeClient().check(VOUCHER);

    assert.equal(result.ticketKey, 'GSSD-1234');
    assert.deepEqual(pauses, [10, 20]);
    assert.equal(portal.requests.length, 3);
  });

  it('is unreachable after three server errors', async () => {
    portal.intercept(() => ({ status: 502 }));

    const error = await failureOf(makeClient().check(VOUCHER));

    assert.equal(error.code, 'portal_unreachable');
    assert.equal(error.httpStatus, 502);
    assert.match(error.message, /127\.0\.0\.1/);
    assert.match(error.message, /HTTP 502/);
    assert.equal(portal.requests.length, 3);
  });

  it('is unreachable when the connection fails', async () => {
    portal.intercept(() => ({ status: 200, destroy: true }));

    const error = await failureOf(makeClient().check(VOUCHER));

    assert.equal(error.code, 'portal_unreachable');
    assert.equal(portal.requests.length, 3);
    assert.deepEqual(pauses, [10, 20]);
  });

  it('is unreachable when nothing listens, without leaking the voucher', async () => {
    const dead = await startFakeSupportPortal();
    const { url } = dead;
    await dead.close();

    const error = await failureOf(makeClient(url).check(VOUCHER));

    assert.equal(error.code, 'portal_unreachable');
    assert.equal(error.message.includes(VOUCHER), false);
    assert.ok(logged.every(entry => !entry.text.includes(VOUCHER)));
  });

  it('rejects answers it cannot read', async () => {
    const answer = { current: 'not json' as unknown };
    portal.intercept(() => ({ status: 200, body: answer.current }));

    const notJson = await failureOf(makeClient().check(VOUCHER));
    assert.equal(notJson.code, undefined);
    assert.equal(notJson.httpStatus, 500);
    assert.match(notJson.message, /cannot read/);

    answer.current = '[1,2]';
    assert.match(
      (await failureOf(makeClient().check(VOUCHER))).message,
      /cannot read/,
    );

    answer.current = { maxBytes: 1 };
    assert.match(
      (await failureOf(makeClient().check(VOUCHER))).message,
      /cannot read/,
    );
  });

  it('names the portal in a generic way when its address is not a URL', async () => {
    const error = await failureOf(makeClient('not a url').check(VOUCHER));

    assert.equal(error.code, 'portal_unreachable');
    assert.match(error.message, /\(support portal\)/);
  });
});

describe('upload', () => {
  it('sends a small archive in one PUT, exactly as the portal asked', async () => {
    const { file, content } = makeFile(1500, 'gluesync-support.tar.xz');

    const result = await makeClient().upload(VOUCHER, file, 'application/x-xz');

    assert.deepEqual(result, {
      ticketKey: 'GSSD-1234',
      size: 1500,
      verified: true,
    });
    assert.deepEqual(
      portal.requests.map(r => `${r.method} ${r.path}`),
      [
        'POST /support/log-uploads/check',
        'POST /support/log-uploads',
        'PUT /s3/single',
        'POST /support/log-uploads/up-1/complete',
      ],
    );

    const create = portal.calls('/support/log-uploads')[0];
    assert.equal(create.json.filename, 'gluesync-support.tar.xz');
    assert.equal(create.json.size, 1500);
    assert.equal(create.json.contentType, 'application/x-xz');
    assert.equal(create.json.source.client, 'conductor');
    assert.equal(create.json.source.version, '9.9.9');
    assert.ok(create.json.source.hostname.length > 0);
    assert.ok(create.json.source.os.length > 0);
    assert.equal(create.headers['x-gluesync-voucher'], VOUCHER);
    assert.equal(create.headers['user-agent'], 'GluesyncConductor/9.9.9');

    const put = portal.calls('/s3/single')[0];
    assert.deepEqual(put.body, content);
    assert.equal(put.headers['content-length'], '1500');
    assert.equal(put.headers['content-type'], 'application/x-xz');
    assert.equal(
      put.headers['x-gluesync-voucher'],
      undefined,
      'S3 never sees the voucher',
    );
    assert.equal(put.headers.authorization, undefined);
  });

  it('reuses the check it is given instead of asking again', async () => {
    const client = makeClient();
    const { file } = makeFile(100);
    const check = await client.check(VOUCHER);

    await client.upload(VOUCHER, file, 'application/gzip', check);

    assert.equal(portal.calls('/support/log-uploads/check').length, 1);
  });

  it('checks the voucher itself when no check is given', async () => {
    const { file } = makeFile(100);

    await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(portal.calls('/support/log-uploads/check').length, 1);
  });

  it('streams the parts of a large archive with the exact length of each', async () => {
    const { file, content } = makeFile(2 * 4096 + 1000);

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(result.verified, true);
    assert.equal(result.size, content.length);
    const puts = portal.requests.filter(r => r.method === 'PUT');
    assert.deepEqual(
      puts.map(r => [r.path, r.headers['content-length']]),
      [
        ['/s3/part/1', '4096'],
        ['/s3/part/2', '4096'],
        ['/s3/part/3', '1000'],
      ],
    );
    assert.deepEqual(portal.assembled(), content);
    puts.forEach(put => {
      assert.equal(put.headers['content-type'], 'application/octet-stream');
      assert.equal(put.headers['x-gluesync-voucher'], undefined);
    });
  });

  it('sends the last part of an archive that is an exact multiple of the part size', async () => {
    const { file, content } = makeFile(2 * 4096);

    await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(portal.requests.filter(r => r.method === 'PUT').length, 2);
    assert.deepEqual(portal.assembled(), content);
  });

  it('sends again the parts a 409 names, with fresh links, then completes', async () => {
    const { file, content } = makeFile(3 * 4096);
    let completes = 0;
    portal.intercept(request => {
      if (request.path.endsWith('/complete')) {
        completes += 1;
        if (completes === 1) {
          portal.stored.delete('2');
        }
      }
      return undefined;
    });

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(result.verified, true);
    assert.equal(completes, 2);
    const links = portal.calls('/support/log-uploads/up-1/links');
    assert.equal(links.length, 1);
    assert.deepEqual(links[0].json, { partNumbers: [2] });
    assert.equal(portal.calls('/s3/part/2').length, 2);
    assert.deepEqual(portal.assembled(), content);
    assert.equal(portal.calls(/abort$/).length, 0);
  });

  it('gives up when the portal keeps missing parts, and aborts', async () => {
    const { file } = makeFile(2 * 4096);
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? {
            status: 409,
            body: errorBody('upload_incomplete', { missingParts: [1] }),
          }
        : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(error.code, undefined);
    assert.match(error.message, /could not join the upload. Missing parts: 1/);
    assert.equal(portal.calls(/\/complete$/).length, 4);
    assert.equal(portal.calls(/\/abort$/).length, 1);
  });

  it('fails a 409 on a single upload, and on one that names nothing', async () => {
    const { file } = makeFile(100);
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? {
            status: 409,
            body: errorBody('upload_incomplete', { missingParts: [1] }),
          }
        : undefined,
    );
    assert.match(
      (await failureOf(makeClient().upload(VOUCHER, file, 'application/gzip')))
        .message,
      /Missing parts: 1/,
    );
    assert.equal(portal.calls(/\/abort$/).length, 1);

    await portal.close();
    portal = await startFakeSupportPortal({ partBytes: 4096 });
    const big = makeFile(2 * 4096, 'big.tar.gz');
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? { status: 409, body: 'conflict' }
        : undefined,
    );
    assert.match(
      (
        await failureOf(
          makeClient().upload(VOUCHER, big.file, 'application/gzip'),
        )
      ).message,
      /Missing parts: unknown/,
    );
  });

  it('refuses a part the archive cannot have', async () => {
    const { file } = makeFile(2 * 4096);
    let completes = 0;
    portal.intercept(request => {
      if (request.path.endsWith('/complete')) {
        completes += 1;
        return {
          status: 409,
          body: errorBody('upload_incomplete', {
            missingParts: [completes === 1 ? 99 : 0],
          }),
        };
      }
      return undefined;
    });

    assert.match(
      (await failureOf(makeClient().upload(VOUCHER, file, 'application/gzip')))
        .message,
      /asked for part 99/,
    );
  });

  it('asks for a new link when S3 says the single link expired', async () => {
    const { file, content } = makeFile(500);
    let puts = 0;
    portal.intercept(request => {
      if (request.method === 'PUT') {
        puts += 1;
        return puts === 1 ? s3Expired : undefined;
      }
      return undefined;
    });

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(result.verified, true);
    assert.equal(puts, 2);
    const links = portal.calls('/support/log-uploads/up-1/links');
    assert.equal(links.length, 1);
    assert.equal(links[0].body.toString(), '{}');
    assert.deepEqual(portal.assembled(), content);
    assert.deepEqual(pauses, [], 'an expired link is refreshed at once');
  });

  it('asks for new links of the remaining parts when one expired', async () => {
    const { file, content } = makeFile(3 * 4096);
    let part2 = 0;
    portal.intercept(request => {
      if (request.path === '/s3/part/2') {
        part2 += 1;
        return part2 === 1 ? s3Expired : undefined;
      }
      return undefined;
    });

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(result.verified, true);
    const links = portal.calls('/support/log-uploads/up-1/links');
    assert.deepEqual(
      links.map(l => l.json),
      [{ partNumbers: [2, 3] }],
    );
    assert.deepEqual(portal.assembled(), content);
  });

  it('gives up when the links keep expiring, and aborts', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.method === 'PUT' ? s3Expired : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.match(error.message, /kept expiring/);
    assert.equal(portal.calls('/support/log-uploads/up-1/links').length, 3);
    assert.equal(portal.calls(/\/abort$/).length, 1);
  });

  it('fails when the portal gives no link for a part it asks to be sent again', async () => {
    const { file } = makeFile(2 * 4096);
    portal.intercept(request => {
      if (request.path === '/support/log-uploads') {
        return {
          status: 200,
          body: {
            id: 'up-1',
            ticketKey: 'GSSD-1234',
            multipart: {
              partSize: 4096,
              parts: [
                {
                  partNumber: 1,
                  url: `${portal.url}/s3/part/1?X-Amz-Signature=secret-signature`,
                },
              ],
            },
          },
        };
      }
      return request.path.endsWith('/links')
        ? { status: 200, body: { expiresIn: 3600, parts: [] } }
        : undefined;
    });

    assert.match(
      (await failureOf(makeClient().upload(VOUCHER, file, 'application/gzip')))
        .message,
      /no link for part 2/,
    );
  });

  it('fails when a refresh brings no link', async () => {
    const { file } = makeFile(500);
    portal.intercept(request => {
      if (request.method === 'PUT') {
        return s3Expired;
      }
      return request.path.endsWith('/links')
        ? { status: 200, body: { expiresIn: 3600 } }
        : undefined;
    });

    assert.match(
      (await failureOf(makeClient().upload(VOUCHER, file, 'application/gzip')))
        .message,
      /no new link/,
    );
  });

  it('retries a PUT that fails with a server error', async () => {
    const { file, content } = makeFile(500);
    let puts = 0;
    portal.intercept(request => {
      if (request.method === 'PUT') {
        puts += 1;
        return puts <= 2 ? { status: 500 } : undefined;
      }
      return undefined;
    });

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(result.verified, true);
    assert.equal(puts, 3);
    assert.deepEqual(pauses, [10, 20]);
    assert.deepEqual(portal.assembled(), content);
  });

  it('retries a PUT that is cut, 408 or 429', async () => {
    const { file } = makeFile(500);
    const statuses = [
      { destroy: true, status: 200 },
      { status: 408 },
      { status: 429 },
    ];
    let puts = 0;
    portal.intercept(request => {
      if (request.method === 'PUT') {
        puts += 1;
        return puts <= 3 ? statuses[puts - 1] : undefined;
      }
      return undefined;
    });

    // Three failures is the limit: the fourth try never happens
    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(puts, 3);
    assert.equal(error.code, 'portal_unreachable');
    assert.equal(error.httpStatus, 502);
    assert.match(error.message, /the archive failed/);
  });

  it('is unreachable after three failed PUTs of a part, and aborts', async () => {
    const { file } = makeFile(2 * 4096);
    portal.intercept(request =>
      request.path === '/s3/part/2' ? { status: 503 } : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(error.code, 'portal_unreachable');
    assert.match(error.message, /part 2 failed/);
    assert.equal(portal.calls('/s3/part/2').length, 3);
    assert.equal(portal.calls(/\/abort$/).length, 1);
  });

  it('does not retry a PUT the storage refuses', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.method === 'PUT'
        ? { status: 403, body: '<Error>SignatureDoesNotMatch</Error>' }
        : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(error.code, undefined);
    assert.equal(error.httpStatus, 500);
    assert.match(error.message, /The storage refused the archive/);
    assert.match(error.message, /HTTP 403/);
    assert.equal(portal.calls('/s3/single').length, 1);
    assert.equal(portal.calls(/\/abort$/).length, 1);
  });

  it('does not follow a redirect of the storage: the body is streamed once', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.method === 'PUT'
        ? { status: 307, headers: { Location: `${portal.url}/s3/elsewhere` } }
        : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.match(error.message, /HTTP 307/);
    assert.equal(portal.calls('/s3/elsewhere').length, 0);
  });

  it('refuses a file larger than the portal takes, before starting an upload', async () => {
    const { file } = makeFile(5000);
    const client = makeClient();

    const error = await failureOf(
      client.upload(VOUCHER, file, 'application/gzip', {
        ticketKey: 'GSSD-1234',
        voucherExpiresAt: null,
        maxBytes: 4096,
        partBytes: 4096,
      }),
    );

    assert.equal(error.code, 'file_too_large');
    assert.equal(error.httpStatus, 400);
    assert.equal(error.maxBytes, 4096);
    assert.deepEqual(portal.requests, []);
  });

  it('refuses an archive over 5 GiB whatever the check says', async () => {
    const huge = path.join(workDir, 'huge.tar.xz');
    writeFileSync(huge, '');
    truncateSync(huge, 5 * GIB + 1);

    const error = await failureOf(
      makeClient().upload(VOUCHER, huge, 'application/x-xz', {
        ticketKey: 'GSSD-1234',
        voucherExpiresAt: null,
        maxBytes: 0,
        partBytes: 0,
      }),
    );
    assert.equal(error.code, 'file_too_large');
    assert.equal(error.maxBytes, 5 * GIB);

    const lenient = await failureOf(
      makeClient().upload(VOUCHER, huge, 'application/x-xz', {
        ticketKey: 'GSSD-1234',
        voucherExpiresAt: null,
        maxBytes: 10 * GIB,
        partBytes: 4096,
      }),
    );
    assert.equal(lenient.maxBytes, 5 * GIB);
    assert.deepEqual(portal.requests, []);
  });

  it('refuses an empty archive', async () => {
    const { file } = makeFile(0);

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.match(error.message, /empty/);
    assert.equal(portal.calls('/support/log-uploads').length, 0);
  });

  it('reports a size the portal could not verify', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? {
            status: 200,
            body: {
              id: 'up-1',
              ticketKey: 'GSSD-1234',
              size: 400,
              verified: false,
            },
          }
        : undefined,
    );

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.deepEqual(result, {
      ticketKey: 'GSSD-1234',
      size: 400,
      verified: false,
    });
  });

  it('takes the declared size when the answer leaves it out, and does not verify without a flag', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? { status: 200, body: { ticketKey: 'GSSD-1234' } }
        : undefined,
    );

    assert.deepEqual(
      await makeClient().upload(VOUCHER, file, 'application/gzip'),
      {
        ticketKey: 'GSSD-1234',
        size: 500,
        verified: false,
      },
    );
  });

  it('maps a refusal while the upload is created, without anything to abort', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path === '/support/log-uploads'
        ? { status: 410, body: errorBody('voucher_expired') }
        : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(error.code, 'voucher_expired');
    assert.equal(portal.calls(/\/abort$/).length, 0);
  });

  it('maps a refusal while the upload is completed, and aborts', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path.endsWith('/complete')
        ? { status: 413, body: errorBody('file_too_large', { maxBytes: 99 }) }
        : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(error.code, 'file_too_large');
    assert.equal(error.maxBytes, 99);
    assert.equal(portal.calls(/\/abort$/).length, 1);
  });

  it('never lets a failing abort hide the real failure', async () => {
    const { file } = makeFile(500);
    portal.intercept(request => {
      if (request.method === 'PUT') {
        return { status: 400 };
      }
      return request.path.endsWith('/abort')
        ? { status: 500, destroy: true }
        : undefined;
    });

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.match(error.message, /storage refused/);
    assert.ok(
      logged.some(
        entry => entry.level === 'warn' && /Could not abort/.test(entry.text),
      ),
    );
  });

  it('fails when the portal names no place to send the archive to', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path === '/support/log-uploads'
        ? { status: 200, body: { id: 'up-1', ticketKey: 'GSSD-1234' } }
        : undefined,
    );

    const error = await failureOf(
      makeClient().upload(VOUCHER, file, 'application/gzip'),
    );

    assert.match(error.message, /no place to send/);
    assert.equal(portal.calls(/\/abort$/).length, 1);
  });

  it('fails when the portal gives a part size of zero', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path === '/support/log-uploads'
        ? {
            status: 200,
            body: {
              id: 'up-1',
              ticketKey: 'GSSD-1234',
              multipart: { partSize: 0, parts: [] },
            },
          }
        : undefined,
    );

    assert.match(
      (await failureOf(makeClient().upload(VOUCHER, file, 'application/gzip')))
        .message,
      /part size of 0/,
    );
  });

  it('asks for the links itself when the portal sent only some of them', async () => {
    const { file, content } = makeFile(2 * 4096);
    portal.intercept(request =>
      request.path === '/support/log-uploads'
        ? {
            status: 200,
            body: {
              id: 'up-1',
              ticketKey: 'GSSD-1234',
              multipart: {
                partSize: 4096,
                parts: [
                  {
                    partNumber: 1,
                    url: `${portal.url}/s3/part/1?X-Amz-Signature=secret-signature`,
                  },
                  { partNumber: 2, url: 12 },
                  { nope: true },
                ],
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'x-ignored': 1,
                },
              },
            },
          }
        : undefined,
    );

    const result = await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.equal(result.verified, true);
    assert.deepEqual(
      portal.calls('/support/log-uploads/up-1/links').map(l => l.json),
      [{ partNumbers: [2] }],
    );
    assert.deepEqual(portal.assembled(), content);
  });

  it('sends the headers the portal returned, with its own Content-Length', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.path === '/support/log-uploads'
        ? {
            status: 200,
            body: {
              id: 'up-1',
              ticketKey: 'GSSD-1234',
              single: {
                url: `${portal.url}/s3/single?X-Amz-Signature=secret-signature`,
                headers: {
                  'x-amz-meta-ticket': 'GSSD-1234',
                  'content-length': '1',
                },
              },
            },
          }
        : undefined,
    );

    await makeClient().upload(VOUCHER, file, 'application/gzip');

    const put = portal.calls('/s3/single')[0];
    assert.equal(put.headers['x-amz-meta-ticket'], 'GSSD-1234');
    assert.equal(put.headers['content-length'], '500');
    assert.equal(put.headers['content-type'], 'application/octet-stream');
  });

  it('never logs the voucher or a presigned query string', async () => {
    const { file } = makeFile(2 * 4096);
    let puts = 0;
    portal.intercept(request => {
      if (request.method === 'PUT') {
        puts += 1;
        return [{ status: 500 }, s3Expired][puts - 1];
      }
      return undefined;
    });

    await makeClient().upload(VOUCHER, file, 'application/gzip');

    assert.ok(logged.length > 0);
    logged.forEach(entry => {
      assert.equal(entry.text.includes(VOUCHER), false, entry.text);
      assert.equal(entry.text.includes('secret-signature'), false, entry.text);
    });
  });

  it('works without a logger', async () => {
    const { file } = makeFile(500);
    portal.intercept(request =>
      request.method === 'PUT' ? { status: 500 } : undefined,
    );
    const quiet = createSupportPortalClient({
      baseUrl: portal.url,
      backoffMs: 1,
    });

    const error = await failureOf(
      quiet.upload(VOUCHER, file, 'application/gzip'),
    );

    assert.equal(error.code, 'portal_unreachable');
  });
});

describe('proxy', () => {
  it('asks the proxy-aware agent for the API and for every S3 PUT', async () => {
    const asked: string[] = [];
    const stubbed = loadWithStubs<typeof import('./supportPortalUpload')>(
      path.resolve(__dirname, './supportPortalUpload'),
      {
        [path.resolve(__dirname, '../../../utils/axiosWithRetry')]: {
          getHttpsAgentFor: (url: string) => {
            asked.push(url);
            return undefined;
          },
        },
      },
    );
    const { file } = makeFile(500);

    await stubbed
      .createSupportPortalClient({ baseUrl: portal.url, version: '1.0.0' })
      .upload(VOUCHER, file, 'application/gzip');

    assert.ok(
      asked.some(url => url === `${portal.url}/support/log-uploads/check`),
    );
    assert.ok(asked.some(url => url.startsWith(`${portal.url}/s3/single?`)));
    assert.ok(asked.some(url => url.endsWith('/complete')));
  });
});

describe('SupportPortalError', () => {
  it('carries the details a caller adds', () => {
    const error = createSupportPortalError('too big', {
      code: 'file_too_large',
      httpStatus: 400,
      maxBytes: 7,
      details: 'kept at /x',
    });

    assert.equal(error.details, 'kept at /x');
    assert.equal(error.maxBytes, 7);
    assert.equal(error.message, 'too big');
  });
});
