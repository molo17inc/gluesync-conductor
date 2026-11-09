import type { RawComposeFile } from '../models/composeFile.model';

/** proxy/traefik.yml of the shipped kit. */
export const KIT_TRAEFIK = `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

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
# api:
#   dashboard: true
#   insecure: true
`;

/** A customer's own proxy: ACME resolver, TLS, their middleware, a comment on every part. */
export const USER_TRAEFIK = `# Customer proxy, production. Do not touch.
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ":443"
    http:
      tls:
        certResolver: letsencrypt # real certificates
      middlewares:
        - security-headers@file
        - ratelimit@file

certificatesResolvers:
  letsencrypt:
    acme:
      email: ops@example.com
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web

log:
  level: DEBUG # customer wants DEBUG
  filePath: /var/log/traefik.log
providers:
  docker:
    exposedByDefault: false
`;

/** proxy/traefik.yml of a trial kit v0.0.286. */
export const LEGACY_TRAEFIK = `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  # Internal only (not published in compose): serves the MOLO17 error pages to the errors middleware.
  errorpages:
    address: ":8099"

# Error pages: Traefik local plugin, baked into the molo17/traefik image (/plugins-local).
experimental:
  localPlugins:
    gluesyncerrorpages:
      moduleName: github.com/molo17/gluesyncerrorpages

log:
  level: INFO

providers:
  docker:
    exposedByDefault: false
`;

export const CERTS_YML = `tls:
  certificates:
    - certFile: /etc/traefik/gluesync-cert.pem
      keyFile: /etc/traefik/gluesync-key.pem
`;

/** What v0.0.286 put on the reverse-proxy (Linux). */
export const LEGACY_PROXY_LABELS: ReadonlyArray<string> = [
  'traefik.enable=true',
  'traefik.http.middlewares.gluesync-pages.plugin.gluesyncerrorpages.root=/gluesync/error-pages',
  'traefik.http.routers.error-pages.entrypoints=errorpages',
  'traefik.http.routers.error-pages.rule=PathPrefix(`/`)',
  'traefik.http.routers.error-pages.service=noop@internal',
  'traefik.http.routers.error-pages.middlewares=gluesync-pages@docker',
  'traefik.http.services.error-pages.loadbalancer.server.port=8099',
  'traefik.http.middlewares.gluesync-errors.errors.status=404,500-503',
  'traefik.http.middlewares.gluesync-errors.errors.service=error-pages',
  'traefik.http.middlewares.gluesync-errors.errors.query=/{status}.html',
  'traefik.http.routers.gluesync-unavailable.rule=PathPrefix(`/`)',
  'traefik.http.routers.gluesync-unavailable.priority=1',
  'traefik.http.routers.gluesync-unavailable.entrypoints=websecure',
  'traefik.http.routers.gluesync-unavailable.tls=true',
  'traefik.http.routers.gluesync-unavailable.service=noop@internal',
  'traefik.http.routers.gluesync-unavailable.middlewares=gluesync-pages@docker',
];

/** What the target wiring puts on the reverse-proxy (Linux). */
export const TARGET_PROXY_LABELS: ReadonlyArray<string> = [
  'traefik.enable=true',
  'traefik.http.middlewares.gluesync-pages.plugin.gluesyncerrorpages.root=/gluesync/error-pages',
  'traefik.http.middlewares.gluesync-pages.plugin.gluesyncerrorpages.mode=wrap',
  'traefik.http.middlewares.gluesync-unavailable.plugin.gluesyncerrorpages.root=/gluesync/error-pages',
  'traefik.http.middlewares.gluesync-unavailable.plugin.gluesyncerrorpages.mode=unavailable',
  'traefik.http.routers.gluesync-unavailable.rule=PathPrefix(`/`)',
  'traefik.http.routers.gluesync-unavailable.priority=1',
  'traefik.http.routers.gluesync-unavailable.entrypoints=websecure',
  'traefik.http.routers.gluesync-unavailable.tls=true',
  'traefik.http.routers.gluesync-unavailable.service=noop@internal',
  'traefik.http.routers.gluesync-unavailable.middlewares=gluesync-unavailable@docker',
];

