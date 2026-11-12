// courier-inbound: the Conductor's own Courier heal (healCourierInbound) on the sandbox kit. Every conductor
// start runs it, so by the time this profile runs the kit is already wired: the profile takes the wiring out
// again (traefik.yml, the proxy's 8090 port, Core Hub's courier labels, and the running containers with
// them), then restarts the conductor and watches the heal put it back, recreating the proxy and Core Hub
// once. A second restart must change nothing; with the opt-out label on the proxy a restart must change
// nothing either. The kit is left wired, as the conductor wired it, for the profiles that follow.
//
// The fake traefik does not read traefik.yml or labels, so a request on 8090 would only prove the fake:
// the routing itself is covered by the demo-kits kit with the real molo17/traefik.
//
// The hook records `it.courier.steps` ({ id, ok, detail, severity? }), turned into checks by courierChecks.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env } from './env.mjs';
import { kitCompose } from './setup.mjs';
import { containers } from './stack.mjs';
import { docker, now, waitFor } from './util.mjs';

const CORE_HUB = 'gluesync-core-hub';
const PROXY = 'reverse-proxy';
const OPT_OUT = 'com.molo17.conductor.courier-inbound=false';

// The labels the kits put on Core Hub (and healCourierInbound adds)
export const COURIER_LABELS = {
  'traefik.http.routers.courier.entrypoints': 'courier',
  'traefik.http.routers.courier.rule': 'PathPrefix(`/api-inbound/`)',
  'traefik.http.routers.courier.tls': 'true',
  'traefik.http.routers.courier.service': 'courier',
  'traefik.http.services.courier.loadbalancer.server.port': '8090',
  'traefik.http.services.courier.loadbalancer.server.scheme': 'http',
  'traefik.http.services.courier.loadbalancer.passhostheader': 'true',
};

// What the conductor adds to traefik.yml: the kit's two comment lines and the entry point
const ENTRY_POINT_BLOCK =
  /^( *)# Courier inbound \(HTTP Source agent in Core Hub\).*\n\1# internal network\..*\n\1courier:\n\1 +address: ":8090"\n/m;
const PORT_LINE = /^ +- "?8090:8090"?\n/m;
const COURIER_LABEL_LINE = /^ +- "?traefik\.http\.(routers|services)\.courier\..*\n/gm;

const composeFile = () => path.join(env.kitDir, 'docker-compose.yml');
const traefikFile = () => path.join(env.kitDir, 'proxy', 'traefik.yml');
const certsFile = () => path.join(env.kitDir, 'proxy', 'certs.yml');
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const backupDir = () => path.join(env.kitDir, '.conductor', 'proxy-backup');

const backups = () =>
  fs.existsSync(backupDir()) ? fs.readdirSync(backupDir()).map(stamp => ({ stamp, files: fs.readdirSync(path.join(backupDir(), stamp)).sort() })) : [];

const step = (it, id, ok, detail, severity) => {
  it.courier ||= { steps: [] };
  it.courier.steps.push({ id, ok: !!ok, detail, ...(severity ? { severity } : {}) });
  it.notes.push(`${id}: ${ok ? 'ok' : 'NOT ok'}, ${detail}`);
};

// A service block of the compose text: from `  name:` to the next service (or the end)
const serviceBlock = (text, name) => new RegExp(String.raw`\n {2}${name}:\n(?:(?: {4}.*)?\n)*`).exec(text)?.[0] ?? '';

const replaceBlock = (text, name, change) => {
  const block = serviceBlock(text, name);
  return block ? text.replace(block, change(block)) : text;
};

// The compose text without the courier wiring: no 8090 on the proxy, no courier label on Core Hub
const unwiredCompose = (text, { optOut = false } = {}) => {
  const proxy = replaceBlock(text, PROXY, b => {
    const noPort = b.replace(PORT_LINE, '');
    return optOut ? noPort.replace(/^( +)- com\.molo17\.conductor\.type=third-party\n/m, (m, pad) => `${m}${pad}- ${OPT_OUT}\n`) : noPort;
  });
  return replaceBlock(proxy, CORE_HUB, b => b.replace(COURIER_LABEL_LINE, ''));
};

const parsedService = (text, name) => {
  try {
    return YAML.parse(text)?.services?.[name] ?? {};
  } catch {
    return {};
  }
};

