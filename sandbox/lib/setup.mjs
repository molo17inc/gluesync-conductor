import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { env, requiredImages, SERVICES, versionsFor } from './env.mjs';
import { waitStackReady } from './stack.mjs';
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

// ---------------------------------------------------------------- image seeding

// Makes `images` (canonical Docker Hub names) available in one daemon without Docker Hub when
// SANDBOX_IMAGE_MIRROR is set: pull `<mirror>/<image>`, tag it with the canonical name, drop the
// mirror tag. Everything that names the image later (docker run, compose, FROM in a Dockerfile)
// then finds it locally and never resolves a registry. An image already present is left alone.
// Without a mirror this only pulls what is missing, which is what docker would do on first use.
// `inner` picks the sandbox daemon; the default is the host's.
export const seedImages = async (images, { inner = false } = {}) => {
  const dock = inner ? docker : (args, opts) => run(dockerBin(), args, opts);
  const must = inner ? mustDocker : (args, opts) => mustRun(dockerBin(), args, opts);
  const daemon = inner ? 'sandbox' : 'host';
  await Promise.all(
    images.map(async image => {
      if ((await dock(['image', 'inspect', image])).code === 0) return;
      if (!env.imageMirror) {
        say(`pulling ${image} into the ${daemon} daemon`);
        await must(['pull', '-q', image], { timeoutMs: 300000 });
        return;
      }
      const mirrored = `${env.imageMirror}/${image}`;
      say(`pulling ${mirrored} into the ${daemon} daemon, tagged ${image}`);
      await must(['pull', '-q', mirrored], { timeoutMs: 300000 });
      await must(['tag', mirrored, image]);
      await dock(['rmi', mirrored]);
    }),
  );
};

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
  // Host port -> port inside the DinD container. The kit publishes its own ports at the same number
  // inside; the daemon API and the two infra admin ports have fixed inner ports.
  const mappings = [
    [env.dockerPort, 2375],
    [env.ports.conductor, env.ports.conductor],
    [env.ports.corehub, env.ports.corehub],
    [env.ports.proxy, env.ports.proxy],
    [env.ports.backofficeAdmin, env.infraPorts.backofficeAdmin],
    [env.ports.dockerProxyAdmin, env.infraPorts.dockerProxyAdmin],
  ];
  const publish = mappings.flatMap(([host, inner]) => ['-p', `127.0.0.1:${host}:${inner}`]);
  await seedImages(requiredImages.outer);
  say('starting isolated Docker-in-Docker daemon', { image: env.dindImage });
  await mustRun(dockerBin(), [
    'run', '-d', '--privileged', '--name', env.dindName, '--hostname', 'sandbox-host',
    '-e', 'DOCKER_TLS_CERTDIR=',
    ...env.dindAddHosts.flatMap(h => ['--add-host', h]),
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
  await seedImages(requiredImages.inner, { inner: true });
};

// ---------------------------------------------------------------- kit files

const writeIfMissing = (file, content) => {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
};

// The kit directories the fakes write to (state files, logs), bind-mounted into containers that
// run as `node` (uid/gid 1000 in the fakes' image), not as the user that creates them here: on a
// Linux host a directory owned by someone else with mode 0755 would be read-only for them. Only
// these are handed over; every other directory keeps the default owner and mode.
const FAKES_UID = 1000;
const FAKES_DIR_MODE = 0o770;
const fakeWritableDirs = () => [
  kit('data', 'core-hub'), kit('data', 'chronos'), kit('data', 'postgresql-cdc-source-agent'),
  kit('logs', 'core-hub'), kit('logs', 'chronos'), path.join(env.stateDir, 'backoffice'),
];

// As root (the CI job, a root Docker host) the directory becomes the fakes' own. As any other
// user it is already writable for them where Docker maps ownership (Docker Desktop) or when that
// user is uid 1000; on a Linux host with another uid nothing here can fix it, so it is said.
const handOverToFakes = dir => {
  const uid = process.getuid?.();
  if (uid === 0) {
    fs.chownSync(dir, FAKES_UID, FAKES_UID);
    fs.chmodSync(dir, FAKES_DIR_MODE);
  } else if (process.platform === 'linux' && uid !== FAKES_UID) {
    say(`warning: ${dir} is owned by uid ${uid}, the fakes run as uid ${FAKES_UID} and may not be able to write there; run the sandbox as root or as uid ${FAKES_UID}`);
  }
};

const prepareKitFiles = async () => {
  [kit(), kit('shared'), kit('proxy'), kit('prometheus'), kit('grafana')].forEach(d => fs.mkdirSync(d, { recursive: true }));
  fakeWritableDirs().forEach(d => {
    fs.mkdirSync(d, { recursive: true });
    handOverToFakes(d);
  });

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
      'cd /out',
      'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out sandbox-ca.pem -days 3650 -subj "/CN=Conductor Sandbox CA" 2>/dev/null',
      'openssl req -newkey rsa:2048 -nodes -keyout gluesync-key.pem -out srv.csr -subj "/CN=gluesync-core-hub" 2>/dev/null',
      String.raw`printf "subjectAltName=DNS:gluesync-core-hub,DNS:gluesync-chronos,DNS:gluesync-conductor,DNS:api.backoffice.molo17.com,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\n" > ext.cnf`,
      'openssl x509 -req -in srv.csr -CA sandbox-ca.pem -CAkey ca-key.pem -CAcreateserial -out gluesync-cert.pem -days 3650 -extfile ext.cnf 2>/dev/null',
      'rm -f srv.csr ext.cnf sandbox-ca.srl',
      'chmod 644 *.pem',
    ].join(' && ');
    // The DinD image already has openssl, so nothing is downloaded (an alpine container would
    // `apk add` it from the Alpine CDN). It runs in the host's daemon, where that image is
    // present after seeding anyway; the bind mount is the same directory the sandbox daemon sees.
    await mustRun(dockerBin(), ['run', '--rm', '--entrypoint', 'sh', '-v', `${kit('shared')}:/out`, env.dindImage, '-c', script], {
      timeoutMs: 180000,
    });
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

// The fakes' build context: Dockerfile, fake.mjs and the `ws` package from the sandbox's own
// node_modules (resolved, so a symlinked node_modules works), so the image build needs no npm.
const stageFakesContext = () => {
  const ctx = path.join(env.runDir, 'fakes-context');
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  const fakes = path.join(env.sandboxDir, 'fakes');
  fs.copyFileSync(path.join(fakes, 'Dockerfile'), path.join(ctx, 'Dockerfile'));
  fs.copyFileSync(path.join(fakes, 'fake.mjs'), path.join(ctx, 'fake.mjs'));
  const ws = path.dirname(createRequire(import.meta.url).resolve('ws/package.json'));
  fs.cpSync(ws, path.join(ctx, 'ws'), { recursive: true, dereference: true });
  return ctx;
};

// No `--pull`: a FROM that is already in the daemon (seeded from the mirror, see seedImages) is used
// as it is. BuildKit in the sandbox daemon does that for the named image, without a registry lookup.
const buildBases = async () => {
  say('building fake service base image');
  await mustDocker(['build', '-q', '-t', env.fakeBase, stageFakesContext()], { timeoutMs: 300000 });

  if (!fs.existsSync(path.join(env.conductorPkgDir, 'build', 'index.js'))) {
    throw new Error('conductor build missing: run "yarn install && yarn build" in the repo root first');
  }
  say('building conductor image from packages/gluesync-conductor/build');
  await mustDocker(['build', '-q', '-t', env.conductorBase, env.conductorPkgDir], { timeoutMs: 300000 });
  // Keeper containers stop the conductor's post-update image prune from deleting the bases and the
  // seeded images (the conductor pulls its helper images itself, so they must be there when it needs them).
  const keepers = [
    [`${env.keepPrefix}conductor-base`, env.conductorBase],
    [`${env.keepPrefix}fake-base`, env.fakeBase],
    ...requiredImages.inner.map(image => [`${env.keepPrefix}${image.replaceAll(/[^\w.-]/g, '-')}`, image]),
  ];
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
  await mustDocker(['build', '-q', '-t', ref, '-'], { input: `${dockerfile}\n`, timeoutMs: 120000 });
  await mustDocker(['push', '-q', ref], { timeoutMs: 120000 });
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
  const infra = await infraCompose(['up', '-d', '--wait'], { timeoutMs: 180000 });
  if (infra.timedOut) throw new Error('infra up hung: no registry/backoffice/docker proxy healthy after 180s');
  if (infra.code !== 0) throw new Error(`infra up failed: ${infra.err}`);

  const v0 = versionsFor(0);
  say('publishing initial fake images (iteration 0 versions)');
  await ensureImages(v0);
  await backofficeAdmin('/__sandbox/catalog', catalogFor(v0));

  if (fresh || !fs.existsSync(kit('docker-compose.yml'))) renderKitCompose(v0);

  say('starting the kit (fake services + real conductor)');
  const r = await kitCompose(['up', '-d'], { timeoutMs: 300000 });
  if (r.timedOut) throw new Error('kit up hung: docker compose up -d did not return in 300s');
  if (r.code !== 0) throw new Error(`kit up failed: ${r.err}`);

  // The conductor, and the fakes the iterations talk to straight away, answer real requests.
  try {
    await waitStackReady({ timeoutMs: 240000 });
  } catch (e) {
    throw new Error(`${e.message}; check run/kit logs and \`node sandbox/run.mjs logs\``);
  }
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
