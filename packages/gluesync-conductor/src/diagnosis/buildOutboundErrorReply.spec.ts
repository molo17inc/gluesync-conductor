import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AxiosError, AxiosHeaders, InternalAxiosRequestConfig } from 'axios';

import buildDiagnosis from './buildDiagnosis';
import buildOutboundErrorReply, {
  isMolo17OutboundError,
} from './buildOutboundErrorReply';
import { DiagnosisCode } from './diagnosis.model';
import { ProbeResult } from './probes/probe.model';
import { RunConnectivityCheck } from './runConnectivityCheck';

const BACKOFFICE_URL =
  'https://api.backoffice.molo17.com/agent/conductor/version';

const configFor = (url: string): InternalAxiosRequestConfig =>
  ({ url, headers: new AxiosHeaders() }) as InternalAxiosRequestConfig;

const httpFailure = (
  url: string,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): AxiosError =>
  new AxiosError(
    `Request failed with status code ${status}`,
    'ERR_BAD_RESPONSE',
    configFor(url),
    undefined,
    {
      status,
      data,
      statusText: '',
      headers: new AxiosHeaders(headers),
      config: configFor(url),
    },
  );

const networkFailure = (
  url: string,
  code: string,
  message: string,
): AxiosError => new AxiosError(message, code, configFor(url));

// A fake check that records the trigger it was given and answers with a code.
const fakeCheck = (
  code: DiagnosisCode,
): Readonly<{ run: RunConnectivityCheck; triggers: ProbeResult[] }> => {
  const triggers: ProbeResult[] = [];

  return {
    triggers,
    run: async options => {
      if (options?.trigger) {
        // eslint-disable-next-line functional/immutable-data
        triggers.push(options.trigger);
      }
      return buildDiagnosis({ code });
    },
  };
};

describe('isMolo17OutboundError', () => {
  it('accepts a failed request to the backoffice', () => {
    assert.equal(
      isMolo17OutboundError(networkFailure(BACKOFFICE_URL, 'ETIMEDOUT', 'x')),
      true,
    );
  });

  it('rejects an axios error from anywhere else, such as Core Hub', () => {
    assert.equal(
      isMolo17OutboundError(
        networkFailure('https://corehub.local/api/x', 'ETIMEDOUT', 'x'),
      ),
      false,
    );
  });

  it('rejects errors that are not axios errors', () => {
    assert.equal(isMolo17OutboundError(new Error('boom')), false);
    assert.equal(isMolo17OutboundError(undefined), false);
  });
});

describe('buildOutboundErrorReply', () => {
  it('replies 503 with the diagnosis when MOLO17 is the one that is down', async () => {
    const check = fakeCheck('OTA_SERVICE_DOWN');
    const reply = await buildOutboundErrorReply(
      httpFailure(
        BACKOFFICE_URL,
        503,
        { message: 'Service Unavailable' },
        { 'x-amz-cf-id': 'abc' },
      ),
      { runConnectivityCheck: check.run },
    );

    assert.equal(reply?.statusCode, 503);
    assert.equal(reply?.body.success, false);
    assert.equal(reply?.body.diagnosis.code, 'OTA_SERVICE_DOWN');
    assert.equal(reply?.body.error, reply?.body.diagnosis.fallback.title);
    assert.equal(check.triggers[0].origin, 'molo17');
    assert.equal(check.triggers[0].httpStatus, 503);
  });

  it('replies 502, not the upstream status, when the customer side is at fault', async () => {
    const reply = await buildOutboundErrorReply(
      httpFailure(BACKOFFICE_URL, 503, '', {}),
      {
        runConnectivityCheck: fakeCheck('UNEXPECTED_RESPONSE_FROM_INTERMEDIARY')
          .run,
      },
    );

    assert.equal(reply?.statusCode, 502);
  });

  it('hands the sieve the real response, marking a 503 without MOLO17 headers as an intermediary', async () => {
    const check = fakeCheck('UNEXPECTED_RESPONSE_FROM_INTERMEDIARY');

    await buildOutboundErrorReply(
      httpFailure(BACKOFFICE_URL, 503, '<html>proxy says no</html>', {
        server: 'squid',
      }),
      { runConnectivityCheck: check.run },
    );

    assert.equal(check.triggers[0].origin, 'intermediary');
    assert.equal(check.triggers[0].reachable, true);
  });

  it('turns a 407 from a proxy into a 502 instead of forwarding the 407 to the browser', async () => {
    const reply = await buildOutboundErrorReply(
      httpFailure(BACKOFFICE_URL, 407, ''),
      { runConnectivityCheck: fakeCheck('PROXY_AUTH_REQUIRED').run },
    );

    assert.equal(reply?.statusCode, 502);
  });

  it('classifies a transport failure as unreachable', async () => {
    const check = fakeCheck('NO_INTERNET');

    await buildOutboundErrorReply(
      networkFailure(
        BACKOFFICE_URL,
        'ENOTFOUND',
        'getaddrinfo ENOTFOUND api.backoffice.molo17.com',
      ),
      { runConnectivityCheck: check.run },
    );

    assert.equal(check.triggers[0].reachable, false);
    assert.equal(check.triggers[0].errorKind, 'dns');
    assert.equal(check.triggers[0].origin, undefined);
  });

  it('never puts proxy credentials in details', async () => {
    const reply = await buildOutboundErrorReply(
      networkFailure(
        BACKOFFICE_URL,
        'ECONNREFUSED',
        'tunnel failed via http://alice:S3CR3T@proxy.corp:3128',
      ),
      { runConnectivityCheck: fakeCheck('PROXY_UNREACHABLE').run },
    );

    assert.ok(!JSON.stringify(reply).includes('S3CR3T'));
  });

  it('leaves errors that are not ours to the caller', async () => {
    const deps = { runConnectivityCheck: fakeCheck('UNKNOWN').run };

    assert.equal(
      await buildOutboundErrorReply(
        networkFailure('https://corehub.local/x', 'ETIMEDOUT', 'x'),
        deps,
      ),
      undefined,
    );
    assert.equal(
      await buildOutboundErrorReply(new Error('boom'), deps),
      undefined,
    );
  });

  it('falls back to the caller when the diagnosis itself fails', async () => {
    const reply = await buildOutboundErrorReply(
      networkFailure(BACKOFFICE_URL, 'ETIMEDOUT', 'x'),
      {
        runConnectivityCheck: async () => {
          throw new Error('probe machinery broke');
        },
      },
    );

    assert.equal(reply, undefined);
  });

  it('never answers a failed request with a 2xx', async () => {
    const reply = await buildOutboundErrorReply(
      networkFailure(BACKOFFICE_URL, 'ETIMEDOUT', 'x'),
      { runConnectivityCheck: fakeCheck('CONNECTIVITY_OK').run },
    );

    assert.equal(reply?.statusCode, 502);
  });
});
