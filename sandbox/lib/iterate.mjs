import fs from 'node:fs';
import path from 'node:path';
import { env, SERVICES, versionsFor } from './env.mjs';
import { backofficeAdmin, catalogFor, dindRunning, ensureImages, kitCompose } from './setup.mjs';
import { LogCollector, callConductor, conductorContainer, containers, corehub, health, settle, snapshot, waitConductor, waitConductorStartup, waitStackReady } from './stack.mjs';
import { PROFILES, resetChaos } from './scenarios.mjs';
import { ComposeSampler } from './composeSampler.mjs';
import { readLiveCompose, releaseDiskFault } from './diskFault.mjs';
import { driveLikeUi, uiChecks } from './uiDriver.mjs';
import { sessionSuite } from './sessions.mjs';
import { runChecks } from './checks.mjs';
import { writeReport } from './report.mjs';
import { iterationCases, writeJunit } from './junit.mjs';
import { describeState, docker, inSequence, now, rng, say, setLogFile, shuffle, sleep, waitFor, writeJson } from './util.mjs';

const stateFile = () => path.join(env.stateDir, 'iterations.json');

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { last: 0 };
  }
};

const pushedRefs = () => new Set(JSON.parse(fs.readFileSync(path.join(env.stateDir, 'pushed-images.json'), 'utf8')));

// pino in the conductor writes either epoch ms or "MM/DD/YYYY, HH:MM:SS" (container TZ = UTC).
const pinoTimeToIso = t => {
  if (typeof t === 'number') return new Date(t).toISOString();
  const m = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})$/.exec(t || '');
  return m ? new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] % 24, +m[5], +m[6])).toISOString() : null;
};

const fileLogInfo = async conductorId => {
  const f = '/opt/gluesync-conductor/logs/gluesync-conductor.log';
  const r = await docker(['exec', conductorId, 'sh', '-c', `[ -f ${f} ] && wc -l < ${f} && head -n 1 ${f}`]);
  if (r.code !== 0) return { path: f, exists: false };
  const [count, first] = r.out.split('\n');
  let firstTs = null;
  try {
    firstTs = pinoTimeToIso(JSON.parse(first).time);
  } catch {
    /* not JSON */
  }
  return { path: f, exists: true, lines: Number(count), firstTs };
};

const resources = async conductorId => {
  const stats = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', conductorId]);
  // "45.3MiB / 7.6GiB": the usage comes first. Anchored, so the match cannot backtrack.
  const m = /^([\d.]+)\s*(KiB|MiB|GiB)/.exec(stats.out || '');
  const mib = m ? +m[1] * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]] : null;
  const fds = await docker(['exec', conductorId, 'sh', '-c', 'ls /proc/1/fd | wc -l']);
  return { memMiB: mib ? +mib.toFixed(1) : null, fds: fds.code === 0 ? Number(fds.out) : null };
};

// What the conductor already did to the shipped kit before any update ran
// (startup healers rewrite the compose file).
const baseline = () => {
  const comments = t => t.split('\n').filter(l => l.trim().startsWith('#')).length;
  const template = fs.readFileSync(path.join(env.sandboxDir, 'kit', 'docker-compose.template.yml'), 'utf8');
  const live = fs.readFileSync(path.join(env.kitDir, 'docker-compose.yml'), 'utf8');
  return { templateCommentLines: comments(template), liveCommentLines: comments(live) };
};

const tags = list => Object.fromEntries(list.filter(c => c.state === 'running').map(c => [c.service, c.tag]));

// The conductor updates itself first, then Chronos, then everything else.
const phaseFor = (before, target, lagging) => {
  const behind = s => before[s] !== target[s] && !lagging.has(s);
  if (behind('gluesync-conductor')) return 'conductor';
  if (behind('gluesync-chronos')) return 'chronos';
  return 'bulk';
};

// After the conductor updated itself: waits for the new container and, for a bad
// release, for the rollback. Returns whether the user keeps clicking.
const followSelfUpdate = async (it, entry, target, plan, oldId) => {
  const back = await waitConductor({ notId: oldId, timeoutMs: 300000 });
  entry.conductorBackMs = back.ms;
  entry.conductorBack = back.ok;
  if (!back.ok) {
    it.notes.push('conductor did not come back within 5 minutes of its self-update');
    return false;
  }
  // Wait out the self-update helper's verification (it rolls back a bad
  // release within ~2 minutes), then see which version stuck.
  if (plan.crashImages?.includes('gluesync-conductor')) {
    const settledBack = await waitFor(
      'conductor rollback',
      async () => {
        const c = await conductorContainer();
        return c && c.tag !== target['gluesync-conductor'] && (await health()).status === 200 ? c : false;
      },
      { timeoutMs: 240000, intervalMs: 5000 },
    );
    it.notes.push(
      settledBack.ok
        ? `conductor rolled itself back to ${settledBack.value.tag} after ${Math.round(settledBack.ms / 1000)}s`
        : 'conductor did not roll itself back within 4 minutes',
    );
    return false;
  }
  return true;
};

