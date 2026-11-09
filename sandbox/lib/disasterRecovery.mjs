// Disaster recovery profiles: the update guard of a DR site (dr-update-guard) and the guided setup of a
// single-host Compose install (dr-guided-setup). Both read and write the real kit compose file; the fake
// Core Hub ignores the GS_DR_* variables, so what is tested is the conductor's side: what it refuses, what
// it writes, what it recreates and what it puts back.
//
// Each hook records `it.dr.steps`: one { id, ok, detail, severity? } per expectation, turned into
// checks by drChecks (checks.mjs).

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env, SERVICES, versionsFor } from './env.mjs';
import { callConductor, containers } from './stack.mjs';
import { docker, inSequence, now, waitFor } from './util.mjs';

const CORE_HUB = 'gluesync-core-hub';
const CHRONOS = 'gluesync-chronos';
export const DR_REFUSED_TEXT = 'Disaster recovery is enabled on this Core Hub';
const DR_ENV_FILE = 'gluesync-dr.env';
// What the conductor itself reads (the kit folder is mounted there; restartWithDrift greps the same path)
const CONDUCTOR_COMPOSE = '/opt/gluesync-conductor/root-folder/docker-compose.yml';

const composeFile = () => path.join(env.kitDir, 'docker-compose.yml');
const drEnvFile = () => path.join(env.kitDir, DR_ENV_FILE);
const readCompose = () => YAML.parse(fs.readFileSync(composeFile(), 'utf8'));
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const step = (it, id, ok, detail, severity) => {
  it.dr ||= { steps: [] };
  it.dr.steps.push({ id, ok: !!ok, detail, ...(severity ? { severity } : {}) });
  it.notes.push(`${id}: ${ok ? 'ok' : 'NOT ok'}, ${detail}`);
  return !!ok;
};

const running = async service => (await containers()).find(c => c.service === service && c.state === 'running');

const containerEnv = async service => {
  const c = await running(service);
  if (!c) return [];
  const r = await docker(['inspect', '--format', '{{json .Config.Env}}', c.id]);
  try {
    return JSON.parse(r.out);
  } catch {
    return [];
  }
};

// Docker Desktop's file share can serve the conductor an older copy for a moment after the host writes:
// a hook that edits the compose file waits until the conductor reads the edit itself.
const conductorSees = async (pattern, present) => {
  const c = await running('gluesync-conductor');
  return waitFor(
    `conductor ${present ? 'sees' : 'no longer sees'} ${pattern}`,
    async () => ((await docker(['exec', c.id, 'grep', '-c', pattern, CONDUCTOR_COMPOSE])).out.trim() !== '0') === present,
    { timeoutMs: 15000, intervalMs: 200 },
  );
};

const update = (ctx, it, label, ids) =>
  callConductor(it, label, 'POST', '/containers', { token: ctx.adminToken, body: { action: 'update', ids, releaseChannel: 'ga' }, timeoutMs: 600000 });

const versionOf = (ctx, it, label, service) =>
  callConductor(it, label, 'GET', `/services/${service}/version/ga`, { token: ctx.adminToken, timeoutMs: 60000 });

// ---------------------------------------------------------------- dr-update-guard

const DR_LINE = '      - GS_DR_ENABLED=true\n';
const CORE_HUB_ENVIRONMENT = /(\n {2}gluesync-core-hub:\n(?:.*\n)*? {4}environment:\n)/;

// What an operator does by hand on a DR site (the documented manual setup): GS_DR_ENABLED=true in the
// environment of Core Hub. The running container is left alone: the guard reads the compose file only,
// because a standby Core Hub does not answer HTTP.
export const enableDrByHand = async (ctx, it) => {
  const text = fs.readFileSync(composeFile(), 'utf8');
  if (!CORE_HUB_ENVIRONMENT.test(text)) throw new Error('could not find the environment of gluesync-core-hub in the kit compose file');
  ctx.sampler?.pause();
  try {
    fs.writeFileSync(composeFile(), text.replace(CORE_HUB_ENVIRONMENT, m => `${m}${DR_LINE}`));
  } finally {
    ctx.sampler?.resume();
  }
  const seen = await conductorSees('GS_DR_ENABLED=true', true);
  it.notes.push(`GS_DR_ENABLED=true added to ${CORE_HUB} by hand at ${now()} (conductor saw it after ${seen.ms}ms)`);
};

