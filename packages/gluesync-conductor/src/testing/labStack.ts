import { parse } from 'yaml';

import { RawComposeFile } from '../models/composeFile.model';

/**
 * A realistic Swarm stack file (namespace `gluesync`): long-syntax ports and
 * volumes, deploy blocks, secrets and configs, and `${VAR:-default}`
 * interpolations that Conductor leaves as written.
 */
export const labStackYaml = `
name: gluesync
services:
  reverse-proxy:
    image: traefik:v3.1
    command:
      - --providers.swarm.endpoint=unix:///var/run/docker.sock
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
    ports:
      - target: 80
        published: 80
        protocol: tcp
        mode: ingress
      - target: 443
        published: 443
        protocol: tcp
        mode: ingress
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    secrets:
      - source: proxy-cert
        target: proxy.crt
        mode: 0400
    networks:
      - gluesync-net
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager

  gluesync-core-hub:
    image: molo17/gluesync-core-hub:\${CORE_HUB_TAG:-2.3.0}
    environment:
      GLUESYNC_ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      JAVA_OPTS: -Xmx\${CORE_HUB_HEAP:-4g}
    volumes:
      - type: bind
        source: /srv/gluesync/data
        target: /opt/gluesync/data
      - type: bind
        source: /srv/gluesync/logs
        target: /opt/gluesync/logs
        read_only: true
    sysctls:
      - net.core.somaxconn=1024
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    networks:
      - gluesync-net
    labels:
      - com.molo17.conductor.type=core-hub
    deploy:
      replicas: 1
      labels:
        - traefik.enable=true
        - traefik.http.routers.hub.rule=Host(\`\${HUB_HOST:-hub.local}\`)
        - traefik.http.services.hub.loadbalancer.server.port=1717
      placement:
        constraints:
          - node.labels.gluesync.data == true
      update_config:
        failure_action: rollback
        monitor: 30s
      resources:
        limits:
          cpus: 4
          memory: 8G

  gluesync-chronos:
    image: molo17/gluesync-chronos:0.2.4
    networks:
      - gluesync-net
    labels:
      com.molo17.conductor.type: module
    deploy:
      replicas: 1

  prometheus:
    image: prom/prometheus:v2.54.1
    configs:
      - source: prometheus-yml
        target: /etc/prometheus/prometheus.yml
    volumes:
      - type: volume
        source: prometheus-data
        target: /prometheus
    networks:
      - gluesync-net
    labels:
      - com.molo17.conductor.type=third-party
    deploy:
      replicas: 1

  grafana:
    image: molo17/grafana:13.0.2.dashboard3
    user: "472:472"
    ports:
      - target: 3000
        published: 3000
        mode: host
    volumes:
      - type: volume
        source: grafana-data
        target: /var/lib/grafana
    networks:
      - gluesync-net
    labels:
      - com.molo17.conductor.type=third-party
    deploy:
      replicas: 1

  gluesync-conductor:
    image: molo17/gluesync-conductor:3.1.0
    environment:
      DKR_COMPOSE_FILE: /opt/gluesync-conductor/root-folder/docker-stack.yml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - type: bind
        source: .
        target: /opt/gluesync-conductor/root-folder
    labels:
      - com.molo17.conductor.type=module
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager

networks:
  gluesync-net:
    driver: overlay
    attachable: true

volumes:
  prometheus-data:
  grafana-data:

secrets:
  proxy-cert:
    file: ./secrets/proxy.crt

configs:
  prometheus-yml:
    file: ./prometheus.yml
`;

export const labStack = parse(labStackYaml) as RawComposeFile;

const TYPE_LABEL = 'com.molo17.conductor.type';

const withoutTypeLabel = (
  labels: unknown,
): ReadonlyArray<string> | Record<string, unknown> | undefined => {
  if (Array.isArray(labels)) {
    return labels.filter(label => !String(label).startsWith(`${TYPE_LABEL}=`));
  }

  return labels && typeof labels === 'object'
    ? Object.fromEntries(
        Object.entries(labels).filter(([key]) => key !== TYPE_LABEL),
      )
    : undefined;
};

/**
 * The lab stack as a customer's kit has it before Conductor ever ran on it: no
 * `com.molo17.conductor.type` anywhere. Swarm mode never writes the label, so
 * it has to work out the types.
 */
export const labStackWithoutTypes = {
  ...labStack,
  services: Object.fromEntries(
    Object.entries(labStack.services ?? {}).map(([id, service]) => [
      id,
      {
        ...service,
        labels: withoutTypeLabel(service.labels),
        ...(service.deploy
          ? {
              deploy: {
                ...service.deploy,
                labels: withoutTypeLabel(service.deploy.labels),
              },
            }
          : {}),
      },
    ]),
  ),
} as RawComposeFile;
