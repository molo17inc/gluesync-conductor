import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COURIER_LABEL_LIST } from '../../testing/courierInboundFixtures';
import {
  COURIER_LABELS,
  bindsHostPort,
  containerPortFor,
  isCourierRouterLabel,
  portMappings,
  publishesContainerPort,
  tcpPortOf,
} from './courierInboundWiring';

const one = (port: unknown) => {
  const [mapping] = portMappings([port]);
  return mapping;
};

describe('the courier labels', () => {
  it('are exactly the ones the kit puts on Core Hub', () => {
    assert.deepEqual(
      Object.entries(COURIER_LABELS).map(([key, value]) => `${key}=${value}`),
      COURIER_LABEL_LIST,
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
