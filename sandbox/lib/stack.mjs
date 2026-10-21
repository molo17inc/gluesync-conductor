import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import { env } from './env.mjs';
import { describeState, docker, dockerBin, now, request, sleep, waitFor } from './util.mjs';

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
    .filter(c => !c.Names.startsWith('keep-'))
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
      try {
        const list = await containers();
        list
          .filter(c => this.services.includes(c.service) && c.state === 'running' && !this.followed.has(c.id))
          .forEach(c => this.follow(c));
      } catch {
        /* daemon blip: try again next tick */
      }
      if (!this.stopped) this.timer = setTimeout(tick, 2000);
    };
    // tick never rejects: it catches the daemon errors itself.
    void tick();
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
      this.followed.delete(c.id);
    });
    this.followed.set(c.id, child);
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
