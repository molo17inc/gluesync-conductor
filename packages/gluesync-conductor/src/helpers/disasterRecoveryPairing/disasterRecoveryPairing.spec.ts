import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PAIRING_CODE_PREFIX,
  buildPairingPayload,
  rebuildPairingPayload,
  decodePairingCode,
  encodePairingCode,
  generateSecret,
  validateFirstSiteRequest,
} from './disasterRecoveryPairing';
import { PairingCodeError } from './disasterRecoveryPairing.errors';
import type { PairingPayload } from './disasterRecoveryPairing.model';

const SECRET = 'q8Zr0yKc-mP3v_XtN2bHsLw9aUeD5fGjR7oIiYkTnVA';

const payload: PairingPayload = {
  v: 1,
  secret: SECRET,
  failoverMode: 'manual',
  witnessUrl: null,
  leaseTtlSeconds: 30,
  first: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
  joiner: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
};

const encodeRaw = (value: unknown): string =>
  `${PAIRING_CODE_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

const rejects = (code: unknown, message?: RegExp): void => {
  assert.throws(
    () => decodePairingCode(code),
    (error: unknown) =>
      error instanceof PairingCodeError &&
      (message === undefined || message.test(error.message)),
  );
};

describe('generateSecret', () => {
  it('is 32 random bytes in base64url, different every time', () => {
    const first = generateSecret();

    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, generateSecret());
  });
});

describe('pairing code', () => {
  it('is GSDR1. followed by the base64url of the JSON payload', () => {
    const code = encodePairingCode(payload);

    assert.ok(code.startsWith('GSDR1.'));
    assert.match(code, /^GSDR1\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(
      JSON.parse(
        Buffer.from(code.slice('GSDR1.'.length), 'base64url').toString(),
      ),
      payload,
    );
  });

  it('decodes what it encodes', () => {
    assert.deepEqual(decodePairingCode(encodePairingCode(payload)), payload);
  });

  it('carries a witness and its lease', () => {
    const witness: PairingPayload = {
      ...payload,
      failoverMode: 'witness',
      witnessUrl: 'https://witness.example.com:8443/lease',
      leaseTtlSeconds: 45,
    };

    assert.deepEqual(decodePairingCode(encodePairingCode(witness)), witness);
  });

  it('refuses what is not a string or does not start with GSDR', () => {
    [undefined, null, 42, {}, '', 'hello', 'Bearer abc'].forEach(code =>
      rejects(code, /not valid/),
    );
  });

  it('refuses another version of the format', () => {
    rejects('GSDR2.abcdef', /version/);
    rejects(encodeRaw({ ...payload, v: 2 }), /version/);
    rejects(encodeRaw({ ...payload, v: undefined }), /version/);
  });

  it('refuses a body that is not base64url or not JSON', () => {
    rejects('GSDR1.', /not valid/);
    rejects('GSDR1.@@@@', /not valid/);
    rejects(`GSDR1.${Buffer.from('not json').toString('base64url')}`);
    rejects(encodeRaw('just a string'));
    rejects(encodeRaw([payload]));
  });

  it('refuses a payload a Core Hub would not start with', () => {
    const bad: ReadonlyArray<unknown> = [
      { ...payload, secret: 'short' },
      { ...payload, secret: `${SECRET}\nGS_DR_ENABLED=false` },
      { ...payload, secret: 42 },
      { ...payload, failoverMode: 'automatic' },
      { ...payload, failoverMode: 'witness', witnessUrl: null },
      { ...payload, leaseTtlSeconds: 5 },
      { ...payload, first: undefined },
      { ...payload, joiner: { nodeId: 'Site B', url: payload.joiner.url } },
      { ...payload, joiner: { nodeId: 'site-b', url: 'ftp://10.0.0.2:1717' } },
      { ...payload, joiner: { nodeId: 'site-a', url: 'http://10.0.0.2:1717' } },
    ];

    bad.forEach(value => rejects(encodeRaw(value), /not valid/));
  });
});

describe('validateFirstSiteRequest', () => {
  const request = {
    thisSite: { nodeId: 'site-a', url: 'http://10.0.0.1:1717' },
    peerSite: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
    failoverMode: 'manual',
  };

  const problems = (value: unknown): ReadonlyArray<string> => {
    const result = validateFirstSiteRequest(value);

    return result.valid ? [] : result.problems;
  };

  it('accepts a manual pair and fills in the lease', () => {
    assert.deepEqual(validateFirstSiteRequest(request), {
      valid: true,
      value: { ...request, witnessUrl: null, leaseTtlSeconds: 30 },
    });
  });

  it('accepts a witness with its lease', () => {
    const result = validateFirstSiteRequest({
      ...request,
      failoverMode: 'witness',
      witnessUrl: 'https://witness.example.com',
      leaseTtlSeconds: 20,
    });

    assert.deepEqual(result, {
      valid: true,
      value: {
        ...request,
        failoverMode: 'witness',
        witnessUrl: 'https://witness.example.com',
        leaseTtlSeconds: 20,
      },
    });
  });

  it('writes a site url as Core Hub reads it: lower case, no trailing slash', () => {
    const result = validateFirstSiteRequest({
      ...request,
      thisSite: { nodeId: 'site-a', url: ' HTTPS://Hub-A.Example.com:1717/ ' },
    });

    assert.ok(result.valid);
    assert.equal(result.value.thisSite.url, 'https://hub-a.example.com:1717');
  });

  it('wants a node id of 1 to 32 characters, lower case, digits and dashes', () => {
    ['', 'Site-A', '-a', 'a_b', 'a.b', 'a'.repeat(33), 42, undefined].forEach(
      nodeId =>
        assert.ok(
          problems({ ...request, thisSite: { ...request.thisSite, nodeId } })
            .join()
            .includes('thisSite.nodeId'),
          String(nodeId),
        ),
    );
    ['a', '0', 'site-a', 'a'.repeat(32)].forEach(nodeId =>
      assert.deepEqual(
        problems({ ...request, thisSite: { ...request.thisSite, nodeId } }),
        [],
      ),
    );
  });

  it('wants distinct node ids and distinct urls', () => {
    assert.deepEqual(
      problems({
        ...request,
        peerSite: { ...request.peerSite, nodeId: 'site-a' },
      }),
      ['thisSite.nodeId and peerSite.nodeId must be different'],
    );
    assert.deepEqual(
      problems({
        ...request,
        peerSite: { ...request.peerSite, url: 'http://10.0.0.1:1717/' },
      }),
      ['thisSite.url and peerSite.url must be different'],
    );
  });

  it('wants an http(s) url with a host and a port and nothing else', () => {
    [
      '10.0.0.1:1717',
      'http://10.0.0.1',
      'http://10.0.0.1:0',
      'http://10.0.0.1:70000',
      'http://10.0.0.1:1717/path',
      'http://10.0.0.1:1717?x=1',
      'http://user@10.0.0.1:1717',
      'ftp://10.0.0.1:1717',
      'http://:1717',
      '',
    ].forEach(url =>
      assert.ok(
        problems({ ...request, peerSite: { ...request.peerSite, url } })
          .join()
          .includes('peerSite.url'),
        url,
      ),
    );
    [
      'http://hub-b:1717',
      'https://[::1]:1717',
      'http://10.0.0.2:65535',
    ].forEach(url =>
      assert.deepEqual(
        problems({ ...request, peerSite: { ...request.peerSite, url } }),
        [],
        url,
      ),
    );
  });

  it('takes a host, an IPv6 address and a witness path in any case, and nothing outside the character sets', () => {
    const peerProblems = (url: string): ReadonlyArray<string> =>
      problems({ ...request, peerSite: { ...request.peerSite, url } });
    const witnessProblems = (witnessUrl: string): ReadonlyArray<string> =>
      problems({ ...request, failoverMode: 'witness', witnessUrl });

    [
      'HTTP://HUB-B.EXAMPLE.COM:1717',
      'http://Hub-B.Example.com:1717/',
      'http://A:1717',
      'http://9:1717',
      'http://a-b.C-d:1717',
      'http://[FE80::ABCD:ef01]:1717',
      'http://[::FFFF:10.0.0.2]:1717',
    ].forEach(url => assert.deepEqual(peerProblems(url), [], url));
    [
      'http://-a:1717',
      'http://a-:1717',
      'http://.a:1717',
      'http://a.:1717',
      'http://a_b:1717',
      'http://a b:1717',
      'http://hüb:1717',
      'http://[G::1]:1717',
      'http://[::1:1717',
      'http://::1]:1717',
      'http://[]:1717',
    ].forEach(url =>
      assert.ok(peerProblems(url).length > 0, `${url} is refused`),
    );

    [
      'HTTPS://Witness.Example.com',
      'https://witness.example.com:8443',
      'https://WITNESS.example.com:8443/Path/To_It-1.0~x%2F+=&?a,b:c@d',
      'https://[FE80::1]/W',
      'https://w/',
    ].forEach(url => assert.deepEqual(witnessProblems(url), [], url));
    [
      'https://w/a b',
      "https://w/a'b",
      'https://w/a"b',
      'https://w/a$b',
      'https://w/a\\b',
      'https://w/a#b',
      'https://w/ä',
      'https://w:0',
      'https://w:65536',
      'https://w path',
      'https://user@w/',
      'https://w?x=1',
    ].forEach(url =>
      assert.ok(witnessProblems(url).length > 0, `${url} is refused`),
    );
  });

  it('knows exactly two failover modes', () => {
    ['manual', 'witness'].forEach(failoverMode =>
      assert.ok(
        !problems({
          ...request,
          failoverMode,
          witnessUrl:
            failoverMode === 'witness' ? 'https://witness.example.com' : null,
        })
          .join()
          .includes('failoverMode'),
      ),
    );
    [
      'Manual',
      'WITNESS',
      ' manual',
      'constructor',
      'toString',
      '',
      1,
      null,
    ].forEach(failoverMode =>
      assert.deepEqual(problems({ ...request, failoverMode }), [
        'failoverMode must be "manual" or "witness"',
      ]),
    );
  });

  it('needs a witness url exactly with the witness mode', () => {
    assert.deepEqual(problems({ ...request, failoverMode: 'witness' }), [
      'witnessUrl is required with failoverMode "witness" and must be an http:// or https:// URL with a host and, if it has a port, one from 1 to 65535 (for example http://10.0.0.3:1719)',
    ]);
    assert.ok(
      problems({
        ...request,
        failoverMode: 'witness',
        witnessUrl: 'ftp://witness',
      }).length > 0,
    );
    assert.deepEqual(
      problems({ ...request, witnessUrl: 'https://witness.example.com' }),
      ['witnessUrl is only accepted with failoverMode "witness"'],
    );
  });

  it('keeps the lease between 20 and 600 seconds', () => {
    const witness = {
      ...request,
      failoverMode: 'witness',
      witnessUrl: 'https://witness.example.com',
    };

    [19, 601, 30.5, '30', -1].forEach(leaseTtlSeconds =>
      assert.ok(
        problems({ ...witness, leaseTtlSeconds })
          .join()
          .includes('leaseTtlSeconds'),
        String(leaseTtlSeconds),
      ),
    );
    [20, 30, 600].forEach(leaseTtlSeconds =>
      assert.deepEqual(problems({ ...witness, leaseTtlSeconds }), []),
    );
  });

  it('refuses an unknown mode and a body that is not an object, reporting every problem', () => {
    assert.deepEqual(problems({ ...request, failoverMode: 'auto' }), [
      'failoverMode must be "manual" or "witness"',
    ]);
    assert.deepEqual(problems(null), ['the body must be an object']);
    assert.ok(problems({}).length >= 3);
  });
});

describe('rebuildPairingPayload', () => {
  const request = (extra: object = {}) => {
    const checked = validateFirstSiteRequest({
      thisSite: { nodeId: 'site-a', url: 'HTTP://10.0.0.1:1717/' },
      peerSite: { nodeId: 'site-b', url: 'http://10.0.0.2:1717' },
      failoverMode: 'manual',
      ...extra,
    });

    assert.ok(checked.valid);
    return checked.value;
  };

  // What the first site writes to its env file, as parseEnvFile reads it
  const fileOf = (
    value: ReturnType<typeof request>,
    secret: string,
  ): Record<string, string> => ({
    GS_DR_NODE_ID: value.thisSite.nodeId,
    GS_DR_PEER_URL: value.peerSite.url,
    GS_DR_FAILOVER_MODE: value.failoverMode,
    ...(value.witnessUrl ? { GS_DR_WITNESS_URL: value.witnessUrl } : {}),
    GS_DR_SHARED_SECRET: secret,
    GS_DR_PAIRING_FIRST_URL: value.thisSite.url,
    GS_DR_PAIRING_JOINER_NODE_ID: value.peerSite.nodeId,
    GS_DR_PAIRING_LEASE_TTL_SECONDS: String(value.leaseTtlSeconds),
  });

  const rebuilt = (variables: Record<string, string>) => {
    const result = rebuildPairingPayload(variables);

    assert.ok(result.ok);
    return result.payload;
  };

  it('gives the payload the setup handed out, field for field and in the same order', () => {
    [
      request(),
      request({ leaseTtlSeconds: 90 }),
      request({
        failoverMode: 'witness',
        witnessUrl: 'https://witness.example.com:8443/lease',
        leaseTtlSeconds: 45,
      }),
    ].forEach(value => {
      const original = buildPairingPayload(SECRET, value);

      assert.equal(
        encodePairingCode(rebuilt(fileOf(value, SECRET))),
        encodePairingCode(original),
      );
      assert.deepEqual(
        decodePairingCode(encodePairingCode(original)),
        original,
      );
    });
  });

  it('names every variable the file lacks, so a joiner file or an older setup is told apart', () => {
    const result = rebuildPairingPayload({
      GS_DR_NODE_ID: 'site-b',
      GS_DR_PEER_URL: 'http://10.0.0.1:1717',
      GS_DR_FAILOVER_MODE: 'witness',
      GS_DR_SHARED_SECRET: SECRET,
    });

    assert.ok(!result.ok);
    assert.deepEqual(result.missing, [
      'GS_DR_PAIRING_FIRST_URL',
      'GS_DR_PAIRING_JOINER_NODE_ID',
      'GS_DR_PAIRING_LEASE_TTL_SECONDS',
      'GS_DR_WITNESS_URL',
    ]);
  });

  it('refuses what a first-site request would refuse, without echoing a value', () => {
    const file = fileOf(request(), SECRET);
    const bad = [
      { ...file, GS_DR_NODE_ID: 'Not Valid' },
      { ...file, GS_DR_PAIRING_LEASE_TTL_SECONDS: '5' },
      { ...file, GS_DR_PAIRING_JOINER_NODE_ID: 'site-a' },
      { ...file, GS_DR_SHARED_SECRET: 'short secret' },
    ].map(rebuildPairingPayload);

    bad.forEach(result => {
      assert.ok(!result.ok);
      assert.deepEqual(result.missing, []);
      assert.ok(result.problems.length > 0);
      assert.ok(
        !JSON.stringify(result).includes(SECRET) &&
          !JSON.stringify(result).includes('short secret'),
      );
    });
  });
});
