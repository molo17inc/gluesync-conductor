import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { env } from './env.mjs';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const now = () => new Date().toISOString();

// "running/healthy", or just "running" for a container without a healthcheck.
export const describeState = c => (c.health ? `${c.state}/${c.health}` : c.state);

let logStream = null;
export const setLogFile = file => {
  logStream = fs.createWriteStream(file, { flags: 'a' });
};

export const say = (msg, extra) => {
  const details = extra ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}${details}`;
  process.stdout.write(`${line}\n`);
  logStream?.write(`${line}\n`);
};

// Run a command; never throws. `docker: true` targets the sandbox daemon instead of
// the host one.
export const run = (cmd, args, opts = {}) =>
  new Promise(resolve => {
    const started = Date.now();
    const childEnv = { ...process.env, ...opts.env };
    if (opts.docker) childEnv.DOCKER_HOST = env.dockerHost;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: childEnv,
      stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => {
      out += d;
      if (opts.stream) process.stdout.write(d);
    });
    child.stderr.on('data', d => {
      err += d;
      if (opts.stream) process.stderr.write(d);
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          err += `\n[timeout after ${opts.timeoutMs}ms]`;
        }, opts.timeoutMs)
      : null;
    child.on('error', e => {
      err += String(e);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim(), ms: Date.now() - started });
    });
  });

export const mustRun = async (cmd, args, opts = {}) => {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed (${r.code}): ${(r.err || r.out).slice(-2000)}`);
  }
  return r;
};

// The docker CLI by absolute path, from fixed system directories rather than
// whatever PATH holds. SANDBOX_DOCKER_BIN overrides it.
const DOCKER_BIN_CANDIDATES = ['/usr/local/bin/docker', '/usr/bin/docker', '/bin/docker'];
let dockerBinCache = null;
export const dockerBin = () => {
  if (!dockerBinCache) {
    dockerBinCache = [process.env.SANDBOX_DOCKER_BIN, ...DOCKER_BIN_CANDIDATES].filter(Boolean).find(p => fs.existsSync(p));
    if (!dockerBinCache) throw new Error(`docker CLI not found in ${DOCKER_BIN_CANDIDATES.join(', ')}; set SANDBOX_DOCKER_BIN`);
  }
  return dockerBinCache;
};

export const docker = (args, opts = {}) => run(dockerBin(), args, { ...opts, docker: true });
export const mustDocker = (args, opts = {}) => mustRun(dockerBin(), args, { ...opts, docker: true });

// JSON-over-HTTP(S) with the sandbox CA. Never throws: errors come back in the result.
export const request = (url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) =>
  new Promise(resolve => {
    const started = Date.now();
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = lib.request(
      u,
      {
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        ca: u.protocol === 'https:' ? env.caPem() : undefined,
        timeout: timeoutMs,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text, ms: Date.now() - started });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', e => resolve({ status: 0, error: e.message, ms: Date.now() - started }));
    if (payload) req.write(payload);
    req.end();
  });

// Polls `fn` until it returns something truthy or the time is up. `last` in a
// timeout is what the last probe returned (or the message of what it threw).
export const waitFor = async (label, fn, { timeoutMs = 60000, intervalMs = 2000 } = {}) => {
  const started = Date.now();
  const probe = async last => {
    if (Date.now() - started >= timeoutMs) return { ok: false, label, last, ms: Date.now() - started };
    const seen = await fn().then(value => ({ value, threw: false }), e => ({ value: e.message, threw: true }));
    if (seen.value && !seen.threw) return { ok: true, value: seen.value, ms: Date.now() - started };
    await sleep(intervalMs);
    return probe(seen.value);
  };
  return probe(undefined);
};

// Runs `fn` on each item one after the other, for callers whose order matters or
// whose target must not be hit concurrently. Resolves to the results in order.
export const inSequence = (items, fn) =>
  items.reduce(async (previous, item, index) => {
    const results = await previous;
    return [...results, await fn(item, index)];
  }, Promise.resolve([]));

// Small deterministic PRNG so a run can be replayed with --seed.
export const rng = seed => {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
};

export const shuffle = (arr, rand) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
