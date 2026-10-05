import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AxiosError, AxiosHeaders } from 'axios';

import {
  classifyProbeError,
  detectOrigin,
  normalizeHeaders,
} from './classifyProbeError';

const withCode = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const httpError = (
  status: number,
  headers: Record<string, string> = {},
): AxiosError =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    {
      status,
      data: '',
      statusText: '',
      headers: new AxiosHeaders(headers),
      config: { headers: new AxiosHeaders() },
    },
  );

// Codes and messages below were captured from Conductor's real axios helper
// against local servers and fake proxies (see the connectivity smoke run).
describe('classifyProbeError', () => {
  const cases: ReadonlyArray<readonly [string, Error, string]> = [
    [
      'DNS failure',
      withCode('ENOTFOUND', 'getaddrinfo ENOTFOUND does-not-exist.invalid'),
      'dns',
    ],
    [
      'DNS temporary failure',
      withCode('EAI_AGAIN', 'getaddrinfo EAI_AGAIN x'),
      'dns',
    ],
    [
      'connection refused',
      withCode('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1'),
      'refused',
    ],
    [
      'axios timeout',
      withCode('ECONNABORTED', 'timeout of 800ms exceeded'),
      'timeout',
    ],
    [
      'socket timeout',
      withCode('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:443'),
      'timeout',
    ],
    [
      'aborted by the hard deadline',
      withCode('ERR_CANCELED', 'canceled'),
      'timeout',
    ],
    ['connection reset', withCode('ECONNRESET', 'socket hang up'), 'reset'],
    [
      'self-signed certificate',
      withCode('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'),
      'tls',
    ],
    [
      'untrusted corporate CA',
      withCode(
        'SELF_SIGNED_CERT_IN_CHAIN',
        'self-signed certificate in certificate chain',
      ),
      'tls',
    ],
    [
      'unknown issuer',
      withCode(
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'unable to verify the first certificate',
      ),
      'tls',
    ],
    [
      'expired certificate',
      withCode('CERT_HAS_EXPIRED', 'certificate has expired'),
      'tls',
    ],
    [
      'TLS error with an unlisted code',
      withCode('ERR_SOMETHING', 'unable to get local issuer certificate'),
      'tls',
    ],
    ['anything else', withCode('EWEIRD', 'boom'), 'other'],
  ];

  cases.forEach(([name, error, expectedKind]) => {
    it(`classifies ${name} as ${expectedKind}`, () => {
      const failure = classifyProbeError(error);

      assert.equal(failure.kind, expectedKind);
      assert.equal(failure.httpStatus, undefined);
    });
  });

  it('treats a proxy answering 407 to CONNECT as proxy-auth with a status', () => {
    const failure = classifyProbeError(httpError(407));

    assert.equal(failure.kind, 'proxy-auth');
    assert.equal(failure.httpStatus, 407);
  });

  it('keeps the status of a proxy 503 and does not call it a network error', () => {
    const failure = classifyProbeError(httpError(503));

    assert.equal(failure.httpStatus, 503);
    assert.equal(failure.kind, undefined);
  });

  it('never leaks proxy credentials echoed in a message', () => {
    const failure = classifyProbeError(
      new Error('tunnel failed via http://alice:S3CR3T@proxy.corp:3128'),
    );

    assert.ok(!failure.message.includes('S3CR3T'));
  });
});

describe('response origin', () => {
  it('lower-cases header names and flattens AxiosHeaders', () => {
    const headers = normalizeHeaders(
      new AxiosHeaders({ 'X-Amz-Cf-Id': 'abc', 'Content-Length': 12 }),
    );

    assert.deepEqual(headers, { 'x-amz-cf-id': 'abc', 'content-length': '12' });
  });

  it('recognises MOLO17 edge headers on a relayed response', () => {
    assert.equal(detectOrigin({ 'x-amz-cf-id': 'abc' }), 'molo17');
    assert.equal(detectOrigin({ 'x-amzn-requestid': 'abc' }), 'molo17');
    assert.equal(detectOrigin({ 'x-amz-apigw-id': 'abc' }), 'molo17');
  });

  it('treats a response without them as coming from an intermediary', () => {
    assert.equal(detectOrigin({ server: 'squid/5.7' }), 'intermediary');
    assert.equal(detectOrigin({}), 'intermediary');
  });

  it('reads the origin from the headers of an error response', () => {
    const fromProxy = classifyProbeError(httpError(503, { server: 'squid' }));
    const fromMolo17 = classifyProbeError(
      httpError(503, { 'x-amz-cf-id': 'abc' }),
    );

    assert.equal(detectOrigin(fromProxy.headers), 'intermediary');
    assert.equal(detectOrigin(fromMolo17.headers), 'molo17');
  });
});
