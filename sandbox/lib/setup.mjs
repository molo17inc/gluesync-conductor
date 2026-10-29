import fs from 'node:fs';
import path from 'node:path';
import { env, SERVICES, versionsFor } from './env.mjs';
import { docker, dockerBin, mustDocker, mustRun, request, run, say, waitFor, writeJson } from './util.mjs';

const kit = (...p) => path.join(env.kitDir, ...p);
const pushedFile = () => path.join(env.stateDir, 'pushed-images.json');

const infraEnv = () => ({
  SANDBOX_ADMIN_TOKEN: env.adminToken,
  SANDBOX_PROXY_USER: env.proxyUser,
  SANDBOX_PROXY_PASS: env.proxyPass,
  SANDBOX_KIT_DIR: env.kitDir,
  SANDBOX_STATE_DIR: env.stateDir,
});

export const compose = (file, args, opts = {}) =>
  docker(['compose', '-f', file, ...args], { cwd: path.dirname(file), timeoutMs: 600000, ...opts });

export const kitCompose = (args, opts) => compose(kit('docker-compose.yml'), args, opts);

const infraCompose = (args, opts = {}) =>
  compose(path.join(env.sandboxDir, 'infra', 'docker-compose.yml'), args, { ...opts, env: infraEnv() });

// ---------------------------------------------------------------- dind

export const dindRunning = async () => {
  const r = await run(dockerBin(), ['inspect', '-f', '{{.State.Running}}', env.dindName]);
  return r.code === 0 && r.out === 'true';
};

const startDind = async () => {
  if (await dindRunning()) {
    say('sandbox daemon already running');
    return;
  }
  await run(dockerBin(), ['rm', '-f', env.dindName]);
  const publish = [env.dockerPort, ...Object.values(env.ports)].flatMap(p => ['-p', `127.0.0.1:${p}:${p === env.dockerPort ? 2375 : p}`]);
  say('starting isolated Docker-in-Docker daemon', { image: env.dindImage });
  await mustRun(dockerBin(), [
    'run', '-d', '--privileged', '--name', env.dindName, '--hostname', 'sandbox-host',
    '-e', 'DOCKER_TLS_CERTDIR=',
    ...publish,
    // Same absolute path inside the daemon, so compose bind mounts and the
    // conductor's BASE_PATH resolve exactly as they do on a customer host.
    '-v', `${env.runDir}:${env.runDir}`,
    '-v', `${env.dindVolume}:/var/lib/docker`,
    env.dindImage,
  ]);
  const ready = await waitFor('dind', async () => (await docker(['info', '--format', '{{.ServerVersion}}'])).code === 0, {
    timeoutMs: 90000,
  });
  if (!ready.ok) throw new Error('sandbox Docker daemon did not come up');
  say('sandbox daemon ready');
};

// ---------------------------------------------------------------- kit files

const writeIfMissing = (file, content) => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
};

