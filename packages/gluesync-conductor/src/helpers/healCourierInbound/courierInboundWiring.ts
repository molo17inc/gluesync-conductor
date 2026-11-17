/**
 * The Courier inbound wiring of the kit: Core Hub serves the Courier pipeline
 * endpoints on a listener of its own, port 8090. Traefik ends TLS on an entry
 * point of the same port and forwards to it: over HTTPS from Core Hub 2.3.2.2,
 * where 8090 is Core Hub's own inbound server and serves HTTPS whenever Core
 * Hub has TLS (the kits always enable it); over plain HTTP before, where 8090
 * was the HTTP Source agent. No error-page middleware on it: the API answers
 * JSON, its errors included.
 */

import {
  compareVersions,
  imageTag,
  parseTagVersion,
} from '../healProxyErrorPages/errorPagesWiring';
import type {
  LabelSet,
  TagVersion,
} from '../healProxyErrorPages/errorPagesWiring';

/** `com.molo17.conductor.courier-inbound=false` on the reverse-proxy or Core Hub: leave the install alone. */
export const OPT_OUT_LABEL = 'com.molo17.conductor.courier-inbound';

export const COURIER_PORT = 8090;
export const COURIER_ENTRYPOINT = 'courier';
export const COURIER_ADDRESS = `:${COURIER_PORT}`;
export const COURIER_PORT_MAPPING = `${COURIER_PORT}:${COURIER_PORT}`;

// `${VAR:-8090}` and `${VAR-8090}` read as their default; any other `$` is unknown
const withDefaults = (text: string): string =>
  text.replaceAll(/\$\{[^}:-]*:?-([^}]*)\}/g, '$1');

/**
 * The comment put above the entry point in traefik.yml. Not the kit's own
 * (which says plain HTTP): the scheme is up to Core Hub's labels, and changes
 * with its version.
 */
export const COURIER_COMMENT: ReadonlyArray<string> = [
  '# Courier inbound (Core Hub port 8090): HTTPS here; to Core Hub as its courier labels say',
  '# (HTTPS from 2.3.2.2). No error-page middleware: the API answers JSON, its errors included.',
];

const ROUTER = `traefik.http.routers.${COURIER_ENTRYPOINT}`;
const SERVICE = `traefik.http.services.${COURIER_ENTRYPOINT}`;

/** How Traefik reaches Core Hub's port 8090. */
export type CourierScheme = 'http' | 'https';

/** The label that carries the scheme; the one label whose kit value changes with Core Hub. */
export const COURIER_SCHEME_LABEL = `${SERVICE}.loadbalancer.server.scheme`;

/** Values of the scheme label this code may have written: the others are the customer's. */
export const KIT_SCHEMES: ReadonlyArray<string> = ['http', 'https'];

/** Core Hub from this version serves port 8090 itself, over HTTPS. */
export const HTTPS_INBOUND_FROM: TagVersion = [2, 3, 2, 2];

/**
 * The scheme Core Hub of this image needs: `https` for 2.3.2.2 or later, and
 * for a tag that does not start with a dotted number (`latest`, `develop`,
 * none), `http` for an older version. `${VAR:-x}` reads as its default.
 */
export const courierScheme = (coreHubImage: unknown): CourierScheme => {
  const version =
    typeof coreHubImage === 'string'
      ? parseTagVersion(imageTag(withDefaults(coreHubImage)))
      : undefined;

  return version !== undefined &&
    compareVersions(version, HTTPS_INBOUND_FROM) < 0
    ? 'http'
    : 'https';
};

/** Labels of the Core Hub service, for the scheme its version needs. */
export const courierLabels = (scheme: CourierScheme): LabelSet => ({
  [`${ROUTER}.entrypoints`]: COURIER_ENTRYPOINT,
  [`${ROUTER}.rule`]: 'PathPrefix(`/api-inbound/`)',
  [`${ROUTER}.tls`]: 'true',
  [`${ROUTER}.service`]: COURIER_ENTRYPOINT,
  [`${SERVICE}.loadbalancer.server.port`]: String(COURIER_PORT),
  [COURIER_SCHEME_LABEL]: scheme,
  [`${SERVICE}.loadbalancer.passhostheader`]: 'true',
});

