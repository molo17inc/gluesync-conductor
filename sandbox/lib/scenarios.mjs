// Chaos profiles. Each iteration bumps every service to a new version and drives the
// update the way the UI does; a profile adds one fault on top.
//
// plan(target) returns what the runner should expect:
//   expect        'updated' | 'partial'
//   lagging       services allowed to stay on their old version
//   skipImages    services whose target image is advertised but never pushed
//   crashImages   services whose target image is a bad release (crash loop)
//   catalog       per-service catalog overrides { service: version }
//   freshToken    drive the update with a token the conductor has not cached
//   concurrent    send each update request N times in parallel
//   expectConductorRestarts   Docker restarts of the conductor the profile causes on purpose
//   refusal       { phrase, code, status }: the first update round must be refused with a failure
//                 containing the phrase, answered with that HTTP status and a diagnosis of
//                 that code, and leave everything untouched. The fault is
//                 released right after that round and the user clicks again, so the same
//                 iteration must still converge.
//   minRounds     keep clicking (after a failed or stalled round) until at least this many rounds
//   flapping      the profile toggles a fault while the bulk update runs (see beforeRound)
//   blanked       the profile blanks the compose file before the update (see compose-blanked)
//   proxyPages    the proxy-error-pages profile: evidence is recorded in it.proxyPages and checked (see checks.mjs)
//   faultActive   (on the profile, not the plan) (ctx, it) => boolean | Promise<boolean>: true while the
//                 profile's Docker fault is in effect. The driver waits for it to end before it judges
//                 a round, so rounds that fail inside the fault do not count as "no progress"
//
// A profile may also set versions(i) -> { service: version }: tags used instead of versionsFor(i) for those services.
//
// before/during/after get (ctx, it). `during` runs alongside the update driver and
// can watch ctx.inflight to strike while an update request is in progress.
// beforeRound(ctx, it, { round, phase }) runs right before each update request is sent,
// for faults that must not be active during the conductor's self-update.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DISK_FULL_TEXT, env, SERVICES, versionsFor } from './env.mjs';
import { composeProblem } from './composeSampler.mjs';
import { releaseDiskFault, startDiskFault } from './diskFault.mjs';
import { backofficeAdmin, kitCompose } from './setup.mjs';
import { callConductor, containers, corehub, dockerProxy, waitConductor } from './stack.mjs';
import { docker, now, sleep, waitFor } from './util.mjs';

const ALL = Object.keys(SERVICES);
const except = (...keep) => ALL.filter(s => !keep.includes(s));

// Resolves once a bulk (non-conductor) update request is in flight.
const bulkInFlight = (ctx, timeoutMs = 300000) =>
  waitFor('bulk update in flight', async () => ctx.inflight && ctx.inflight.round >= 2 && ctx.inflight, {
    timeoutMs,
    intervalMs: 250,
  });

// The conductor log shows compose recreating a service of the bulk update: `Container gluesync-grafana-1 Recreated`.
const RECREATED = /Container \S+ Recreated/;

// The sandbox's Docker socket proxy container, in the infra project (the conductor's DOCKER_HOST points at its socket).
const dockerProxyContainer = async () => {
  const found = await docker([
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=conductor-sandbox-infra',
    '--filter',
    'label=com.docker.compose.service=dockerproxy',
  ]);
  return found.out.split('\n').find(Boolean);
};

// Starts the Docker socket proxy again (a no-op when it runs) and waits until its admin API answers.
export const startDockerProxyContainer = async () => {
  const id = await dockerProxyContainer();
  if (id) await docker(['start', id]);
  return waitFor('docker proxy admin', async () => (await dockerProxy()).status === 200, { timeoutMs: 30000, intervalMs: 500 });
};

