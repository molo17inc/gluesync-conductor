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
//
// before/during/after get (ctx, it). `during` runs alongside the update driver and
// can watch ctx.inflight to strike while an update request is in progress.

import fs from 'node:fs';
import path from 'node:path';
import { env, SERVICES, versionsFor } from './env.mjs';
import { backofficeAdmin, kitCompose } from './setup.mjs';
import { callConductor, containers, corehub, dockerProxy } from './stack.mjs';
import { docker, now, sleep, waitFor } from './util.mjs';

const ALL = Object.keys(SERVICES);
const except = (...keep) => ALL.filter(s => !keep.includes(s));

// Resolves once a bulk (non-conductor) update request is in flight.
const bulkInFlight = (ctx, timeoutMs = 300000) =>
  waitFor('bulk update in flight', async () => ctx.inflight && ctx.inflight.round >= 2 && ctx.inflight, {
    timeoutMs,
    intervalMs: 250,
  });

const containerOf = async service => (await containers()).find(c => c.service === service && c.state === 'running');

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
    during: async (ctx, it) => {
      if (!(await bulkInFlight(ctx)).ok) return;
      await sleep(1500);
      await dockerProxy({ mode: 'refuse', until: Date.now() + 10000 });
      await callConductor(it, 'during blip: /containers', 'GET', '/containers?type=all', { token: ctx.adminToken });
      await callConductor(it, 'during blip: /version', 'GET', '/version', { token: ctx.adminToken });
    },
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
    },
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
    name: 'conductor-bad-release',
    destructive: true,
    description: 'The new conductor image crashes on start. The self-update helper must roll the conductor back by itself.',
    plan: () => ({ expect: 'partial', lagging: ALL, crashImages: ['gluesync-conductor'], conductorMayDie: true }),
  },
];

export const resetChaos = async () => {
  await corehub.chaos({ auth: null, ws: null });
  const state = (await backofficeAdmin('/__sandbox/state')).json;
  const clear = Object.fromEntries(Object.keys(state?.chaos || {}).map(k => [k, null]));
  if (Object.keys(clear).length) await backofficeAdmin('/__sandbox/chaos', clear);
  await dockerProxy({ mode: 'pass' });
};
