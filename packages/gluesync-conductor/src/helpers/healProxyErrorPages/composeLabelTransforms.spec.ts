import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEGACY_PROXY_LABELS,
  TARGET_PROXY_LABELS,
  kitCompose,
} from '../../testing/proxyErrorPagesFixtures';
import {
  addTargetLabels,
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
