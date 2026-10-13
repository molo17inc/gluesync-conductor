// Fake Gluesync services for the conductor sandbox.
//
// One image, several roles (FAKE_ROLE):
//   corehub      HTTPS :1717, WebSocket /ext-module handshake, /authentication/*
//   chronos      HTTPS :1717, health and version only
//   http         plain HTTP on FAKE_PORT (traefik, prometheus, grafana, portainer, agents)
//   backoffice   fake api.backoffice.molo17.com behind an HTTP CONNECT proxy
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

const markReady = () => fs.writeFileSync('/tmp/ready', VERSION);

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

  const modules = new Map();

  const server = https.createServer(tlsOptions(), async (req, res) => {
    const url = new URL(req.url, 'https://corehub');
    const p = url.pathname;
    try {
      if (p === '/health' || p === '/version') {
        return send(res, 200, { version: VERSION, status: 'ok' });
      }
      if (p === '/authentication/login' && req.method === 'POST') {
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
      }
      if (p === '/authentication/logout' && req.method === 'POST') {
        const token = tokenFrom(req);
        if (token && state.sessions[token]) {
          state.sessions[token].revoked = true;
          persist();
        }
        return send(res, 200, { success: true });
      }
      if (p === '/authentication/me') {
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
      }

      // ---- sandbox admin API (runner only)
      if (p.startsWith('/__sandbox/')) {
        if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
        if (p === '/__sandbox/state') {
          return send(res, 200, {
            version: VERSION,
            stats: state.stats,
            chaos: state.chaos,
            modules: [...modules.values()],
            sessions: Object.keys(state.sessions).length,
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
        if (p === '/__sandbox/ws-drop' && req.method === 'POST') {
          const body = await readBody(req);
          let n = 0;
          wss.clients.forEach(ws => {
            n += 1;
            if (body.mode === 'close') ws.close(1000, 'sandbox close');
            else ws.terminate();
          });
          log('warn', 'dropped module sockets', { count: n, mode: body.mode || 'terminate' });
          return send(res, 200, { dropped: n });
        }
      }
      return send(res, 404, { error: `no route ${req.method} ${p}` });
    } catch (error) {
      log('error', 'handler failed', { error: String(error) });
      return send(res, 500, { error: String(error) });
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

const startHttp = () => {
  const port = Number(process.env.FAKE_PORT || 8080);
  http
    .createServer((req, res) => send(res, 200, { service: SERVICE, version: VERSION }))
    .listen(port, () => {
      log('info', 'fake service listening', { port });
      markReady();
    });
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

  const record = entry => {
    state.requests.push({ ts: new Date().toISOString(), ...entry });
    if (state.requests.length > 5000) state.requests.splice(0, state.requests.length - 5000);
    persist();
  };

  // chaos[name] = { mode: 404|500|slow|garbage|flaky, failCount, delayMs }
  const backoffice = https.createServer(tlsOptions(), async (req, res) => {
    const parts = new URL(req.url, `https://${BACKOFFICE_HOST}`).pathname.split('/').filter(Boolean);
    const [kind, name, ver] = parts;
    const chaos = state.chaos[name];
    const reply = (status, body) => {
      record({ path: req.url, status, chaos: chaos?.mode || null });
      return send(res, status, body);
    };
    if (chaos) {
      if (chaos.mode === 'slow') await sleep(chaos.delayMs || 7000);
      if (chaos.mode === '500') return reply(500, { error: 'chaos 500' });
      if (chaos.mode === 'garbage') return reply(200, '<html>maintenance</html>');
      if (chaos.mode === 'flaky' && (chaos.failCount || 0) > 0) {
        chaos.failCount -= 1;
        persist();
        return reply(503, { error: 'chaos flaky' });
      }
      if (chaos.mode === '404') return reply(404, { error: 'not found' });
    }
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
    const [host, port] = req.url.split(':');
    const auth = req.headers['proxy-authorization'] || '';
    const expected = proxyUser ? `Basic ${Buffer.from(`${proxyUser}:${proxyPass}`).toString('base64')}` : '';
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
    void port;
  });
  proxy.listen(3128, () => log('info', 'proxy listening', { port: 3128 }));

  // Admin API for the runner.
  http
    .createServer(async (req, res) => {
      if (!isAdmin(req)) return send(res, 403, { error: 'admin token required' });
      const p = new URL(req.url, 'http://admin').pathname;
      if (p === '/__sandbox/state') return send(res, 200, { catalog: state.catalog, chaos: state.chaos });
      if (p === '/__sandbox/requests') {
        const since = new URL(req.url, 'http://admin').searchParams.get('since');
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
    fs.chmodSync(listenPath, 0o666);
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
