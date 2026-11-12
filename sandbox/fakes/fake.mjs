// Fake Gluesync services for the conductor sandbox.
//
// One image, several roles (FAKE_ROLE):
//   corehub      HTTPS :1717, WebSocket /ext-module handshake, /authentication/*,
//                the pipeline list and maintenance mode commands
//   chronos      HTTPS :1717, health and version only
//   http         plain HTTP on FAKE_PORT (traefik, prometheus, grafana, portainer, agents)
//   backoffice   fake api.backoffice.molo17.com behind an HTTP CONNECT proxy, with the fake support portal
//   dockerproxy  unix-socket pass-through to the Docker daemon with fault injection
//
// Every role logs one JSON line per event to stdout. Runtime chaos switches live
// in a JSON state file so they survive container recreation during updates.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const ROLE = process.env.FAKE_ROLE || 'http';
const VERSION = process.env.FAKE_VERSION || 'dev';
const SERVICE = process.env.FAKE_SERVICE || ROLE;
const ADMIN_TOKEN = process.env.SANDBOX_ADMIN_TOKEN || 'sandbox-admin';

const log = (level, msg, extra = {}) =>
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, role: ROLE, service: SERVICE, version: VERSION, msg, ...extra })}\n`,
  );

// The image's HEALTHCHECK tests for this file. It lives in the image's own
// directory rather than in the world-writable /tmp.
const READY_FILE = '/fake/ready';
const markReady = () => fs.writeFileSync(READY_FILE, VERSION);

// A "bad release" image is built with FAKE_CRASH=1: it exits shortly after start,
// so the conductor sees a crash-looping container after an update.
if (process.env.FAKE_CRASH === '1') {
  log('error', 'bad release: crashing on purpose');
  setTimeout(() => process.exit(3), 1500);
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};

const readBody = req =>
  new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __raw: raw });
      }
    });
  });

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    ...headers,
  });
  res.end(payload);
};

const isAdmin = req => req.headers['x-sandbox-admin'] === ADMIN_TOKEN;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tlsOptions = () => ({
  cert: fs.readFileSync(process.env.FAKE_TLS_CERT || '/opt/gluesync/shared/gluesync-cert.pem'),
  key: fs.readFileSync(process.env.FAKE_TLS_KEY || '/opt/gluesync/shared/gluesync-key.pem'),
});

// ---------------------------------------------------------------- corehub

const startCoreHub = async () => {
  const { WebSocketServer } = await import('ws');
  const stateFile = process.env.FAKE_STATE_FILE || '/opt/gluesync/data/fake-corehub-state.json';
  const users = {
    admin: { password: 'admin', role: 'SUPER_ADMIN' },
    manager: { password: 'manager', role: 'MANAGER' },
    monitor: { password: 'monitor', role: 'MONITOR' },
    viewer: { password: 'viewer', role: 'VIEWER' },
  };
  const state = readJson(stateFile, { sessions: {}, chaos: {}, stats: {} });
  state.sessions ??= {};
  state.chaos ??= {};
  state.stats ??= {};
  state.stats.starts = (state.stats.starts || 0) + 1;
  state.stats.authMeCalls ??= 0;
  state.stats.wsHandshakes ??= 0;
  state.stats.wsRejected ??= 0;
  // Pipelines and what was done to them, kept across Core Hub's recreation
  // like the real one keeps them in its database: { id, name,
  // configurationCompleted, isInMaintenanceMode, running, runningBeforeMaintenance }
  state.pipelines ??= [];
  state.pipelineEvents ??= [];
  // Tokens handed out in the module handshake: the Conductor calls the REST API with them
  state.moduleTokens ??= {};
  const persist = () => writeJson(stateFile, state);
  persist();

  // chaos.auth: { mode: ok|error500|slow|hang|garbage|norole, delayMs, until }
  // chaos.ws:   { reject: bool, until }
  const activeChaos = key => {
    const c = state.chaos[key];
    if (!c) return null;
    if (c.until && Date.now() > c.until) return null;
    return c;
  };

  const tokenFrom = req => {
    const authz = req.headers.authorization;
    if (authz) return authz.replace(/^Bearer\s+/i, '').trim();
    const cookie = req.headers.cookie || '';
    const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('gs-auth='));
    return match ? match.slice('gs-auth='.length) : null;
  };

  const sessionFor = token => {
    const s = token ? state.sessions[token] : null;
    if (!s || s.revoked) return null;
    if (s.expiresAt && Date.now() > s.expiresAt) return null;
    return s;
  };

  // Who may call the pipeline API: a logged-in user or a module (role EXTERNAL_MODULE)
  const callerOf = req => {
    const token = tokenFrom(req);
    if (token && state.moduleTokens[token]) return { username: state.moduleTokens[token], role: 'EXTERNAL_MODULE' };
    return sessionFor(token);
  };

  // ---- pipelines (gluesync-kotlin PipelinesRoutes.kt and SyncCommandRoutes.kt)
  // chaos.pipelines: { noAnswer, listStatus, listDelayMs, statusStatus, enterFail: { id: status },
  //                   drainMs: { id: ms }, exitStatus, exitFailTimes, until }
  const pipelineEvent = (op, id, extra = {}) => {
    state.pipelineEvents.push({ ts: new Date().toISOString(), version: VERSION, op, id, ...extra });
    persist();
    log('info', `pipeline ${op}`, { id, ...extra });
  };
  const pipelineDto = p => ({
    id: p.id,
    name: p.name,
    description: null,
    sourceAgentsInfo: [],
    targetAgentsInfo: [],
    configurationCompleted: p.configurationCompleted !== false,
    isInMaintenanceMode: p.isInMaintenanceMode === true,
  });
  const coreHubError = (res, status, message) =>
    send(res, status, { notificationId: -1, message, exceptionMessage: 'chaos' });

  const listPipelines = async (req, res, { caller, chaos }) => {
    pipelineEvent('list', null, { by: caller.role });
    if (chaos.listDelayMs) await sleep(chaos.listDelayMs);
    if (chaos.listStatus) return coreHubError(res, chaos.listStatus, 'Something went wrong fetching pipelines.');
    return send(res, 200, state.pipelines.map(pipelineDto));
  };

  const entitiesStatus = (req, res, { pipeline, chaos }) => {
    if (chaos.statusStatus) return coreHubError(res, chaos.statusStatus, 'Something went wrong fetching entity status.');
    return send(res, 200, [
      { pipelineId: pipeline.id, entityId: `${pipeline.id}-e1`, isMigrationActive: false, isSyncActive: pipeline.running === true, isBusy: false, snapshotWriteMethod: 'DEFAULT' },
    ]);
  };

  const enterMaintenance = async (req, res, { pipeline, caller, chaos }) => {
    pipelineEvent('enter-requested', pipeline.id, { by: caller.role });
    const failWith = chaos.enterFail?.[pipeline.id];
    if (failWith) {
      pipelineEvent('enter-failed', pipeline.id, { status: failWith });
      return coreHubError(res, failWith, 'Failed to enter maintenance mode.');
    }
    // Draining: Core Hub answers once the entities are stopped
    const drainMs = chaos.drainMs?.[pipeline.id];
    if (drainMs) await sleep(drainMs);
    pipeline.runningBeforeMaintenance = pipeline.running === true;
    pipeline.running = false;
    pipeline.isInMaintenanceMode = true;
    pipelineEvent('entered', pipeline.id);
    return send(res, 202, 'Pipeline entered maintenance mode successfully');
  };

  const exitMaintenance = (req, res, { pipeline, caller, chaos }) => {
    pipelineEvent('exit-requested', pipeline.id, { by: caller.role });
    if (chaos.exitStatus && (chaos.exitFailTimes ?? Infinity) > 0) {
      if (chaos.exitFailTimes) chaos.exitFailTimes -= 1;
      persist();
      pipelineEvent('exit-failed', pipeline.id, { status: chaos.exitStatus });
      return coreHubError(res, chaos.exitStatus, 'Failed to exit maintenance mode.');
    }
    pipeline.isInMaintenanceMode = false;
    pipeline.running = pipeline.runningBeforeMaintenance !== false;
    pipelineEvent('exited', pipeline.id);
    return send(res, 202, 'Pipeline exited maintenance mode successfully');
  };

  // `${method} ${what follows /pipelines/{id}/}`
  const pipelineRoutes = {
    'GET entities-status': entitiesStatus,
    'POST commands/maintenance/enter': enterMaintenance,
    'POST commands/maintenance/exit': exitMaintenance,
  };

  const pipelines = async (req, res, p) => {
    // A Core Hub that does not answer: the connection drops, no status at all
    if (activeChaos('pipelines')?.noAnswer) {
      pipelineEvent('dropped', null, { path: p });
      return req.socket.destroy();
    }
    const caller = callerOf(req);
    if (!caller) return send(res, 401, { notificationId: -1, message: 'Invalid authorization token', exceptionMessage: null });
    const chaos = activeChaos('pipelines') || {};
    if (p === '/pipelines' && req.method === 'GET') return listPipelines(req, res, { caller, chaos });
    const match = /^\/pipelines\/([^/]+)\/(.+)$/.exec(p);
    const handler = match && pipelineRoutes[`${req.method} ${match[2]}`];
    if (!handler) return noRoute(req, res, p);
    const pipeline = state.pipelines.find(x => x.id === decodeURIComponent(match[1]));
    if (!pipeline) return coreHubError(res, 404, `Pipeline with id ${match[1]} not found`);
    return handler(req, res, { pipeline, caller, chaos });
  };

  const modules = new Map();

  const noRoute = (req, res, p) => send(res, 404, { error: `no route ${req.method} ${p}` });

  const login = async (req, res) => {
    const body = await readBody(req);
    const user = users[body.username];
    if (!user || user.password !== body.password) {
      log('warn', 'login rejected', { username: body.username });
      return send(res, 401, { error: 'Invalid credentials' });
    }
    const token = `sess-${randomUUID()}`;
    const ttl = Number(body.ttlSeconds || 3600);
    state.sessions[token] = {
      username: body.username,
      role: user.role,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };
    persist();
    log('info', 'login ok', { username: body.username, role: user.role });
    return send(res, 200, { token, username: body.username, role: user.role }, {
      'set-cookie': `gs-auth=${token}; Path=/; HttpOnly; Secure`,
    });
  };

  const logout = (req, res) => {
    const token = tokenFrom(req);
    if (token && state.sessions[token]) {
      state.sessions[token].revoked = true;
      persist();
    }
    return send(res, 200, { success: true });
  };

  const authMe = async (req, res) => {
    state.stats.authMeCalls += 1;
    const chaos = activeChaos('auth');
    const mode = chaos?.mode || 'ok';
    log('debug', 'auth/me', { mode, hasAuthz: !!req.headers.authorization, hasCookie: !!req.headers.cookie });
    if (mode === 'error500') return send(res, 500, { error: 'chaos: internal error' });
    if (mode === 'hang') return; // never answer
    if (mode === 'slow') await sleep(chaos.delayMs || 8000);
    if (mode === 'garbage') return send(res, 200, '<html>not json</html>');
    const session = sessionFor(tokenFrom(req));
    if (!session) return send(res, 401, { error: 'Not authenticated' });
    if (mode === 'norole') return send(res, 200, { username: session.username });
    return send(res, 200, { username: session.username, role: session.role });
  };

  const dropModuleSockets = async (req, res) => {
    const body = await readBody(req);
    let n = 0;
    wss.clients.forEach(ws => {
      n += 1;
      if (body.mode === 'close') ws.close(1000, 'sandbox close');
      else ws.terminate();
    });
    log('warn', 'dropped module sockets', { count: n, mode: body.mode || 'terminate' });
    return send(res, 200, { dropped: n });
  };

  // ---- sandbox admin API (runner only)
  const sandboxAdmin = async (req, res, p) => {
    if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
    if (p === '/__sandbox/state') {
      return send(res, 200, {
        version: VERSION,
        stats: state.stats,
        chaos: state.chaos,
        modules: [...modules.values()],
        sessions: Object.keys(state.sessions).length,
        pipelines: state.pipelines,
        pipelineEvents: state.pipelineEvents.length,
      });
    }
    if (p === '/__sandbox/chaos' && req.method === 'POST') {
      const body = await readBody(req);
      state.chaos = { ...state.chaos, ...body };
      Object.keys(state.chaos).forEach(k => state.chaos[k] === null && delete state.chaos[k]);
      persist();
      log('warn', 'chaos updated', { chaos: state.chaos });
      return send(res, 200, { chaos: state.chaos });
    }
    if (p === '/__sandbox/revoke' && req.method === 'POST') {
      const body = await readBody(req);
      const s = state.sessions[body.token];
      if (s) s.revoked = true;
      persist();
      return send(res, 200, { revoked: !!s });
    }
    if (p === '/__sandbox/ws-drop' && req.method === 'POST') return dropModuleSockets(req, res);
    // { pipelines: [{ id, name, running, isInMaintenanceMode, configurationCompleted }] } replaces them
    // and clears the events; { events: [] } only clears the events
    if (p === '/__sandbox/pipelines' && req.method === 'POST') {
      const body = await readBody(req);
      if (Array.isArray(body.pipelines)) state.pipelines = body.pipelines;
      state.pipelineEvents = [];
      persist();
      return send(res, 200, { pipelines: state.pipelines });
    }
    if (p === '/__sandbox/pipelines') return send(res, 200, { pipelines: state.pipelines, events: state.pipelineEvents });
    return noRoute(req, res, p);
  };

  const route = (req, res, p) => {
    if (p === '/health' || p === '/version') return send(res, 200, { version: VERSION, status: 'ok' });
    if (p === '/authentication/login' && req.method === 'POST') return login(req, res);
    if (p === '/authentication/logout' && req.method === 'POST') return logout(req, res);
    if (p === '/authentication/me') return authMe(req, res);
    if (p.startsWith('/__sandbox/')) return sandboxAdmin(req, res, p);
    if (p === '/pipelines' || p.startsWith('/pipelines/')) return pipelines(req, res, p);
    return noRoute(req, res, p);
  };

  const server = https.createServer(tlsOptions(), async (req, res) => {
    const url = new URL(req.url, 'https://corehub');
    const p = url.pathname;
    try {
      await route(req, res, p);
    } catch (error) {
      log('error', 'handler failed', { error: String(error) });
      send(res, 500, { error: String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'https://corehub');
    if (url.pathname !== '/ext-module') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const license = req.headers['module-license'];
      const tag = req.headers['module-tag'] || 'unknown';
      const id = randomUUID().slice(0, 8);
      const chaos = activeChaos('ws');
      if (!license || chaos?.reject) {
        state.stats.wsRejected += 1;
        persist();
        log('warn', 'module rejected', { tag, reason: !license ? 'missing license' : 'chaos' });
        ws.close(4001, !license ? 'Missing license' : 'Invalid license');
        return;
      }
      let handshaken = false;
      ws.on('message', data => {
        const msg = data.toString();
        if (!handshaken) {
          handshaken = true;
          state.stats.wsHandshakes += 1;
          persist();
          const token = `mod-${tag}-${Date.now()}`;
          state.moduleTokens[token] = tag;
          persist();
          modules.set(id, { id, tag, connectedAt: new Date().toISOString(), pings: 0 });
          log('info', 'module handshake', { tag, id, first: msg });
          ws.send(token);
          return;
        }
        if (msg === 'ping') {
          const m = modules.get(id);
          if (m) m.pings += 1;
          ws.send('pong');
        }
      });
      ws.on('close', code => {
        modules.delete(id);
        log('info', 'module disconnected', { tag, id, code });
      });
    });
  });

  server.listen(1717, () => {
    log('info', 'fake corehub listening', { port: 1717 });
    markReady();
  });
};

// ---------------------------------------------------------------- chronos

const startChronos = () => {
  const server = https.createServer(tlsOptions(), (req, res) => {
    if (req.url.startsWith('/api/health') || req.url.startsWith('/health')) {
      return send(res, 200, { status: 'ok', version: VERSION });
    }
    if (req.url.startsWith('/version') || req.url.startsWith('/api/version')) {
      return send(res, 200, { version: VERSION });
    }
    return send(res, 404, { error: 'not found' });
  });
  server.listen(1717, () => {
    log('info', 'fake chronos listening', { port: 1717 });
    markReady();
  });
};

// ---------------------------------------------------------------- plain http

// With FAKE_PROXY_TARGET set (the fake traefik), requests under FAKE_PROXY_PREFIX
// are forwarded to the target with the prefix stripped, as the real kit's
// `replacepathregex` middleware does for /conductor/api/. The UI reaches the
// conductor this way, so recreating the proxy cuts the UI's own request.
const forwardToTarget = (upstream, prefix, req, res) => {
  const stripped = `/${req.url.slice(prefix.length)}`;
  const lib = upstream.protocol === 'https:' ? https : http;
  const started = Date.now();
  const out = lib.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: stripped,
      method: req.method,
      headers: { ...req.headers, host: upstream.host },
      rejectUnauthorized: false,
    },
    up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      up.on('end', () => log('info', 'proxied', { method: req.method, path: stripped, status: up.statusCode, ms: Date.now() - started }));
    },
  );
  out.on('error', e => {
    log('warn', 'proxy upstream error', { method: req.method, path: stripped, error: e.message, ms: Date.now() - started });
    if (res.headersSent) res.destroy();
    else send(res, 502, { error: `upstream: ${e.message}` });
  });
  req.pipe(out);
};

const startHttp = () => {
  const port = Number(process.env.FAKE_PORT || 8080);
  const upstream = process.env.FAKE_PROXY_TARGET ? new URL(process.env.FAKE_PROXY_TARGET) : null;
  const prefix = process.env.FAKE_PROXY_PREFIX || '/conductor/api/';
  http
    .createServer((req, res) => {
      if (upstream && req.url.startsWith(prefix)) return forwardToTarget(upstream, prefix, req, res);
      return send(res, 200, { service: SERVICE, version: VERSION });
    })
    .listen(port, () => {
      log('info', 'fake service listening', { port, proxy: upstream ? `${prefix} -> ${upstream.href}` : undefined });
      markReady();
    });
};

// ---------------------------------------------------------------- support portal

// The support portal of the voucher log upload and the S3 it hands presigned URLs for, both on the
// backoffice host (the conductor reaches them through the same CONNECT proxy): the API under
// /support-api (the conductor's GLUESYNC_SUPPORT_API_URL), the uploads under /sbx-s3. Kept in memory.
const PORTAL_PREFIX = '/support-api/support/log-uploads';
const S3_PREFIX = '/sbx-s3/';
const VOUCHER_HEADER = 'x-gluesync-voucher';
// voucher -> what the portal answers for it
const VOUCHERS = {
  'GSV-SBX0-0000-0001': { ticketKey: 'GSSD-4242' },
  'GSV-SBX0-0000-0002': { status: 401, code: 'voucher_invalid', message: 'unknown or revoked voucher' },
  'GSV-SBX0-0000-0003': { status: 410, code: 'voucher_expired', message: 'the ticket was closed more than 30 days ago' },
};
const VOUCHER_TEXT = /GSV-?[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]{4}/i;

const readRaw = req =>
  new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const createSupportPortal = () => {
  const fresh = () => ({ partBytes: 16 * 1024 * 1024, maxBytes: 5 * 1024 ** 3, faults: [], requests: [], uploads: {}, seq: 0 });
  let portal = fresh();

  const link = (id, partNumber) => {
    const tail = partNumber ? `part/${partNumber}` : 'single';
    return {
      ...(partNumber ? { partNumber } : {}),
      url: `https://api.backoffice.molo17.com${S3_PREFIX}${id}/${tail}?X-Amz-Expires=3600&X-Amz-Signature=sbx`,
    };
  };

  // faults: [{ op: check|start|links|complete|put, part?, action: destroy|status, status?, body?, times? }]
  const faultFor = (op, part) => {
    const f = portal.faults.find(x => x.op === op && (x.part === undefined || x.part === part) && (x.times ?? 1) > 0);
    if (f) f.times = (f.times ?? 1) - 1;
    return f;
  };

  const voucherReply = voucher => {
    const known = VOUCHERS[voucher];
    if (!known) return [401, { error: { code: 'voucher_invalid', message: 'unknown voucher' } }];
    if (known.status) return [known.status, { error: { code: known.code, message: known.message } }];
    return null;
  };

  // The reply of "start": one signed URL, or one per part above the part size
  const startReply = (id, ticketKey, json, multipart, count) =>
    multipart
      ? { id, ticketKey, expiresIn: 3600, multipart: { partSize: portal.partBytes, parts: Array.from({ length: count }, (_, k) => link(id, k + 1)), headers: { 'Content-Type': 'application/octet-stream' } } }
      : { id, ticketKey, expiresIn: 3600, single: { ...link(id), headers: { 'Content-Type': json.contentType } } };

  const startUpload = (res, record, ticketKey, json) => {
    if (json.size > portal.maxBytes) return send(res, 413, { error: { code: 'file_too_large', message: 'too large', maxBytes: portal.maxBytes } });
    portal.seq += 1;
    const id = `up-${portal.seq}`;
    const multipart = json.size > portal.partBytes;
    const count = multipart ? Math.ceil(json.size / portal.partBytes) : 1;
    portal.uploads[id] = { id, ticketKey, declared: json.size, contentType: json.contentType, fileName: json.fileName, multipart, count, parts: {}, completed: false, aborted: false };
    record.uploadId = id;
    return send(res, 200, startReply(id, ticketKey, json, multipart, count));
  };

  const linksReply = (id, json) =>
    json.partNumbers ? { expiresIn: 3600, parts: json.partNumbers.map(n => link(id, n)) } : { expiresIn: 3600, single: link(id) };

  const completeUpload = (res, upload, ticketKey) => {
    const keys = upload.multipart ? Array.from({ length: upload.count }, (_, k) => String(k + 1)) : ['single'];
    const missing = keys.filter(k => !upload.parts[k]);
    if (missing.length) return send(res, 409, { error: { code: 'upload_incomplete', message: 'parts missing', missingParts: missing.map(Number) } });
    const size = keys.reduce((sum, k) => sum + upload.parts[k].length, 0);
    Object.assign(upload, { completed: true, size, verified: size === upload.declared });
    return send(res, 200, { id: upload.id, ticketKey, size, verified: upload.verified, attachmentId: `att-${upload.id}` });
  };

  const api = async (req, res, p, body, record) => {
    const voucher = req.headers[VOUCHER_HEADER];
    const op = p === PORTAL_PREFIX ? 'start' : p.split('/').pop();
    record.op = op;
    const fault = faultFor(op);
    if (fault?.action === 'destroy') return req.socket.destroy();
    if (fault?.action === 'status') return send(res, fault.status, fault.body ?? { error: { code: 'sandbox_fault', message: 'injected' } });
    const refused = voucherReply(voucher);
    if (refused) return send(res, ...refused);
    const { ticketKey } = VOUCHERS[voucher];
    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    if (op === 'check') return send(res, 200, { ticketKey, voucherExpiresAt: null, maxBytes: portal.maxBytes, partBytes: portal.partBytes });
    if (op === 'start') return startUpload(res, record, ticketKey, json);
    const id = p.slice(PORTAL_PREFIX.length + 1).split('/')[0];
    const upload = portal.uploads[id];
    record.uploadId = id;
    if (!upload) return send(res, 404, { error: { code: 'not_found', message: `no upload ${id}` } });
    if (op === 'links') return send(res, 200, linksReply(id, json));
    if (op === 'complete') return completeUpload(res, upload, ticketKey);
    if (op === 'abort') {
      upload.aborted = true;
      res.writeHead(204);
      return res.end();
    }
    return send(res, 404, { error: { code: 'not_found', message: p } });
  };

  const s3 = (req, res, p, body, record) => {
    const [id, kind, n] = p.slice(S3_PREFIX.length).split('/');
    const key = kind === 'part' ? n : 'single';
    record.op = 'put';
    record.uploadId = id;
    record.part = key;
    const upload = portal.uploads[id];
    if (req.method !== 'PUT' || !upload) return send(res, 404, 'NoSuchUpload');
    const fault = faultFor('put', kind === 'part' ? Number(n) : undefined);
    if (fault?.action === 'destroy') return req.socket.destroy();
    if (fault?.action === 'status') return send(res, fault.status, fault.body ?? 'injected');
    upload.parts[key] = body;
    return send(res, 200, '', { ETag: `"etag-${id}-${key}"` });
  };

  const route = async (req, res, url) => {
    const p = url.pathname;
    const body = await readRaw(req);
    const record = {
      ts: new Date().toISOString(),
      method: req.method,
      path: p,
      bytes: body.length,
      voucherHeader: req.headers[VOUCHER_HEADER] ?? null,
      // The voucher may only travel in its header: never in the URL, never in a body
      voucherInUrl: VOUCHER_TEXT.test(decodeURIComponent(req.url)),
      voucherInBody: p.startsWith(PORTAL_PREFIX) && VOUCHER_TEXT.test(body.toString('utf8')),
    };
    portal.requests.push(record);
    const done = res.end.bind(res);
    res.end = (...args) => {
      record.status = res.statusCode;
      return done(...args);
    };
    try {
      await (p.startsWith(S3_PREFIX) ? s3 : api)(req, res, p, body, record);
    } catch (e) {
      log('error', 'portal route failed', { error: e.message });
      if (!res.headersSent) send(res, 500, { error: { code: 'sandbox', message: e.message } });
    }
    log('info', 'portal request', { method: record.method, path: p, op: record.op, status: record.status ?? 'dropped' });
  };

  const handles = url => url.pathname.startsWith(PORTAL_PREFIX) || url.pathname.startsWith(S3_PREFIX);

  // /__sandbox/portal          POST { reset, partBytes, maxBytes, faults }
  // /__sandbox/portal/state    GET  requests and uploads (part sizes, not bytes)
  // /__sandbox/portal/file     GET  ?id= the upload as S3 would assemble it
  // Resolves to false for any other path.
  const admin = async (req, res, url) => {
    const p = url.pathname;
    if (p === '/__sandbox/portal' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.reset) portal = fresh();
      for (const k of ['partBytes', 'maxBytes', 'faults']) if (body[k] !== undefined) portal[k] = body[k];
      return send(res, 200, { partBytes: portal.partBytes, maxBytes: portal.maxBytes, faults: portal.faults });
    }
    if (p === '/__sandbox/portal/state') {
      const uploads = Object.values(portal.uploads).map(({ parts, ...u }) => ({
        ...u,
        parts: Object.fromEntries(Object.entries(parts).map(([k, b]) => [k, b.length])),
      }));
      return send(res, 200, { requests: portal.requests, uploads, faults: portal.faults });
    }
    if (p === '/__sandbox/portal/file') {
      const upload = portal.uploads[url.searchParams.get('id')];
      if (!upload) return send(res, 404, { error: 'no such upload' });
      const keys = Object.keys(upload.parts).sort((a, b) => (a === 'single' ? 0 : Number(a)) - (b === 'single' ? 0 : Number(b)));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.concat(keys.map(k => upload.parts[k])));
    }
    return false;
  };

  return { handles, route, admin };
};

