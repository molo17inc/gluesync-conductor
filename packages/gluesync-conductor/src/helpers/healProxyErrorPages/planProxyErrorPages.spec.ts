import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KIT_TRAEFIK,
  LEGACY_PROXY_LABELS,
  LEGACY_TRAEFIK,
  TARGET_PROXY_LABELS,
  USER_TRAEFIK,
  kitCompose,
} from '../../testing/proxyErrorPagesFixtures';
import {
  compareVersions,
  imageTag,
  isCapableImage,
  parseTagVersion,
} from './errorPagesWiring';
import planProxyErrorPages from './planProxyErrorPages';
import { addStatic } from './traefikStaticTransforms';

const CAPABLE = 'molo17/traefik:3.7.16.3';
const OLD = 'molo17/traefik:3.6.2';

const TARGET_TRAEFIK = addStatic(KIT_TRAEFIK);
const LEGACY_PROXY = ['com.molo17.conductor.type=third-party'];

const plan = (
  compose: ReturnType<typeof kitCompose>,
  traefikYamlText: string = KIT_TRAEFIK,
  isWindows = false,
) =>
  planProxyErrorPages({
    composeJson: compose,
    proxyServiceName: 'reverse-proxy',
    traefikYamlText,
    isWindows,
  });

describe('image tags', () => {
  it('reads the leading numeric part of the tag', () => {
    assert.deepEqual(parseTagVersion('3.7.16.3'), [3, 7, 16, 3]);
    assert.deepEqual(
      parseTagVersion('3.7.16.3-win-nanoserver-ltsc2019'),
      [3, 7, 16, 3],
    );
    assert.deepEqual(parseTagVersion('3.7.16.3.develop'), [3, 7, 16, 3]);
    assert.deepEqual(
      parseTagVersion('3.7.16.3.develop-win-nanoserver-ltsc2022'),
      [3, 7, 16, 3],
    );
    assert.equal(parseTagVersion('latest'), undefined);
    assert.equal(parseTagVersion('v3.7.16.3'), undefined);
    assert.equal(parseTagVersion(undefined), undefined);
  });

  it('takes the tag of a registry with a port and ignores a digest', () => {
    assert.equal(
      imageTag('localhost:5000/molo17/traefik:3.7.16.3'),
      '3.7.16.3',
    );
    assert.equal(imageTag('localhost:5000/molo17/traefik'), undefined);
    assert.equal(imageTag('molo17/traefik:3.7.16.3@sha256:abcdef'), '3.7.16.3');
  });

  it('compares the four parts numerically', () => {
    assert.ok(compareVersions([3, 7, 16, 10], [3, 7, 16, 3]) > 0);
    assert.ok(compareVersions([3, 7, 16], [3, 7, 16, 3]) < 0);
    assert.equal(compareVersions([3, 7, 16, 0], [3, 7, 16]), 0);
  });

  it('is capable from 3.7.16.3 on, Linux and Windows, release and develop', () => {
    const capable = [
      'molo17/traefik:3.7.16.3',
      'molo17/traefik:3.7.16.3-win-nanoserver-ltsc2019',
      'molo17/traefik:3.7.16.3-win-nanoserver-ltsc2022',
      'molo17/traefik:3.7.16.3.develop',
      'molo17/traefik:3.7.16.3.develop-win-nanoserver-ltsc2022',
      'molo17/traefik:3.7.16.10',
      'molo17/traefik:3.7.17.0',
      'molo17/traefik:3.8.0.1',
      'localhost:5000/molo17/traefik:3.7.16.4',
    ];
    const incapable = [
      'molo17/traefik:3.7.16.1',
      'molo17/traefik:3.7.16.2.develop',
      'molo17/traefik:3.6.2-win-nanoserver-ltsc2022',
      'molo17/traefik:latest',
      'molo17/traefik',
      'traefik:3.7.16.3',
      'traefik:v3.1',
    ];

    assert.deepEqual(
      capable.filter(i => !isCapableImage(i)),
      [],
    );
    assert.deepEqual(incapable.filter(isCapableImage), []);
  });
});

