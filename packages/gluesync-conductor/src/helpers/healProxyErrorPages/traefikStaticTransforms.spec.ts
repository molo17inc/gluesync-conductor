import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

import {
  KIT_TRAEFIK,
  LEGACY_TRAEFIK,
  USER_TRAEFIK,
} from '../../testing/proxyErrorPagesFixtures';
import {
  addStatic,
  inspectTraefikStatic,
  removeStatic,
} from './traefikStaticTransforms';

const NO_HTTP = `entryPoints:
  websecure:
    address: ":443"
`;

describe('addStatic', () => {
  it('adds the middleware and the plugin to the kit file and changes nothing else', () => {
    assert.equal(
      addStatic(KIT_TRAEFIK),
      `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
    http:
      middlewares:
        - gluesync-pages@docker

log:
  level: INFO

providers:
  docker:
    exposedByDefault: false
    endpoint: "unix:///var/run/docker.sock"
  file:
    filename: "/etc/traefik/certs.yml"
    watch: true
serversTransport:
  insecureSkipVerify: true
experimental:
  localPlugins:
    gluesyncerrorpages:
      moduleName: github.com/molo17/gluesyncerrorpages
# api:
#   dashboard: true
#   insecure: true
`,
    );
  });

  it('appends to the middlewares a customer already has and keeps every setting and comment', () => {
    const out = addStatic(USER_TRAEFIK);

    assert.equal(
      out,
      USER_TRAEFIK.replace(
        '        - ratelimit@file\n',
        '        - ratelimit@file\n        - gluesync-pages@docker\n',
      ).replace(
        'providers:\n  docker:\n    exposedByDefault: false\n',
        'providers:\n  docker:\n    exposedByDefault: false\nexperimental:\n  localPlugins:\n    gluesyncerrorpages:\n      moduleName: github.com/molo17/gluesyncerrorpages\n',
      ),
    );

    const conf = parse(out);
    assert.deepEqual(conf.entryPoints.websecure.http.middlewares, [
      'security-headers@file',
      'ratelimit@file',
      'gluesync-pages@docker',
    ]);
    assert.equal(
      conf.entryPoints.websecure.http.tls.certResolver,
      'letsencrypt',
    );
    assert.equal(
      conf.certificatesResolvers.letsencrypt.acme.email,
      'ops@example.com',
    );
    assert.equal(conf.log.level, 'DEBUG');
    assert.match(out, /# real certificates/);
    assert.match(out, /# customer wants DEBUG/);
    assert.match(out, /^# Customer proxy, production\. Do not touch\./);
  });

  it('is idempotent: ours is there once', () => {
    const once = addStatic(USER_TRAEFIK);

    assert.equal(addStatic(once), once);
    assert.equal(once.split('gluesync-pages@docker').length - 1, 1);
  });

  it('creates only the levels that are missing', () => {
    const out = addStatic(NO_HTTP);

    assert.equal(
      out,
      `entryPoints:
  websecure:
    address: ":443"
    http:
      middlewares:
        - gluesync-pages@docker
experimental:
  localPlugins:
    gluesyncerrorpages:
      moduleName: github.com/molo17/gluesyncerrorpages
`,
    );
  });

  it('adds to an experimental section the customer already has', () => {
    const out = addStatic(
      `${NO_HTTP}experimental:\n  plugins:\n    mine:\n      moduleName: example.com/mine\n      version: v1.0.0\n`,
    );

    assert.deepEqual(parse(out).experimental, {
      plugins: { mine: { moduleName: 'example.com/mine', version: 'v1.0.0' } },
      localPlugins: {
        gluesyncerrorpages: {
          moduleName: 'github.com/molo17/gluesyncerrorpages',
        },
      },
    });
  });

  it('keeps the layout of the file: four-space indent, unindented lists, flow lists, CRLF', () => {
    const four = KIT_TRAEFIK.replaceAll('  ', '    ');
    const flat = `${NO_HTTP}    http:\n      middlewares:\n      - a@file\n`;
    const flow = `${NO_HTTP}    http:\n      middlewares: [a@file, b@file]\n`;
    const crlf = KIT_TRAEFIK.replaceAll('\n', '\r\n');

    assert.match(
      addStatic(four),
      /\n {12}middlewares:\n {16}- gluesync-pages@docker/,
    );
    assert.match(
      addStatic(flat),
      /middlewares:\n {6}- a@file\n {6}- gluesync-pages@docker/,
    );
    assert.match(
      addStatic(flow),
      /middlewares: \[a@file, b@file, gluesync-pages@docker\]/,
    );
    assert.ok(
      addStatic(crlf)
        .split('\r\n')
        .every(line => !line.includes('\n')),
    );
    assert.ok(addStatic(crlf).includes('gluesync-pages@docker\r\n'));
  });

  it('converts: drops the entryPoints.errorpages of v0.0.286 and keeps the plugin', () => {
    const out = addStatic(LEGACY_TRAEFIK, { dropLegacyEntry: true });
    const conf = parse(out);

    assert.equal(conf.entryPoints.errorpages, undefined);
    assert.deepEqual(conf.entryPoints.websecure.http.middlewares, [
      'gluesync-pages@docker',
    ]);
    assert.equal(
      conf.experimental.localPlugins.gluesyncerrorpages.moduleName,
      'github.com/molo17/gluesyncerrorpages',
    );
    assert.match(out, /# Error pages: Traefik local plugin/);
    assert.doesNotMatch(out, /8099/);
  });

  it('keeps an errorpages entry point that is the customer own', () => {
    const mine = LEGACY_TRAEFIK.replace(':8099', ':9000');

    assert.equal(
      parse(addStatic(mine, { dropLegacyEntry: true })).entryPoints.errorpages
        .address,
      ':9000',
    );
  });

  it('refuses a file that is not a YAML mapping', () => {
    assert.throws(() => addStatic('a: [1, 2\n'), /not valid YAML/);
    assert.throws(() => addStatic('- a\n- b\n'), /not a YAML mapping/);
  });
});

describe('removeStatic', () => {
  it('gives back the original text of a file addStatic changed', () => {
    [KIT_TRAEFIK, USER_TRAEFIK, KIT_TRAEFIK.replaceAll('\n', '\r\n')].forEach(
      original => {
        assert.equal(removeStatic(addStatic(original)), original);
      },
    );
    [
      NO_HTTP,
      KIT_TRAEFIK.replaceAll('  ', '    '),
      `${NO_HTTP}    http:\n      middlewares:\n      - a@file\n`,
      `${NO_HTTP}    http:\n      middlewares: [a@file, b@file]\n`.replace(
        '[a@file, b@file]',
        '[a@file,b@file]',
      ),
    ].forEach(original => {
      const back = removeStatic(addStatic(original));

      assert.deepEqual(parse(back), parse(original));
    });
  });

  it('removes only our list item and keeps the customer middlewares', () => {
    const out = removeStatic(addStatic(USER_TRAEFIK));

    assert.deepEqual(parse(out).entryPoints.websecure.http.middlewares, [
      'security-headers@file',
      'ratelimit@file',
    ]);
  });

  it('prunes the containers that are empty because of us, and only those', () => {
    const onlyOurs = parse(removeStatic(addStatic(KIT_TRAEFIK)));
    assert.equal(onlyOurs.entryPoints.websecure.http, undefined);
    assert.equal(onlyOurs.experimental, undefined);

    // the customer's tls under http keeps http; their other plugin keeps experimental
    const withTls = `${NO_HTTP}    http:\n      tls:\n        certResolver: le\n`;
    const withPlugin = `${NO_HTTP}experimental:\n  plugins:\n    mine:\n      moduleName: example.com/mine\n      version: v1\n`;
    const a = parse(removeStatic(addStatic(withTls)));
    const b = parse(removeStatic(addStatic(withPlugin)));

    assert.deepEqual(a.entryPoints.websecure.http, {
      tls: { certResolver: 'le' },
    });
    assert.equal(a.experimental, undefined);
    assert.equal(b.experimental.localPlugins, undefined);
    assert.ok(b.experimental.plugins.mine);
  });

  it('removes what v0.0.286 added: the plugin, the errorpages entry point and their comments', () => {
    const out = removeStatic(LEGACY_TRAEFIK);

    assert.equal(
      out,
      `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

log:
  level: INFO

providers:
  docker:
    exposedByDefault: false
`,
    );
  });

  it('leaves a plugin entry that is not ours and a file without our keys as they are', () => {
    const mine = `${NO_HTTP}experimental:\n  localPlugins:\n    gluesyncerrorpages:\n      moduleName: example.com/mine\n`;

    assert.equal(removeStatic(mine), mine);
    assert.equal(removeStatic(USER_TRAEFIK), USER_TRAEFIK);
    assert.equal(removeStatic(KIT_TRAEFIK), KIT_TRAEFIK);
  });
});

describe('inspectTraefikStatic', () => {
  it('reads what the planner needs', () => {
    assert.deepEqual(inspectTraefikStatic(KIT_TRAEFIK), {
      ok: true,
      facts: {
        hasWebsecure: true,
        middlewares: 'absent',
        hasPagesMiddleware: false,
        plugin: 'absent',
        hasErrorpagesEntry: false,
        errorpagesIsOurs: false,
      },
    });
    assert.deepEqual(inspectTraefikStatic(LEGACY_TRAEFIK), {
      ok: true,
      facts: {
        hasWebsecure: true,
        middlewares: 'absent',
        hasPagesMiddleware: false,
        plugin: 'ours',
        hasErrorpagesEntry: true,
        errorpagesIsOurs: true,
      },
    });
    assert.equal(
      inspectTraefikStatic(addStatic(USER_TRAEFIK)).ok &&
        (inspectTraefikStatic(addStatic(USER_TRAEFIK)) as any).facts
          .hasPagesMiddleware,
      true,
    );
  });

  it('reports a file it cannot use', () => {
    assert.equal(inspectTraefikStatic('a: [').ok, false);
    assert.equal(inspectTraefikStatic('').ok, false);
  });
});