/** The courier labels a Core Hub service of the compose file needs, from its image. */
export const courierLabelsFor = (coreHub: unknown): LabelSet =>
  courierLabels(
    courierScheme(
      typeof coreHub === 'object' && coreHub !== null
        ? (coreHub as Readonly<Record<string, unknown>>).image
        : undefined,
    ),
  );

/** A label of the courier router or service, ours or not. */
export const isCourierRouterLabel = (key: string): boolean =>
  key.startsWith(`${ROUTER}.`) || key.startsWith(`${SERVICE}.`);

// ------------------------------------------------------------------ ports

type Range = readonly [number, number];

/** One published port of a compose service, as far as it can be read. */
export type PortMapping = Readonly<{
  /** Host ports; undefined when none is fixed (`"8090"`), 'unknown' when interpolated. */
  host: Range | 'unknown' | undefined;
  container: Range | 'unknown';
  protocol: string;
}>;

const parseRange = (text: string): Range | 'unknown' => {
  const match = /^(\d+)(?:-(\d+))?$/.exec(withDefaults(text).trim());

  if (!match) {
    return 'unknown';
  }

  const low = Number(match[1]);

  return [low, match[2] === undefined ? low : Number(match[2])];
};

// The host part of `[ip:](host):container`, `ip::container` or `container`
const hostPart = (beforeContainer: string | undefined): string | undefined => {
  if (beforeContainer === undefined) {
    return undefined;
  }

  const colon = beforeContainer.endsWith(']')
    ? -1
    : beforeContainer.lastIndexOf(':');

  return beforeContainer.slice(colon + 1);
};

const parseShort = (spec: string): PortMapping => {
  const [body, protocol = 'tcp'] = withDefaults(spec).split('/');
  const colon = body.lastIndexOf(':');
  const host = hostPart(colon < 0 ? undefined : body.slice(0, colon));

  return {
    host: host === undefined || host === '' ? undefined : parseRange(host),
    container: parseRange(body.slice(colon + 1)),
    protocol: protocol.toLowerCase(),
  };
};

// A field of the long form as text: a string or a number, anything else is no value
const scalarText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const parseLong = (port: Readonly<Record<string, unknown>>): PortMapping => {
  const published = scalarText(port.published);

  return {
    host: published === '' ? undefined : parseRange(published),
    container: parseRange(scalarText(port.target)),
    protocol: (scalarText(port.protocol) || 'tcp').toLowerCase(),
  };
};

/** The published ports of a service; an entry that is neither form is left out. */
export const portMappings = (ports: unknown): ReadonlyArray<PortMapping> =>
  (Array.isArray(ports) ? ports : []).flatMap(port => {
    if (typeof port === 'string' || typeof port === 'number') {
      return [parseShort(String(port))];
    }

    return typeof port === 'object' && port !== null
      ? [parseLong(port as Record<string, unknown>)]
      : [];
  });

const inRange = (range: Range | 'unknown' | undefined, port: number) =>
  Array.isArray(range) && range[0] <= port && port <= range[1];

const isTcp = (mapping: PortMapping): boolean => mapping.protocol === 'tcp';

/** TCP mapping that binds this port on the host. */
export const bindsHostPort = (mapping: PortMapping, port: number): boolean =>
  isTcp(mapping) && inRange(mapping.host, port);

/** TCP mapping that publishes this port of the container, on whichever host port. */
export const publishesContainerPort = (
  mapping: PortMapping,
  port: number,
): boolean => isTcp(mapping) && inRange(mapping.container, port);

/** Container port a host port reaches through the mapping (ranges map one to one). */
export const containerPortFor = (
  mapping: PortMapping,
  hostPort: number,
): number | undefined => {
  const { host, container } = mapping;

  if (!Array.isArray(host) || !Array.isArray(container)) {
    return undefined;
  }

  return container[0] === container[1]
    ? container[0]
    : container[0] + (hostPort - host[0]);
};

// ------------------------------------------------------------ entry points

/** Port a Traefik entry point address (`[host]:port[/tcp|/udp]`) listens on over TCP. */
export const tcpPortOf = (address: unknown): number | undefined => {
  const match =
    typeof address === 'string'
      ? /:(\d+)(?:\/(tcp|udp))?$/i.exec(address.trim())
      : null;

  return match && (match[2] ?? 'tcp').toLowerCase() === 'tcp'
    ? Number(match[1])
    : undefined;
};