const disableDrByHand = async (ctx, it) => {
  ctx.sampler?.pause();
  try {
    fs.writeFileSync(composeFile(), fs.readFileSync(composeFile(), 'utf8').replace(DR_LINE, ''));
  } finally {
    ctx.sampler?.resume();
  }
  const gone = await conductorSees('GS_DR_ENABLED=true', false);
  it.notes.push(`GS_DR_ENABLED removed again at ${now()} (conductor saw it after ${gone.ms}ms)`);
};

const itemOf = (res, id) => (res.json?.data?.containers || []).find(c => c.id === id);

// Runs after the refused "update all" was recorded (and found untouched), with DR still on: only Core Hub
// and Chronos are guarded, so a request for another service goes through while either of them alone is
// refused. Then DR goes and the user's next click updates everything.
export const guardOnSingleServices = async (ctx, it) => {
  try {
    const grafana = await update(ctx, it, 'dr: update grafana only', ['grafana']);
    const item = itemOf(grafana, 'grafana');
    const grafanaNow = await running('grafana');
    step(
      it,
      'dr.other-service-not-guarded',
      grafana.status === 200 && item?.status === 'OK' && grafanaNow?.tag === versionsFor(it.index).grafana,
      `grafana alone with DR on: HTTP ${grafana.status}, item ${item?.status ?? 'none'} (${item?.message ?? ''}), running ${grafanaNow?.tag}`,
    );
    // One after the other: two single-service updates at once meet the action gate ("busy") first.
    const refusedAlone = await inSequence([CHRONOS, CORE_HUB], async id => {
      const r = await update(ctx, it, `dr: update ${id} only`, [id]);
      return { id, status: r.status, error: r.json?.error ?? r.error };
    });
    step(
      it,
      'dr.guarded-service-alone-refused',
      refusedAlone.every(r => r.status === 409 && String(r.error).includes(DR_REFUSED_TEXT)),
      refusedAlone.map(r => `${r.id} alone -> HTTP ${r.status} ${r.error}`).join('; '),
    );
  } finally {
    await disableDrByHand(ctx, it);
  }
};

// The UI reads every service's version when the update page opens (iterate does it after `before`):
// Core Hub and Chronos must come back with updateBlocked and the reason, every other service without.
const blockedFlagsStep = it => {
  const replies = Object.keys(SERVICES).map(s => {
    const call = it.api.find(a => a.label === `ui: version ${s}`);
    return { service: s, status: call?.status, blocked: call?.json?.data?.updateBlocked, reason: call?.json?.data?.reason };
  });
  const wrong = replies.filter(r => {
    const guarded = r.service === CORE_HUB || r.service === CHRONOS;
    return r.status !== 200 || (guarded ? r.blocked !== true || !String(r.reason).includes(DR_REFUSED_TEXT) : r.blocked === true);
  });
  return {
    id: 'dr.update-blocked-flags',
    ok: wrong.length === 0,
    detail: wrong.length
      ? wrong.map(r => `${r.service}: HTTP ${r.status}, updateBlocked ${r.blocked}, reason ${r.reason ?? 'none'}`).join('; ')
      : 'version replies: core-hub and chronos updateBlocked with the reason, every other service not blocked',
  };
};

const refusalLoggedStep = conductorLogs => {
  const hits = conductorLogs.filter(l => l.line.includes('refused: disaster recovery is enabled on this Core Hub'));
  return {
    id: 'dr.refusal-logged',
    ok: hits.some(l => /"level":40/.test(l.line)),
    detail: hits.length ? `${hits.length} refusal line(s), at warn: ${hits.some(l => /"level":40/.test(l.line))}` : 'the refusal was never logged',
  };
};

