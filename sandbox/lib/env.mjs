import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sandboxDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDir = path.join(sandboxDir, 'run');

let caCache = null;

export const env = {
  sandboxDir,
  repoDir: path.resolve(sandboxDir, '..'),
  conductorPkgDir: path.resolve(sandboxDir, '..', 'packages', 'gluesync-conductor'),
  runDir,
  kitDir: path.join(runDir, 'kit'),
  stateDir: path.join(runDir, 'state'),
  reportsDir: path.join(sandboxDir, 'reports'),

  dindName: 'conductor-sandbox-dind',
  dindVolume: 'conductor-sandbox-dind',
  dindImage: 'docker:28.3.3-dind',
  dockerPort: 23750,
  get dockerHost() {
    return `tcp://127.0.0.1:${this.dockerPort}`;
  },

  registry: 'localhost:5000',
  project: 'gluesync',
  ports: { conductor: 5317, corehub: 5318, backofficeAdmin: 8088, dockerProxyAdmin: 8089 },

  // Sandbox-only values, not real credentials. The proxy password and license
  // text are canaries: the logging check fails if they show up in conductor logs.
  adminToken: 'sandbox-admin-7f3c',
  proxyUser: 'sbproxy',
  proxyPass: 'SbProxyP4ss-leakcheck',
  licenseText: 'SANDBOX-LICENSE-LEAKCHECK-91e2',

  fakeBase: 'conductor-sandbox/fake-base:dev',
  conductorBase: 'conductor-sandbox/conductor-base:dev',

  caPem() {
    if (!caCache) caCache = fs.readFileSync(path.join(this.kitDir, 'shared', 'sandbox-ca.pem'));
    return caCache;
  },
};

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