// One "update all" click (sent `plan.concurrent` times in parallel). Returns whether
// the user clicks again. `state` carries the retry and no-progress counters across rounds.
const driveRound = async (ctx, it, target, plan, state, round) => {
  state.retryable = false;
  state.waited = false;
  const ready = await waitConductor({ timeoutMs: 240000 });
  if (!ready.ok) {
    it.rounds.push({ round, error: 'conductor not reachable', waitedMs: ready.ms });
    return false;
  }
  const before = tags(await containers());
  const phase = phaseFor(before, target, state.lagging);
  try {
    await ctx.profile?.beforeRound?.(ctx, it, { round, phase });
  } catch (e) {
    it.notes.push(`round ${round} hook failed: ${e.message}`);
  }
  ctx.inflight = { round, phase, conductorId: ready.value.id, startedAt: Date.now() };
  const send = () =>
    callConductor(it, `update round ${round}`, 'POST', '/containers', {
      token: state.token,
      body: { action: 'update', ids: [], releaseChannel: 'ga' },
      timeoutMs: 600000,
    });
  const responses = await Promise.all(Array.from({ length: plan.concurrent || 1 }, send));
  ctx.inflight = null;
  const items = responses.flatMap(r => r.json?.data?.containers || []);
  const entry = {
    round,
    phase,
    statuses: responses.map(r => r.status || r.error),
    ms: Math.max(...responses.map(r => r.ms)),
    items: items.map(c => `${c.id}:${c.status}`),
  };
  it.rounds.push(entry);
  say(`  round ${round} (${phase}) -> ${entry.statuses.join(',')} in ${Math.round(entry.ms / 1000)}s ${entry.items.join(' ')}`);

  // A profile that expects the first round to be refused: it is not an outage to wait out;
  // `drive` looks at what the refusal left behind, lifts the fault and goes on.
  if (plan.refusal && !state.released) {
    const text = responses.map(r => JSON.stringify(r.json ?? r.text ?? r.error ?? '')).join(' ');
    entry.refused = text.includes(plan.refusal.phrase);
    entry.refusalText = text.slice(0, 400);
    entry.refusalDiagnoses = responses.map(r => r.json?.diagnosis?.code);
    if (entry.refused) return false;
  }

  // CoreHub or the conductor briefly unavailable: a user waits and clicks
  // again. These retries do not count as update rounds (up to 12 of them).
  if (responses.every(r => r.status === 503 || r.status === 0) && state.retries < 12) {
    state.retries += 1;
    state.waited = true;
    await sleep(10000);
    return true;
  }
  if (!responses.some(r => r.status === 200)) {
    state.retryable = true;
    return false;
  }
  if (items.some(c => c.id === 'gluesync-conductor')) {
    return followSelfUpdate(it, entry, target, plan, ready.value.id);
  }
  // Keep clicking until everything is current: lagging services are allowed to stay
  // behind, but the bulk update must still be attempted so its refusal is tested.
  const after = tags(await containers());
  if (Object.keys(SERVICES).every(s => after[s] === target[s])) return false;
  state.noProgress = JSON.stringify(after) === JSON.stringify(before) ? state.noProgress + 1 : 0;
  state.retryable = state.noProgress >= 2;
  return state.noProgress < 2;
};

// What a refused update must leave alone: the compose bytes the conductor sees and the containers.
const untouched = async () => {
  const live = await readLiveCompose();
  const list = await containers();
  return { compose: live, containers: list.map(c => `${c.service}:${c.id}:${c.image}`).sort() };
};

