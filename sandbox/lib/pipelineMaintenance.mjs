// The pipeline maintenance profiles: before an update changes Core Hub's image the conductor puts
// every running pipeline in Core Hub's maintenance mode, and takes the same ones out of it once Core
// Hub is stable again (or rolled back). The fake Core Hub (fakes/fake.mjs) keeps the pipelines and
// an event per command, stamped with its own version, so the runner can tell on which Core Hub a
// pipeline was paused and on which it was resumed.

import fs from 'node:fs';
import path from 'node:path';
import { env, versionsFor } from './env.mjs';
import { backofficeAdmin, catalogFor } from './setup.mjs';
import { containers, corehub, waitConductor } from './stack.mjs';
import { docker, now, sleep, waitFor } from './util.mjs';

const CORE_HUB = 'gluesync-core-hub';

// Two running pipelines, one stopped, one a user put in maintenance by hand, one draft that has
// never been configured: only the first two may be paused and resumed
export const SEED = [
  { id: 'orders', name: 'Orders', running: true },
  { id: 'billing', name: 'Billing', running: true },
  { id: 'idle', name: 'Stopped', running: false },
  { id: 'held', name: 'In maintenance by hand', running: false, isInMaintenanceMode: true },
  { id: 'draft', name: 'Draft', running: true, configurationCompleted: false },
];
export const RUNNING = ['orders', 'billing'];

// The phrases of the conductor's refusals (pipelineMaintenance.ts)
export const DRAIN_REFUSED_TEXT = 'did not enter maintenance mode in time';
export const ENTER_REFUSED_TEXT = 'could not put every running pipeline in maintenance mode';

// The list the conductor keeps while it holds pipelines (pausedPipelinesStore.ts)
export const pausedFile = () => path.join(env.kitDir, '.conductor', 'update-paused-pipelines.json');

const running = async service => (await containers()).find(c => c.service === service && c.state === 'running');
const tagOf = async service => (await running(service))?.tag ?? null;
const pipelinesState = async () => (await corehub.admin('/__sandbox/pipelines')).json ?? { pipelines: [], events: [] };

// mode: updated | refused | rollback | restart, what pipelineChecks expects
export const seedPipelines = async (ctx, it, { mode, chaos = null }) => {
  it.pipelines = { mode, coreHubBefore: await tagOf(CORE_HUB) };
  await corehub.admin('/__sandbox/pipelines', {
    pipelines: SEED.map(p => ({ configurationCompleted: true, isInMaintenanceMode: false, ...p })),
  });
  await corehub.chaos({ pipelines: chaos });
  it.notes.push(`seeded pipelines ${SEED.map(p => p.id).join(', ')}${chaos ? ` with chaos ${JSON.stringify(chaos)}` : ''}`);
};

// The conductor and Chronos stay where they are, so the first round is the bulk update with Core Hub
// (the round a refusal profile judges)
export const pinConductorAndChronos = async (ctx, it) => {
  const pinned = { 'gluesync-conductor': await tagOf('gluesync-conductor'), 'gluesync-chronos': await tagOf('gluesync-chronos') };
  await backofficeAdmin('/__sandbox/catalog', catalogFor(pinned));
  it.notes.push(`catalog pinned to the running conductor ${pinned['gluesync-conductor']} and chronos ${pinned['gluesync-chronos']}`);
};

export const liftPipelineChaos = async (ctx, it) => {
  await corehub.chaos({ pipelines: null });
  it.notes.push(`pipeline chaos lifted at ${now()}`);
};

// After the refused round: the fault goes and the catalog offers the conductor and Chronos again, so
// the next clicks converge as usual (self-update, Chronos, the rest)
export const releasePipelineRefusal = async (ctx, it) => {
  await liftPipelineChaos(ctx, it);
  const target = versionsFor(it.index);
  await backofficeAdmin(
    '/__sandbox/catalog',
    catalogFor({ 'gluesync-conductor': target['gluesync-conductor'], 'gluesync-chronos': target['gluesync-chronos'] }),
  );
  it.notes.push('catalog offers the conductor and chronos again');
};

