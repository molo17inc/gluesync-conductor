// Drives an update the way the Core Hub UI's "Platform updates" modal does
// (gluesync-ui: usePlatformUpdates.ts): one POST /containers per service, in the
// UI's order, through the reverse proxy (the UI reaches the conductor at
// /conductor/api/ behind Traefik), with the UI's automatic retries: up to 3,
// after 2s/4s/8s, for any failure the conductor's diagnosis does not blame on the
// customer's environment. The sequence halts at the first service that fails;
// the user then sees "Update failed" with a Retry button.
//
// Compared with `drive` in iterate.mjs (an "update all" click, ids: []), this
// also exercises what updating the reverse proxy does to the request that
// travels through it.

import { callConductor, containers, corehub, settle, waitConductor } from './stack.mjs';
import { now, say, sleep, waitFor } from './util.mjs';

// What the modal lists, in the order it updates (modules, third parties, core-hub).
const UI_ORDER = ['gluesync-conductor', 'gluesync-chronos', 'reverse-proxy', 'grafana', 'portainer', 'prometheus', 'gluesync-core-hub'];
const RESTARTABLE = new Set(['gluesync-conductor', 'gluesync-chronos', 'gluesync-core-hub']);
const MAX_AUTO_RETRIES = 3;
const DELAY_RETRY_MS = 2000;
const GRACE_CONDUCTOR_MS = 15000;
const GRACE_OTHER_MS = 3000;

// gluesync-ui shared/features/diagnosis/shouldRetryUpdate.ts
const shouldRetryUpdate = diagnosis => diagnosis === undefined || diagnosis.schemaVersion !== 1 || diagnosis.owner !== 'customer';

// What updateSingleService throws for one response, or null when it succeeded.
const failureOf = r => {
  if (r.status === 0) return { message: r.error, diagnosis: undefined };
  const json = r.json;
  if (r.status === 200 && json?.success) {
    const bad = (json.data?.containers || []).find(c => c.status === 'ERROR');
    return bad ? { message: bad.message, diagnosis: undefined } : null;
  }
  return {
    message: json?.error ? [json.error, json.details].filter(Boolean).join(' - ') : `HTTP ${r.status}`,
    diagnosis: json?.diagnosis,
  };
};

const runningContainer = async service => (await containers()).find(c => c.service === service && c.state === 'running');

// waitForServiceRestart / waitForCoreHubRestart in the UI: the module drops off
// the Core Hub and registers again, then a grace period. Here: the container is
// replaced and healthy. After core-hub the UI logs out, so the user logs in again.
const afterRestartable = async (service, state, before) => {
  if (service === 'gluesync-conductor') {
    const back = await waitConductor({ notId: before?.id, timeoutMs: 300000 });
    if (!back.ok) throw new Error('conductor did not come back within 5 minutes of its self-update');
    await sleep(GRACE_CONDUCTOR_MS);
    return { conductorBackMs: back.ms };
  }
  const healthy = await waitFor(
    `${service} after update`,
    async () => {
      const c = await runningContainer(service);
      return c && c.id !== before?.id && (!c.health || c.health === 'healthy') ? c : false;
    },
    { timeoutMs: 300000, intervalMs: 2000 },
  );
  if (!healthy.ok) throw new Error(`${service} did not come back after its update`);
  await sleep(GRACE_OTHER_MS);
  if (service === 'gluesync-core-hub') state.token = await corehub.login('admin');
  return {};
};

const describeAttempt = (label, r, failure) => {
  const took = `${(r.ms / 1000).toFixed(1)}s`;
  const why = failure ? `: ${failure.message}` : '';
  return `  ${label} -> ${r.status || r.error} in ${took}${why}`;
};

// One POST per attempt, with the UI's backoff, until the service updates or the
// automatic retries run out. Records every attempt on `step` and sets its outcome.
const tryUpdate = async (it, service, state, round, tag, step, attempt) => {
  const retrySuffix = attempt ? ` retry ${attempt}` : '';
  const label = `update round ${round} ${tag}${service}${retrySuffix}`;
  const r = await callConductor(it, label, 'POST', '/containers', {
    token: state.token,
    body: { action: 'update', ids: [service], releaseChannel: 'ga' },
    timeoutMs: 600000,
    via: 'proxy',
  });
  const failure = failureOf(r);
  step.attempts.push({
    attempt,
    at: now(),
    status: r.status,
    ms: r.ms,
    ...(failure ? { error: failure.message, diagnosis: failure.diagnosis?.code } : {}),
  });
  say(describeAttempt(label, r, failure));
  if (!failure) {
    step.outcome = 'success';
    return;
  }
  if (attempt < MAX_AUTO_RETRIES && shouldRetryUpdate(failure.diagnosis)) {
    await sleep(2 ** attempt * DELAY_RETRY_MS);
    await tryUpdate(it, service, state, round, tag, step, attempt + 1);
    return;
  }
  step.outcome = 'failed';
  step.error = failure.message;
  step.status = r.status;
};

