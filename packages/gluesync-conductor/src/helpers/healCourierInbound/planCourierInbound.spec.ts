import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COURIER_LABEL_LIST,
  COURIER_TRAEFIK,
  PRE_COURIER_TRAEFIK,
  courierKitCompose,
} from '../../testing/courierInboundFixtures';
import type { CourierKitOptions } from '../../testing/courierInboundFixtures';
import planCourierInbound, { WIRING_IN_PLACE } from './planCourierInbound';

const COREHUB = [
  'traefik.enable=true',
  'traefik.http.routers.corehub.rule=PathPrefix(`/`)',
  'com.molo17.conductor.type=core-hub',
];
const WIRED_COREHUB = [...COREHUB, ...COURIER_LABEL_LIST];
const WIRED_PORTS = ['80:80', '443:443', '8090:8090'];

const plan = (
  options: CourierKitOptions = {},
  traefikYamlText = PRE_COURIER_TRAEFIK,
  coreHubServiceName = 'gluesync-core-hub',
) =>
  planCourierInbound({
    composeJson: courierKitCompose(options),
    proxyServiceName: 'reverse-proxy',
    coreHubServiceName,
    traefikYamlText,
  });

const wired = (options: CourierKitOptions = {}) =>
  plan(
    { coreHubLabels: WIRED_COREHUB, proxyPorts: WIRED_PORTS, ...options },
    COURIER_TRAEFIK,
  );