// After the round that was expected to be refused: records what it left behind, then lifts the
// fault (always, so a conductor that did not refuse cannot keep a full disk for the whole
// iteration). Returns whether the round was refused, i.e. whether the user clicks again.
const endRefusal = async (ctx, it, plan, state, round, kept) => {
  const entry = it.rounds.find(r => r.round === round);
  const after = await untouched();
  const services = await callConductor(it, 'refusal: services', 'GET', '/services', { token: state.token, timeoutMs: 15000 });
  it.refusal = {
    round,
    refused: !!entry?.refused,
    statuses: entry?.statuses,
    text: entry?.refusalText,
    diagnoses: entry?.refusalDiagnoses,
    composeUnchanged: !!kept.compose && !!after.compose && kept.compose.equals(after.compose),
    composeBytes: after.compose?.length ?? null,
    containersUnchanged: JSON.stringify(kept.containers) === JSON.stringify(after.containers),
    changedContainers: after.containers.filter(c => !kept.containers.includes(c)),
    servicesStatus: services.status,
  };
  await releaseDiskFault(it);
  state.released = true;
  state.noProgress = 0;
  return it.refusal.refused;
};

// Drives the update the way a persistent user does in the UI: "update all", wait,
// click again, until everything is current or the conductor stops making progress.
const drive = async (ctx, it, target, plan) => {
  const state = {
    token: plan.freshToken ? await corehub.login('admin') : ctx.adminToken,
    lagging: new Set(plan.lagging || []),
    noProgress: 0,
    retries: 0,
  };
  const kept = plan.refusal ? await untouched() : null;
  const maxRounds = Math.max(6, plan.minRounds || 0);
  for (let round = 1; round <= maxRounds + state.retries; round += 1) {
    const more = await driveRound(ctx, it, target, plan, state, round);
    const refused = plan.refusal && !state.released && !state.waited ? await endRefusal(ctx, it, plan, state, round, kept) : false;
    if (more || refused) continue;
    // A profile that wants the user to keep clicking: a failed or stalled round is retried.
    if (state.retryable && round < (plan.minRounds || 0)) {
      await sleep(2000);
      continue;
    }
    break;
  }
  ctx.inflight = null;
};

// Brings a dead conductor back by pointing the compose file at the last good tag.
const recoverConductor = async (it, goodTag) => {
  const file = path.join(env.kitDir, 'docker-compose.yml');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/(molo17\/gluesync-conductor:)[^\s]+/, `$1${goodTag}`));
  await kitCompose(['up', '-d', 'gluesync-conductor']);
  const back = await waitConductor({ timeoutMs: 240000 });
  it.notes.push(`runner restored conductor ${goodTag} by hand: ${back.ok ? 'ok' : 'failed'}`);
};

const outcomeOf = (it, failed, warned) => {
  if (it.error || failed.length) return 'fail';
  return warned.length ? 'warn' : 'pass';
};