describe('planProxyErrorPages', () => {
  it('adds the wiring to a kit whose image can serve it', () => {
    assert.equal(plan(kitCompose({ image: CAPABLE })).action, 'add');
  });

  it('leaves a kit whose image cannot serve it alone', () => {
    assert.equal(plan(kitCompose({ image: OLD })).action, 'none');
  });

  it('is idempotent: nothing to do once the target wiring is in place', () => {
    const compose = kitCompose({
      image: CAPABLE,
      proxyLabels: [
        ...TARGET_PROXY_LABELS,
        'com.molo17.conductor.type=third-party',
      ],
    });

    assert.equal(plan(compose, TARGET_TRAEFIK).action, 'none');
  });

  it('adds what is missing when only part of the wiring is there', () => {
    const labelsOnly = kitCompose({
      image: CAPABLE,
      proxyLabels: TARGET_PROXY_LABELS,
    });

    assert.equal(plan(labelsOnly, KIT_TRAEFIK).action, 'add');
    assert.equal(
      plan(kitCompose({ image: CAPABLE }), TARGET_TRAEFIK).action,
      'add',
    );
  });

  it('removes the wiring when the image can no longer serve it', () => {
    const compose = kitCompose({
      image: OLD,
      proxyLabels: TARGET_PROXY_LABELS,
    });

    assert.equal(plan(compose, TARGET_TRAEFIK).action, 'remove');
    // the static part alone is enough to remove
    assert.equal(
      plan(kitCompose({ image: OLD }), TARGET_TRAEFIK).action,
      'remove',
    );
  });

  it('honours the opt-out label: removes our wiring, never adds', () => {
    const optOut = 'com.molo17.conductor.error-pages=false';

    assert.equal(
      plan(
        kitCompose({
          image: CAPABLE,
          proxyLabels: [...TARGET_PROXY_LABELS, optOut],
        }),
        TARGET_TRAEFIK,
      ).action,
      'remove',
    );
    assert.equal(
      plan(kitCompose({ image: CAPABLE, proxyLabels: [optOut] })).action,
      'none',
    );
  });

  it('converts the v0.0.286 wiring on a capable image', () => {
    const compose = kitCompose({
      image: CAPABLE,
      proxyLabels: LEGACY_PROXY_LABELS,
      legacyServiceLabels: true,
    });

    assert.equal(plan(compose, LEGACY_TRAEFIK).action, 'convert');
  });

  it('keeps v0.0.286 working on 3.7.16.1/.2, which serve it, and removes it below', () => {
    const legacy = (image: string) =>
      plan(
        kitCompose({
          image,
          proxyLabels: LEGACY_PROXY_LABELS,
          legacyServiceLabels: true,
        }),
        LEGACY_TRAEFIK,
      ).action;

    assert.equal(legacy('molo17/traefik:3.7.16.1'), 'none');
    assert.equal(legacy('molo17/traefik:3.7.16.2'), 'none');
    assert.equal(
      legacy('molo17/traefik:3.6.2-win-nanoserver-ltsc2022'),
      'remove',
    );
  });

  it('removes v0.0.286 when the customer opts out', () => {
    const compose = kitCompose({
      image: CAPABLE,
      proxyLabels: [
        ...LEGACY_PROXY_LABELS,
        'com.molo17.conductor.error-pages=false',
      ],
      legacyServiceLabels: true,
    });

    assert.equal(plan(compose, LEGACY_TRAEFIK).action, 'remove');
  });

  it('skips a label of ours with a value the customer changed', () => {
    const changed = TARGET_PROXY_LABELS.map(l =>
      l.endsWith('gluesyncerrorpages.root=/gluesync/error-pages')
        ? 'traefik.http.middlewares.gluesync-pages.plugin.gluesyncerrorpages.root=/srv/my-pages'
        : l,
    );
    const result = plan(
      kitCompose({ image: CAPABLE, proxyLabels: changed }),
      TARGET_TRAEFIK,
    );

    assert.equal(result.action, 'skip');
    assert.match(result.reason, /customised/);
  });

  it('skips a customised label of v0.0.286 on another service', () => {
    const compose = kitCompose({
      image: CAPABLE,
      proxyLabels: LEGACY_PROXY_LABELS,
      legacyServiceLabels: true,
    });
    const chronos = compose.services?.['gluesync-chronos'];
    const edited = {
      ...compose,
      services: {
        ...compose.services,
        'gluesync-chronos': {
          ...chronos,
          image: chronos?.image ?? '',
          labels: (chronos?.labels as string[]).map(l =>
            l.startsWith('traefik.http.routers.chronos-html.entrypoints=')
              ? 'traefik.http.routers.chronos-html.entrypoints=web'
              : l,
          ),
        },
      },
    };

    assert.equal(plan(edited, LEGACY_TRAEFIK).action, 'skip');
  });

  it('skips when traefik.enable is off or the plugin entry is the customer own', () => {
    assert.equal(
      plan(
        kitCompose({ image: CAPABLE, proxyLabels: ['traefik.enable=false'] }),
      ).action,
      'skip',
    );
    assert.equal(
      plan(
        kitCompose({ image: CAPABLE }),
        `${KIT_TRAEFIK}experimental:\n  localPlugins:\n    gluesyncerrorpages:\n      moduleName: example.com/mine\n`,
      ).action,
      'skip',
    );
  });

  it('skips without websecure, unparseable files and interpolated tags', () => {
    const noWebsecure = 'entryPoints:\n  web:\n    address: ":80"\n';

    assert.equal(
      plan(kitCompose({ image: CAPABLE }), noWebsecure).action,
      'skip',
    );
    assert.equal(
      plan(kitCompose({ image: CAPABLE }), 'a: [1, 2\n').action,
      'skip',
    );
    assert.equal(plan(kitCompose({ image: CAPABLE }), '').action, 'skip');
    assert.equal(
      plan(kitCompose({ image: `molo17/traefik:\${TRAEFIK_TAG}` })).action,
      'skip',
    );
    assert.equal(
      plan(
        kitCompose({ image: CAPABLE }),
        'entryPoints:\n  websecure:\n    address: ":443"\n    http:\n      middlewares: abc\n',
      ).action,
      'skip',
    );
  });

  it('reads the middlewares of a customer proxy and still adds', () => {
    assert.equal(
      plan(kitCompose({ image: CAPABLE }), USER_TRAEFIK).action,
      'add',
    );
  });

  it('puts the Windows pages folder in the target labels it expects', () => {
    const windows = TARGET_PROXY_LABELS.map(l =>
      l.replace('/gluesync/error-pages', String.raw`C:\gluesync\error-pages`),
    );
    const image = 'molo17/traefik:3.7.16.3-win-nanoserver-ltsc2022';

    assert.equal(
      plan(kitCompose({ image, proxyLabels: windows }), TARGET_TRAEFIK, true)
        .action,
      'none',
    );
    // the Linux folder on Windows is not what we write: customised
    assert.equal(
      plan(
        kitCompose({ image, proxyLabels: TARGET_PROXY_LABELS }),
        TARGET_TRAEFIK,
        true,
      ).action,
      'skip',
    );
  });

  it('reads labels written as a map', () => {
    const map = Object.fromEntries(
      TARGET_PROXY_LABELS.map(l => {
        const at = l.indexOf('=');

        return [l.slice(0, at), l.slice(at + 1)];
      }),
    );

    assert.equal(
      plan(kitCompose({ image: CAPABLE, proxyLabels: map }), TARGET_TRAEFIK)
        .action,
      'none',
    );
  });

  it('does nothing without a reverse-proxy service', () => {
    assert.equal(
      planProxyErrorPages({
        composeJson: { services: {} },
        proxyServiceName: 'reverse-proxy',
        traefikYamlText: KIT_TRAEFIK,
        isWindows: false,
      }).action,
      'skip',
    );
  });

  it('is pure: the same input gives the same answer', () => {
    const compose = kitCompose({ image: CAPABLE });

    assert.deepEqual(plan(compose), plan(compose));
    assert.equal(LEGACY_PROXY.length, 1);
  });
});