// docker-proxy-down: the Docker API is not refusing connections, it is gone: the proxy container
// is stopped for `downMs`, right after compose recreated a service of the bulk update.
const DOCKER_PROXY_DOWN_MS = 10000;
const stopProxyAfterRecreate = async (ctx, it) => {
  const bulk = await waitFor('bulk round in flight', async () => ctx.inflight?.phase === 'bulk' && ctx.inflight, {
    timeoutMs: 300000,
    intervalMs: 250,
  });
  if (!bulk.ok) return;
  const since = new Date(bulk.value.startedAt).toISOString();
  const seen = await waitFor(
    'recreate in the conductor log',
    async () => ctx.collector.since('gluesync-conductor', since).find(l => RECREATED.test(l.line)),
    { timeoutMs: 120000, intervalMs: 25 },
  );
  const id = await dockerProxyContainer();
  if (!seen.ok || !id) {
    it.notes.push(seen.ok ? 'docker proxy container not found' : 'no recreate seen in the conductor log: the proxy was not stopped');
    return;
  }
  it.dockerFault = { active: true };
  try {
    const stopped = await docker(['stop', '-t', '0', id]);
    it.notes.push(`docker proxy stopped (exit ${stopped.code}) at ${now()} after: ${seen.value.line.trim()}`);
    await sleep(DOCKER_PROXY_DOWN_MS);
  } finally {
    const back = await startDockerProxyContainer();
    it.notes.push(`docker proxy started again at ${now()}${back.ok ? '' : ' (admin API did not answer)'}`);
    it.dockerFault = { active: false };
  }
};

const containerOf = async service => (await containers()).find(c => c.service === service && c.state === 'running');

// Disk-fault sizes. The kit's conductor runs with CONDUCTOR_UPDATE_MIN_FREE_BYTES=65536 and
// CONDUCTOR_WRITE_RESERVE_BYTES=4096, so a 256 KiB tmpfs is a meaningful "disk".
const ALMOST_FULL_KIB = 32; // more than the compose file (~10 KiB), below the 64 KiB minimum
const FLAP_OPEN_KIB = 96; // above the 64 KiB minimum: pre-flights pass while the toggle is open
const FLAP_ROUNDS = 3; // bulk rounds under flapping before the filler stops and the update must converge

const composeFile = () => path.join(env.kitDir, 'docker-compose.yml');

// compose-blanked: what the compose file looks like to a reader that polls it from the moment
// the conductor starts: blank (empty, or only the newlines safeWriteFile pads with) until it is restored, and never anything else but the last-good bytes.
const watchRestore = async (lastGood, blanked) => {
  const file = composeFile();
  const stubs = new Set();
  const restored = await waitFor(
    'compose restore',
    async () => {
      const bytes = fs.readFileSync(file);
      if (lastGood && bytes.equals(lastGood)) return true;
      const text = bytes.toString('utf8');
      // Blank is what composeProblem calls blank: nothing but whitespace. The conductor writes in
      // place through safeWriteFile, which first grows the file to its final size with newlines (so the
      // overwrite cannot hit ENOSPC); for a file that was empty that is, for a moment, a file of
      // newlines. It means the same as an empty file to YAML, and a slow runner's poll sees it.
      if (!text.trim()) return false;
      if (stubs.size < 3 && !stubs.has(text.slice(0, 200))) {
        stubs.add(text.slice(0, 200));
        blanked.stubs.push({ at: now(), size: bytes.length, head: text.slice(0, 200) });
      }
      return !lastGood;
    },
    { timeoutMs: lastGood ? 60000 : 15000, intervalMs: 25 },
  );
  blanked.restoredMs = restored.ok ? restored.ms : null;
};

