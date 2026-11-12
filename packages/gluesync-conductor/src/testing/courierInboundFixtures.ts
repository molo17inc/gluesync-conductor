import type { RawComposeFile } from '../models/composeFile.model';

/** The courier labels of Core Hub, as the kit writes them. */
export const COURIER_LABEL_LIST: ReadonlyArray<string> = [
  'traefik.http.routers.courier.entrypoints=courier',
  'traefik.http.routers.courier.rule=PathPrefix(`/api-inbound/`)',
  'traefik.http.routers.courier.tls=true',
  'traefik.http.routers.courier.service=courier',
  'traefik.http.services.courier.loadbalancer.server.port=8090',
  'traefik.http.services.courier.loadbalancer.server.scheme=http',
  'traefik.http.services.courier.loadbalancer.passhostheader=true',
];

const COREHUB_LABELS: ReadonlyArray<string> = [
  'traefik.enable=true',
  'traefik.http.routers.corehub.entrypoints=websecure',
  'traefik.http.routers.corehub.rule=PathPrefix(`/`)',
  'traefik.http.routers.corehub.tls=true',
  'traefik.http.services.corehub.loadbalancer.server.port=1717',
  'com.molo17.conductor.type=core-hub',
];

/** traefik.yml of a kit made before the Courier wiring. */
export const PRE_COURIER_TRAEFIK = `entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
  websecure:
    address: ":443"

log:
  level: INFO

providers:
  docker:
    exposedByDefault: false
  file:
    filename: "/etc/traefik/certs.yml"
    watch: true
`;

/** The same file as a kit with the Courier wiring ships it. */
export const COURIER_TRAEFIK = `entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
          permanent: true
  websecure:
    address: ":443"
  # Courier inbound (HTTP Source agent in Core Hub): HTTPS here, plain HTTP to the agent on the
  # internal network. No error-page middleware: the API answers JSON, its errors included.
  courier:
    address: ":8090"

log:
  level: INFO

providers:
  docker:
    exposedByDefault: false
  file:
    filename: "/etc/traefik/certs.yml"
    watch: true
`;

export type CourierKitOptions = Readonly<{
  proxyPorts?: ReadonlyArray<unknown>;
  coreHubLabels?: ReadonlyArray<string> | Record<string, string>;
  proxyLabels?: ReadonlyArray<string>;
  others?: Record<string, unknown>;
}>;

/** The compose file of a kit made before the Courier wiring, as the JSON the Conductor reads. */
export const courierKitCompose = ({
  proxyPorts = ['80:80', '443:443'],
  coreHubLabels = COREHUB_LABELS,
  proxyLabels = ['com.molo17.conductor.type=third-party'],
  others = {},
}: CourierKitOptions = {}): Partial<RawComposeFile> =>
  ({
    name: 'gluesync',
    services: {
      'gluesync-core-hub': {
        image: 'molo17/gluesync-core-hub:2.3.0.0',
        ports: ['8765:8765'],
        labels: coreHubLabels,
      },
      'reverse-proxy': {
        image: 'molo17/traefik:3.7.16.3',
        ports: proxyPorts,
        volumes: ['./proxy:/etc/traefik:ro'],
        labels: proxyLabels,
      },
      ...others,
    },
  }) as Partial<RawComposeFile>;

/** The same kit as the text of docker-compose.yml, with comments to keep. */
export const courierKitComposeText = (
  coreHubLabels: ReadonlyArray<string> = COREHUB_LABELS,
  proxyPorts: ReadonlyArray<string> = ['80:80', '443:443'],
): string => `# kit header: keep me
name: gluesync

services:
  gluesync-core-hub:
    image: molo17/gluesync-core-hub:2.3.0.0
    ports:
      - 8765:8765
    labels:
      # core hub router
${coreHubLabels.map(l => `      - ${l}`).join('\n')}

  reverse-proxy:
    restart: unless-stopped
    image: molo17/traefik:3.7.16.3
    ports:
      # the published ports
${proxyPorts.map(p => `      - ${p}`).join('\n')}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /PROXY_DIR/traefik.yml:/etc/traefik/traefik.yml:ro
    labels:
      - com.molo17.conductor.type=third-party
`;