const runIteration = async (ctx, i, profile, k) => {
  const target = versionsFor(i);
  const plan = { lagging: [], ...profile.plan(target, i) };
  const it = {
    index: i,
    profile: profile.name,
    description: profile.description,
    expect: plan.expect,
    startedAt: now(),
    rounds: [],
    api: [],
    notes: [],
    checks: [],
    metrics: {},
  };
  const iterDir = path.join(ctx.dir, `iter-${String(k + 1).padStart(2, '0')}-${profile.name}`);
  fs.mkdirSync(iterDir, { recursive: true });
  say(`iteration ${k + 1}/${ctx.total} [${profile.name}] -> versions .${100 + i}: ${profile.description}`);

  ctx.profile = profile;
  ctx.sampler = new ComposeSampler();
  try {
    // Mounts or filler files a failed earlier iteration (or runner) left in the conductor.
    await releaseDiskFault(it);
    await ensureImages(target, { skip: plan.skipImages || [], crash: plan.crashImages || [] });
    const catalogVersions = { ...target, ...plan.catalog };
    await backofficeAdmin('/__sandbox/catalog', catalogFor(catalogVersions));

    const corehubBefore = (await corehub.admin('/__sandbox/state')).json;
    // From here to the end of the iteration the compose file is sampled every ~25ms.
    ctx.sampler.start();
    await profile.before?.(ctx, it);
    const pre = await snapshot();
    fs.writeFileSync(path.join(iterDir, 'compose-before.yml'), pre.compose.text);
    // What the UI does when the update page opens.
    await callConductor(it, 'ui: containers', 'GET', '/containers?type=all', { token: ctx.adminToken });
    await callConductor(it, 'ui: services', 'GET', '/services', { token: ctx.adminToken });
    await inSequence(Object.keys(SERVICES), s =>
      callConductor(it, `ui: version ${s}`, 'GET', `/services/${s}/version/ga`, { token: ctx.adminToken, timeoutMs: 60000 }),
    );

    const started = Date.now();
    const driver = plan.ui ? driveLikeUi : drive;
    await Promise.allSettled([driver(ctx, it, target, plan), profile.during ? profile.during(ctx, it) : null]);
    it.metrics.updateMs = Date.now() - started;
    await profile.after?.(ctx, it);
    await resetChaos();

    if (plan.conductorMayDie && (await health()).status !== 200) {
      await recoverConductor(it, pre.byService['gluesync-conductor']?.tag);
    }

    const settled = await settle(ctx, ctx.adminToken, { ignore: plan.crashImages || [] });
    it.sampler = ctx.sampler.finish();
    const sessions = await sessionSuite(it, { deep: k === 0 || (k + 1) % 5 === 0 });
    const post = await snapshot();
    fs.writeFileSync(path.join(iterDir, 'compose-after.yml'), post.compose.text);
    const corehubAfter = (await corehub.admin('/__sandbox/state')).json;
    const conductor = post.byService['gluesync-conductor'];
    const composeConfig = await kitCompose(['config', '-q']);
    const fileLog = conductor ? await fileLogInfo(conductor.id) : null;
    if (conductor) Object.assign(it.metrics, await resources(conductor.id));
    const selfUpdate = it.rounds.find(r => r.conductorBackMs !== undefined);
    if (selfUpdate) it.metrics.conductorSelfUpdateMs = selfUpdate.conductorBackMs;

    const conductorLogs = ctx.collector.since('gluesync-conductor', it.startedAt);
    it.checks = [
      ...runChecks({
        it,
        pre,
        post,
        target,
        plan,
        settled,
        corehubBefore,
        corehubAfter,
        conductorLogs,
        pushedRefs: pushedRefs(),
        composeConfig,
        fileLog,
      }),
      ...sessions,
      ...(plan.ui ? uiChecks(it, post, target) : []),
    ];
    it.final = Object.fromEntries(Object.entries(post.byService).map(([s, c]) => [s, `${c.tag} ${describeState(c)}`]));
    fs.writeFileSync(path.join(iterDir, 'conductor.log'), conductorLogs.map(l => `${l.ts} [${l.incarnation}] ${l.line}`).join('\n'));
    fs.writeFileSync(
      path.join(iterDir, 'corehub.log'),
      ctx.collector.since('gluesync-core-hub', it.startedAt).map(l => `${l.ts} [${l.incarnation}] ${l.line}`).join('\n'),
    );
  } catch (e) {
    it.error = e.stack || String(e);
    say(`  iteration error: ${e.message}`);
    await resetChaos().catch(() => {});
  }
  it.sampler ||= ctx.sampler.finish();
  ctx.sampler = null;
  ctx.profile = null;
  it.finishedAt = now();
  it.durationMs = Date.parse(it.finishedAt) - Date.parse(it.startedAt);
  const failed = it.checks.filter(c => c.severity === 'fail');
  const warned = it.checks.filter(c => c.severity === 'warn');
  it.outcome = outcomeOf(it, failed, warned);
  writeJson(path.join(iterDir, 'iteration.json'), it);
  const failList = failed.length ? ` | fail: ${failed.map(c => c.id).join(', ')}` : '';
  const warnList = warned.length ? ` | warn: ${warned.map(c => c.id).join(', ')}` : '';
  say(`  -> ${it.outcome.toUpperCase()} in ${Math.round(it.durationMs / 1000)}s${failList}${warnList}`);
  return it;
};

// "2/4" -> { index: 2, total: 4 }
export const parseShard = spec => {
  const m = /^(\d+)\/(\d+)$/.exec(spec || '');
  const shard = m && { index: Number(m[1]), total: Number(m[2]) };
  if (!shard || shard.index < 1 || shard.index > shard.total) throw new Error(`--shard must be i/n with 1 <= i <= n (got "${spec}")`);
  return shard;
};

// Which profiles run, in PROFILES order.
//   --profiles a,b   exactly those
//   --profiles all   every non-destructive profile except the excluded ones (also the default with --shard)
//   --shard i/n      the profiles at positions k of that list with k % n == i-1
export const selectProfiles = ({ profiles, destructive, shard, exclude }) => {
  const known = PROFILES.map(p => p.name);
  const unknown = [...profiles.filter(n => n !== 'all'), ...exclude].filter(n => !known.includes(n));
  if (unknown.length) throw new Error(`unknown profile(s) ${unknown.join(',')}; known: ${known.join(', ')}`);
  const all = profiles.includes('all') || (!profiles.length && !!shard);
  const eligible = PROFILES.filter(p => destructive || !p.destructive);
  const selected = all
    ? eligible.filter(p => !exclude.includes(p.name))
    : eligible.filter(p => !profiles.length || profiles.includes(p.name));
  return {
    all,
    available: shard ? selected.filter((_, k) => k % shard.total === shard.index - 1) : selected,
  };
};

