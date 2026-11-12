import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

import { USER_TRAEFIK } from '../../testing/proxyErrorPagesFixtures';
import {
  COURIER_LABEL_LIST,
  COURIER_TRAEFIK,
  PRE_COURIER_TRAEFIK,
  courierKitCompose,
} from '../../testing/courierInboundFixtures';
import applyCourierInboundPlan, {
  addCoreHubLabels,
  addCourierEntryPoint,
  addProxyPort,
} from './applyCourierInboundPlan';
import type { CourierInboundPlan } from './healCourierInbound.model';
import planCourierInbound from './planCourierInbound';

const ALL: CourierInboundPlan = {
  action: 'add',
  reason: 'missing: entry point, proxy port, Core Hub labels',
  missing: ['entry point', 'proxy port', 'Core Hub labels'],
};

describe('addCourierEntryPoint', () => {
  it('gives the kit file exactly what the kit ships', () => {
    assert.equal(addCourierEntryPoint(PRE_COURIER_TRAEFIK), COURIER_TRAEFIK);
  });

  it('leaves a file that has the entry point as it is', () => {
    assert.equal(addCourierEntryPoint(COURIER_TRAEFIK), COURIER_TRAEFIK);
    const custom = COURIER_TRAEFIK.replace('":8090"', '"0.0.0.0:8090"');
    assert.equal(addCourierEntryPoint(custom), custom);
  });

  it('adds it after the last entry point of a customer file, only those lines', () => {
    const next = addCourierEntryPoint(USER_TRAEFIK);
    const added = `        - ratelimit@file
  # Courier inbound (HTTP Source agent in Core Hub): HTTPS here, plain HTTP to the agent on the
  # internal network. No error-page middleware: the API answers JSON, its errors included.
  courier:
    address: ":8090"
`;

    assert.ok(next.includes(added));
    assert.equal(
      next.replace(added, '        - ratelimit@file\n'),
      USER_TRAEFIK,
    );
    assert.deepEqual(parse(next).entryPoints.courier, { address: ':8090' });
  });

  it('follows the indentation of the file', () => {
    const four = 'entryPoints:\n    websecure:\n        address: ":443"\n';

    assert.equal(
      addCourierEntryPoint(four),
      `${four}    # Courier inbound (HTTP Source agent in Core Hub): HTTPS here, plain HTTP to the agent on the
    # internal network. No error-page middleware: the API answers JSON, its errors included.
    courier:
        address: ":8090"
`,
    );
  });

  it('keeps CRLF line ends and a missing final newline', () => {
    const crlf = 'entryPoints:\r\n  websecure:\r\n    address: ":443"\r\n';
    const next = addCourierEntryPoint(crlf);

    assert.ok(next.endsWith('  courier:\r\n    address: ":8090"\r\n'));
    assert.ok(!/[^\r]\n/.test(next));

    const bare = 'entryPoints:\n  websecure:\n    address: ":443"';
    assert.ok(
      addCourierEntryPoint(bare).endsWith('\n  courier:\n    address: ":8090"'),
    );
  });

  it('gives a courier key with no value just its address', () => {
    const text =
      'entryPoints:\n  websecure:\n    address: ":443"\n  courier:\nlog:\n  level: INFO\n';

    assert.equal(
      addCourierEntryPoint(text),
      'entryPoints:\n  websecure:\n    address: ":443"\n  courier:\n    address: ":8090"\nlog:\n  level: INFO\n',
    );
  });

  it('throws an unsafe layout on a file it cannot splice', () => {
    assert.throws(
      () =>
        addCourierEntryPoint('entryPoints: {websecure: {address: ":443"}}\n'),
      /not a block mapping/,
    );
    assert.throws(
      () => addCourierEntryPoint('log:\n  level: INFO\n'),
      /no entry points to add to/,
    );
    assert.throws(
      () => addCourierEntryPoint('entryPoints:\nlog:\n  level: INFO\n'),
      /no entry points to add to/,
    );
    assert.throws(() => addCourierEntryPoint('- a\n'), /not a YAML mapping/);
  });
});