// pipelines-conductor-restart: the conductor is SIGKILLed while it waits for the pipelines to report
// maintenance mode (Core Hub's list answers 6 s late), before any image changed. The restarted
// conductor must resume them from its file. The next update click waits for that (beforeRound).
export const killConductorWhilePaused = async (ctx, it) => {
  const bulk = await waitFor('bulk round in flight', async () => ctx.inflight?.phase === 'bulk' && ctx.inflight, {
    timeoutMs: 300000,
    intervalMs: 250,
  });
  if (!bulk.ok) return;
  const entered = await waitFor(
    'running pipelines entered',
    async () => {
      const { events } = await pipelinesState();
      return RUNNING.every(id => events.some(e => e.op === 'entered' && e.id === id)) && fs.existsSync(pausedFile());
    },
    { timeoutMs: 60000, intervalMs: 100 },
  );
  const conductor = await running('gluesync-conductor');
  if (!entered.ok || !conductor) {
    it.notes.push(entered.ok ? 'conductor container not found' : 'the running pipelines never entered maintenance mode');
    return;
  }
  const killedAt = new Date().toISOString();
  const r = await docker(['run', '--rm', '--pid=host', 'alpine:3.20', 'kill', '-9', String(conductor.pid)]);
  it.pipelines.killedAt = killedAt;
  it.pipelines.fileAtKill = fs.readFileSync(pausedFile(), 'utf8');
  it.notes.push(`SIGKILL conductor pid ${conductor.pid} at ${killedAt} with ${RUNNING.join(', ')} in maintenance: exit ${r.code}`);
  await sleep(1000);
  const back = await waitConductor({ timeoutMs: 120000 });
  it.notes.push(back.ok ? `conductor back after ${Math.round(back.ms / 1000)}s` : 'conductor did not restart');
};

// The next click waits until the restarted conductor has resumed the pipelines by itself
export const waitResumedAfterRestart = async (ctx, it) => {
  if (!it.pipelines?.killedAt || it.pipelines.resumedAfterRestart !== undefined) return;
  const resumed = await waitFor(
    'pipelines resumed after the restart',
    async () => {
      const { pipelines } = await pipelinesState();
      return RUNNING.every(id => pipelines.some(p => p.id === id && !p.isInMaintenanceMode && p.running));
    },
    { timeoutMs: 180000, intervalMs: 1000 },
  );
  it.pipelines.resumedAfterRestart = resumed.ok;
  it.notes.push(resumed.ok ? `restarted conductor resumed the pipelines in ${Math.round(resumed.ms / 1000)}s` : 'pipelines still in maintenance 3 minutes after the restart');
  await liftPipelineChaos(ctx, it);
};

export const collectPipelines = async (ctx, it) => {
  const pm = (it.pipelines ||= {});
  // A resume can still be running in the background: give it time before judging
  const settled = await waitFor(
    'pipelines out of maintenance',
    async () => {
      const state = await pipelinesState();
      return RUNNING.every(id => state.pipelines.some(p => p.id === id && !p.isInMaintenanceMode)) && state;
    },
    { timeoutMs: 120000, intervalMs: 1000 },
  );
  const state = settled.ok ? settled.value : await pipelinesState();
  pm.final = state.pipelines;
  pm.events = state.events.filter(e => e.op !== 'list');
  pm.coreHubAfter = await tagOf(CORE_HUB);
  pm.fileAfter = fs.existsSync(pausedFile()) ? fs.readFileSync(pausedFile(), 'utf8') : null;
  const refused = it.api.find(a => a.label === 'update round 1' && a.status >= 400);
  pm.refusedRound = refused ? { from: refused.ts, to: new Date(Date.parse(refused.ts) + refused.ms + 1000).toISOString() } : null;
  pm.replies = it.api
    .filter(a => a.method === 'POST' && a.path === '/containers')
    .map(a => ({ status: a.status, item: a.json?.data?.containers?.find(c => c.id === CORE_HUB), error: a.json?.error, details: a.json?.details }));
  // The next profiles get a Core Hub without pipelines, as before this feature
  await corehub.admin('/__sandbox/pipelines', { pipelines: [] });
  await corehub.chaos({ pipelines: null });
};