// ---------------------------------------------------------------- backoffice

const startBackoffice = () => {
  const stateFile = process.env.FAKE_STATE_FILE || '/data/backoffice-state.json';
  const state = readJson(stateFile, { catalog: {}, chaos: {}, requests: [] });
  state.catalog ??= {};
  state.chaos ??= {};
  state.requests ??= [];
  const persist = () => writeJson(stateFile, state);
  const proxyUser = process.env.PROXY_USER || '';
  const proxyPass = process.env.PROXY_PASS || '';
  const BACKOFFICE_HOST = 'api.backoffice.molo17.com';
  const portal = createSupportPortal();

  const record = entry => {
    state.requests.push({ ts: new Date().toISOString(), ...entry });
    if (state.requests.length > 5000) state.requests.splice(0, state.requests.length - 5000);
    persist();
  };

  // chaos[name] = { mode: 404|500|slow|garbage|flaky, failCount, delayMs }
  // Returns the [status, body] the chaos forces, or null to answer normally.
  const chaosReply = async chaos => {
    if (!chaos) return null;
    if (chaos.mode === 'slow') await sleep(chaos.delayMs || 7000);
    if (chaos.mode === '500') return [500, { error: 'chaos 500' }];
    if (chaos.mode === 'garbage') return [200, '<html>maintenance</html>'];
    if (chaos.mode === 'flaky' && (chaos.failCount || 0) > 0) {
      chaos.failCount -= 1;
      persist();
      return [503, { error: 'chaos flaky' }];
    }
    if (chaos.mode === '404') return [404, { error: 'not found' }];
    return null;
  };

  const backoffice = https.createServer(tlsOptions(), async (req, res) => {
    const url = new URL(req.url, `https://${BACKOFFICE_HOST}`);
    if (portal.handles(url)) return portal.route(req, res, url);
    const parts = url.pathname.split('/').filter(Boolean);
    const [kind, name, ver] = parts;
    const chaos = state.chaos[name];
    const reply = (status, body) => {
      record({ path: req.url, status, chaos: chaos?.mode || null });
      return send(res, status, body);
    };
    const forced = await chaosReply(chaos);
    if (forced) return reply(...forced);
    if (kind === 'agent' && parts[2] === 'version') {
      const entry = state.catalog[name];
      if (!entry) return reply(404, { error: `unknown agent ${name}` });
      return reply(200, {
        availableGA: true,
        availableBeta: true,
        availableAlpha: true,
        latestVersionGA: entry.ga,
        latestVersionBeta: entry.beta ?? entry.ga,
        latestVersionAlpha: entry.alpha ?? entry.beta ?? entry.ga,
      });
    }
    if (kind === 'changelog') {
      const entry = state.catalog[name];
      if (!entry) return reply(404, { error: `unknown agent ${name}` });
      return reply(200, {
        id: 1,
        versionNumber: ver,
        releaseDate: new Date().toISOString(),
        changelog: `Sandbox changelog for ${name} ${ver}`,
        changelogSummary: null,
        module: name,
        relativePath: null,
      });
    }
    return reply(404, { error: 'no route' });
  });
  backoffice.listen(8443, '127.0.0.1', () => log('info', 'fake backoffice listening', { port: 8443 }));

  // HTTP CONNECT proxy: tunnels api.backoffice.molo17.com to the fake, refuses the rest.
  const proxy = http.createServer((req, res) => send(res, 405, { error: 'CONNECT only' }));
  proxy.on('connect', (req, clientSocket, head) => {
    const [host] = req.url.split(':');
    const auth = req.headers['proxy-authorization'] || '';
    const credentials = Buffer.from(`${proxyUser}:${proxyPass}`).toString('base64');
    const expected = proxyUser ? `Basic ${credentials}` : '';
    if (proxyUser && auth !== expected) {
      record({ proxy: req.url, status: 407 });
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    if (host !== BACKOFFICE_HOST) {
      record({ proxy: req.url, status: 403 });
      log('warn', 'proxy refused non-backoffice host', { target: req.url });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(8443, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  proxy.listen(3128, () => log('info', 'proxy listening', { port: 3128 }));

  // Admin API for the runner.
  http
    .createServer(async (req, res) => {
      if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
      // The base URL only serves to parse the path and query string.
      const url = new URL(req.url, 'https://admin');
      const p = url.pathname;
      if (p === '/__sandbox/state') return send(res, 200, { catalog: state.catalog, chaos: state.chaos });
      if (p.startsWith('/__sandbox/portal') && (await portal.admin(req, res, url)) !== false) return undefined;
      if (p === '/__sandbox/requests') {
        const since = url.searchParams.get('since');
        return send(res, 200, state.requests.filter(r => !since || r.ts >= since));
      }
      if (p === '/__sandbox/catalog' && req.method === 'POST') {
        const body = await readBody(req);
        state.catalog = { ...state.catalog, ...body };
        persist();
        log('info', 'catalog updated', { catalog: state.catalog });
        return send(res, 200, state.catalog);
      }
      if (p === '/__sandbox/chaos' && req.method === 'POST') {
        const body = await readBody(req);
        state.chaos = { ...state.chaos, ...body };
        Object.keys(state.chaos).forEach(k => state.chaos[k] === null && delete state.chaos[k]);
        persist();
        log('warn', 'chaos updated', { chaos: state.chaos });
        return send(res, 200, state.chaos);
      }
      return send(res, 404, { error: 'no route' });
    })
    .listen(8088, () => {
      log('info', 'backoffice admin listening', { port: 8088 });
      markReady();
    });
};

// ---------------------------------------------------------------- docker socket proxy

const startDockerProxy = () => {
  const upstreamPath = process.env.DOCKER_UPSTREAM || '/var/run/docker.sock';
  const listenPath = process.env.DOCKER_PROXY_SOCKET || '/sockproxy/docker.sock';
  // mode: pass | delay | refuse | reset
  const chaos = { mode: 'pass', delayMs: 0, until: 0 };
  const current = () => (chaos.until && Date.now() > chaos.until ? 'pass' : chaos.mode);

  try {
    fs.unlinkSync(listenPath);
  } catch {
    /* not there */
  }
  const server = net.createServer(client => {
    const mode = current();
    if (mode === 'refuse') {
      client.destroy();
      return;
    }
    const connect = () => {
      const upstream = net.connect(upstreamPath);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
      if (mode === 'reset') setTimeout(() => upstream.destroy(), 200);
    };
    if (mode === 'delay') setTimeout(connect, chaos.delayMs || 5000);
    else connect();
  });
  server.listen(listenPath, () => {
    // Owner and group only, like the real Docker socket: its one client, the conductor, runs as root.
    fs.chmodSync(listenPath, 0o660);
    log('info', 'docker proxy listening', { listenPath, upstreamPath });
    markReady();
  });

  http
    .createServer(async (req, res) => {
      if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        Object.assign(chaos, { mode: 'pass', delayMs: 0, until: 0 }, body);
        log('warn', 'docker proxy chaos', chaos);
      }
      return send(res, 200, { ...chaos, effective: current() });
    })
    .listen(8089, () => log('info', 'docker proxy admin listening', { port: 8089 }));
};

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, exiting');
  process.exit(0);
});

const roles = {
  corehub: startCoreHub,
  chronos: startChronos,
  http: startHttp,
  backoffice: startBackoffice,
  dockerproxy: startDockerProxy,
};

if (!roles[ROLE]) {
  log('error', `unknown FAKE_ROLE ${ROLE}`);
  process.exit(2);
}
await roles[ROLE]();