// The iterations to run, in order. `all` and a shard run each selected profile once and ignore
// --iterations; --iterations sizes the other schedules (a repeated explicit list, or the default
// random one).
const buildSchedule = ({ all, shard, profiles, available, iterations, rand }) => {
  if (all || shard) return [...available];
  const schedule = [];
  if (profiles.length) {
    while (schedule.length < iterations) schedule.push(...available);
  } else {
    const clean = available.find(p => p.name === 'clean');
    const others = available.filter(p => p.name !== 'clean');
    if (clean) schedule.push(clean);
    while (schedule.length < iterations) schedule.push(...shuffle(others, rand));
  }
  schedule.length = iterations;
  return schedule;
};

// How a sharded run names itself: in the report directory, in the log line and in the junit suite.
const shardNames = shard => {
  if (!shard) return { dirSuffix: '', logNote: '', suite: 'conductor-sandbox iterate' };
  const text = `shard ${shard.index}/${shard.total}`;
  return { dirSuffix: `-shard${shard.index}of${shard.total}`, logNote: `, ${text}`, suite: `conductor-sandbox iterate ${text}` };
};

// Runs the iterations, writes the report (and junit.xml) and resolves to the run: the caller
// turns `run.iterations[].outcome === 'fail'` into the exit code.
export const iterate = async ({ iterations, seed, profiles, destructive, shard: shardSpec, exclude = [] }) => {
  const shard = shardSpec ? parseShard(shardSpec) : null;
  // Fail on a typo before anything starts.
  const { all, available } = selectProfiles({ profiles, destructive, shard, exclude });
  if (!available.length && !shard) throw new Error(`no profiles match ${profiles.join(',')}`);
  if (!(await dindRunning()) || (await health()).status !== 200) {
    throw new Error('sandbox is not up or the conductor is unhealthy: run `node sandbox/run.mjs up` first');
  }
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const names = shardNames(shard);
  const dir = path.join(env.reportsDir, `${stamp}-seed${seed}${names.dirSuffix}`);
  fs.mkdirSync(dir, { recursive: true });
  setLogFile(path.join(dir, 'runner.log'));
  const startedAt = now();
  if (!available.length) {
    say(`shard ${shard.index}/${shard.total} has no profiles: nothing to run`);
    return { seed, startedAt, iterations: [] };
  }

  const rand = rng(seed);
  const schedule = buildSchedule({ all, shard, profiles, available, iterations, rand });
  const total = schedule.length;

  // Same wait as the end of `up`: a runner that reaches this line right after `up` must not meet a
  // fake that is still starting.
  await waitStackReady();
  // Iteration 1's snapshot must not race the Conductor's startup recreates (auto-adoption).
  await waitConductorStartup();
  const collector = new LogCollector(path.join(dir, 'logs'));
  collector.start();
  // The collector's timer and its `docker logs -f` children keep the process alive: whatever
  // happens below, they are stopped before iterate returns or throws (a throw here once left the
  // CI job `running` for the rest of its timeout).
  try {
    const ctx = { dir, collector, total, adminToken: await corehub.login('admin', 86400), inflight: null };
    const state = loadState();
    const run = { seed, startedAt, ...(shard ? { shard } : {}), schedule: schedule.map(p => p.name), iterations: [], baseline: baseline() };
    say(`run ${path.basename(dir)}: ${total} iterations, seed ${seed}${names.logNote}`);
    say(`schedule: ${run.schedule.join(', ')}`);

    const writeJunitFile = () => writeJunit(dir, { suite: names.suite, classname: 'sandbox.iterate', startedAt, cases: iterationCases(run) });
    await inSequence(schedule, async (profile, k) => {
      const i = state.last + 1;
      run.iterations.push(await runIteration(ctx, i, profile, k));
      state.last = i;
      writeJson(stateFile(), state);
      writeReport(dir, run);
      // After every iteration, so a job that is killed half way still leaves a test report.
      writeJunitFile();
    });
    run.finishedAt = now();
    const { md } = writeReport(dir, run);
    writeJunitFile();
    say(`report: ${md}`);
    return run;
  } finally {
    collector.stop();
  }
};
