import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { SERVICES, env } from './env.mjs';
import { describeState, docker, dockerBin, inSequence, now, request, say, sleep, waitFor } from './util.mjs';

// ---------------------------------------------------------------- HTTP clients

const conductorUrl = p => `https://127.0.0.1:${env.ports.conductor}${p}`;
// Through the kit's reverse proxy, the path the Core Hub UI uses.
const proxiedConductorUrl = p => `http://127.0.0.1:${env.ports.proxy}/conductor/api${p}`;
const corehubUrl = p => `https://127.0.0.1:${env.ports.corehub}${p}`;

// Every conductor call made by the runner goes through here so the report has a
// full API transcript per iteration. `via: 'proxy'` sends it through the kit's
// reverse proxy instead of the conductor's published port.
export const callConductor = async (ctx, label, method, p, { token, cookie, body, timeoutMs = 30000, via } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const started = now();
  const res = await request(via === 'proxy' ? proxiedConductorUrl(p) : conductorUrl(p), { method, headers, body, timeoutMs });
  const entry = {
    ts: started,
    label,
    method,
    path: p,
    ...(via ? { via } : {}),
    status: res.status,
    ms: res.ms,
    error: res.error,
    contentType: res.headers?.['content-type'],
    json: res.json,
    text: res.json === undefined ? res.text?.slice(0, 1000) : undefined,
  };
  ctx?.api?.push(entry);
  return res;
};

export const corehub = {
  login: async (username, ttlSeconds = 3600) => {
    const res = await request(corehubUrl('/authentication/login'), {
      method: 'POST',
      body: { username, password: username, ttlSeconds },
    });
    if (res.status !== 200) throw new Error(`fake corehub login failed: ${res.status} ${res.error || res.text}`);
    return res.json.token;
  },
  admin: (p, body) =>
    request(corehubUrl(p), {
      method: body ? 'POST' : 'GET',
      body,
      headers: { 'x-sandbox-admin': env.adminToken },
      timeoutMs: 10000,
    }),
  chaos: body => corehub.admin('/__sandbox/chaos', body),
};

export const dockerProxy = body =>
  request(`http://127.0.0.1:${env.ports.dockerProxyAdmin}/`, {
    method: body ? 'POST' : 'GET',
    body,
    headers: { 'x-sandbox-admin': env.adminToken },
  });

export const health = () => request(conductorUrl('/health'), { timeoutMs: 5000 });

// `docker compose up -d` returns when the containers are started, not when their servers listen:
// the published port accepts the connection and the fake behind it is not there yet ("socket
// disconnected before secure TLS connection was established"). A slower host (a CI runner) hits
// that window every time, so nothing may talk to a fake before it has answered a real request.
// Each probe is retried for up to `timeoutMs`; the first one that never succeeds throws with what
// it saw last.
export const waitStackReady = async ({ timeoutMs = 120000 } = {}) => {
  const probes = [
    ['fake corehub (TLS login)', async () => ({ ok: !!(await corehub.login('admin', 60)) })],
    ['fake backoffice (admin API)', async () => ({ ok: (await backofficeState()).status === 200, why: 'no 200' })],
    ['docker socket proxy (admin API)', async () => ({ ok: (await dockerProxy()).status === 200, why: 'no 200' })],
    ['conductor /health', async () => ({ ok: (await health()).status === 200, why: 'no 200' })],
  ];
  const started = Date.now();
  await inSequence(probes, async ([label, fn]) => {
    let last = 'never answered';
    const left = Math.max(5000, timeoutMs - (Date.now() - started));
    const r = await waitFor(
      label,
      async () => {
        try {
          const res = await fn();
          if (!res.ok) last = res.why || 'not ready';
          return res.ok;
        } catch (e) {
          last = e.message;
          return false;
        }
      },
      { timeoutMs: left, intervalMs: 2000 },
    );
    if (!r.ok) throw new Error(`${label} not ready after ${Math.round(r.ms / 1000)}s: ${last}`);
  });
  say(`stack ready after ${Math.round((Date.now() - started) / 1000)}s: fake corehub, backoffice, docker proxy and conductor answer`);
};

const backofficeState = () =>
  request(`http://127.0.0.1:${env.ports.backofficeAdmin}/__sandbox/state`, { headers: { 'x-sandbox-admin': env.adminToken }, timeoutMs: 5000 });

// ---------------------------------------------------------------- docker state