// Truncates the compose file to 0 bytes while the conductor is stopped (what an old conductor
// left behind on a full disk), starts it again and watches what it does with the file.
const blankCompose = async (ctx, it) => {
  const file = composeFile();
  const blanked = { lastGoodBytes: null, restoredMs: null, byteEqual: false, stubs: [], repairedByRunner: false };
  it.blanked = blanked;
  const original = fs.readFileSync(file);
  // The conductor writes the backup at startup and after every compose write.
  await waitFor('last-good backup', async () => fs.existsSync(env.lastGoodFile) && fs.statSync(env.lastGoodFile).size > 0, {
    timeoutMs: 30000,
    intervalMs: 1000,
  });
  const lastGood = fs.existsSync(env.lastGoodFile) ? fs.readFileSync(env.lastGoodFile) : null;
  blanked.lastGoodBytes = lastGood?.length ?? null;
  const c = await containerOf('gluesync-conductor');
  // The blank file is the fault: it must not count as a bad sample of the conductor.
  ctx.sampler?.pause();
  try {
    if (c) await docker(['stop', '-t', '10', c.id]);
    fs.truncateSync(file, 0);
    it.notes.push(`compose truncated to 0 bytes with the conductor ${c?.id} stopped at ${now()}`);
    if (c) await docker(['start', c.id]);
    // The restore is logged by this start of the conductor, which the round-1 self-update
    // replaces within a couple of seconds: follow its logs now rather than at the collector's next tick.
    await ctx.collector.sync();
    await watchRestore(lastGood, blanked);
    blanked.byteEqual = !!lastGood && fs.readFileSync(file).equals(lastGood);
    if (blanked.restoredMs === null) {
      // Keep the runner going: put the file back so the next iterations are not poisoned.
      fs.writeFileSync(file, original);
      blanked.repairedByRunner = true;
      it.notes.push('compose was not restored within the time limit; the runner put the original file back');
    } else {
      it.notes.push(`compose restored ${blanked.restoredMs}ms after the conductor started (byte-equal to last-good: ${blanked.byteEqual})`);
    }
    const back = await waitConductor({ timeoutMs: 120000 });
    if (!back.ok) it.notes.push('conductor did not become healthy after the compose was restored');
  } finally {
    ctx.sampler?.resume();
  }
};

// ---------------------------------------------------------------- proxy-error-pages

// The kit's proxy folder is sandbox/kit/proxy: a customer's traefik.yml (their own middleware, ACME
// resolver, log level, comments) and the kit's certs.yml, which nothing may ever change.
const proxyFile = name => path.join(env.kitDir, 'proxy', name);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const PROXY_SERVICE_BLOCK = /\n {2}reverse-proxy:\n(?:(?: {4}.*)?\n)*/;
const proxyBlock = () => PROXY_SERVICE_BLOCK.exec(fs.readFileSync(composeFile(), 'utf8'))?.[0] ?? '';
const proxyTag = () => /molo17\/traefik:(\S+)/.exec(proxyBlock())?.[1];
const wiringIn = () => {
  const conf = fs.readFileSync(proxyFile('traefik.yml'), 'utf8');
  return {
    static: conf.includes('- gluesync-pages@docker') && conf.includes('gluesyncerrorpages:'),
    labels: proxyBlock().includes('gluesyncerrorpages.mode=wrap'),
  };
};
const wired = () => {
  const w = wiringIn();
  return w.static && w.labels;
};
const unwired = () => {
  const w = wiringIn();
  return !w.static && !w.labels;
};

const proxyBackups = () => {
  const dir = path.join(env.kitDir, '.conductor', 'proxy-backup');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(stamp => ({ stamp, files: fs.readdirSync(path.join(dir, stamp)).sort() }));
};

const conductorLogged = async (ctx, it, pattern) => {
  await ctx.collector.sync();
  return ctx.collector.since('gluesync-conductor', it.startedAt).some(l => pattern.test(l.line));
};

// What the proxy folder and the proxy's compose block look like right now.
const proxyState = () => ({
  conf: fs.readFileSync(proxyFile('traefik.yml'), 'utf8'),
  certsSha: sha256(proxyFile('certs.yml')),
  block: proxyBlock(),
  tag: proxyTag(),
});

const proxyBaseline = async (ctx, it) => {
  it.proxyPages = { baseline: proxyState(), originalTag: proxyTag() };
};

