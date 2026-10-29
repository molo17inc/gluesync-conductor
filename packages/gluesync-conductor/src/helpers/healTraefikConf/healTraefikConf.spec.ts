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

  describe('changes only the bytes of the redirect', () => {
    const REDIRECT_LINES = [
      '    http:',
      '      redirections:',
      '        entryPoint:',
      '          to: websecure',
      '          scheme: https',
      '          permanent: true',
    ];
    const CUSTOMER = `entryPoints:
  web:
    address: ":80"   # plain http
  websecure:
    address: ":443"
    http:
      middlewares:
        - user-headers@file   # customer middleware, must survive

log:
  level: DEBUG  # customer debug level
accessLog: {}
`;

    const lines = (text: string): string[] => text.split(/(?<=\n)/);

    const addedLines = (before: string, after: string): string[] => {
      const old = lines(before);
      const kept = lines(after).reduce<{ at: number; added: string[] }>(
        (acc, line) =>
          line === old[acc.at]
            ? { ...acc, at: acc.at + 1 }
            : { ...acc, added: [...acc.added, line] },
        { at: 0, added: [] },
      );

      assert.equal(kept.at, old.length, 'a line of the original changed');

      return kept.added;
    };

    const healed = async (text: string): Promise<string> => {
      await heal(text);

      return readFileSync(file, 'utf8');
    };

    it('adds only the redirect lines to the customer file, double-space comments and blank lines intact', async () => {
      const out = await healed(CUSTOMER);

      assert.deepEqual(
        addedLines(CUSTOMER, out),
        REDIRECT_LINES.map(line => `${line}\n`),
      );
      assert.ok(out.includes('address: ":80"   # plain http'));
      assert.ok(out.includes('- user-headers@file   # customer middleware'));
      assert.ok(out.includes('level: DEBUG  # customer debug level'));
    });

    it('keeps CRLF and adds CRLF lines only', async () => {
      const crlf = CUSTOMER.replaceAll('\n', '\r\n');
      const out = await healed(crlf);

      assert.deepEqual(
        addedLines(crlf, out),
        REDIRECT_LINES.map(line => `${line}\r\n`),
      );
    });

    it('keeps a file without a final newline without one', async () => {
      const noFinal =
        'entryPoints:\n  websecure:\n    address: ":443"\n  web:\n    address: ":80"';
      const out = await healed(noFinal);

      assert.equal(out, `${noFinal}\n${REDIRECT_LINES.join('\n')}`);
    });

    it('uses the four-space indent of the file', async () => {
      const four = CUSTOMER.replaceAll('  ', '    ');
      const out = await healed(four);

      assert.deepEqual(addedLines(four, out), [
        '        http:\n',
        '            redirections:\n',
        '                entryPoint:\n',
        '                    to: websecure\n',
        '                    scheme: https\n',
        '                    permanent: true\n',
      ]);
    });

    it('keeps a document marker and leading comments', async () => {
      const text = `# my proxy\n---\n${CUSTOMER}`;
      const out = await healed(text);

      assert.ok(out.startsWith('# my proxy\n---\nentryPoints:\n'));
      assert.equal(addedLines(text, out).length, 6);
    });

    it('adds only what is missing to a redirect the customer started', async () => {
      const text = `entryPoints:
  web:
    address: ":80"
    http:
      redirections: # mine
        entryPoint:
          priority: 5
          to: "other"   # was other
          scheme: 'http'
          permanent: false
  websecure:
    address: ":443"
`;
      const out = await healed(text);

      assert.equal(
        out,
        text
          .replace('to: "other"', 'to: "websecure"')
          .replace("scheme: 'http'", "scheme: 'https'")
          .replace('permanent: false', 'permanent: true'),
      );
    });

    it('adds a redirections key under an http the customer has', async () => {
      const text = `entryPoints:
  web:
    address: ":80"
    http:
      middlewares:
        - m@file
  websecure:
    address: ":443"
`;
      const out = await healed(text);

      assert.deepEqual(addedLines(text, out), [
        '      redirections:\n',
        '        entryPoint:\n',
        '          to: websecure\n',
        '          scheme: https\n',
        '          permanent: true\n',
      ]);
    });

    it('leaves a layout it cannot splice alone and does not restart', async () => {
      const flow = `entryPoints:\n  web: {address: ":80"}\n  websecure:\n    address: ":443"\n`;

      assert.equal(await heal(flow), null);
      assert.equal(readFileSync(file, 'utf8'), flow);
      assert.deepEqual(restarted, []);
    });
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
