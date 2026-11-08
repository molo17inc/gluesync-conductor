/* eslint-disable functional/immutable-data, functional/no-let, functional/prefer-immutable-types -- recorders and fake answers for the test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';

import {
  WITNESS_PROBE_TIMEOUT_MS,
  probeWitness,
  witnessJoinRefusal,
  witnessWarnings,
} from './disasterRecoveryWitness';
import type { WitnessProbeDeps } from './disasterRecoveryWitness.model';

const URL = 'https://witness.example.com:1719';
const SECRET = 'q8Zr0yKc-mP3v_XtN2bHsLw9aUeD5fGjR7oIiYkTnVA';
const NONCE = 'ab'.repeat(16);
const HEALTH = JSON.stringify({
  status: 'up',
  role: 'WITNESS',
  epoch: 3,
  holder: 'site-a',
});

type Answer = Readonly<{ status: number; data?: unknown }> | Error;

// The answers in order; the last one repeats. Never touches the network.
const fake = (...answers: ReadonlyArray<Answer>) => {
  const requests: AxiosRequestConfig[] = [];
  const deps: WitnessProbeDeps = {
    request: async config => {
      requests.push(config);
      const answer = answers[Math.min(requests.length, answers.length) - 1];

      if (answer instanceof Error) {
        throw answer;
      }

      return {
        status: answer.status,
        data: answer.data ?? '',
      } as AxiosResponse;
    },
    nowSeconds: () => 1_700_000_000,
    nonce: () => NONCE,
  };

  return { requests, deps };
};

const credentials = { nodeId: 'site-b', secret: SECRET };

describe('probeWitness', () => {
  it('reads the open /health with a short timeout, no signature, and accepts a self-signed certificate', async () => {
    const { requests, deps } = fake({ status: 200, data: HEALTH });

    assert.deepEqual(await probeWitness(URL, undefined, deps), {
      kind: 'answers',
    });
    assert.equal(requests.length, 1);

    const [request] = requests;

    assert.equal(request.url, `${URL}/health`);
    assert.equal(request.method, 'GET');
    assert.equal(request.timeout, WITNESS_PROBE_TIMEOUT_MS);
    assert.equal(WITNESS_PROBE_TIMEOUT_MS, 3000);
    assert.deepEqual(request.headers, {});
    assert.equal(request.proxy, false);
    assert.equal(request.maxRedirects, 0);
    assert.equal(
      (request.httpsAgent as { options: { rejectUnauthorized: boolean } })
        .options.rejectUnauthorized,
      false,
    );
  });

  it('takes the role whatever its case, and a url with a path or a trailing slash', async () => {
    const { requests, deps } = fake({
      status: 200,
      data: JSON.stringify({ role: 'witness' }),
    });

    assert.deepEqual(
      await probeWitness('http://10.0.0.3:1719/witness/', undefined, deps),
      { kind: 'answers' },
    );
    assert.equal(requests[0].url, 'http://10.0.0.3:1719/witness/health');
  });

  it('is unreachable when nothing answers, with the code of the failure', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      isAxiosError: true,
      code: 'ECONNREFUSED',
    });
    const { deps } = fake(refused);

    assert.deepEqual(await probeWitness(URL, credentials, deps), {
      kind: 'unreachable',
      reason: 'ECONNREFUSED',
    });
    assert.deepEqual(
      await probeWitness(URL, credentials, fake(new Error('boom')).deps),
      {
        kind: 'unreachable',
        reason: 'boom',
      },
    );
  });

  it('says what happened instead of the code of axios: a timeout, a body over the cap', async () => {
    const failure = (code: string): Error =>
      Object.assign(new Error(`axios ${code}`), {
        isAxiosError: true,
        code,
      });
    const reasons = await Promise.all(
      ['ECONNABORTED', 'ETIMEDOUT', 'ERR_CANCELED', 'ERR_BAD_RESPONSE'].map(
        async code => probeWitness(URL, undefined, fake(failure(code)).deps),
      ),
    );

    assert.deepEqual(reasons, [
      { kind: 'unreachable', reason: 'no answer within 3 s' },
      { kind: 'unreachable', reason: 'no answer within 3 s' },
      { kind: 'unreachable', reason: 'no answer within 3 s' },
      {
        kind: 'unreachable',
        reason: 'answered something that is not a witness',
      },
    ]);
  });

  it('is unreachable when /health does not answer 200, and signs nothing then', async () => {
    const { requests, deps } = fake({ status: 502 });

    assert.deepEqual(await probeWitness(URL, credentials, deps), {
      kind: 'unreachable',
      reason: 'answered 502',
    });
    assert.equal(requests.length, 1);
  });

  it('is not a witness when it answers another role, or no role, or no JSON', async () => {
    const other = fake({ status: 200, data: JSON.stringify({ role: 'NODE' }) });
    const empty = fake({ status: 200, data: '{}' });
    const html = fake({ status: 200, data: '<html>ok</html>' });

    assert.deepEqual(await probeWitness(URL, credentials, other.deps), {
      kind: 'not-a-witness',
      role: 'NODE',
    });
    assert.deepEqual(await probeWitness(URL, undefined, empty.deps), {
      kind: 'not-a-witness',
      role: null,
    });
    assert.deepEqual(await probeWitness(URL, undefined, html.deps), {
      kind: 'not-a-witness',
      role: null,
    });
    // the secret is never sent to something that is not the witness
    assert.equal(other.requests.length, 1);
  });

  it('proves the shared secret with a signed read of the lease, signed as DrHmac.kt does', async () => {
    const { requests, deps } = fake(
      { status: 200, data: HEALTH },
      { status: 200, data: '{"epoch":3}' },
    );

    assert.deepEqual(await probeWitness(URL, credentials, deps), {
      kind: 'answers',
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, `${URL}/dr/lease`);
    assert.equal(requests[1].method, 'GET');
    // <epochSeconds>.<nodeId>.<nonce>.<HMAC-SHA256 hex of "request\n<ts>\n<node>\n<nonce>\nGET\n/dr/lease\n<sha256 of an empty body>">
    assert.deepEqual(requests[1].headers, {
      'X-GS-DR-Auth': `1700000000.site-b.${NONCE}.59dbfbbf73e47c513c07ea4444d242982d4ac84bee6526bf35d018ec2318aab1`,
    });
  });

  it('signs the path the witness sees, the one of its url included', async () => {
    const { requests, deps } = fake(
      { status: 200, data: HEALTH },
      { status: 200 },
    );

    await probeWitness(
      'https://witness.example.com:1719/witness/',
      credentials,
      deps,
    );

    assert.equal(
      requests[1].url,
      'https://witness.example.com:1719/witness/dr/lease',
    );
    assert.deepEqual(requests[1].headers, {
      'X-GS-DR-Auth': `1700000000.site-b.${NONCE}.27f61e897f3b23332c256a6afeff4d1a064511b7889359717f9faa39cf5440c6`,
    });
  });

  it('is rejected when the witness answers 401 or 403 to the signature', async () => {
    await Promise.all(
      [401, 403].map(async status => {
        const { deps } = fake({ status: 200, data: HEALTH }, { status });

        assert.deepEqual(await probeWitness(URL, credentials, deps), {
          kind: 'rejected',
        });
      }),
    );
  });

  it('takes /health as enough when the witness has no signed read or fails on it', async () => {
    await Promise.all(
      [404, 500].map(async status => {
        const { deps } = fake({ status: 200, data: HEALTH }, { status });

        assert.deepEqual(await probeWitness(URL, credentials, deps), {
          kind: 'answers',
        });
      }),
    );
  });

  it('is unreachable when the signed read does not answer', async () => {
    const { deps } = fake(
      { status: 200, data: HEALTH },
      new Error('ETIMEDOUT'),
    );

    assert.deepEqual(await probeWitness(URL, credentials, deps), {
      kind: 'unreachable',
      reason: 'ETIMEDOUT',
    });
  });
});

describe('witnessWarnings', () => {
  it('has none when the witness answers', () => {
    assert.deepEqual(witnessWarnings(URL, { kind: 'answers' }), []);
  });

  it('says that the witness does not answer yet, naming the url and gluesync-dr.env', () => {
    const expected = [
      `The witness at ${URL} does not answer yet. This site serves meanwhile; start the witness with the shared secret of gluesync-dr.env before the second site joins: the join is refused while the witness does not answer.`,
    ];

    assert.deepEqual(
      witnessWarnings(URL, { kind: 'unreachable', reason: 'ECONNREFUSED' }),
      expected,
    );
    assert.deepEqual(witnessWarnings(URL, { kind: 'rejected' }), expected);
  });

  it('says when something else than a witness answers', () => {
    const [node] = witnessWarnings(URL, {
      kind: 'not-a-witness',
      role: 'NODE',
    });
    const [unknown] = witnessWarnings(URL, {
      kind: 'not-a-witness',
      role: null,
    });

    assert.match(
      node,
      /answers as a Core Hub with the role "NODE", not as a witness/,
    );
    assert.match(unknown, /answers as something that is not a witness/);
    assert.ok(node.includes(URL));
  });
});

describe('witnessJoinRefusal', () => {
  it('has none when the witness answers', () => {
    assert.equal(witnessJoinRefusal(URL, { kind: 'answers' }, 'site-b'), null);
  });

  it('names the witness url and says it must run with the shared secret of the pair', () => {
    const refusals = [
      witnessJoinRefusal(
        URL,
        { kind: 'unreachable', reason: 'ECONNREFUSED' },
        'site-b',
      ),
      witnessJoinRefusal(URL, { kind: 'rejected' }, 'site-b'),
      witnessJoinRefusal(
        URL,
        { kind: 'not-a-witness', role: 'NODE' },
        'site-b',
      ),
    ];

    refusals.forEach(refusal => {
      assert.ok(refusal);
      assert.ok(refusal.details.includes(URL));
      assert.match(refusal.details, /shared secret of the pair/);
    });
    assert.match(refusals[0]?.details ?? '', /\(ECONNREFUSED\)/);
    assert.match(refusals[1]?.details ?? '', /within 60 seconds/);
    assert.match(
      refusals[1]?.details ?? '',
      /its node id \(GS_DR_NODE_ID\) must differ from the node id of this site, "site-b"/,
    );
  });
});