// The profile's two halves: the update moves reverse-proxy to a tag that can serve the pages, and the wiring must
// appear on its own; then the compose file goes back to the old tag (what a downgrade does) and the proxy is
// recreated, which the conductor sees as a Docker start event, and the wiring must go again, leaving the
// customer's files as they were.
const proxyErrorPages = async (ctx, it) => {
  const pages = it.proxyPages;
  const added = await waitFor('error pages wiring added', async () => wired(), { timeoutMs: 180000, intervalMs: 2000 });
  pages.added = { ok: added.ok, ms: added.ms };
  // The conductor writes both files, then recreates the proxy: wait until it says so before going on.
  pages.addedLogged = (
    await waitFor('add logged', () => conductorLogged(ctx, it, /\[proxy-error-pages\] (add|convert) done/), { timeoutMs: 120000, intervalMs: 2000 })
  ).ok;
  Object.assign(pages.added, proxyState(), { backups: proxyBackups() });

  const file = composeFile();
  const original = pages.originalTag;
  if (!original) {
    it.notes.push('could not read the proxy tag the iteration started with');
    return;
  }
  ctx.sampler?.pause();
  try {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(molo17\/traefik:)\S+/, (_, head) => `${head}${original}`));
  } finally {
    ctx.sampler?.resume();
  }
  const up = await kitCompose(['up', '-d', 'reverse-proxy'], { timeoutMs: 120000 });
  it.notes.push(`proxy put back on ${original} and recreated (up exit ${up.code}); the conductor must notice the start event`);
  const removed = await waitFor('error pages wiring removed', async () => unwired(), { timeoutMs: 120000, intervalMs: 2000 });
  pages.removed = { ok: removed.ok, ms: removed.ms };
  pages.removedLogged = (await waitFor('remove logged', () => conductorLogged(ctx, it, /\[proxy-error-pages\] remove done/), { timeoutMs: 60000, intervalMs: 2000 })).ok;
  Object.assign(pages.removed, proxyState());
};

