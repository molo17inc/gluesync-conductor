import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sandboxDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDir = path.join(sandboxDir, 'run');

let caCache = null;

// Every host-visible name and port can be overridden, so several sandboxes (a developer's own,
// CI shards on a shared daemon) can coexist. Defaults are what a developer's Mac gets.
//   SANDBOX_NAME            prefix of the DinD container and its volume (default conductor-sandbox)
//   SANDBOX_PORT_OFFSET     added to every default port below
//   SANDBOX_DOCKER_PORT, SANDBOX_CONDUCTOR_PORT, SANDBOX_COREHUB_PORT, SANDBOX_PROXY_PORT,
//   SANDBOX_BACKOFFICE_ADMIN_PORT, SANDBOX_DOCKER_PROXY_ADMIN_PORT   one port each, winning over the offset
const portOffset = Number(process.env.SANDBOX_PORT_OFFSET || 0);
const port = (name, fallback) => Number(process.env[`SANDBOX_${name}_PORT`] || fallback + portOffset);
const sandboxName = process.env.SANDBOX_NAME || 'conductor-sandbox';

// Every image the sandbox pulls, by the daemon that needs it. By default they come from Docker Hub,
// on first use. With SANDBOX_IMAGE_MIRROR=<registry>/<repo> (CI: nexus.hq.molo17.com/molo17-local)
// each one is pulled from `<mirror>/<name:tag>` and tagged with its canonical name before anything
// uses it (see seedImages in setup.mjs), so Docker Hub is never contacted. The mirror must hold
// every name below, with the same tag. Keep this list complete: it is what the CI job needs offline.
const DIND_IMAGE = 'docker:28.3.3-dind';
// Also the image the real-kernel ENOSPC test runs in, and the base of the fakes and the conductor.
const NODE_IMAGE = 'node:24.16.0-alpine';
export const requiredImages = {
  // The host's daemon: the sandbox's own Docker-in-Docker, and the certificate step (it has openssl).
  outer: [DIND_IMAGE],
  // The sandbox daemon: the registry, the FROM of sandbox/fakes/Dockerfile and of
  // packages/gluesync-conductor/Dockerfile, the ENOSPC test, the nsenter fallback in diskFault, and
  // the helper images the conductor itself runs (`docker run --rm docker:cli|docker:28 ...`, see
  // autoReboot / restartAllServices: they pull what is not local, from Docker Hub). The conductor's
  // image prune removes whatever is unused, so up() keeps all of these with keep-* containers.
  inner: ['registry:2.8.3', NODE_IMAGE, 'alpine:3.20', 'docker:28', 'docker:cli'],
};

// SANDBOX_DIND_ADD_HOSTS="host:ip,host:ip": --add-host entries for the sandbox DinD container, so a
// test can prove the nested daemon reaches nothing but the mirror (CI never sets it).
const dindAddHosts = (process.env.SANDBOX_DIND_ADD_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean);

// Trailing slashes off, without a regex: `/\/+$/` backtracks quadratically on a long run of them.
const withoutTrailingSlashes = text => {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end -= 1;
  return text.slice(0, end);
};