// ---------------------------------------------------------------- checks

const sameSet = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
const eventsOf = (pm, op, id) => pm.events.filter(e => e.op === op && (id === undefined || e.id === id));
const step = (id, ok, detail) => ({ id, ok, detail });

const commonSteps = pm => {
  const touched = [...new Set(pm.events.filter(e => /^(enter|exit)/.test(e.op)).map(e => e.id))];
  const strangers = touched.filter(id => !RUNNING.includes(id));
  const finalOf = id => pm.final.find(p => p.id === id) || {};
  const notBack = RUNNING.filter(id => finalOf(id).isInMaintenanceMode || !finalOf(id).running);
  const unpaired = eventsOf(pm, 'entered').filter(e => !pm.events.some(x => x.op === 'exited' && x.id === e.id && x.ts >= e.ts));
  const byWhom = [...new Set(pm.events.filter(e => e.by).map(e => e.by))];
  return [
    step('pipelines.only-running-paused', strangers.length === 0, strangers.length ? `commands sent for ${strangers.join(', ')}, which were not running` : `only ${touched.join(', ') || 'nothing'} got maintenance commands; idle, held and draft were left alone`),
    step('pipelines.held-left-alone', finalOf('held').isInMaintenanceMode === true, finalOf('held').isInMaintenanceMode ? 'the pipeline put in maintenance by hand is still in maintenance' : 'the pipeline put in maintenance by hand was taken out of it'),
    step('pipelines.all-resumed', notBack.length === 0 && finalOf('idle').running === false, notBack.length ? `still paused at the end: ${notBack.join(', ')}` : 'every pipeline that was running runs again, the stopped one is still stopped'),
    step('pipelines.every-pause-resumed', unpaired.length === 0, unpaired.length ? `entered maintenance and never exited: ${unpaired.map(e => `${e.id}@${e.version}`).join(', ')}` : `${eventsOf(pm, 'entered').length} pause(s), each followed by a resume`),
    step('pipelines.module-token', byWhom.every(r => r === 'EXTERNAL_MODULE'), `commands sent as ${byWhom.join(', ') || 'nobody'}`),
    step('pipelines.file-cleared', pm.fileAfter === null, pm.fileAfter === null ? 'no paused-pipelines file left in .conductor/' : `left behind: ${pm.fileAfter.slice(0, 200)}`),
  ];
};

// Paused on the old Core Hub (once Core Hub is current no update pauses anything), resumed on the
// new one, reported on Core Hub's reply item
const updatedSteps = pm => {
  // The first command Core Hub answered on its new version: by then every running pipeline must have
  // been in maintenance mode, entered on the old version
  const changedAt = pm.events.find(e => e.version === pm.coreHubAfter)?.ts ?? null;
  const lastBefore = id => pm.events.filter(e => e.id === id && changedAt && e.ts < changedAt && /^(entered|exited)$/.test(e.op)).at(-1);
  const heldAtChange = RUNNING.filter(id => lastBefore(id)?.op === 'entered' && lastBefore(id)?.version === pm.coreHubBefore);
  const resumedOnNew = RUNNING.filter(id => eventsOf(pm, 'exited', id).some(e => e.version === pm.coreHubAfter));
  const reply = pm.replies.find(r => r.item?.pausedPipelines?.length);
  return [
    step(
      'pipelines.paused-before-core-hub-changed',
      pm.coreHubAfter !== pm.coreHubBefore && heldAtChange.length === RUNNING.length,
      `core-hub ${pm.coreHubBefore} -> ${pm.coreHubAfter} (first seen at ${changedAt}); in maintenance from the old Core Hub at that moment: ${heldAtChange.join(', ') || 'none'}`,
    ),
    step('pipelines.resumed-on-new-core-hub', resumedOnNew.length === RUNNING.length, `resumed on ${pm.coreHubAfter}: ${resumedOnNew.join(', ') || 'none'}`),
    step(
      'pipelines.reply-items',
      !!reply && sameSet(reply.item.pausedPipelines, RUNNING) && sameSet(reply.item.resumedPipelines, RUNNING),
      reply ? `Core Hub item: paused ${reply.item.pausedPipelines}, resumed ${reply.item.resumedPipelines}` : 'no reply carried pausedPipelines on the Core Hub item',
    ),
  ];
};

