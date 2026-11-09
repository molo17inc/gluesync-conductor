/* eslint-disable no-template-curly-in-string -- compose interpolations are plain strings in these specs */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = typeof import('./dockerHubManifest');

type Reply = Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>;

type Request = Readonly<{
  method: 'get' | 'head';
  url: string;
  headers: Record<string, string>;
  agent: unknown;
}>;

const PROXY_AGENT = { proxy: true };

const load = (token: Reply, manifest: Reply | Error) => {
  const requests: Request[] = [];
  const subject = loadWithStubs<Subject>(here('./dockerHubManifest'), {
    axios: {
      default: {
        get: async (
          url: string,
          options: { headers: Record<string, string>; httpsAgent: unknown },
        ) => {
          requests.push({
            method: 'get',
            url,
            headers: options.headers,
            agent: options.httpsAgent,
          });
          return token;
        },
        head: async (
          url: string,
          options: { headers: Record<string, string>; httpsAgent: unknown },
        ) => {
          requests.push({
            method: 'head',
            url,
            headers: options.headers,
            agent: options.httpsAgent,
          });
          if (manifest instanceof Error) {
            throw manifest;
          }
          return manifest;
        },
      },
    },
    [here('../../utils/axiosWithRetry')]: {
      getHttpsAgentFor: () => PROXY_AGENT,
    },
  });
  return { subject, requests };
};

const GOOD_TOKEN: Reply = { status: 200, data: { token: 'T0K3N' } };
const FOUND: Reply = {
  status: 200,
  headers: { 'docker-content-digest': 'sha256:abc' },
};

describe('dockerHubManifest', () => {
  it('asks for an anonymous pull token, then HEADs the manifest of the tag', async () => {
    const { subject, requests } = load(GOOD_TOKEN, FOUND);

    assert.deepEqual(
      await subject.dockerHubManifest('molo17/gluesync-chronos:0.3.2-debian'),
      { digest: 'sha256:abc' },
    );

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^https:\/\/auth\.docker\.io\/token\?/);
    assert.match(requests[0].url, /service=registry\.docker\.io/);
    assert.match(
      decodeURIComponent(requests[0].url),
      /scope=repository:molo17\/gluesync-chronos:pull/,
    );
    assert.equal(requests[1].method, 'head');
    assert.equal(
      requests[1].url,
      'https://registry-1.docker.io/v2/molo17/gluesync-chronos/manifests/0.3.2-debian',
    );
    assert.equal(requests[1].headers.Authorization, 'Bearer T0K3N');
    assert.match(requests[1].headers.Accept, /image\.index\.v1\+json/);
    assert.match(
      requests[1].headers.Accept,
      /distribution\.manifest\.list\.v2\+json/,
    );
  });

  it('goes through the proxy agent of the Conductor for both requests', async () => {
    const { subject, requests } = load(GOOD_TOKEN, FOUND);

    await subject.dockerHubManifest('molo17/x:1');

    assert.deepEqual(
      requests.map(request => request.agent),
      [PROXY_AGENT, PROXY_AGENT],
    );
  });

  it('reads the fully qualified name Podman reports, and an official image', async () => {
    const qualified = load(GOOD_TOKEN, FOUND);
    await qualified.subject.dockerHubManifest('docker.io/molo17/x:2');
    assert.match(qualified.requests[1].url, /\/v2\/molo17\/x\/manifests\/2$/);

    const official = load(GOOD_TOKEN, FOUND);
    await official.subject.dockerHubManifest('docker:cli');
    assert.match(
      official.requests[1].url,
      /\/v2\/library\/docker\/manifests\/cli$/,
    );
  });

  it('takes a digest or a missing tag for the reference', async () => {
    const pinned = load(GOOD_TOKEN, FOUND);
    await pinned.subject.dockerHubManifest('molo17/x:1@sha256:def');
    assert.match(pinned.requests[1].url, /manifests\/sha256:def$/);

    const bare = load(GOOD_TOKEN, FOUND);
    await bare.subject.dockerHubManifest('molo17/x');
    assert.match(bare.requests[1].url, /manifests\/latest$/);
  });

  it('is undefined when Docker Hub has no such tag', async () => {
    const { subject } = load(GOOD_TOKEN, { status: 404 });

    assert.equal(await subject.dockerHubManifest('molo17/x:nope'), undefined);
  });

  it('is undefined, without a request, for an image of another registry or a variable', async () => {
    const { subject, requests } = load(GOOD_TOKEN, FOUND);

    assert.equal(await subject.dockerHubManifest('ghcr.io/org/x:1'), undefined);
    assert.equal(await subject.dockerHubManifest('${REG}/x:1'), undefined);
    assert.equal(requests.length, 0);
  });

  it('rejects when no token is given, or Docker Hub answers something else', async () => {
    await assert.rejects(
      load({ status: 429, data: {} }, FOUND).subject.dockerHubManifest('a/b:1'),
      /pull token/,
    );
    await assert.rejects(
      load(GOOD_TOKEN, { status: 429 }).subject.dockerHubManifest('a/b:1'),
      /HTTP 429/,
    );
    await assert.rejects(
      load(GOOD_TOKEN, { status: 200 }).subject.dockerHubManifest('a/b:1'),
      /HTTP 200/,
    );
    await assert.rejects(
      load(GOOD_TOKEN, new Error('ECONNRESET')).subject.dockerHubManifest(
        'a/b:1',
      ),
      /ECONNRESET/,
    );
  });
});

describe('isDistributionUnavailable', () => {
  const { subject } = load(GOOD_TOKEN, FOUND);

  it('is true for what Podman answers', () => {
    assert.equal(subject.isDistributionUnavailable({ statusCode: 404 }), true);
    assert.equal(subject.isDistributionUnavailable({ statusCode: 501 }), true);
    assert.equal(
      subject.isDistributionUnavailable(
        new Error('(HTTP code 500) server error - not implemented'),
      ),
      true,
    );
    assert.equal(
      subject.isDistributionUnavailable(
        new Error('unexpected - page not found'),
      ),
      true,
    );
  });

  it('is false for a registry answer or a dropped connection', () => {
    assert.equal(subject.isDistributionUnavailable({ statusCode: 401 }), false);
    assert.equal(
      subject.isDistributionUnavailable({ code: 'ECONNREFUSED' }),
      false,
    );
    assert.equal(subject.isDistributionUnavailable(undefined), false);
  });
});

describe('isDockerHubImage', () => {
  const { subject } = load(GOOD_TOKEN, FOUND);

  it('tells Docker Hub images from the others', () => {
    assert.equal(subject.isDockerHubImage('molo17/x:1'), true);
    assert.equal(subject.isDockerHubImage('docker.io/library/busybox'), true);
    assert.equal(subject.isDockerHubImage('ghcr.io/o/x'), false);
  });
});