const prepareKitFiles = async () => {
  [
    kit(), kit('shared'), kit('proxy'), kit('prometheus'), kit('grafana'),
    kit('data', 'core-hub'), kit('data', 'chronos'), kit('data', 'postgresql-cdc-source-agent'),
    kit('logs', 'core-hub'), kit('logs', 'chronos'), path.join(env.stateDir, 'backoffice'),
  ].forEach(d => fs.mkdirSync(d, { recursive: true }));

  const debugKit = path.join(env.repoDir, 'debug-container', 'linux');
  writeIfMissing(kit('shared', 'gs-license.dat'), env.licenseText);
  writeIfMissing(
    kit('shared', 'security-config.json'),
    JSON.stringify({ ssl: { certificatePassword: 'sandbox', certificateKeyPassword: 'sandbox' } }, null, 2),
  );
  writeIfMissing(kit('shared', 'logback.xml'), fs.readFileSync(path.join(debugKit, 'shared', 'logback.xml')));
  writeIfMissing(kit('bootstrap-core-hub.json'), fs.readFileSync(path.join(debugKit, 'bootstrap-core-hub.json')));
  // The proxy folder is the sandbox's own (sandbox/kit/proxy): a customer's traefik.yml with settings
  // of their own, which the error pages wiring must leave alone, and the kit's certs.yml, which nothing may touch.
  writeIfMissing(kit('proxy', 'traefik.yml'), fs.readFileSync(path.join(env.sandboxDir, 'kit', 'proxy', 'traefik.yml')));
  writeIfMissing(kit('proxy', 'certs.yml'), fs.readFileSync(path.join(env.sandboxDir, 'kit', 'proxy', 'certs.yml')));
  writeIfMissing(kit('prometheus', 'prometheus.yml'), 'global:\n  scrape_interval: 15s\n');
  writeIfMissing(kit('.env'), '');
  // A migrated v2 install; without this the conductor takes the v1 -> v2 migration path.
  writeIfMissing(kit('.migration-to-v2.json'), JSON.stringify({ completed: true, completedAt: new Date().toISOString() }));

  if (!fs.existsSync(kit('shared', 'sandbox-ca.pem'))) {
    say('generating sandbox CA and server certificate');
    const script = [
      'set -e',
      'apk add --no-cache openssl >/dev/null',
      'cd /out',
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out sandbox-ca.pem -days 3650 -subj "/CN=Conductor Sandbox CA" 2>/dev/null',
      'openssl req -newkey rsa:2048 -nodes -keyout gluesync-key.pem -out srv.csr -subj "/CN=gluesync-core-hub" 2>/dev/null',
      String.raw`printf "subjectAltName=DNS:gluesync-core-hub,DNS:gluesync-chronos,DNS:gluesync-conductor,DNS:api.backoffice.molo17.com,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\n" > ext.cnf`,
      'openssl x509 -req -in srv.csr -CA sandbox-ca.pem -CAkey ca-key.pem -CAcreateserial -out gluesync-cert.pem -days 3650 -extfile ext.cnf 2>/dev/null',
      'rm -f srv.csr ext.cnf sandbox-ca.srl',
      'chmod 644 *.pem',
    ].join(' && ');
    await mustDocker(['run', '--rm', '-v', `${kit('shared')}:/out`, 'alpine:3.20', 'sh', '-c', script], { timeoutMs: 180000 });
  }
};

export const renderKitCompose = versions => {
  const template = fs.readFileSync(path.join(env.sandboxDir, 'kit', 'docker-compose.template.yml'), 'utf8');
  const values = {
    REGISTRY: env.registry,
    KIT_DIR: env.kitDir,
    ADMIN_TOKEN: env.adminToken,
    PROXY_USER: env.proxyUser,
    PROXY_PASS: env.proxyPass,
    PORT_CONDUCTOR: env.ports.conductor,
    PORT_COREHUB: env.ports.corehub,
    PORT_PROXY: env.ports.proxy,
    V_CORE_HUB: versions['gluesync-core-hub'],
    V_CHRONOS: versions['gluesync-chronos'],
    V_CONDUCTOR: versions['gluesync-conductor'],
    V_TRAEFIK: versions['reverse-proxy'],
    V_PROMETHEUS: versions.prometheus,
    V_GRAFANA: versions.grafana,
    V_PORTAINER: versions.portainer,
  };
  const rendered = template.replaceAll(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`template value ${k} missing`);
    return String(values[k]);
  });
  fs.writeFileSync(kit('docker-compose.yml'), rendered);
};

// ---------------------------------------------------------------- images

const loadPushed = () => {
  try {
    return new Set(JSON.parse(fs.readFileSync(pushedFile(), 'utf8')));
  } catch {
    return new Set();
  }
};

const savePushed = set => writeJson(pushedFile(), [...set].sort((a, b) => a.localeCompare(b)));

const buildBases = async () => {
  say('building fake service base image');
  await mustDocker(['build', '-q', '-t', env.fakeBase, path.join(env.sandboxDir, 'fakes')], { timeoutMs: 600000 });

  if (!fs.existsSync(path.join(env.conductorPkgDir, 'build', 'index.js'))) {
    throw new Error('conductor build missing: run "yarn install && yarn build" in the repo root first');
  }
  say('building conductor image from packages/gluesync-conductor/build');
  await mustDocker(['build', '-q', '-t', env.conductorBase, env.conductorPkgDir], { timeoutMs: 600000 });
  // Keeper containers stop the conductor's post-update image prune from deleting the bases.
  const keepers = [['keep-conductor-base', env.conductorBase], ['keep-fake-base', env.fakeBase]];
  await Promise.all(
    keepers.map(async ([name, image]) => {
      await docker(['rm', '-f', name]);
      await mustDocker(['create', '--name', name, image]);
    }),
  );
};

