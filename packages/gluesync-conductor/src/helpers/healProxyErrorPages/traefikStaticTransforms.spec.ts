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
  tryAddStatic,
  tryRemoveStatic,
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
      assert.equal(removeStatic(addStatic(original)), original);
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

// ------------------------------------------------ every other byte stays

const PAGES = 'gluesync-pages@docker';
const PLUGIN_LINES = [
  'experimental:',
  '  localPlugins:',
  '    gluesyncerrorpages:',
  '      moduleName: github.com/molo17/gluesyncerrorpages',
];

const lines = (text: string): string[] => text.split(/(?<=\n)/);

/** The lines `after` has on top of `before`; `before`'s lines must all be there, in order. */
const addedLines = (before: string, after: string): string[] => {
  const old = lines(before);
  const kept = lines(after).reduce<{ at: number; added: string[] }>(
    (acc, line) =>
      line === old[acc.at]
        ? { ...acc, at: acc.at + 1 }
        : { ...acc, added: [...acc.added, line] },
    { at: 0, added: [] },
  );

  assert.equal(kept.at, old.length, 'a line of the original changed or moved');

  return kept.added;
};

// The customer's file of the e2e: double-space comments, blank lines
const CUSTOMER = `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
    http:
      middlewares:
        - user-headers@file   # customer middleware, must survive

log:
  level: DEBUG  # customer debug level
accessLog: {}
`;

const eol = (text: string, to: string): string => text.replaceAll('\n', to);