// ---------------------------------------------------------------- dr-guided-setup

const FIRST = { nodeId: 'sbx-a', url: 'https://gluesync-core-hub:1717' };
const PEER = { nodeId: 'sbx-b', url: 'https://sbx-peer.example.invalid:1717' };

const decodePairing = code => {
  try {
    return JSON.parse(Buffer.from(String(code).replace(/^GSDR1\./, ''), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const readEnvFile = () => {
  if (!fs.existsSync(drEnvFile())) return null;
  return Object.fromEntries(
    fs
      .readFileSync(drEnvFile(), 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
};

const getSetup = async (ctx, it, label) => (await callConductor(it, label, 'GET', '/disaster-recovery/setup', { token: ctx.adminToken })).json?.data ?? {};

// Answers 202, then recreates Chronos and Core Hub: waits for both to run as new containers and for the
// conductor to log that the change is done (or that it rolled back).
const change = async (ctx, it, label, p, body, kind) => {
  const before = { [CORE_HUB]: (await running(CORE_HUB))?.id, [CHRONOS]: (await running(CHRONOS))?.id };
  const since = new Date().toISOString();
  const res = await callConductor(it, label, 'POST', p, { token: ctx.adminToken, body, timeoutMs: 60000 });
  if (res.status !== 202) return { res, recreated: false };
  const recreated = await waitFor(
    `${label}: chronos and core-hub recreated`,
    async () => {
      const [hub, chronos] = await Promise.all([running(CORE_HUB), running(CHRONOS)]);
      return hub && chronos && hub.id !== before[CORE_HUB] && chronos.id !== before[CHRONOS];
    },
    { timeoutMs: 180000, intervalMs: 2000 },
  );
  await ctx.collector.sync();
  const logged = await waitFor(
    `${label}: done logged`,
    async () => ctx.collector.since('gluesync-conductor', since).find(l => new RegExp(`\\[disaster-recovery\\] (${kind} done|recreating the services failed)`).test(l.line)),
    { timeoutMs: 180000, intervalMs: 2000 },
  );
  const doneLine = logged.ok ? logged.value.line : null;
  return { res, recreated: recreated.ok, done: !!doneLine && doneLine.includes(`${kind} done`), doneLine, ms: recreated.ms };
};

const changeStep = (it, id, { res, recreated, done, doneLine }, extra = true, extraDetail = '') =>
  step(
    it,
    id,
    res.status === 202 && recreated && done && extra,
    `HTTP ${res.status}${res.status === 202 ? '' : ` ${res.json?.error ?? res.error} ${res.json?.details ?? ''}`}, chronos and core-hub recreated: ${recreated}, done logged: ${done}${doneLine && !done ? ` (${doneLine.slice(0, 160)})` : ''}${extraDetail}`,
  );

const coreHubPorts = svc => (svc?.ports || []).map(p => String(typeof p === 'object' ? p.target : String(p).split(':').pop()));

// The compose file and the container as a set-up site must have them.
const enabledStep = async (it, id, nodeId) => {
  const compose = readCompose();
  const hub = compose.services[CORE_HUB];
  const chronos = compose.services[CHRONOS];
  const envFile = readEnvFile();
  const runningEnv = await containerEnv(CORE_HUB);
  const problems = [];
  if (!(hub.env_file || []).some(e => String(e?.path ?? e).endsWith(DR_ENV_FILE))) problems.push(`core-hub env_file does not name ${DR_ENV_FILE}`);
  const ports = coreHubPorts(hub);
  if (!ports.includes('1718') || !ports.includes('1719')) problems.push(`core-hub does not publish 1718 and 1719 (ports: ${ports.join(',')})`);
  if (!(hub.volumes || []).some(v => String(v?.target ?? v).includes(':/opt/gluesync/chronos') || v?.target === '/opt/gluesync/chronos')) problems.push('core-hub does not mount the chronos data at /opt/gluesync/chronos');
  if (hub.stop_grace_period !== '60s') problems.push(`core-hub stop_grace_period is ${hub.stop_grace_period}`);
  if (!(chronos.environment || []).some(e => String(e).startsWith('GS_DR_CONTROL_URL='))) problems.push('chronos has no GS_DR_CONTROL_URL');
  if (!envFile) problems.push(`${DR_ENV_FILE} was not written`);
  else {
    if (envFile.GS_DR_ENABLED !== 'true') problems.push(`${DR_ENV_FILE}: GS_DR_ENABLED=${envFile.GS_DR_ENABLED}`);
    if (envFile.GS_DR_NODE_ID !== nodeId) problems.push(`${DR_ENV_FILE}: GS_DR_NODE_ID=${envFile.GS_DR_NODE_ID}, expected ${nodeId}`);
    if (envFile.GS_DR_MANAGED_BY !== 'conductor') problems.push(`${DR_ENV_FILE}: GS_DR_MANAGED_BY=${envFile.GS_DR_MANAGED_BY}`);
    if (!envFile.GS_DR_SHARED_SECRET) problems.push(`${DR_ENV_FILE} has no shared secret`);
  }
  if (!runningEnv.includes('GS_DR_ENABLED=true') || !runningEnv.includes(`GS_DR_NODE_ID=${nodeId}`)) {
    problems.push(`the running core-hub does not have the variables (GS_DR_*: ${runningEnv.filter(e => e.startsWith('GS_DR_') && !/SECRET|TOKEN/.test(e)).join(' ') || 'none'})`);
  }
  if (runningEnv.length && (await containerEnv(CHRONOS)).some(e => e.startsWith('GS_DR_SHARED_SECRET'))) problems.push('chronos got the shared secret');
  step(it, id, problems.length === 0, problems.length ? problems.join('; ') : `compose, ${DR_ENV_FILE} and the running core-hub carry the DR site ${nodeId}`);
  return envFile;
};

// After a disable: Core Hub and Chronos as they were before the setup, the env file gone, nothing left in the container.
const disabledStep = async (it, id, original) => {
  const compose = readCompose();
  const problems = [];
  [CORE_HUB, CHRONOS].forEach(s => {
    if (stable(compose.services[s]) !== stable(original.services[s])) problems.push(`${s} differs from before the setup: ${stable(compose.services[s]).slice(0, 300)}`);
  });
  if (stable(compose) !== stable(original)) problems.push('the rest of the compose file changed');
  if (fs.existsSync(drEnvFile())) problems.push(`${DR_ENV_FILE} is still there`);
  const runningEnv = await containerEnv(CORE_HUB);
  if (runningEnv.some(e => e.startsWith('GS_DR_'))) problems.push('the running core-hub still has GS_DR_* variables');
  return step(it, id, problems.length === 0, problems.length ? problems.join('; ') : 'core-hub and chronos as before the setup, env file removed, no GS_DR_* in the container');
};

export const guidedSetup = async (ctx, it) => {
  const dr = (it.dr ||= { steps: [] });
  const original = readCompose();
  const originalText = fs.readFileSync(composeFile(), 'utf8');

  const initial = await getSetup(ctx, it, 'dr: setup state');
  step(it, 'dr.setup-supported', initial.supported === true && initial.enabled === false, `supported ${initial.supported} (${initial.reason ?? 'no reason'}), enabled ${initial.enabled}`);
  if (!initial.supported) return;

  const invalid = await callConductor(it, 'dr: first with an invalid node id', 'POST', '/disaster-recovery/setup/first', {
    token: ctx.adminToken,
    body: { thisSite: { ...FIRST, nodeId: 'Not_Valid' }, peerSite: PEER, failoverMode: 'manual' },
  });
  step(it, 'dr.invalid-request-refused', invalid.status === 400 && fs.readFileSync(composeFile(), 'utf8') === originalText, `invalid node id -> HTTP ${invalid.status} ${invalid.json?.details ?? invalid.json?.error ?? ''}`);

  // ---- first site
  const first = await change(ctx, it, 'dr: setup first site', '/disaster-recovery/setup/first', { thisSite: FIRST, peerSite: PEER, failoverMode: 'manual' }, 'enable');
  const accepted = first.res.json?.data ?? {};
  const pairing = decodePairing(accepted.pairingCode);
  changeStep(it, 'dr.first-site-accepted', first, String(accepted.pairingCode).startsWith('GSDR1.') && !!pairing && !!accepted.operatorToken, `, pairing code decodes: ${!!pairing}, restarting ${JSON.stringify(accepted.restarting)}`);
  if (first.res.status !== 202) return;
  dr.secrets = [accepted.operatorToken, accepted.pairingCode].filter(Boolean);
  const envFile = await enabledStep(it, 'dr.first-site-written', FIRST.nodeId);
  if (envFile?.GS_DR_SHARED_SECRET) dr.secrets.push(envFile.GS_DR_SHARED_SECRET);
  if (envFile?.GS_DR_ADMIN_TOKEN) dr.secrets.push(envFile.GS_DR_ADMIN_TOKEN);
  const mode = fs.existsSync(drEnvFile()) ? fs.statSync(drEnvFile()).mode & 0o777 : null;
  step(it, 'dr.env-file-private', mode !== null && (mode & 0o077) === 0, `${DR_ENV_FILE} mode ${mode?.toString(8)}`, 'warn');
  const backups = path.join(env.kitDir, '.conductor', 'dr-backup');
  const stamps = fs.existsSync(backups) ? fs.readdirSync(backups) : [];
  step(it, 'dr.backup-written', stamps.some(s => fs.existsSync(path.join(backups, s, 'docker-compose.yml'))), `${stamps.length} backup folder(s) in .conductor/dr-backup`);

  const state = await getSetup(ctx, it, 'dr: setup state after first');
  step(
    it,
    'dr.state-first-site',
    state.enabled && state.managedByConductor && state.nodeId === FIRST.nodeId && state.peerUrl === PEER.url && state.failoverMode === 'manual' && state.bootstrapActive === true,
    `enabled ${state.enabled}, managed ${state.managedByConductor}, node ${state.nodeId}, peer ${state.peerUrl}, mode ${state.failoverMode}, bootstrapActive ${state.bootstrapActive}`,
  );
  const stateText = JSON.stringify(it.api.at(-1)?.json ?? {});
  step(it, 'dr.state-has-no-secret', !dr.secrets.some(s => stateText.includes(s)), 'GET /disaster-recovery/setup carries neither the shared secret nor a token');

  const again = await callConductor(it, 'dr: setup first site again', 'POST', '/disaster-recovery/setup/first', {
    token: ctx.adminToken,
    body: { thisSite: FIRST, peerSite: PEER, failoverMode: 'manual' },
  });
  step(it, 'dr.second-setup-refused', again.status === 409, `a second setup -> HTTP ${again.status} ${again.json?.error ?? ''}`);

  // The guard of dr-update-guard, this time through the env file the setup wrote
  const refused = await update(ctx, it, 'dr: update all on a set-up site', []);
  const hubVersion = await versionOf(ctx, it, 'dr: version core-hub on a set-up site', CORE_HUB);
  step(
    it,
    'dr.setup-site-update-refused',
    refused.status === 409 && String(refused.json?.error).includes(DR_REFUSED_TEXT) && hubVersion.json?.data?.updateBlocked === true,
    `update all -> HTTP ${refused.status} ${refused.json?.error ?? ''}; core-hub version updateBlocked ${hubVersion.json?.data?.updateBlocked}`,
  );

  const shown = await callConductor(it, 'dr: pairing code again', 'POST', '/disaster-recovery/setup/pairing-code', { token: ctx.adminToken });
  const shownPairing = decodePairing(shown.json?.data?.pairingCode);
  step(it, 'dr.pairing-code-again', shown.status === 200 && !!shownPairing && stable(shownPairing) === stable(pairing), `HTTP ${shown.status}, same content as the first answer: ${!!shownPairing && stable(shownPairing) === stable(pairing)}`);

  const off = await change(ctx, it, 'dr: disable (first site)', '/disaster-recovery/disable', { confirm: true }, 'disable');
  changeStep(it, 'dr.disable-accepted', off);
  await disabledStep(it, 'dr.disable-restores', original);
  const afterOff = await getSetup(ctx, it, 'dr: setup state after disable');
  step(it, 'dr.state-disabled', afterOff.enabled === false && afterOff.supported === true, `enabled ${afterOff.enabled}, supported ${afterOff.supported}`);

  // ---- second site: the same host joins with the code of the first
  const garbage = await callConductor(it, 'dr: join with a bad code', 'POST', '/disaster-recovery/setup/join', {
    token: ctx.adminToken,
    body: { pairingCode: 'GSDR1.bm90LWEtY29kZQ', confirmDataMovedAside: true },
  });
  step(it, 'dr.bad-pairing-code-refused', garbage.status === 400, `bad code -> HTTP ${garbage.status} ${garbage.json?.details ?? ''}`);

  const join = await change(ctx, it, 'dr: join as second site', '/disaster-recovery/setup/join', { pairingCode: accepted.pairingCode, confirmDataMovedAside: true }, 'enable');
  const joined = join.res.json?.data ?? {};
  changeStep(it, 'dr.join-accepted', join, joined.nodeId === PEER.nodeId && joined.peerUrl === FIRST.url, `, node ${joined.nodeId}, peer ${joined.peerUrl}`);
  if (join.res.status === 202) {
    if (joined.operatorToken) dr.secrets.push(joined.operatorToken);
    await enabledStep(it, 'dr.join-written', PEER.nodeId);
    const joinState = await getSetup(ctx, it, 'dr: setup state after join');
    step(it, 'dr.state-joiner', joinState.enabled && joinState.nodeId === PEER.nodeId && joinState.peerUrl === FIRST.url && joinState.bootstrapActive === false, `node ${joinState.nodeId}, peer ${joinState.peerUrl}, bootstrapActive ${joinState.bootstrapActive}`);
    const notFirst = await callConductor(it, 'dr: pairing code on the joiner', 'POST', '/disaster-recovery/setup/pairing-code', { token: ctx.adminToken });
    step(it, 'dr.joiner-has-no-pairing-code', notFirst.status === 409, `HTTP ${notFirst.status} ${notFirst.json?.details ?? ''}`);
    const off2 = await change(ctx, it, 'dr: disable (joiner)', '/disaster-recovery/disable', { confirm: true }, 'disable');
    changeStep(it, 'dr.disable-joiner-accepted', off2);
    await disabledStep(it, 'dr.disable-joiner-restores', original);
  }
};

// ---------------------------------------------------------------- checks

const leakStep = (dr, conductorLogs) => {
  const secrets = dr?.secrets || [];
  const hits = conductorLogs.filter(l => secrets.some(s => s && l.line.includes(s)));
  return {
    id: 'dr.secrets-not-logged',
    ok: hits.length === 0,
    detail: hits.length ? `${hits.length} conductor log line(s) carry a secret of the pair (shared secret, token or pairing code)` : `none of the ${secrets.length} secrets of the pair appears in the conductor log`,
  };
};

// One check per recorded step, plus what can only be judged from the iteration as a whole.
export const drChecks = (it, plan, conductorLogs) => {
  const steps = [...(it.dr?.steps || [])];
  if (plan.drGuard) steps.push(blockedFlagsStep(it), refusalLoggedStep(conductorLogs));
  if (plan.drSetup) {
    if (!steps.length) steps.push({ id: 'dr.evidence', ok: false, detail: 'the profile recorded nothing' });
    steps.push(leakStep(it.dr, conductorLogs));
  }
  return steps;
};