export const PROFILES = [
  {
    name: 'clean',
    description: 'No fault. Baseline: conductor self-update, then chronos, then the rest.',
    plan: () => ({ expect: 'updated' }),
  },
  {
    name: 'backoffice-flaky',
    description: 'Backoffice answers 503 twice per service before recovering. Retries should absorb it.',
    plan: () => ({ expect: 'updated' }),
    before: async () => {
      const flaky = { mode: 'flaky', failCount: 2 };
      await backofficeAdmin('/__sandbox/chaos', { 'core-hub': flaky, chronos: { ...flaky }, conductor: { ...flaky }, grafana: { ...flaky } });
    },
  },
  {
    name: 'backoffice-module-down',
    description: 'Backoffice returns 500 for grafana only. Shows whether one module blocks the whole bulk update.',
    plan: () => ({ expect: 'partial', lagging: except('gluesync-conductor', 'gluesync-chronos') }),
    before: async () => backofficeAdmin('/__sandbox/chaos', { grafana: { mode: '500' } }),
  },
  {
    name: 'backoffice-slow',
    description: 'Backoffice takes 7s for core-hub (conductor timeout is 5s). Measures error latency and blast radius.',
    plan: () => ({ expect: 'partial', lagging: except('gluesync-conductor') }),
    before: async () => backofficeAdmin('/__sandbox/chaos', { 'core-hub': { mode: 'slow', delayMs: 7000 } }),
  },
  {
    name: 'catalog-agent-mismatch',
    description: 'Catalog keeps the agent one version behind core-hub. The conductor should refuse cleanly.',
    plan: (target, i) => ({
      expect: 'partial',
      lagging: except('gluesync-conductor', 'gluesync-chronos'),
      catalog: { 'gluesync-postgresql-cdc-source-agent': versionsFor(i - 1)['gluesync-postgresql-cdc-source-agent'] },
    }),
  },
  {
    name: 'missing-image',
    description: 'Prometheus target version is advertised but was never pushed. Checks what is left in the compose file.',
    plan: () => ({ expect: 'partial', lagging: ['prometheus'], skipImages: ['prometheus'] }),
  },
  {
    name: 'bad-release',
    description: 'The new grafana image crashes on start. The conductor must report it and roll grafana back.',
    plan: () => ({ expect: 'partial', lagging: ['grafana'], crashImages: ['grafana'] }),
  },
  {
    name: 'corehub-ws-drop',
    description: 'CoreHub drops the conductor WebSocket twice while the bulk update runs.',
    plan: () => ({ expect: 'updated' }),
    during: async ctx => {
      if (!(await bulkInFlight(ctx)).ok) return;
      await corehub.admin('/__sandbox/ws-drop', { mode: 'terminate' });
      await sleep(5000);
      await corehub.admin('/__sandbox/ws-drop', { mode: 'terminate' });
    },
  },
  {
    name: 'corehub-auth-outage',
    description: 'CoreHub /authentication/me returns 500 for 25s at the start. Expect 503, never 401, then recovery.',
    plan: () => ({ expect: 'updated', freshToken: true }),
    before: async () => corehub.chaos({ auth: { mode: 'error500', until: Date.now() + 25000 } }),
  },
  {
    name: 'corehub-down',
    description: 'CoreHub container is stopped for 40s as the update starts, including while the conductor restarts.',
    plan: () => ({ expect: 'updated', extraCoreHubStarts: 1 }),
    before: async (ctx, it) => {
      const c = await containerOf('gluesync-core-hub');
      if (c) await docker(['stop', '-t', '2', c.id]);
      it.notes.push(`stopped core-hub ${c?.id} at ${now()}`);
      setTimeout(async () => {
        const stopped = (await containers()).find(x => x.service === 'gluesync-core-hub');
        if (stopped && stopped.state !== 'running') await docker(['start', stopped.id]);
        it.notes.push(`restarted core-hub at ${now()}`);
      }, 40000);
    },
  },
  {
    name: 'docker-socket-slow',
    description: 'Every Docker API connection from the conductor is delayed 3s for the first 90s of the update (overloaded host).',
    plan: () => ({ expect: 'updated' }),
    before: async () => dockerProxy({ mode: 'delay', delayMs: 3000, until: Date.now() + 90000 }),
  },
  {
    name: 'docker-socket-blip',
    description: 'Docker API refuses connections for 10s mid-update; GET /version and /containers are called during the blip.',
    plan: () => ({ expect: 'updated' }),
    faultActive: async () => (await dockerProxy()).json?.effective === 'refuse',
    during: async (ctx, it) => {
      if (!(await bulkInFlight(ctx)).ok) return;
      await sleep(1500);
      await dockerProxy({ mode: 'refuse', until: Date.now() + 10000 });
      await callConductor(it, 'during blip: /containers', 'GET', '/containers?type=all', { token: ctx.adminToken });
      await callConductor(it, 'during blip: /version', 'GET', '/version', { token: ctx.adminToken });
    },
  },
  {
    name: 'docker-proxy-down',
    description:
      'The Docker socket proxy container is stopped for 10s right after compose recreated a service of the bulk update (the Docker API is gone, not just refusing). The update must end with every service running, on its new image or rolled back, the compose file matching the containers and nothing left stopped or created-not-started; the next click converges.',
    // The user keeps clicking after a round that failed inside the outage.
    plan: () => ({ expect: 'updated', minRounds: 8 }),
    faultActive: (ctx, it) => it.dockerFault?.active === true,
    during: stopProxyAfterRecreate,
  },
  {
    name: 'concurrent-update',
    description: 'Every update request is sent twice in parallel, like a double click or two open tabs.',
    plan: () => ({ expect: 'updated', concurrent: 2 }),
  },
  {
    name: 'conductor-crash-mid-update',
    description: 'The conductor process is SIGKILLed right after it rewrites the compose file in the bulk update (power cut, OOM kill).',
    plan: () => ({ expect: 'updated', expectConductorRestarts: 1 }),
    during: async (ctx, it) => {
      if (!(await bulkInFlight(ctx)).ok) return;
      // Strike the moment the conductor has rewritten the compose file, before it
      // has recreated the containers.
      const file = path.join(env.kitDir, 'docker-compose.yml');
      const before = fs.statSync(file).mtimeMs;
      const rewritten = await waitFor('compose rewrite', async () => fs.statSync(file).mtimeMs !== before, {
        timeoutMs: 20000,
        intervalMs: 25,
      });
      it.notes.push(rewritten.ok ? `compose rewritten ${rewritten.ms}ms into the bulk update` : 'compose rewrite not seen');
      const c = await containerOf('gluesync-conductor');
      if (!c) return;
      const r = await docker(['run', '--rm', '--pid=host', 'alpine:3.20', 'kill', '-9', String(c.pid)]);
      it.notes.push(`SIGKILL conductor pid ${c.pid} (${c.id}) at ${now()}: exit ${r.code}`);
      // Whatever the kill left behind, and what the restarted conductor made of it, must be a valid compose.
      const look = () => composeProblem(fs.readFileSync(file, 'utf8'));
      it.crashCompose = { afterKill: look() };
      await sleep(1000);
      const back = await waitConductor({ timeoutMs: 120000 });
      it.crashCompose.afterRestart = back.ok ? look() : 'conductor did not restart';
    },
  },
  {
    name: 'disk-full',
    description:
      "The compose file's filesystem has no free space when the update is sent (a 256 KiB tmpfs bind-mounted over the conductor's compose mount and filled). The update must be refused with 'not enough free disk space' and touch nothing; once space is freed the retry must update everything.",
    plan: () => ({ expect: 'updated', refusal: { phrase: DISK_FULL_TEXT, code: 'DISK_FULL', status: 507 } }),
    before: (ctx, it) => startDiskFault(ctx, it, { freeKiB: 0 }),
  },
  {
    name: 'disk-almost-full',
    description:
      'Free space on the compose file filesystem is above the compose size but below the conductor minimum (32 KiB left, minimum 64 KiB). Same expectation as disk-full: refused up front with nothing touched, then the retry succeeds.',
    plan: () => ({ expect: 'updated', refusal: { phrase: DISK_FULL_TEXT, code: 'DISK_FULL', status: 507 } }),
    before: (ctx, it) => startDiskFault(ctx, it, { freeKiB: ALMOST_FULL_KIB }),
  },
  {
    name: 'disk-flapping',
    description:
      'During the bulk update the compose filesystem toggles between full and 96 KiB free every 20-50 ms, so pre-flights sometimes pass and the compose write then hits ENOSPC. The UI-like driver keeps retrying. The compose file must never be blank or invalid at any sample; after the filler stops the update must converge.',
    plan: () => ({ expect: 'updated', flapping: { rounds: FLAP_ROUNDS }, minRounds: 14 }),
    // Not before the conductor's self-update: its helper recreates the conductor from the host compose file.
    beforeRound: async (ctx, it, { round, phase }) => {
      if (phase !== 'bulk') return;
      const flap = (it.flapping ||= { bulkRounds: 0 });
      if (flap.bulkRounds === 0) {
        await startDiskFault(ctx, it, { freeKiB: FLAP_OPEN_KIB, flap: true });
        flap.startRound = round;
      } else if (flap.bulkRounds === FLAP_ROUNDS) {
        await releaseDiskFault(it);
        flap.stopRound = round;
      }
      flap.bulkRounds += 1;
    },
    after: (ctx, it) => releaseDiskFault(it),
  },
  {
    name: 'compose-blanked',
    description:
      'The compose file is truncated to 0 bytes (what a conductor left behind on a full disk) and the conductor restarted. Within 60s it must restore the file from its last-good backup, byte for byte, log it, and never write a stub compose; then the normal update works.',
    plan: () => ({ expect: 'updated', blanked: true }),
    before: blankCompose,
  },
  {
    name: 'full-restart',
    description: 'After the update, the "restart all" action (pull, down, up through a helper container).',
    plan: () => ({ expect: 'updated', extraCoreHubStarts: 1 }),
    after: async (ctx, it) => {
      const before = await containerOf('gluesync-conductor');
      const r = await callConductor(it, 'full restart', 'POST', '/containers', {
        token: ctx.adminToken,
        body: { action: 'restart', ids: [] },
        timeoutMs: 60000,
      });
      it.notes.push(`full restart answered ${r.status}`);
      const back = await waitFor(
        'conductor after full restart',
        async () => {
          const c = await containerOf('gluesync-conductor');
          return c && c.id !== before?.id;
        },
        { timeoutMs: 300000, intervalMs: 3000 },
      );
      it.metrics.fullRestartMs = back.ms;
      if (!back.ok) it.notes.push('conductor container was not recreated by the full restart within 5 minutes');
    },
  },
  {
    name: 'compose-customization',
    description: 'A customer edit (env var, label with $$, a comment) is added before the update and must survive it.',
    plan: () => ({ expect: 'updated', customization: true }),
    before: async (ctx, it) => {
      const file = path.join(env.kitDir, 'docker-compose.yml');
      const text = fs.readFileSync(file, 'utf8');
      const marker = /(\n {2}grafana:\n)/;
      if (!marker.test(text)) {
        it.notes.push('could not find grafana block to customise');
        return;
      }
      // Replacer functions: in a replacement string "$$" would collapse to "$".
      const edited = text
        .replace(marker, m => `${m}    # customer note: keep the CUSTOMER_SETTING below\n`)
        .replace(/(\n {2}grafana:\n(?:.*\n)*? {4}environment:\n)/, m => `${m}      - CUSTOMER_SETTING=keep-me\n`)
        .replace(/(\n {2}grafana:\n(?:.*\n)*? {4}labels:\n)/, m => `${m}      - customer.note=costs $$5 per month\n`);
      fs.writeFileSync(file, edited);
      const r = await kitCompose(['up', '-d', 'grafana']);
      it.notes.push(`customised grafana in compose (up exit ${r.code})`);
    },
  },
  {
    name: 'proxy-error-pages',
    description:
      'The update moves reverse-proxy to a molo17/traefik tag with the error pages wrapper (3.7.16.x): the conductor must add the wiring on its own (gluesync-pages middleware and plugin in proxy/traefik.yml, labels on the proxy service), back up both files first, recreate the proxy, never touch certs.yml and keep every line of the customer traefik.yml. Then the old tag is put back and the proxy recreated: the wiring must go again and traefik.yml and the proxy block of the compose file must be as they were.',
    versions: i => ({ 'reverse-proxy': `3.7.16.${100 + i}` }),
    // The proxy ends the iteration on the tag it started with, which is the downgrade half.
    plan: () => ({ expect: 'updated', lagging: ['reverse-proxy'], proxyPages: true }),
    before: proxyBaseline,
    after: proxyErrorPages,
  },
  {
    name: 'ui-sequence',
    description:
      'What the Core Hub UI does: one update request per service, in the UI order, through the reverse proxy, with the UI auto-retry policy. Updating reverse-proxy recreates the proxy the request travels through.',
    // The UI never updates agents from the platform updates modal.
    plan: () => ({ expect: 'updated', ui: true, lagging: ['gluesync-postgresql-cdc-source-agent'] }),
  },
  {
    name: 'conductor-bad-release',
    destructive: true,
    description: 'The new conductor image crashes on start. The self-update helper must roll the conductor back by itself.',
    plan: () => ({ expect: 'partial', lagging: ALL, crashImages: ['gluesync-conductor'], conductorMayDie: true }),
  },
];

// Also what a failed iteration relies on to leave nothing behind: no disk-fault mounts or
// filler files in the conductor, and the compose file on the host as the conductor last had it.
export const resetChaos = async () => {
  await releaseDiskFault().catch(() => {});
  await corehub.chaos({ auth: null, ws: null });
  const state = (await backofficeAdmin('/__sandbox/state')).json;
  const clear = Object.fromEntries(Object.keys(state?.chaos || {}).map(k => [k, null]));
  if (Object.keys(clear).length) await backofficeAdmin('/__sandbox/chaos', clear);
  // A profile that was cut short may have left the proxy container stopped.
  await startDockerProxyContainer();
  await dockerProxy({ mode: 'pass' });
};