describe('addStatic / removeStatic splice the original text', () => {
  it('adds only lines to the customer file and removes them again, byte for byte', () => {
    const added = addStatic(CUSTOMER);

    assert.deepEqual(addedLines(CUSTOMER, added), [
      `        - ${PAGES}\n`,
      ...PLUGIN_LINES.map(line => `${line}\n`),
    ]);
    assert.ok(added.includes('user-headers@file   # customer middleware'));
    assert.ok(added.includes('level: DEBUG  # customer debug level'));
    assert.equal(removeStatic(added), CUSTOMER);
  });

  it('keeps CRLF line ends: only CRLF lines are added', () => {
    const crlf = eol(CUSTOMER, '\r\n');
    const added = addStatic(crlf);

    assert.deepEqual(addedLines(crlf, added), [
      `        - ${PAGES}\r\n`,
      ...PLUGIN_LINES.map(line => `${line}\r\n`),
    ]);
    assert.ok(!/[^\r]\n/.test(added));
    assert.equal(removeStatic(added), crlf);
  });

  it('keeps a file without a final newline without one', () => {
    const noFinal = CUSTOMER.trimEnd();
    const added = addStatic(noFinal);

    assert.ok(!added.endsWith('\n'));
    assert.ok(
      added.endsWith('      moduleName: github.com/molo17/gluesyncerrorpages'),
    );
    assert.deepEqual(parse(added).experimental.localPlugins, {
      gluesyncerrorpages: {
        moduleName: 'github.com/molo17/gluesyncerrorpages',
      },
    });
    assert.equal(removeStatic(added), noFinal);

    // the last line is the one we add to, with and without CRLF
    const websecureLast = 'entryPoints:\n  websecure:\n    address: ":443"';
    assert.equal(removeStatic(addStatic(websecureLast)), websecureLast);
    assert.equal(
      removeStatic(addStatic(eol(websecureLast, '\r\n'))),
      eol(websecureLast, '\r\n'),
    );
  });

  it('keeps a four-space indent and uses it for what it adds', () => {
    const four = CUSTOMER.replaceAll('  ', '    ');
    const added = addStatic(four);

    assert.deepEqual(addedLines(four, added), [
      `                - ${PAGES}\n`,
      'experimental:\n',
      '    localPlugins:\n',
      '        gluesyncerrorpages:\n',
      '            moduleName: github.com/molo17/gluesyncerrorpages\n',
    ]);
    assert.equal(removeStatic(added), four);
  });
  it('adds to a flow list inside the brackets and takes it out again', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['[a@file, b@file]', `[a@file, b@file, ${PAGES}]`],
      ['[a@file,b@file]', `[a@file,b@file, ${PAGES}]`],
      ['[ a@file, b@file ]', `[ a@file, b@file, ${PAGES} ]`],
      ['[a@file]', `[a@file, ${PAGES}]`],
      ['[]', `[${PAGES}]`],
      ['[a@file, b@file]  # keep me', `[a@file, b@file, ${PAGES}]  # keep me`],
    ];

    cases.forEach(([list, expected]) => {
      const original = `${NO_HTTP}    http:\n      middlewares: ${list}\n`;
      const added = addStatic(original);

      assert.equal(
        added,
        `${NO_HTTP}    http:\n      middlewares: ${expected}\n${PLUGIN_LINES.map(line => `${line}\n`).join('')}`,
      );
      assert.equal(removeStatic(added), original);
    });
  });
  it('adds a whole http when websecure has none, and only that', () => {
    const added = addStatic(NO_HTTP);

    assert.deepEqual(addedLines(NO_HTTP, added), [
      '    http:\n',
      '      middlewares:\n',
      `        - ${PAGES}\n`,
      ...PLUGIN_LINES.map(line => `${line}\n`),
    ]);
    assert.equal(removeStatic(added), NO_HTTP);
  });

  it('fills a middlewares or http key that has no value', () => {
    const cases: ReadonlyArray<[string, string]> = [
      [`    http:\n      middlewares:\n`, `        - ${PAGES}\n`],
      [`    http:\n`, `      middlewares:\n        - ${PAGES}\n`],
      [`    http:   # later\n`, `      middlewares:\n        - ${PAGES}\n`],
    ];

    cases.forEach(([tail, inserted]) => {
      const original = `${NO_HTTP}${tail}`;
      const added = addStatic(original);

      assert.deepEqual(
        addedLines(original, added),
        [
          inserted
            .split('\n')
            .slice(0, -1)
            .map(line => `${line}\n`),
          PLUGIN_LINES.map(line => `${line}\n`),
        ].flat(),
      );
      assert.deepEqual(parse(added).entryPoints.websecure.http.middlewares, [
        PAGES,
      ]);
      // a bare key with nothing else on it goes with our entry; one with a comment stays
      assert.equal(
        removeStatic(added),
        tail.includes('#') ? original : NO_HTTP,
      );
    });
  });

  it('adds next to the other plugins of an experimental section', () => {
    const original = `${NO_HTTP}experimental:  # mine\n  plugins:\n    mine:\n      moduleName: example.com/mine\n      version: v1.0.0\n\nlog:\n  level: INFO\n`;
    const added = addStatic(original);

    assert.deepEqual(addedLines(original, added), [
      '    http:\n',
      '      middlewares:\n',
      `        - ${PAGES}\n`,
      '  localPlugins:\n',
      '    gluesyncerrorpages:\n',
      '      moduleName: github.com/molo17/gluesyncerrorpages\n',
    ]);
    assert.ok(added.includes('experimental:  # mine'));
    assert.equal(removeStatic(added), original);

    const withLocal = `${original.replace('\nlog:', '  localPlugins:\n    other:\n      moduleName: example.com/other\n\nlog:')}`;
    const addedLocal = addStatic(withLocal);

    assert.deepEqual(Object.keys(parse(addedLocal).experimental.localPlugins), [
      'other',
      'gluesyncerrorpages',
    ]);
    assert.equal(removeStatic(addedLocal), withLocal);
  });

  it('keeps a document marker, leading comments and an end marker', () => {
    const original = `# Customer proxy\n# second line\n---\n${CUSTOMER}...\n`;
    const added = addStatic(original);

    assert.ok(added.startsWith('# Customer proxy\n# second line\n---\n'));
    assert.ok(
      added.endsWith('moduleName: github.com/molo17/gluesyncerrorpages\n...\n'),
    );
    assert.deepEqual(addedLines(original, added).length, 5);
    assert.equal(removeStatic(added), original);
  });

  it('is idempotent in both directions', () => {
    [
      CUSTOMER,
      eol(CUSTOMER, '\r\n'),
      CUSTOMER.trimEnd(),
      NO_HTTP,
      KIT_TRAEFIK,
    ].forEach(original => {
      const added = addStatic(original);

      assert.equal(addStatic(added), added);
      assert.equal(removeStatic(original), original);
      assert.equal(removeStatic(removeStatic(added)), original);
    });
  });

  it('removes only our lines: the customer comments and middlewares around them stay', () => {
    const original = `${NO_HTTP.replace('address: ":443"\n', 'address: ":443"\n')}    http:\n      middlewares:\n        - a@file  # first\n        - ${PAGES}   # ours\n        - b@file\n`;

    assert.equal(
      removeStatic(original),
      original.replace(`        - ${PAGES}   # ours\n`, ''),
    );
  });

  it('keeps a parent key that holds a comment of the customer', () => {
    const original = `${NO_HTTP}    http:\n      middlewares:\n        # chain order matters\n        - ${PAGES}\n`;
    const back = removeStatic(original);

    assert.equal(
      back,
      `${NO_HTTP}    http:\n      middlewares:\n        # chain order matters\n`,
    );
    assert.deepEqual(parse(back).entryPoints.websecure.http, {
      middlewares: null,
    });
  });

  it('says why it leaves a layout alone instead of rewriting it', () => {
    const flowWebsecure = 'entryPoints:\n  websecure: {address: ":443"}\n';
    const mapMiddlewares = `${NO_HTTP}    http:\n      middlewares:\n        a: b\n`;
    const commented = `${NO_HTTP}experimental:\n  localPlugins:\n    gluesyncerrorpages:\n      # ours\n      moduleName: github.com/molo17/gluesyncerrorpages\n`;

    [flowWebsecure, mapMiddlewares].forEach(text => {
      const result = tryAddStatic(text);

      assert.equal(result.ok, false);
      assert.throws(() => addStatic(text));
    });
    assert.equal(tryRemoveStatic(commented).ok, false);
    assert.throws(() => removeStatic(commented), /comment of its own/);
    assert.deepEqual(tryAddStatic(CUSTOMER), {
      ok: true,
      text: addStatic(CUSTOMER),
    });
    assert.equal(tryAddStatic('a: [1, 2\n').ok, false);
  });
});