export const imageRef = (service, version) => `${env.registry}/${SERVICES[service].image}:${version}`;

// Builds and pushes one thin image per (service, version). `crash` makes a bad release.
export const ensureImage = async (service, version, { crash = false } = {}) => {
  const pushed = loadPushed();
  const ref = imageRef(service, version);
  if (pushed.has(ref)) return ref;
  const def = SERVICES[service];
  const dockerfile =
    def.role === 'conductor'
      ? [
          `FROM ${env.conductorBase}`,
          `LABEL sandbox.version=${version}`,
          `ENV SANDBOX_CONDUCTOR_VERSION=${version}`,
          ...(crash ? ['CMD ["sh", "-c", "echo sandbox bad conductor release >&2; exit 3"]'] : []),
        ].join('\n')
      : [
          `FROM ${env.fakeBase}`,
          `ENV FAKE_ROLE=${def.role} FAKE_SERVICE=${service} FAKE_VERSION=${version} FAKE_CRASH=${crash ? 1 : 0}`,
          `LABEL sandbox.version=${version}`,
        ].join('\n');
  await mustDocker(['build', '-q', '-t', ref, '-'], { input: `${dockerfile}\n`, timeoutMs: 300000 });
  await mustDocker(['push', '-q', ref], { timeoutMs: 300000 });
  const after = loadPushed();
  after.add(ref);
  savePushed(after);
  return ref;
};

export const ensureImages = async (versions, { skip = [], crash = [] } = {}) => {
  const jobs = Object.entries(versions).filter(([s]) => !skip.includes(s));
  const queue = [...jobs];
  // Each worker takes the next job until the queue is empty.
  const drain = async () => {
    const next = queue.shift();
    if (!next) return;
    const [service, version] = next;
    await ensureImage(service, version, { crash: crash.includes(service) });
    await drain();
  };
  await Promise.all(Array.from({ length: 4 }, drain));
};

// ---------------------------------------------------------------- lifecycle

export const catalogFor = versions =>
  Object.fromEntries(Object.entries(versions).map(([service, v]) => [SERVICES[service].short, { ga: v, beta: v, alpha: v }]));

export const backofficeAdmin = (p, body) =>
  request(`http://127.0.0.1:${env.ports.backofficeAdmin}${p}`, {
    method: body ? 'POST' : 'GET',
    body,
    headers: { 'x-sandbox-admin': env.adminToken },
  });

export const up = async ({ fresh = false } = {}) => {
  fs.mkdirSync(env.runDir, { recursive: true });
  await startDind();
  await prepareKitFiles();
  await buildBases();

  say('starting sandbox infrastructure (registry, fake backoffice + proxy, docker socket proxy)');
  const infra = await infraCompose(['up', '-d', '--wait'], { timeoutMs: 300000 });
  if (infra.code !== 0) throw new Error(`infra up failed: ${infra.err}`);

  const v0 = versionsFor(0);
  say('publishing initial fake images (iteration 0 versions)');
  await ensureImages(v0);
  await backofficeAdmin('/__sandbox/catalog', catalogFor(v0));

  if (fresh || !fs.existsSync(kit('docker-compose.yml'))) renderKitCompose(v0);

  say('starting the kit (fake services + real conductor)');
  const r = await kitCompose(['up', '-d'], { timeoutMs: 600000 });
  if (r.code !== 0) throw new Error(`kit up failed: ${r.err}`);

  const healthy = await waitFor(
    'conductor health',
    async () => (await request(`https://127.0.0.1:${env.ports.conductor}/health`, { timeoutMs: 5000 })).status === 200,
    { timeoutMs: 240000, intervalMs: 3000 },
  );
  if (!healthy.ok) throw new Error('conductor never became healthy; check run/kit logs and `node sandbox/run.mjs logs`');
  say(`sandbox up: conductor https://127.0.0.1:${env.ports.conductor}, fake corehub https://127.0.0.1:${env.ports.corehub}`);
};

export const down = async ({ purge = false } = {}) => {
  say('removing sandbox daemon (everything inside it goes with it)');
  await run(dockerBin(), ['rm', '-f', env.dindName]);
  await run(dockerBin(), ['volume', 'rm', '-f', env.dindVolume]);
  if (purge) {
    fs.rmSync(env.runDir, { recursive: true, force: true });
    say('removed run/ (reports are kept)');
  }
};