describe('planCourierInbound', () => {
  it('adds the three pieces to a kit made before the wiring', () => {
    assert.deepEqual(plan(), {
      action: 'add',
      reason: 'missing: entry point, proxy port, Core Hub labels',
      missing: ['entry point', 'proxy port', 'Core Hub labels'],
    });
  });

  it('changes nothing on a kit that has the whole wiring', () => {
    assert.deepEqual(wired(), {
      action: 'none',
      reason: WIRING_IN_PLACE,
      missing: [],
    });
  });

  it('adds only what a partly wired kit lacks', () => {
    assert.deepEqual(
      plan({ coreHubLabels: WIRED_COREHUB, proxyPorts: WIRED_PORTS }).missing,
      ['entry point'],
    );
    assert.deepEqual(
      plan({ coreHubLabels: WIRED_COREHUB }, COURIER_TRAEFIK).missing,
      ['proxy port'],
    );
    assert.deepEqual(
      plan({ proxyPorts: WIRED_PORTS }, COURIER_TRAEFIK).missing,
      ['Core Hub labels'],
    );
    // some of the labels only
    assert.deepEqual(
      wired({ coreHubLabels: [...COREHUB, ...COURIER_LABEL_LIST.slice(0, 3)] })
        .missing,
      ['Core Hub labels'],
    );
  });

  it('takes the labels in the map form too', () => {
    const asMap = Object.fromEntries(
      WIRED_COREHUB.map(l => [
        l.slice(0, l.indexOf('=')),
        l.slice(l.indexOf('=') + 1),
      ]),
    );

    assert.equal(wired({ coreHubLabels: asMap }).action, 'none');
  });

  it('keeps the customer port choices: another host port, the long form, a host network', () => {
    assert.equal(wired({ proxyPorts: ['80:80', '9443:8090'] }).action, 'none');
    assert.equal(
      wired({ proxyPorts: [{ target: 8090, published: 8090 }] }).action,
      'none',
    );
    assert.equal(
      wired({
        proxyPorts: [`\${TRAEFIK_COURIER_PORT:-8090}:8090`],
      }).action,
      'none',
    );
    assert.equal(
      wired({ proxyPorts: ['127.0.0.1:8090:8090/tcp'] }).action,
      'none',
    );
    // only UDP on 8090 does not count
    assert.deepEqual(wired({ proxyPorts: ['8090:8090/udp'] }).missing, [
      'proxy port',
    ]);
  });

  it('does not add ports to a proxy on the host network', () => {
    const compose = courierKitCompose({
      coreHubLabels: WIRED_COREHUB,
      proxyPorts: [],
    });
    const proxy = compose.services?.['reverse-proxy'];

    assert.equal(
      planCourierInbound({
        composeJson: {
          ...compose,
          services: {
            ...compose.services,
            'reverse-proxy': { ...proxy, network_mode: 'host' } as never,
          },
        },
        proxyServiceName: 'reverse-proxy',
        coreHubServiceName: 'gluesync-core-hub',
        traefikYamlText: COURIER_TRAEFIK,
      }).action,
      'none',
    );
  });

  it('counts a courier entry point that also has settings of the customer', () => {
    const text = COURIER_TRAEFIK.replace(
      '    address: ":8090"\n',
      '    address: "0.0.0.0:8090"\n    transport:\n      respondingTimeouts:\n        readTimeout: 60s\n',
    );

    assert.equal(wired().action, 'none');
    assert.equal(
      plan({ coreHubLabels: WIRED_COREHUB, proxyPorts: WIRED_PORTS }, text)
        .action,
      'none',
    );
  });

  it('adds the address to a courier key with no value', () => {
    const text = PRE_COURIER_TRAEFIK.replace(
      '    address: ":443"\n',
      '    address: ":443"\n  courier:\n',
    );

    assert.deepEqual(
      plan({ coreHubLabels: WIRED_COREHUB, proxyPorts: WIRED_PORTS }, text)
        .missing,
      ['entry point'],
    );
  });

  describe('opt-out', () => {
    it('is honoured on the reverse-proxy and on Core Hub', () => {
      assert.deepEqual(
        plan({
          proxyLabels: ['com.molo17.conductor.courier-inbound=false'],
        }),
        {
          action: 'none',
          reason: 'com.molo17.conductor.courier-inbound=false',
          missing: [],
        },
      );
      assert.equal(
        plan({
          coreHubLabels: [
            ...COREHUB,
            'com.molo17.conductor.courier-inbound= FALSE',
          ],
        }).action,
        'none',
      );
    });

    it('is only false: any other value adds the wiring', () => {
      assert.equal(
        plan({ proxyLabels: ['com.molo17.conductor.courier-inbound=true'] })
          .action,
        'add',
      );
    });
  });

  describe('skips, with the reason', () => {
    const skipped = (result: ReturnType<typeof plan>, reason: RegExp) => {
      assert.equal(result.action, 'skip');
      assert.match(result.reason, reason);
      assert.deepEqual(result.missing, []);
    };

    it('without the reverse-proxy or Core Hub service', () => {
      skipped(
        planCourierInbound({
          composeJson: courierKitCompose(),
          proxyServiceName: 'traefik',
          coreHubServiceName: 'gluesync-core-hub',
          traefikYamlText: PRE_COURIER_TRAEFIK,
        }),
        /^no reverse-proxy service$/,
      );
      skipped(
        plan({}, PRE_COURIER_TRAEFIK, 'my-core-hub'),
        /^no Core Hub service \(my-core-hub\)$/,
      );
    });

    it('when traefik.yml is not valid, not a mapping or has no websecure', () => {
      skipped(plan({}, 'entryPoints: [\n'), /^traefik\.yml is not valid YAML/);
      skipped(plan({}, '- a\n'), /^traefik\.yml is not a YAML mapping$/);
      skipped(
        plan({}, 'entryPoints:\n  web:\n    address: ":80"\n'),
        /^traefik\.yml has no entryPoints\.websecure$/,
      );
    });

    it('when another entry point already listens on :8090', () => {
      skipped(
        plan(
          {},
          PRE_COURIER_TRAEFIK.replace(
            '    address: ":443"\n',
            '    address: ":443"\n  api:\n    address: "0.0.0.0:8090"\n',
          ),
        ),
        /^entryPoints\.api already listens on :8090$/,
      );
      // UDP on 8090 is not in the way
      assert.equal(
        plan(
          {},
          PRE_COURIER_TRAEFIK.replace(
            '    address: ":443"\n',
            '    address: ":443"\n  dns:\n    address: ":8090/udp"\n',
          ),
        ).action,
        'add',
      );
    });

    it('when the courier entry point listens on another port', () => {
      skipped(
        plan({}, COURIER_TRAEFIK.replace('":8090"', '":9000"')),
        /^entryPoints\.courier is set to ":9000"$/,
      );
      skipped(
        plan(
          {},
          COURIER_TRAEFIK.replace('    address: ":8090"\n', '    http: {}\n'),
        ),
        /^entryPoints\.courier is set to/,
      );
    });

    it('when the proxy sets its entry points on the command line or in the environment', () => {
      const withProxy = (extra: Record<string, unknown>) => {
        const compose = courierKitCompose();
        return planCourierInbound({
          composeJson: {
            ...compose,
            services: {
              ...compose.services,
              'reverse-proxy': {
                ...compose.services?.['reverse-proxy'],
                ...extra,
              } as never,
            },
          },
          proxyServiceName: 'reverse-proxy',
          coreHubServiceName: 'gluesync-core-hub',
          traefikYamlText: PRE_COURIER_TRAEFIK,
        });
      };

      skipped(
        withProxy({ command: ['--entryPoints.web.address=:80'] }),
        /sets its entry points on the command line or in the environment$/,
      );
      skipped(
        withProxy({ command: '--entrypoints.web.address=:80' }),
        /on the command line/,
      );
      skipped(
        withProxy({ environment: ['TRAEFIK_ENTRYPOINTS_WEB_ADDRESS=:80'] }),
        /in the environment$/,
      );
      skipped(
        withProxy({ environment: { TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: ':80' } }),
        /in the environment$/,
      );
      assert.equal(
        withProxy({
          command: ['--log.level=DEBUG'],
          environment: { TZ: 'UTC' },
        }).action,
        'add',
      );
    });

    it('when another service already publishes host port 8090', () => {
      skipped(
        plan({ others: { courier: { image: 'x', ports: ['8090:8080'] } } }),
        /^host port 8090 is already published by courier$/,
      );
      skipped(
        plan({
          others: {
            other: { image: 'x', ports: [{ target: 80, published: '8090' }] },
          },
        }),
        /^host port 8090 is already published by other$/,
      );
    });

    it('when Core Hub publishes 8090 itself', () => {
      const compose = courierKitCompose();
      const coreHub = compose.services?.['gluesync-core-hub'];

      skipped(
        planCourierInbound({
          composeJson: {
            ...compose,
            services: {
              ...compose.services,
              'gluesync-core-hub': {
                ...coreHub,
                ports: ['8765:8765', '8090:8090'],
              } as never,
            },
          },
          proxyServiceName: 'reverse-proxy',
          coreHubServiceName: 'gluesync-core-hub',
          traefikYamlText: PRE_COURIER_TRAEFIK,
        }),
        /^host port 8090 is already published by gluesync-core-hub$/,
      );
    });

    it('when the proxy publishes host port 8090 to another of its ports', () => {
      skipped(
        plan({ proxyPorts: ['80:80', '8090:8443'] }),
        /^reverse-proxy already publishes host port 8090 to its port 8443$/,
      );
    });

    it('when the ports of the proxy are not a list', () => {
      skipped(
        plan({ proxyPorts: '80:80' as never }),
        /^ports of reverse-proxy is not a list$/,
      );
    });

    it('when Traefik does not route Core Hub', () => {
      skipped(
        plan({ coreHubLabels: ['com.molo17.conductor.type=core-hub'] }),
        /^gluesync-core-hub is not routed by Traefik \(traefik\.enable is not set\)$/,
      );
      skipped(
        plan({ coreHubLabels: ['traefik.enable=false'] }),
        /\(traefik\.enable is false\)$/,
      );
    });

    it('when a courier label of Core Hub was customised', () => {
      skipped(
        plan({
          coreHubLabels: [
            ...COREHUB,
            'traefik.http.routers.courier.rule=PathPrefix(`/api/`)',
          ],
        }),
        /^label customised: traefik\.http\.routers\.courier\.rule$/,
      );
    });

    it('when another service defines the courier router or service', () => {
      skipped(
        plan({
          others: {
            courier: {
              image: 'x',
              labels: [
                'traefik.http.routers.courier.rule=Host(`x`)',
                'traefik.http.services.courier.loadbalancer.server.port=80',
              ],
            },
          },
        }),
        /^the courier router or service is already defined on courier$/,
      );
    });
  });
});
