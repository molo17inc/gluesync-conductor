import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COURIER_LABEL_LIST,
  COURIER_LABEL_LIST_HTTPS,
} from '../../testing/courierInboundFixtures';
import {
  bindsHostPort,
  containerPortFor,
  courierLabels,
  courierLabelsFor,
  courierScheme,
  isCourierRouterLabel,
  portMappings,
  publishesContainerPort,
  tcpPortOf,
} from './courierInboundWiring';

const one = (port: unknown) => {
  const [mapping] = portMappings([port]);
  return mapping;
};

const asList = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([key, value]) => `${key}=${value}`);

describe('the courier labels', () => {
  it('are exactly the ones the kit puts on Core Hub, with http', () => {
    assert.deepEqual(asList(courierLabels('http')), COURIER_LABEL_LIST);
  });

  it('differ only in the scheme for https', () => {
    assert.deepEqual(asList(courierLabels('https')), COURIER_LABEL_LIST_HTTPS);
  });

  it('follow the Core Hub image of the service', () => {
    assert.deepEqual(
      asList(courierLabelsFor({ image: 'molo17/gluesync-core-hub:2.3.2.2' })),
      COURIER_LABEL_LIST_HTTPS,
    );
    assert.deepEqual(
      asList(courierLabelsFor({ image: 'molo17/gluesync-core-hub:2.3.2.1' })),
      COURIER_LABEL_LIST,
    );
    assert.deepEqual(
      asList(courierLabelsFor(undefined)),
      COURIER_LABEL_LIST_HTTPS,
    );
  });

  it('tells a label of the courier router or service from the others', () => {
    assert.ok(isCourierRouterLabel('traefik.http.routers.courier.rule'));
    assert.ok(
      isCourierRouterLabel('traefik.http.services.courier.loadbalancer.x'),
    );
    assert.ok(!isCourierRouterLabel('traefik.http.routers.courierx.rule'));
    assert.ok(!isCourierRouterLabel('traefik.http.routers.corehub.rule'));
  });
});

describe('courierScheme', () => {
  it('is https from Core Hub 2.3.2.2', () => {
    [
      'molo17/gluesync-core-hub:2.3.2.2',
      'molo17/gluesync-core-hub:2.3.2.10',
      'molo17/gluesync-core-hub:2.3.3.0',
      'molo17/gluesync-core-hub:2.4',
      'molo17/gluesync-core-hub:3.0.0.0-debian',
      'molo17/gluesync-core-hub:2.3.2.2.develop',
      'registry.example.com:5000/molo17/gluesync-core-hub:2.3.2.2',
      'molo17/gluesync-core-hub:2.3.2.2@sha256:abc',
    ].forEach(image => assert.equal(courierScheme(image), 'https', image));
  });

  it('is http before 2.3.2.2', () => {
    [
      'molo17/gluesync-core-hub:2.3.2.1',
      'molo17/gluesync-core-hub:2.3.2',
      'molo17/gluesync-core-hub:2.3.0.0',
      'molo17/gluesync-core-hub:2.2.11.6-debian',
      'molo17/gluesync-core-hub:2.3.1.0-win-ltsc2022',
      `molo17/gluesync-core-hub:\${COREHUB_TAG:-2.3.0.0}`,
    ].forEach(image => assert.equal(courierScheme(image), 'http', image));
  });

  it('is https for a tag that is not a dotted number, or no tag at all', () => {
    [
      'molo17/gluesync-core-hub:latest',
      'molo17/gluesync-core-hub:develop',
      'molo17/gluesync-core-hub:v2.3.0.0',
      'molo17/gluesync-core-hub',
      `molo17/gluesync-core-hub:\${COREHUB_TAG}`,
      undefined,
      42,
    ].forEach(image => assert.equal(courierScheme(image), 'https', `${image}`));
  });
});

describe('portMappings', () => {
  it('reads the short forms', () => {
    assert.deepEqual(one('8090:8090'), {
      host: [8090, 8090],
      container: [8090, 8090],
      protocol: 'tcp',
    });
    assert.deepEqual(one('127.0.0.1:9090:8090/TCP'), {
      host: [9090, 9090],
      container: [8090, 8090],
      protocol: 'tcp',
    });
    assert.deepEqual(one('[::1]:8090:80'), {
      host: [8090, 8090],
      container: [80, 80],
      protocol: 'tcp',
    });
    assert.deepEqual(one('127.0.0.1::8090'), {
      host: undefined,
      container: [8090, 8090],
      protocol: 'tcp',
    });
    assert.deepEqual(one(8090), {
      host: undefined,
      container: [8090, 8090],
      protocol: 'tcp',
    });
    assert.deepEqual(one('8000-8100:9000-9100/udp'), {
      host: [8000, 8100],
      container: [9000, 9100],
      protocol: 'udp',
    });
  });

  it('reads an interpolation with a default as its default, any other as unknown', () => {
    assert.deepEqual(
      one(`\${TRAEFIK_COURIER_PORT:-8090}:8090`).host,
      [8090, 8090],
    );
    assert.deepEqual(
      one(`\${TRAEFIK_COURIER_PORT-8091}:8090`).host,
      [8091, 8091],
    );
    assert.equal(one(`\${TRAEFIK_COURIER_PORT}:8090`).host, 'unknown');
  });

  it('reads the long form', () => {
    assert.deepEqual(one({ target: 8090, published: '8090' }), {
      host: [8090, 8090],
      container: [8090, 8090],
      protocol: 'tcp',
    });
    assert.deepEqual(one({ target: 8090, protocol: 'udp' }), {
      host: undefined,
      container: [8090, 8090],
      protocol: 'udp',
    });
    assert.equal(one({ published: 8090 }).container, 'unknown');
  });

  it('leaves out what is neither form, and anything that is not a list', () => {
    assert.deepEqual(portMappings([null, true]), []);
    assert.deepEqual(portMappings('8090:8090'), []);
    assert.deepEqual(portMappings(undefined), []);
  });
});

describe('port checks', () => {
  it('binds a host port over TCP only', () => {
    assert.ok(bindsHostPort(one('8090:80'), 8090));
    assert.ok(bindsHostPort(one('8000-8100:8000-8100'), 8090));
    assert.ok(!bindsHostPort(one('8090:8090/udp'), 8090));
    assert.ok(!bindsHostPort(one('8090'), 8090));
    assert.ok(!bindsHostPort(one(`\${X}:8090`), 8090));
  });

  it('publishes a container port on whichever host port', () => {
    assert.ok(publishesContainerPort(one('9443:8090'), 8090));
    assert.ok(publishesContainerPort(one('8090'), 8090));
    assert.ok(!publishesContainerPort(one('8090:80'), 8090));
    assert.ok(!publishesContainerPort(one('8090:8090/udp'), 8090));
  });

  it('maps a host port of a range one to one', () => {
    assert.equal(containerPortFor(one('8000-8100:9000-9100'), 8090), 9090);
    assert.equal(containerPortFor(one('8000-8100:80'), 8090), 80);
    assert.equal(containerPortFor(one('8090'), 8090), undefined);
  });
});

describe('tcpPortOf', () => {
  it('reads the TCP port of an entry point address', () => {
    assert.equal(tcpPortOf(':8090'), 8090);
    assert.equal(tcpPortOf('0.0.0.0:8090/tcp'), 8090);
    assert.equal(tcpPortOf('[::]:8090'), 8090);
    assert.equal(tcpPortOf(':8090/udp'), undefined);
    assert.equal(tcpPortOf('nonsense'), undefined);
    assert.equal(tcpPortOf(8090), undefined);
  });
});