const COREHUB_LABELS: ReadonlyArray<string> = [
  'traefik.enable=true',
  'traefik.http.routers.corehub.entrypoints=websecure',
  'traefik.http.routers.corehub.rule=PathPrefix(`/`)',
  'traefik.http.routers.corehub.tls=true',
  'com.molo17.conductor.type=core-hub',
];

const LEGACY_COREHUB_LABELS: ReadonlyArray<string> = [
  'traefik.http.routers.corehub.priority=2',
  'traefik.http.routers.corehub-html.rule=(PathPrefix(`/`)) && HeaderRegexp(`Accept`, `text/html`)',
  'traefik.http.routers.corehub-html.priority=3',
  'traefik.http.routers.corehub-html.entrypoints=websecure',
  'traefik.http.routers.corehub-html.tls=true',
  'traefik.http.routers.corehub-html.service=corehub',
  'traefik.http.routers.corehub-html.middlewares=gluesync-errors@docker',
];

const CHRONOS_LABELS: ReadonlyArray<string> = [
  'traefik.enable=true',
  'traefik.http.routers.chronos.rule=PathPrefix(`/chronos/`)',
  'traefik.http.routers.chronos.middlewares=chronos@docker',
  'com.molo17.conductor.type=module',
];

const LEGACY_CHRONOS_LABELS: ReadonlyArray<string> = [
  'traefik.http.routers.chronos-html.rule=(PathPrefix(`/chronos/`)) && HeaderRegexp(`Accept`, `text/html`)',
  'traefik.http.routers.chronos-html.entrypoints=websecure',
  'traefik.http.routers.chronos-html.tls=true',
  'traefik.http.routers.chronos-html.service=chronos',
  'traefik.http.routers.chronos-html.middlewares=chronos@docker,gluesync-errors@docker',
];

export type KitOptions = Readonly<{
  image?: string;
  proxyLabels?: ReadonlyArray<string> | Record<string, string>;
  legacyServiceLabels?: boolean;
  proxyVolumes?: ReadonlyArray<string>;
}>;

/** The compose file of a kit, as the JSON the Conductor reads. */
export const kitCompose = ({
  image = 'molo17/traefik:3.6.2',
  proxyLabels = ['com.molo17.conductor.type=third-party'],
  legacyServiceLabels = false,
  proxyVolumes = [
    '/var/run/docker.sock:/var/run/docker.sock',
    './proxy/traefik.yml:/etc/traefik/traefik.yml:ro',
    './proxy/certs.yml:/etc/traefik/certs.yml:ro',
  ],
}: KitOptions = {}): Partial<RawComposeFile> => ({
  name: 'gluesync',
  services: {
    'gluesync-core-hub': {
      image: 'molo17/gluesync-core-hub:2.3.0.0',
      labels: legacyServiceLabels
        ? [...COREHUB_LABELS, ...LEGACY_COREHUB_LABELS]
        : COREHUB_LABELS,
    },
    'gluesync-chronos': {
      image: 'molo17/gluesync-chronos:0.2.1',
      labels: legacyServiceLabels
        ? [...CHRONOS_LABELS, ...LEGACY_CHRONOS_LABELS]
        : CHRONOS_LABELS,
    },
    'reverse-proxy': {
      image,
      volumes: proxyVolumes,
      labels: proxyLabels,
    },
  },
});

/** The same kit as the text of docker-compose.yml, with comments to keep. */
export const kitComposeText = (
  image: string,
  proxyLabels: ReadonlyArray<string>,
): string => `# kit header: keep me
name: gluesync

services:
  gluesync-core-hub:
    image: molo17/gluesync-core-hub:2.3.0.0
    labels:
      # core hub router
      - traefik.enable=true
      - com.molo17.conductor.type=core-hub

  reverse-proxy:
    restart: unless-stopped
    image: ${image}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /PROXY_DIR/traefik.yml:/etc/traefik/traefik.yml:ro
      - /PROXY_DIR/certs.yml:/etc/traefik/certs.yml:ro
    labels:
      # the proxy is third-party
${proxyLabels.map(l => `      - ${l}`).join('\n')}
      - com.molo17.conductor.type=third-party
`;