export const env = {
  sandboxDir,
  repoDir: path.resolve(sandboxDir, '..'),
  conductorPkgDir: path.resolve(sandboxDir, '..', 'packages', 'gluesync-conductor'),
  runDir,
  kitDir: path.join(runDir, 'kit'),
  stateDir: path.join(runDir, 'state'),
  // The conductor keeps its last valid compose file in <root-folder>/.conductor, and the
  // kit mounts the kit directory as the root folder.
  lastGoodFile: path.join(runDir, 'kit', '.conductor', 'docker-compose.last-good.yml'),
  reportsDir: path.join(sandboxDir, 'reports'),

  dindName: `${sandboxName}-dind`,
  dindVolume: `${sandboxName}-dind`,
  dindImage: DIND_IMAGE,
  enospcImage: NODE_IMAGE,
  imageMirror: withoutTrailingSlashes(process.env.SANDBOX_IMAGE_MIRROR || ''),
  dindAddHosts,
  dockerPort: port('DOCKER', 23750),
  get dockerHost() {
    return `tcp://127.0.0.1:${this.dockerPort}`;
  },

  registry: 'localhost:5000',
  project: 'gluesync',
  // proxy: the fake reverse-proxy, which forwards /conductor/api/ to the conductor as the UI's requests travel.
  ports: {
    conductor: port('CONDUCTOR', 5317),
    corehub: port('COREHUB', 5318),
    proxy: port('PROXY', 5319),
    backofficeAdmin: port('BACKOFFICE_ADMIN', 8088),
    dockerProxyAdmin: port('DOCKER_PROXY_ADMIN', 8089),
  },
  // Ports the infra containers listen on inside the sandbox daemon (the infra compose file's own);
  // the DinD container publishes them to ports.backofficeAdmin / ports.dockerProxyAdmin on the host.
  infraPorts: { backofficeAdmin: 8088, dockerProxyAdmin: 8089 },
  // Helper containers that stop the conductor's image prune from deleting the bases. They live in
  // the sandbox daemon, so they cannot clash with anything on the host and need no per-sandbox name.
  keepPrefix: 'keep-',

  // Sandbox-only values, not real credentials. The proxy password and license
  // text are canaries: the logging check fails if they show up in conductor logs.
  adminToken: 'sandbox-admin-7f3c',
  proxyUser: 'sbproxy',
  proxyPass: 'SbProxyP4ss-leakcheck',
  licenseText: 'SANDBOX-LICENSE-LEAKCHECK-91e2',

  // Image names inside the sandbox daemon (no host-side clash possible).
  fakeBase: 'conductor-sandbox/fake-base:dev',
  conductorBase: 'conductor-sandbox/conductor-base:dev',

  caPem() {
    if (!caCache) caCache = fs.readFileSync(path.join(this.kitDir, 'shared', 'sandbox-ca.pem'));
    return caCache;
  },
};

// Phrases the conductor contract fixes (see the disk-full and compose-blanked profiles).
export const DISK_FULL_TEXT = 'not enough free disk space';
export const RESTORED_LOG = 'restored docker-compose.yml from last-good backup';

// The services the default kit ships, keyed by compose service name.
// `short` is what the conductor asks the backoffice for (image name minus "gluesync-").
export const SERVICES = {
  'gluesync-core-hub': { short: 'core-hub', image: 'molo17/gluesync-core-hub', role: 'corehub', type: 'core-hub' },
  'gluesync-postgresql-cdc-source-agent': { short: 'postgresql-cdc', image: 'molo17/gluesync-postgresql-cdc', role: 'http', type: 'agent' },
  'gluesync-chronos': { short: 'chronos', image: 'molo17/gluesync-chronos', role: 'chronos', type: 'module' },
  'gluesync-conductor': { short: 'conductor', image: 'molo17/gluesync-conductor', role: 'conductor', type: 'module' },
  'reverse-proxy': { short: 'traefik', image: 'molo17/traefik', role: 'http', type: 'third-party' },
  prometheus: { short: 'prometheus', image: 'molo17/prometheus', role: 'http', type: 'third-party' },
  grafana: { short: 'grafana', image: 'molo17/grafana', role: 'http', type: 'third-party' },
  portainer: { short: 'portainer', image: 'molo17/portainer', role: 'http', type: 'third-party' },
};

// Version scheme per iteration. Agents always share the core-hub version, as the
// conductor refuses updates when they differ.
export const versionsFor = i => {
  const n = 100 + i;
  return {
    'gluesync-core-hub': `2.3.0.${n}`,
    'gluesync-postgresql-cdc-source-agent': `2.3.0.${n}`,
    'gluesync-chronos': `0.2.${n}`,
    'gluesync-conductor': `0.13.${n}`,
    'reverse-proxy': `3.6.${n}`,
    prometheus: `3.8.${n}`,
    grafana: `12.3.${n}`,
    portainer: `2.33.${n}`,
  };
};