const labelMap = labels =>
  Array.isArray(labels)
    ? Object.fromEntries(labels.map(String).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    : { ...labels };

const hasCourierLabels = labels => Object.entries(COURIER_LABELS).every(([k, v]) => String(labels?.[k]) === v);

const publishes8090 = service => (service.ports || []).some(p => String(typeof p === 'object' ? `${p.published}:${p.target}` : p) === '8090:8090');

const running = async service => (await containers()).find(c => c.service === service && c.state === 'running');

const inspect = async id => {
  const r = await docker(['inspect', id]);
  return r.code === 0 ? JSON.parse(r.out)[0] : null;
};

// Containers of a kit service created since `sinceSec` (Docker events, so a recreate between two polls is counted too)
const createdSince = async (service, sinceSec) => {
  const r = await docker([
    'events',
    '--since',
    sinceSec,
    '--until',
    nowSec(),
    '--filter',
    'type=container',
    '--filter',
    'event=create',
    '--filter',
    `label=com.docker.compose.project=${env.project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.Actor.ID}}',
  ]);
  return r.out.split('\n').filter(Boolean);
};

const nowSec = () => (Date.now() / 1000).toFixed(3);

const conductorLine = async (ctx, since, pattern) => {
  await ctx.collector.sync();
  return ctx.collector.since('gluesync-conductor', since).find(l => pattern.test(l.line));
};

const STARTUP_DONE = /\[conductor-healer\] (nothing to heal|reboot needed to heal)/;

// Stops the conductor, lets `change` edit the kit and its containers, starts the conductor again and waits
// until its startup (the heals included) is done. Returns the moment the conductor started, as an ISO
// time for the log collector and as epoch seconds for Docker events.
const aroundConductor = async (ctx, it, change) => {
  const conductor = await running('gluesync-conductor');
  if (!conductor) throw new Error('no running conductor container');
  await docker(['stop', '-t', '20', conductor.id], { timeoutMs: 60000 });
  ctx.sampler?.pause();
  try {
    await change();
  } finally {
    ctx.sampler?.resume();
  }
  const since = new Date().toISOString();
  const sinceSec = nowSec();
  await docker(['start', conductor.id]);
  await ctx.collector.sync();
  const started = await waitFor('conductor startup', () => conductorLine(ctx, since, STARTUP_DONE), { timeoutMs: 240000, intervalMs: 2000 });
  if (!started.ok) it.notes.push(`conductor did not log its startup verdict within 4 minutes of ${since}`);
  return { since, sinceSec };
};

// Puts the files as given and recreates the proxy and Core Hub from them (the conductor is stopped)
const applyKit = async (it, compose, traefik) => {
  fs.writeFileSync(composeFile(), compose);
  fs.writeFileSync(traefikFile(), traefik);
  const up = await kitCompose(['up', '-d', '--no-deps', PROXY, CORE_HUB], { timeoutMs: 180000 });
  it.notes.push(`kit put back without the courier wiring at ${now()} (up exit ${up.code})`);
  return up.code === 0;
};

// The wiring as it is right now: in the files, and on the running containers
const observe = async () => {
  const text = read(composeFile());
  const hub = await running(CORE_HUB);
  const proxy = await running(PROXY);
  const [hubInfo, proxyInfo] = await Promise.all([hub ? inspect(hub.id) : null, proxy ? inspect(proxy.id) : null]);
  return {
    compose: text,
    traefik: read(traefikFile()),
    certsSha: sha256(certsFile()),
    backups: backups(),
    hubId: hub?.id,
    proxyId: proxy?.id,
    hubLabels: hubInfo?.Config?.Labels ?? {},
    proxyBinding: proxyInfo?.HostConfig?.PortBindings?.['8090/tcp']?.map(b => b.HostPort) ?? [],
  };
};

const sameFiles = (a, b) => a.compose === b.compose && a.traefik === b.traefik && a.certsSha === b.certsSha;

// ------------------------------------------------------------------ the wiring added

const missingLines = (original, now) => {
  const have = new Set(now.split('\n'));
  return original.split('\n').filter(l => l.trim() && !have.has(l));
};

const recordAdded = (it, base, added, events) => {
  const block = ENTRY_POINT_BLOCK.exec(added.traefik);
  const withoutBlock = block ? added.traefik.replace(block[0], '') : added.traefik;
  const kept = withoutBlock === base.traefik;
  const lost = missingLines(base.traefik, added.traefik).join(' | ') || 'none, but other bytes changed';
  const customerFile = kept ? 'byte for byte the customer file' : `not the customer file (lines lost: ${lost})`;
  step(
    it,
    'courier.entry-point-added',
    !!block && kept,
    block ? `entryPoints.courier on ":8090" added; without it traefik.yml is ${customerFile}` : 'traefik.yml has no courier entry point on :8090 written by the conductor',
  );
  step(it, 'courier.certs-untouched', added.certsSha === base.certsSha, added.certsSha === base.certsSha ? 'proxy/certs.yml has the same bytes' : 'proxy/certs.yml changed');

  const proxy = parsedService(added.compose, PROXY);
  const hub = parsedService(added.compose, CORE_HUB);
  const hubLabels = labelMap(hub.labels);
  const missing = Object.keys(COURIER_LABELS).filter(k => String(hubLabels[k]) !== COURIER_LABELS[k]);
  step(
    it,
    'courier.compose-wired',
    publishes8090(proxy) && missing.length === 0,
    `reverse-proxy publishes 8090:8090: ${publishes8090(proxy)}; Core Hub courier labels missing: ${missing.join(', ') || 'none'}`,
  );

  const fresh = added.backups.filter(b => !base.backups.some(x => x.stamp === b.stamp));
  const backup = fresh.find(b => b.files.includes('docker-compose.yml') && b.files.includes('traefik.yml'));
  step(
    it,
    'courier.backup-made',
    fresh.length === 1 && !!backup,
    backup ? `backup ${backup.stamp} holds ${backup.files.join(', ')}` : `new backups: ${JSON.stringify(fresh)} (expected one with docker-compose.yml and traefik.yml)`,
  );

  step(
    it,
    'courier.corehub-recreated-once',
    events.hub.length === 1 && hasCourierLabels(added.hubLabels) && added.hubId !== base.hubId,
    `Core Hub containers created after the conductor started: ${events.hub.length} (expected 1); running ${added.hubId} (was ${base.hubId}) carries the courier labels: ${hasCourierLabels(added.hubLabels)}`,
  );
  step(
    it,
    'courier.proxy-publishes-8090',
    events.proxy.length === 1 && added.proxyBinding.includes('8090'),
    `reverse-proxy containers created after the conductor started: ${events.proxy.length} (expected 1); running ${added.proxyId} binds 8090/tcp to host port ${added.proxyBinding.join(',') || 'none'}`,
  );
};

// ------------------------------------------------------------------ the profile

const ADD_DONE = /\[courier-inbound\] add done, reverse-proxy recreated/;
const HUB_BEFORE = /\[courier-inbound\] recreating gluesync-core-hub to apply the courier route labels/;
const HUB_AFTER = /\[courier-inbound\] gluesync-core-hub recreated, the courier route labels are applied/;
const WIRED = /\[courier-inbound\] nothing to change: wiring already in place/;
const OPTED_OUT = /\[courier-inbound\] nothing to change: com\.molo17\.conductor\.courier-inbound=false/;

const addPhase = async (ctx, it, unwired) => {
  const prepared = {};
  const { since, sinceSec } = await aroundConductor(ctx, it, async () => {
    prepared.ok = await applyKit(it, unwired.compose, unwired.traefik);
    Object.assign(prepared, await observe());
  });
  const hubDone = await waitFor('Core Hub recreate logged', () => conductorLine(ctx, since, HUB_AFTER), { timeoutMs: 180000, intervalMs: 2000 });
  const [added, hub, proxy] = await Promise.all([observe(), createdSince(CORE_HUB, sinceSec), createdSince(PROXY, sinceSec)]);
  const logged = {
    add: !!(await conductorLine(ctx, since, ADD_DONE)),
    hubBefore: !!(await conductorLine(ctx, since, HUB_BEFORE)),
    hubAfter: hubDone.ok,
  };
  step(
    it,
    'courier.unwired-baseline',
    prepared.ok && !ENTRY_POINT_BLOCK.test(prepared.traefik) && !hasCourierLabels(prepared.hubLabels),
    `kit without the wiring before the conductor started: up ok ${prepared.ok}, running Core Hub without courier labels: ${!hasCourierLabels(prepared.hubLabels)}`,
  );
  recordAdded(it, prepared, added, { hub, proxy });
  step(
    it,
    'courier.logged',
    logged.add && logged.hubBefore && logged.hubAfter,
    `conductor logged: add done ${logged.add}, recreating Core Hub ${logged.hubBefore}, Core Hub recreated ${logged.hubAfter}`,
  );
  return added;
};

const idempotencyPhase = async (ctx, it, wired) => {
  const { since, sinceSec } = await aroundConductor(ctx, it, async () => {});
  const logged = await waitFor('already wired logged', () => conductorLine(ctx, since, WIRED), { timeoutMs: 60000, intervalMs: 2000 });
  const [again, hub, proxy] = await Promise.all([observe(), createdSince(CORE_HUB, sinceSec), createdSince(PROXY, sinceSec)]);
  const ok = logged.ok && sameFiles(wired, again) && again.backups.length === wired.backups.length && hub.length === 0 && proxy.length === 0;
  step(
    it,
    'courier.idempotent',
    ok,
    `after a second conductor start: logged "wiring already in place" ${logged.ok}, files byte-identical ${sameFiles(wired, again)}, new backups ${again.backups.length - wired.backups.length}, Core Hub created ${hub.length}, proxy created ${proxy.length}`,
  );
};

const optOutPhase = async (ctx, it, unwired) => {
  const prepared = {};
  const { since, sinceSec } = await aroundConductor(ctx, it, async () => {
    prepared.ok = await applyKit(it, unwiredCompose(unwired.compose, { optOut: true }), unwired.traefik);
    Object.assign(prepared, await observe());
  });
  const logged = await waitFor('opt-out logged', () => conductorLine(ctx, since, OPTED_OUT), { timeoutMs: 60000, intervalMs: 2000 });
  const [after, hub, proxy] = await Promise.all([observe(), createdSince(CORE_HUB, sinceSec), createdSince(PROXY, sinceSec)]);
  const untouched = sameFiles(prepared, after) && after.backups.length === prepared.backups.length && hub.length === 0 && proxy.length === 0;
  step(
    it,
    'courier.opt-out',
    prepared.ok && prepared.compose.includes(OPT_OUT) && logged.ok && untouched && !hasCourierLabels(after.hubLabels),
    `with ${OPT_OUT} on the proxy: logged ${logged.ok}, files byte-identical ${sameFiles(prepared, after)}, new backups ${after.backups.length - prepared.backups.length}, Core Hub created ${hub.length}, proxy created ${proxy.length}`,
  );
};

// The kit back as the conductor wired it, with the running containers to match: the next profiles start
// from a wired install and no heal of theirs recreates anything
const restoreWired = async (ctx, it, wired) => {
  await aroundConductor(ctx, it, async () => {
    fs.writeFileSync(composeFile(), wired.compose);
    fs.writeFileSync(traefikFile(), wired.traefik);
    const up = await kitCompose(['up', '-d', '--no-deps', PROXY, CORE_HUB], { timeoutMs: 180000 });
    it.notes.push(`kit put back as the conductor wired it at ${now()} (up exit ${up.code})`);
  });
};

export const courierInbound = async (ctx, it) => {
  it.courier ||= { steps: [] };
  const start = { compose: read(composeFile()), traefik: read(traefikFile()) };
  const unwired = { compose: unwiredCompose(start.compose), traefik: start.traefik.replace(ENTRY_POINT_BLOCK, '') };
  if (unwired.compose === start.compose && unwired.traefik === start.traefik) {
    it.notes.push('the kit had no courier wiring when the profile started (no conductor start had wired it)');
  }

  const wired = await addPhase(ctx, it, unwired);
  try {
    await idempotencyPhase(ctx, it, wired);
    await optOutPhase(ctx, it, unwired);
  } finally {
    await restoreWired(ctx, it, wired);
  }
};

export const courierChecks = it => {
  const steps = [...(it.courier?.steps || [])];
  if (!steps.length) steps.push({ id: 'courier.evidence', ok: false, detail: 'the profile recorded nothing' });
  return steps;
};