describe('compose transforms', () => {
  it('appends 8090:8090 to the ports of the proxy, creating the list when there is none', () => {
    const compose = courierKitCompose();

    assert.deepEqual(
      addProxyPort(compose, 'reverse-proxy').services?.['reverse-proxy']?.ports,
      ['80:80', '443:443', '8090:8090'],
    );

    const noPorts = courierKitCompose({ proxyPorts: undefined });
    const proxy = { ...noPorts.services?.['reverse-proxy'] };
    delete (proxy as Record<string, unknown>).ports;

    assert.deepEqual(
      addProxyPort(
        {
          ...noPorts,
          services: { ...noPorts.services, 'reverse-proxy': proxy as never },
        },
        'reverse-proxy',
      ).services?.['reverse-proxy']?.ports,
      ['8090:8090'],
    );

    // a service that is not there is not created
    assert.deepEqual(addProxyPort(compose, 'nothing'), compose);
  });

  it('appends the missing courier labels to Core Hub, in the form the file uses', () => {
    const list = addCoreHubLabels(
      courierKitCompose({
        coreHubLabels: ['traefik.enable=true', COURIER_LABEL_LIST[0]],
      }),
      'gluesync-core-hub',
    );

    assert.deepEqual(list.services?.['gluesync-core-hub']?.labels, [
      'traefik.enable=true',
      ...COURIER_LABEL_LIST,
    ]);

    const map = addCoreHubLabels(
      courierKitCompose({ coreHubLabels: { 'traefik.enable': 'true' } }),
      'gluesync-core-hub',
    );

    assert.deepEqual(map.services?.['gluesync-core-hub']?.labels, {
      'traefik.enable': 'true',
      ...Object.fromEntries(
        COURIER_LABEL_LIST.map(l => [
          l.slice(0, l.indexOf('=')),
          l.slice(l.indexOf('=') + 1),
        ]),
      ),
    });
  });
});

describe('applyCourierInboundPlan', () => {
  const files = {
    composeJson: courierKitCompose(),
    traefikYamlText: PRE_COURIER_TRAEFIK,
  };

  it('adds every missing piece, and the result plans nothing more', () => {
    const applied = applyCourierInboundPlan(
      files,
      ALL,
      'reverse-proxy',
      'gluesync-core-hub',
    );

    assert.ok(applied.ok);
    assert.equal(applied.files.traefikYamlText, COURIER_TRAEFIK);
    assert.equal(
      planCourierInbound({
        composeJson: applied.files.composeJson,
        proxyServiceName: 'reverse-proxy',
        coreHubServiceName: 'gluesync-core-hub',
        traefikYamlText: applied.files.traefikYamlText,
      }).action,
      'none',
    );
  });

  it('adds only the pieces of the plan', () => {
    const applied = applyCourierInboundPlan(
      files,
      { ...ALL, missing: ['Core Hub labels'] },
      'reverse-proxy',
      'gluesync-core-hub',
    );

    assert.ok(applied.ok);
    assert.equal(applied.files.traefikYamlText, PRE_COURIER_TRAEFIK);
    assert.deepEqual(
      applied.files.composeJson.services?.['reverse-proxy'],
      files.composeJson.services?.['reverse-proxy'],
    );
  });

  it('returns the files as they are for a plan that adds nothing', () => {
    const applied = applyCourierInboundPlan(
      files,
      { action: 'none', reason: 'x', missing: ['entry point'] },
      'reverse-proxy',
      'gluesync-core-hub',
    );

    assert.deepEqual(applied, { ok: true, files });
  });

  it('says why when traefik.yml cannot be spliced, and changes nothing', () => {
    assert.deepEqual(
      applyCourierInboundPlan(
        { ...files, traefikYamlText: 'entryPoints: {websecure: {}}\n' },
        ALL,
        'reverse-proxy',
        'gluesync-core-hub',
      ),
      {
        ok: false,
        reason: 'traefik.yml layout: entryPoints is not a block mapping',
      },
    );
  });
});
