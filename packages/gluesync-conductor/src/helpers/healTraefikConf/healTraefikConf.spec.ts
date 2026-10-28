/* eslint-disable functional/immutable-data -- temp files and a recorder for the test */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import loadWithStubs from '../../testing/loadWithStubs';
import { KIT_TRAEFIK } from '../../testing/proxyErrorPagesFixtures';

const here = (p: string): string => path.resolve(__dirname, p);

type Subject = Readonly<{
  default: (compose?: object) => Promise<string | null>;
  findProxyServiceName: (compose: object) => string | null;
}>;

const restarted: string[] = [];

const subject = loadWithStubs<Subject>(here('./healTraefikConf'), {
  [here('../../utils/docker/getDocker')]: {
    getDocker: () => ({
      listContainers: async () => [
        { Id: 'proxy-1', Names: ['/reverse-proxy'] },
      ],
      getContainer: (id: string) => ({
        restart: async () => {
          restarted.push(id);
        },
      }),
    }),
  },
});

const REDIRECT = `    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
`;

describe('healTraefikConf', () => {
  let file: string;

  const composeFor = (traefikPath: string) => ({
    services: {
      'reverse-proxy': {
        image: 'molo17/traefik:3.6.2',
        volumes: [`${traefikPath}:/etc/traefik/traefik.yml:ro`],
      },
    },
  });

  const heal = (text: string) => {
    writeFileSync(file, text);

    return subject.default(composeFor(file));
  };

  beforeEach(() => {
    file = path.join(
      mkdtempSync(path.join(tmpdir(), 'traefik-')),
      'traefik.yml',
    );
    restarted.length = 0;
  });

  it('adds the http to https redirect and keeps the comments and the rest of the file', async () => {
    const result = await heal(KIT_TRAEFIK);

    assert.equal(result, 'reverse-proxy');
    assert.equal(
      readFileSync(file, 'utf8'),
      KIT_TRAEFIK.replace(
        '    address: ":80"\n',
        `    address: ":80"\n${REDIRECT}`,
      ),
    );
    assert.deepEqual(restarted, ['proxy-1']);
  });

  it('leaves the ACME resolver, the log level and every comment of a customer file alone', async () => {
    const customer = `# production proxy
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: le # real certs
certificatesResolvers:
  le:
    acme:
      email: ops@example.com
      storage: /etc/traefik/acme.json
log:
  level: DEBUG # wanted
`;

    await heal(customer);

    assert.equal(
      readFileSync(file, 'utf8'),
      customer.replace(
        '    address: ":80"\n',
        `    address: ":80"\n${REDIRECT}`,
      ),
    );
  });

  it('replaces a redirect that points somewhere else', async () => {
    const text = `entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: other
          scheme: http
  websecure:
    address: ":443"
`;

    await heal(text);

    assert.equal(
      readFileSync(file, 'utf8'),
      text.replace(
        '          to: other\n          scheme: http\n',
        '          to: websecure\n          scheme: https\n          permanent: true\n',
      ),
    );
  });

  it('writes the file in place, so a single-file mount keeps seeing it', async () => {
    writeFileSync(file, KIT_TRAEFIK);
    const inode = statSync(file).ino;

    await subject.default(composeFor(file));

    assert.equal(statSync(file).ino, inode);
  });

  it('does nothing when the redirect is there: file untouched, no restart', async () => {
    const text = KIT_TRAEFIK.replace(
      '    address: ":80"\n',
      `    address: ":80"\n${REDIRECT}`,
    );
    writeFileSync(file, text);
    const mtime = statSync(file).mtimeMs;

    assert.equal(await subject.default(composeFor(file)), null);
    assert.equal(statSync(file).mtimeMs, mtime);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.deepEqual(restarted, []);
  });

  it('skips a file without web or websecure, an empty one and an invalid one', async () => {
    const noWebsecure = 'entryPoints:\n  web:\n    address: ":80"\n';
    const noWeb = 'entryPoints:\n  websecure:\n    address: ":443"\n';

    assert.equal(await heal(noWebsecure), null);
    assert.equal(readFileSync(file, 'utf8'), noWebsecure);
    assert.equal(await heal(noWeb), null);
    assert.equal(readFileSync(file, 'utf8'), noWeb);
    assert.equal(await heal(''), null);
    assert.equal(await heal('a: [1, 2\n'), null);
    assert.deepEqual(restarted, []);
  });

  it('does nothing without a reverse-proxy or without its traefik.yml', async () => {
    assert.equal(await subject.default({ services: {} }), null);
    assert.equal(
      await subject.default(composeFor('/does/not/exist/traefik.yml')),
      null,
    );
  });

  it('keeps CRLF line ends', async () => {
    await heal(KIT_TRAEFIK.replaceAll('\n', '\r\n'));

    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('permanent: true\r\n'));
    assert.ok(!/[^\r]\n/.test(text));
  });

  it('finds the reverse-proxy by name or by its Traefik image', () => {
    assert.equal(
      subject.findProxyServiceName(composeFor(file)),
      'reverse-proxy',
    );
    assert.equal(
      subject.findProxyServiceName({
        services: { edge: { image: 'traefik:v3' } },
      }),
      'edge',
    );
  });
});