const parseTag = image => {
  const i = image.lastIndexOf(':');
  return i > image.lastIndexOf('/') ? image.slice(i + 1) : 'latest';
};

export const containers = async () => {
  const ids = await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${env.project}`]);
  if (ids.code !== 0 || !ids.out) return [];
  const insp = await docker(['inspect', ...ids.out.split('\n')]);
  if (insp.code !== 0) return [];
  return JSON.parse(insp.out).map(c => ({
    id: c.Id.slice(0, 12),
    name: c.Name.replace(/^\//, ''),
    service: c.Config.Labels['com.docker.compose.service'],
    image: c.Config.Image,
    tag: parseTag(c.Config.Image),
    sandboxVersion: c.Config.Labels['sandbox.version'] || null,
    state: c.State.Status,
    health: c.State.Health?.Status || null,
    restartCount: c.RestartCount,
    startedAt: c.State.StartedAt,
    finishedAt: c.State.FinishedAt,
    exitCode: c.State.ExitCode,
    oomKilled: c.State.OOMKilled,
    pid: c.State.Pid,
  }));
};

// Containers that belong to neither the kit nor the sandbox infra: the conductor's
// helper containers (docker:cli, docker:28) that should be gone once they finish.
export const strayContainers = async () => {
  const r = await docker(['ps', '-a', '--format', '{{json .}}']);
  if (r.code !== 0 || !r.out) return [];
  return r.out
    .split('\n')
    .map(l => JSON.parse(l))
    .filter(c => !/com\.docker\.compose\.project=(gluesync|conductor-sandbox-infra)/.test(c.Labels || ''))
    .filter(c => !c.Names.startsWith(env.keepPrefix))
    .map(c => ({ id: c.ID, name: c.Names, image: c.Image, state: c.State, status: c.Status }));
};

export const readCompose = () => {
  const file = path.join(env.kitDir, 'docker-compose.yml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  try {
    return { text, parsed: YAML.parse(text), parseError: null };
  } catch (e) {
    return { text, parsed: null, parseError: e.message };
  }
};

export const snapshot = async () => {
  const list = await containers();
  const byService = {};
  list.forEach(c => {
    byService[c.service] ||= [];
    byService[c.service].push(c);
  });
  return {
    ts: now(),
    containers: list,
    byService: Object.fromEntries(
      Object.entries(byService).map(([s, cs]) => [s, cs.find(c => c.state === 'running') || cs[0]]),
    ),
    duplicates: Object.entries(byService)
      .filter(([, cs]) => cs.length > 1)
      .map(([s, cs]) => ({ service: s, containers: cs.map(c => `${c.name}:${c.state}`) })),
    strays: await strayContainers(),
    compose: readCompose(),
  };
};

// ---------------------------------------------------------------- waiting

export const conductorContainer = async () => (await containers()).find(c => c.service === 'gluesync-conductor' && c.state === 'running');

const kitFingerprint = (list, strict) =>
  list
    .filter(c => SERVICES[c.service])
    .map(c => [c.service, c.id, c.image, ...(strict ? [String(c.state === 'running')] : [])].join(' '))
    .sort((a, b) => a.localeCompare(b));

const describeKitChange = (before, after) => {
  const gone = before.filter(e => !after.includes(e)).map(e => `-${e}`);
  const added = after.filter(e => !before.includes(e)).map(e => `+${e}`);
  return [...gone, ...added].join(', ') || 'none';
};

// Why the kit is not worth looking at yet (empty when it is): a kit service without exactly one
// container, or with one that is not running. Only asked for when `strict`.
const kitProblems = (list, strict) =>
  Object.keys(SERVICES).flatMap(service => {
    if (!strict) return [];
    const mine = list.filter(c => c.service === service);
    const names = mine.map(c => `${c.name}:${c.state}`).join(', ');
    if (mine.length !== 1) return [`${service}: ${mine.length} containers (${names || 'none'})`];
    return mine[0].state !== 'running' ? [`${service}: ${mine[0].state}`] : [];
  });

// Waits until the kit is SETTLED, so a snapshot taken afterwards is the kit as it stays: every kit
// service has exactly one running container (`strict`, the default; without it a service a profile
// left down on purpose is accepted) and the containers' ids and image refs are the same on
// `stablePolls` consecutive polls `intervalMs` apart. The conductor recreates containers right
// after it starts (it labels the services it adopts and starts them again), and a snapshot taken
// in the middle reads "<tag> (neither old nor target)" for every service that was caught. Throws,
// naming what kept changing, when `timeoutMs` passes. The conductor's own startup is waited for
// separately (`waitConductorStartup`).
export const waitKitSettled = async ({ timeoutMs = 120000, intervalMs = 2000, stablePolls = 3, strict = true } = {}) => {
  const started = Date.now();
  const poll = async (prev, stable, lastChange, lastChangeAt) => {
    const elapsed = Date.now() - started;
    const list = await containers();
    const problems = kitProblems(list, strict);
    const fingerprint = kitFingerprint(list, strict);
    const same = !!prev && fingerprint.join('\n') === prev.join('\n');
    const change = prev && !same ? describeKitChange(prev, fingerprint) : lastChange;
    const changeAt = prev && !same ? elapsed : lastChangeAt;
    const stableNow = !problems.length && same ? stable + 1 : 0;
    if (stableNow >= stablePolls - 1) {
      say(`kit settled after ${Math.round(elapsed / 1000)}s: ${fingerprint.length} containers unchanged for ${stablePolls} polls`);
      return;
    }
    if (elapsed >= timeoutMs) {
      const why = [
        ...problems,
        ...(change ? [`containers kept changing, last at +${Math.round(changeAt / 1000)}s: ${change}`] : []),
      ];
      throw new Error(`kit did not settle within ${Math.round(timeoutMs / 1000)}s (${stablePolls} identical polls ${intervalMs}ms apart needed): ${why.join('; ') || 'no stable run of polls'}`);
    }
    await sleep(intervalMs);
    return poll(fingerprint, stableNow, change, changeAt);
  };
  return poll(null, 0, null, 0);
};

// Waits until a conductor container (optionally a new one, optionally on a given tag)
// is running and answering /health.
export const waitConductor = async ({ notId, tag, timeoutMs = 240000 } = {}) =>
  waitFor(
    'conductor',
    async () => {
      const c = await conductorContainer();
      if (!c) return false;
      if (notId && c.id === notId) return false;
      if (tag && c.tag !== tag) return false;
      const h = await health();
      return h.status === 200 ? c : false;
    },
    { timeoutMs, intervalMs: 2000 },
  );

// After it listens, the Conductor runs its startup steps (healers, auto-adoption that recreates the
// adopted services, log-collection sync) and the last one logs the conductor-healer verdict, after
// the adoption's recreates. A snapshot taken before that line races those recreates (a container
// removed between `ps` and `inspect`). If the verdict is a reboot, the Conductor replaces itself and
// the new container is waited for the same way.
const healerVerdict = /\[conductor-healer\] (nothing to heal|reboot needed to heal)/;

const conductorLogs = async id => {
  const r = await docker(['logs', id], { timeoutMs: 15000 });
  return `${r.out}\n${r.err}`;
};

const waitHealerVerdict = async (id, deadline) => {
  const r = await waitFor(
    'conductor startup',
    async () => healerVerdict.exec(await conductorLogs(id))?.[1] || false,
    { timeoutMs: Math.max(1000, deadline - Date.now()), intervalMs: 1000 },
  );
  if (!r.ok) throw new Error(`conductor ${id} did not log the conductor-healer verdict after ${Math.round(r.ms / 1000)}s: startup (adoption) not finished`);
  if (r.value !== 'reboot needed to heal') return;
  const next = await waitConductor({ notId: id, timeoutMs: Math.max(1000, deadline - Date.now()) });
  if (!next.ok) throw new Error(`conductor did not come back after the reboot to heal, ${Math.round(next.ms / 1000)}s`);
  await waitHealerVerdict(next.value.id, deadline);
};

export const waitConductorStartup = async ({ timeoutMs = 180000 } = {}) => {
  const started = Date.now();
  const c = await conductorContainer();
  if (!c) throw new Error('conductor startup: no running conductor container');
  await waitHealerVerdict(c.id, started + timeoutMs);
  say(`conductor startup done after ${Math.round((Date.now() - started) / 1000)}s (adoption finished)`);
};

// Waits until nothing in the kit is starting/restarting and the conductor answers
// authenticated reads (no update-mode 503). Returns what was still unsettled.
// One look at the kit: what is not running/healthy, and whether the conductor answers.
const observeStack = async (token, ignore) => {
  const list = await containers();
  // The conductor's self-update helper keeps verifying for up to ~2 minutes.
  const helpers = (await strayContainers()).filter(c => c.state === 'running');
  const unsettled = [
    ...list
      .filter(c => !ignore.includes(c.service))
      .filter(c => c.state !== 'running' || (c.health && c.health !== 'healthy')),
    ...helpers.map(h => ({ service: `helper ${h.name}`, state: h.image, health: null })),
  ];
  const h = await health();
  const svc = h.status === 200 ? await callConductor(null, 'settle', 'GET', '/services', { token, timeoutMs: 10000 }) : null;
  return {
    ok: unsettled.length === 0 && h.status === 200 && svc?.status === 200,
    seen: {
      unsettled: unsettled.map(c => `${c.service}:${describeState(c)}`),
      health: h.status || h.error,
      services: svc?.status,
    },
  };
};

export const settle = async (ctx, token, { timeoutMs = 180000, ignore = [] } = {}) => {
  const started = Date.now();
  // Settled means two consecutive clean looks, 3s apart.
  const probe = async (stableFor, last) => {
    if (Date.now() - started >= timeoutMs) return { ok: false, ms: Date.now() - started, last };
    const { ok, seen } = await observeStack(token, ignore);
    const stable = ok ? stableFor + 1 : 0;
    if (stable >= 2) return { ok: true, ms: Date.now() - started, last: seen };
    await sleep(3000);
    return probe(stable, seen);
  };
  return probe(0, null);
};

// ---------------------------------------------------------------- log collection

// A Docker restart keeps the id, so a follow is keyed by the start as well: the follow of the
// previous start may not have closed yet when the container is running again.
const followKey = c => `${c.id}@${c.startedAt}`;

// Follows the docker logs of every incarnation of the watched services, so logs
// survive the container being replaced by an update.
export class LogCollector {
  constructor(dir, services = ['gluesync-conductor', 'gluesync-core-hub']) {
    this.dir = dir;
    this.services = services;
    this.followed = new Map();
    this.lastTs = new Map();
    this.lines = [];
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  start() {
    const tick = async () => {
      await this.sync();
      if (!this.stopped) this.timer = setTimeout(tick, 2000);
    };
    // tick never rejects: sync catches the daemon errors itself.
    void tick();
  }

  // Follows every running incarnation not followed yet. The timer does this every 2s; a caller
  // that has just started a container which may be gone again within 2s (the conductor
  // restarted right before a self-update replaces it) calls it at once, so its lines are not lost.
  async sync() {
    try {
      const list = await containers();
      list
        .filter(c => this.services.includes(c.service) && c.state === 'running' && !this.followed.has(followKey(c)))
        .forEach(c => this.follow(c));
    } catch {
      /* daemon blip: try again next tick */
    }
  }

  follow(c) {
    const file = fs.createWriteStream(path.join(this.dir, `${c.service}.log`), { flags: 'a' });
    const resumeFrom = this.lastTs.get(c.id);
    file.write(`===== ${resumeFrom ? 'resumed' : 'incarnation'} ${c.id} ${c.image} (started ${c.startedAt}) =====\n`);
    // docker logs -f ends when the container stops; a Docker restart keeps the id,
    // so the follow is resumed from the last line seen.
    const args = ['logs', '-f', '--timestamps', ...(resumeFrom ? ['--since', resumeFrom] : []), c.id];
    const child = spawn(dockerBin(), args, {
      env: { ...process.env, DOCKER_HOST: env.dockerHost },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = stream => {
      let buf = '';
      stream.on('data', d => {
        buf += d;
        const parts = buf.split('\n');
        buf = parts.pop();
        parts.forEach(raw => {
          if (!raw) return;
          file.write(`${raw}\n`);
          const sp = raw.indexOf(' ');
          const ts = raw.slice(0, sp);
          if (resumeFrom && ts <= resumeFrom) return;
          this.lastTs.set(c.id, ts);
          this.lines.push({ service: c.service, incarnation: c.id, ts, line: raw.slice(sp + 1) });
        });
      });
    };
    onData(child.stdout);
    onData(child.stderr);
    child.on('close', () => {
      file.end();
      this.followed.delete(followKey(c));
    });
    this.followed.set(followKey(c), child);
  }

  since(service, isoTs) {
    return this.lines.filter(l => l.service === service && l.ts >= isoTs);
  }

  incarnations(service) {
    return [...new Set(this.lines.filter(l => l.service === service).map(l => l.incarnation))];
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.followed.forEach(child => child.kill());
  }
}