// The refused round paused some pipelines and resumed them, on the same untouched Core Hub, before
// it answered
const refusedSteps = pm => {
  const round = pm.refusedRound;
  const inRound = e => round && e.ts >= round.from && e.ts <= round.to;
  const entered = pm.events.filter(e => e.op === 'entered' && inRound(e));
  const notResumed = entered.filter(e => !pm.events.some(x => x.op === 'exited' && x.id === e.id && inRound(x) && x.ts >= e.ts && x.version === e.version));
  return [
    step(
      'pipelines.refusal-resumed',
      !!round && entered.length > 0 && notResumed.length === 0 && entered.every(e => e.version === pm.coreHubBefore),
      round
        ? `refused round ${round.from}..${round.to}: entered ${entered.map(e => e.id).join(', ') || 'nothing'}${notResumed.length ? `, not resumed before the reply: ${notResumed.map(e => e.id).join(', ')}` : ', all resumed before the reply'} on ${pm.coreHubBefore}`
        : 'no refused round recorded',
    ),
  ];
};

const rolledBackSteps = pm => {
  const exits = eventsOf(pm, 'exited');
  const reply = pm.replies.find(r => r.item?.status === 'ERROR' && r.item?.resumedPipelines?.length);
  return [
    step('pipelines.resumed-after-rollback', pm.coreHubAfter === pm.coreHubBefore && exits.length > 0 && exits.every(e => e.version === pm.coreHubBefore), `core-hub back on ${pm.coreHubAfter} (was ${pm.coreHubBefore}); resumed on ${[...new Set(exits.map(e => e.version))].join(', ') || 'nothing'}`),
    step('pipelines.reply-items', !!reply && sameSet(reply.item.resumedPipelines, RUNNING), reply ? `failed Core Hub item: paused ${reply.item.pausedPipelines}, resumed ${reply.item.resumedPipelines}` : 'no failed Core Hub item reported resumedPipelines'),
  ];
};

const restartSteps = pm => {
  const after = pm.killedAt ? pm.events.filter(e => e.ts > pm.killedAt) : [];
  const firstEnterAfter = after.find(e => e.op === 'enter-requested')?.ts ?? '~';
  const resumedByRestart = RUNNING.filter(id => after.some(e => e.op === 'exited' && e.id === id && e.version === pm.coreHubBefore && e.ts < firstEnterAfter));
  return [
    step('pipelines.killed-while-paused', !!pm.killedAt && /orders/.test(pm.fileAtKill || ''), pm.killedAt ? `killed at ${pm.killedAt}, paused-pipelines file then: ${(pm.fileAtKill || '').replace(/\s+/g, ' ').slice(0, 160)}` : 'the conductor was not killed'),
    step('pipelines.resumed-after-restart', resumedByRestart.length === RUNNING.length && pm.resumedAfterRestart === true, `resumed by the restarted conductor before the next update: ${resumedByRestart.join(', ') || 'none'}`),
  ];
};

export const pipelineChecks = it => {
  const pm = it.pipelines;
  if (!pm?.events) return [step('pipelines.evidence', false, 'the profile recorded nothing about the pipelines')];
  const { mode } = pm;
  return [
    ...commonSteps(pm),
    ...(mode === 'rollback' ? rolledBackSteps(pm) : updatedSteps(pm)),
    ...(mode === 'refused' ? refusedSteps(pm) : []),
    ...(mode === 'restart' ? restartSteps(pm) : []),
  ];
};
