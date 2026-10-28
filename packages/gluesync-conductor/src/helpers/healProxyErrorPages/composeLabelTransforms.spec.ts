import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEGACY_PROXY_LABELS,
  TARGET_PROXY_LABELS,
  kitCompose,
} from '../../testing/proxyErrorPagesFixtures';
import {
  addTargetLabels,
  convertLabels,
  removeAllLabels,
  removeProxyLabels,
} from './composeLabelTransforms';

const TYPE = 'com.molo17.conductor.type=third-party';
const PROXY = 'reverse-proxy';

const labelsOf = (compose: ReturnType<typeof kitCompose>, name = PROXY) =>
  compose.services?.[name]?.labels;

const toMap = (list: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(
    list.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

describe('addTargetLabels', () => {
  it('appends the target labels after the ones the proxy has, as a list', () => {
    const out = addTargetLabels(
      kitCompose({ proxyLabels: ['my.label=1', TYPE] }),
      PROXY,
      false,
    );

    assert.deepEqual(labelsOf(out), [
      'my.label=1',
      TYPE,
      ...TARGET_PROXY_LABELS,
    ]);
  });

  it('keeps a map as a map', () => {
    const out = addTargetLabels(
      kitCompose({
        proxyLabels: {
          'my.label': '1',
          'com.molo17.conductor.type': 'third-party',
        },
      }),
      PROXY,
      false,
    );

    assert.deepEqual(labelsOf(out), {
      'my.label': '1',
      'com.molo17.conductor.type': 'third-party',
      ...toMap(TARGET_PROXY_LABELS),
    });
  });

  it('does not repeat a label the proxy already has, traefik.enable included', () => {
    const out = addTargetLabels(
      kitCompose({ proxyLabels: ['traefik.enable=true', TYPE] }),
      PROXY,
      false,
    );
    const list = labelsOf(out) as string[];

    assert.equal(list.filter(l => l === 'traefik.enable=true').length, 1);
    assert.deepEqual(addTargetLabels(out, PROXY, false), out);
  });

  it('uses the Windows pages folder on Windows', () => {
    const list = labelsOf(
      addTargetLabels(kitCompose(), PROXY, true),
    ) as string[];

    assert.ok(
      list.includes(
        String.raw`traefik.http.middlewares.gluesync-pages.plugin.gluesyncerrorpages.root=C:\gluesync\error-pages`,
      ),
    );
    assert.ok(list.every(l => !l.includes('/gluesync/error-pages')));
  });

  it('creates the labels when the proxy has none and touches no other service', () => {
    const base = kitCompose();
    const noLabels = {
      ...base,
      services: {
        ...base.services,
        [PROXY]: { image: base.services?.[PROXY]?.image ?? '' },
      },
    };
    const out = addTargetLabels(noLabels, PROXY, false);

    assert.deepEqual(labelsOf(out), TARGET_PROXY_LABELS);
    assert.deepEqual(
      out.services?.['gluesync-core-hub'],
      base.services?.['gluesync-core-hub'],
    );
  });
});

describe('removeProxyLabels', () => {
  it('removes the target labels and traefik.enable, leaving the rest', () => {
    const out = removeProxyLabels(
      kitCompose({ proxyLabels: ['my.label=1', ...TARGET_PROXY_LABELS, TYPE] }),
      PROXY,
      false,
    );

    assert.deepEqual(labelsOf(out), ['my.label=1', TYPE]);
  });

  it('keeps traefik.enable when the customer has other Traefik labels', () => {
    const out = removeProxyLabels(
      kitCompose({
        proxyLabels: [
          ...TARGET_PROXY_LABELS,
          'traefik.http.routers.dashboard.rule=Host(`t.example.com`)',
          TYPE,
        ],
      }),
      PROXY,
      false,
    );

    assert.deepEqual(labelsOf(out), [
      'traefik.enable=true',
      'traefik.http.routers.dashboard.rule=Host(`t.example.com`)',
      TYPE,
    ]);
  });

  it('leaves a label of ours with another value, and removes in a map too', () => {
    const edited = TARGET_PROXY_LABELS.map(l =>
      l.endsWith('.priority=1')
        ? 'traefik.http.routers.gluesync-unavailable.priority=9'
        : l,
    );
    const out = removeProxyLabels(
      kitCompose({ proxyLabels: toMap([...edited, TYPE]) }),
      PROXY,
      false,
    );

    assert.deepEqual(labelsOf(out), {
      'traefik.http.routers.gluesync-unavailable.priority': '9',
      'com.molo17.conductor.type': 'third-party',
      'traefik.enable': 'true',
    });
  });

  it('removes the labels key when nothing is left', () => {
    const out = removeProxyLabels(
      kitCompose({ proxyLabels: TARGET_PROXY_LABELS }),
      PROXY,
      false,
    );

    assert.equal('labels' in (out.services?.[PROXY] ?? {}), false);
  });
});

describe('convertLabels', () => {
  const legacy = kitCompose({
    image: 'molo17/traefik:3.7.16.3',
    proxyLabels: ['my.label=1', ...LEGACY_PROXY_LABELS, TYPE],
    legacyServiceLabels: true,
  });

  it('swaps the v0.0.286 labels of the proxy for the target ones, in place', () => {
    const out = convertLabels(legacy, PROXY, false);
    const list = labelsOf(out) as string[];

    assert.deepEqual(
      list.filter(l => !TARGET_PROXY_LABELS.includes(l)),
      ['my.label=1', TYPE],
    );
    assert.ok(TARGET_PROXY_LABELS.every(l => list.includes(l)));
    // shared labels keep their place: traefik.enable stays right after my.label
    assert.equal(list[1], 'traefik.enable=true');
    assert.ok(
      list.every(
        l => !l.includes('error-pages.') && !l.includes('gluesync-errors'),
      ),
    );
    assert.equal(
      list.filter(l => l.includes('gluesync-pages@docker')).length,
      0,
    );
  });

  it('removes the exact v0.0.286 labels of the other services and nothing else', () => {
    const out = convertLabels(legacy, PROXY, false);

    assert.deepEqual(labelsOf(out, 'gluesync-core-hub'), [
      'traefik.enable=true',
      'traefik.http.routers.corehub.entrypoints=websecure',
      'traefik.http.routers.corehub.rule=PathPrefix(`/`)',
      'traefik.http.routers.corehub.tls=true',
      'com.molo17.conductor.type=core-hub',
    ]);
    assert.deepEqual(labelsOf(out, 'gluesync-chronos'), [
      'traefik.enable=true',
      'traefik.http.routers.chronos.rule=PathPrefix(`/chronos/`)',
      'traefik.http.routers.chronos.middlewares=chronos@docker',
      'com.molo17.conductor.type=module',
    ]);
  });

  it('keeps a customer label next to the v0.0.286 ones, even on an -html router', () => {
    const base = legacy.services?.['gluesync-core-hub'];
    const out = convertLabels(
      {
        ...legacy,
        services: {
          ...legacy.services,
          'gluesync-core-hub': {
            ...base,
            image: base?.image ?? '',
            labels: [
              ...(base?.labels as string[]),
              'traefik.http.routers.corehub-html.entrypoints=websecure,web',
              'my.service.label=keep',
            ],
          },
        },
      },
      PROXY,
      false,
    );

    const left = labelsOf(out, 'gluesync-core-hub') as string[];
    assert.ok(left.includes('my.service.label=keep'));
    assert.ok(
      left.includes(
        'traefik.http.routers.corehub-html.entrypoints=websecure,web',
      ),
    );
    assert.ok(!left.includes('traefik.http.routers.corehub.priority=2'));
  });

  it('is a no-op for the service labels of a kit without v0.0.286 wiring', () => {
    const plain = kitCompose({ proxyLabels: [TYPE] });
    const out = convertLabels(plain, PROXY, false);

    assert.deepEqual(
      out.services?.['gluesync-core-hub'],
      plain.services?.['gluesync-core-hub'],
    );
  });
});

describe('removeAllLabels', () => {
  it('removes the target and the v0.0.286 labels, on every service', () => {
    const out = removeAllLabels(
      kitCompose({
        proxyLabels: [...LEGACY_PROXY_LABELS, ...TARGET_PROXY_LABELS, TYPE],
        legacyServiceLabels: true,
      }),
      PROXY,
      false,
    );

    assert.deepEqual(labelsOf(out), [TYPE]);
    assert.ok(
      (labelsOf(out, 'gluesync-core-hub') as string[]).every(
        l => !l.includes('-html') && !l.includes('priority'),
      ),
    );
  });
});