const updateOne = async (it, service, state, round, tag) => {
  const step = { service, startedAt: now(), attempts: [], outcome: 'pending' };
  const before = await runningContainer(service);
  await tryUpdate(it, service, state, round, tag, step, 0);
  if (step.outcome === 'success' && RESTARTABLE.has(service)) {
    try {
      Object.assign(step, await afterRestartable(service, state, before));
    } catch (e) {
      step.outcome = 'failed';
      step.error = e.message;
    }
  }
  step.finishedAt = now();
  it.rounds.push({
    round,
    phase: `${tag}${service}`,
    statuses: step.attempts.map(a => a.status || a.error),
    ms: step.attempts.reduce((s, a) => s + a.ms, 0),
    items: [`${service}:${step.outcome}`],
    ...(step.conductorBackMs !== undefined ? { conductorBackMs: step.conductorBackMs, conductorBack: true } : {}),
  });
  return step;
};

// One service after the other, as the modal does; stops at the first failure.
const runSequence = async (ctx, it, services, state, startRound, tag) => {
  const steps = [];
  let round = startRound;
  for (const service of services) {
    round += 1;
    ctx.inflight = { round, phase: `${tag}${service}`, startedAt: Date.now() };
    const step = await updateOne(it, service, state, round, tag);
    ctx.inflight = null;
    steps.push(step);
    if (step.outcome === 'failed') return { steps, halted: service, round };
  }
  return { steps, halted: null, round };
};

export const driveLikeUi = async (ctx, it, target) => {
  const state = { token: ctx.adminToken };
  const current = Object.fromEntries(
    (await containers())
      .filter(c => c.state === 'running')
      .map(c => [c.service, c.tag]),
  );
  const pending = UI_ORDER.filter(s => current[s] !== target[s]);
  say(`  ui sequence: ${pending.join(' -> ')}`);
  const first = await runSequence(ctx, it, pending, state, 0, 'ui:');
  const ui = { order: pending, steps: first.steps, halted: first.halted, manualRetry: null };
  it.ui = ui;
  if (!first.halted) return;

  // The user reads the failure, waits for the stack to calm down and presses
  // Retry: the modal re-sends the failed service and goes on with the rest.
  it.notes.push(`ui sequence halted at ${first.halted}: ${first.steps.at(-1).error}`);
  const calm = await settle(ctx, state.token, { timeoutMs: 300000 });
  it.notes.push(`stack settled ${calm.ok ? '' : 'NOT '}before the manual Retry (${Math.round(calm.ms / 1000)}s)`);
  const remaining = pending.slice(pending.indexOf(first.halted));
  const second = await runSequence(ctx, it, remaining, state, first.round, 'ui-retry:');
  ui.manualRetry = { services: remaining, steps: second.steps, halted: second.halted };
  if (second.halted) it.notes.push(`manual Retry halted again at ${second.halted}: ${second.steps.at(-1).error}`);
};

// Checks on what the user would have seen. Evaluated with the final stack state.
export const uiChecks = (it, post, target) => {
  const ui = it.ui;
  if (!ui) return [];
  const result = (id, ok, detail, { severity = 'fail', evidence } = {}) => ({
    area: 'errors',
    id,
    ok,
    severity: ok ? 'pass' : severity,
    detail,
    ...(evidence ? { evidence } : {}),
  });
  const allSteps = [...ui.steps, ...(ui.manualRetry?.steps || [])];
  const attempts = allSteps.flatMap(s => s.attempts.map(a => ({ ...a, service: s.service })));

  const conflicts = attempts.filter(a => a.status === 409);
  const cut = attempts.filter(a => a.status === 0);
  const failed = allSteps.filter(s => s.outcome === 'failed');
  // A failure shown for a service that did reach the target version anyway.
  const spurious = ui.steps
    .filter(s => s.outcome === 'failed')
    .filter(s => post.byService[s.service]?.tag === target[s.service]);

  const cutList = cut.map(a => `${a.service} attempt ${a.attempt}: ${a.error} after ${a.ms}ms`).join(' | ');
  const conflictList = [...new Set(conflicts.map(a => `${a.service}: ${a.error}`))].join(' | ');
  const spuriousList = spurious.map(s => `${s.service} updated to ${target[s.service]} but the user saw "Update failed": ${s.error}`).join(' | ');
  const retryOutcome = ui.manualRetry?.halted ? `halted at ${ui.manualRetry.halted}` : 'completed';
  const haltedDetail = `halted at ${ui.halted}; ${failed.length} failed step(s); manual Retry ${retryOutcome}`;

  return [
    result('errors.ui-request-cut', cut.length === 0, cut.length ? cutList : 'no UI request lost its connection', { severity: 'info' }),
    result(
      'errors.ui-action-lock-409',
      conflicts.length === 0,
      conflicts.length ? `the UI's retry was refused by the action lock: ${conflictList}` : 'no retry hit the action lock',
      { evidence: conflicts.map(a => ({ service: a.service, attempt: a.attempt, at: a.at, error: a.error })) },
    ),
    result('errors.ui-spurious-failure', spurious.length === 0, spurious.length ? spuriousList : 'every failure the user saw was a real one'),
    result('errors.ui-sequence-halted', ui.halted === null, ui.halted ? haltedDetail : 'the sequence ran through', { severity: 'warn' }),
  ];
};
