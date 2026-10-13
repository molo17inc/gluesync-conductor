// Invariants evaluated after every iteration. A check is { area, id, ok, severity, detail, evidence }.
// severity: fail (a real defect), warn (degraded / risky), info (worth knowing).

import { env, SERVICES } from './env.mjs';
import { describeState } from './util.mjs';

// severity is what a failure means; it defaults to 'fail'.
const result = (area, id, ok, detail, severity, evidence) => ({
  area,
  id,
  ok,
  severity: ok ? 'pass' : (severity ?? 'fail'),
  detail,
  ...(evidence ? { evidence } : {}),
});

// JSON with sorted keys, so two values compare equal regardless of key order.
const stable = v => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (!v || typeof v !== 'object') return JSON.stringify(v);
  const fields = Object.keys(v)
    .sort((a, b) => a.localeCompare(b))
    .map(k => `${JSON.stringify(k)}:${stable(v[k])}`);
  return `{${fields.join(',')}}`;
};

const commentLines = text => text.split('\n').filter(l => l.trim().startsWith('#')).length;

const updateCalls = it => it.api.filter(a => a.label.startsWith('update round'));

// ---------------------------------------------------------------- stack + compose

// A release that crashes on start must end up back on the previous version, running.
const badReleaseChecks = (pre, post, plan) =>
  (plan.crashImages || []).map(s => {
    const before = pre.byService[s];
    const now = post.byService[s];
    const ok = !!now && now.state === 'running' && now.tag === before?.tag;
    const where = now ? `${now.state} on ${now.tag}, restarts ${now.restartCount}` : 'gone';
    return result(
      'stack',
      'stack.bad-release-rolled-back',
      ok,
      ok ? `${s} rolled back to ${now.tag} and is running` : `${s} is ${where} (previous version ${before?.tag})`,
    );
  });

// Compose fields other than the image that the update changed, per service and top level.
const composeDrift = (pre, post, preServices, services) => {
  const drift = Object.keys(preServices)
    .filter(s => services[s])
    .flatMap(s => {
      const keys = new Set([...Object.keys(preServices[s]), ...Object.keys(services[s])]);
      keys.delete('image');
      return [...keys]
        .filter(k => stable(preServices[s][k]) !== stable(services[s][k]))
        .map(k => ({ service: s, key: k, before: preServices[s][k], after: services[s][k] }));
    });
  const topBefore = { ...pre.compose.parsed };
  const topAfter = { ...post.compose.parsed };
  delete topBefore.services;
  delete topAfter.services;
  if (stable(topBefore) !== stable(topAfter)) drift.push({ service: '(top level)', key: 'name/networks/volumes', before: topBefore, after: topAfter });
  return drift;
};

// The env var, label and comment a customer added before the update must survive it.
const customizationChecks = post => {
  const keep = ['CUSTOMER_SETTING=keep-me', 'customer.note=costs $$5 per month'];
  const missing = keep.filter(k => !post.compose.text.includes(k));
  return [
    result('compose', 'compose.customer-edits-kept', missing.length === 0, missing.length ? `customer edits lost: ${missing.join(', ')}` : 'customer env var and label kept'),
    result(
      'compose',
      'compose.customer-comment-kept',
      post.compose.text.includes('# customer note'),
      post.compose.text.includes('# customer note') ? 'customer comment kept' : 'customer comment dropped by the rewrite',
      'warn',
    ),
  ];
};

const stackChecks = x => {
  const { pre, post, target, plan } = x;
  const out = [];
  const lagging = new Set(plan.lagging || []);
  const crash = new Set(plan.crashImages || []);

  const wrong = Object.keys(SERVICES).flatMap(s => {
    const tag = post.byService[s]?.tag;
    if (!tag) return [`${s}: no container`];
    if (lagging.has(s)) return tag === target[s] || tag === pre.byService[s]?.tag ? [] : [`${s}: ${tag} (neither old nor target)`];
    return tag === target[s] ? [] : [`${s}: running ${tag}, expected ${target[s]}`];
  });
  out.push(result('stack', 'stack.target-versions', wrong.length === 0, wrong.length ? wrong.join('; ') : `all services at expected versions (${plan.expect})`));

  const services = post.compose.parsed?.services || {};
  const mismatch = Object.entries(services).flatMap(([s, svc]) => {
    const running = post.byService[s];
    if (!running) return [`${s}: in compose but no container`];
    return svc.image === running.image ? [] : [`${s}: compose says ${svc.image}, container runs ${running.image}`];
  });
  out.push(
    result(
      'compose',
      'compose.matches-runtime',
      mismatch.length === 0,
      mismatch.length ? `compose file and running containers disagree: ${mismatch.join('; ')}` : 'compose file matches running containers',
    ),
  );

  const unpublished = Object.entries(services)
    .filter(([, svc]) => svc.image?.startsWith(env.registry) && !x.pushedRefs.has(svc.image))
    .map(([s, svc]) => `${s} -> ${svc.image}`);
  out.push(
    result(
      'compose',
      'compose.images-exist',
      unpublished.length === 0,
      unpublished.length
        ? `compose references images that do not exist in the registry (next restart of these services fails): ${unpublished.join('; ')}`
        : 'every image in the compose file exists',
    ),
  );

  const looping = post.containers
    .filter(c => !crash.has(c.service) && c.service !== 'gluesync-conductor')
    .filter(c => {
      const before = pre.containers.find(p => p.id === c.id);
      return c.state === 'restarting' || (before && c.restartCount > before.restartCount);
    })
    .map(c => `${c.service} (${c.state}, restarts ${c.restartCount})`);
  out.push(
    ...badReleaseChecks(pre, post, plan),
    result('stack', 'stack.no-crash-loops', looping.length === 0, looping.length ? looping.join('; ') : 'no unexpected restarts'),
    result(
      'stack',
      'stack.no-duplicate-containers',
      post.duplicates.length === 0,
      post.duplicates.length ? JSON.stringify(post.duplicates) : 'one container per service',
    ),
  );

  const strays = post.strays.filter(s => !pre.strays.some(p => p.id === s.id));
  const strayList = strays.map(s => `${s.name} (${s.image}, ${s.status})`).join('; ');
  out.push(
    result(
      'stack',
      'stack.no-leftover-helpers',
      strays.length === 0,
      strays.length ? `helper containers left behind: ${strayList}` : 'no leftover helper containers',
      'warn',
    ),
    // ---- compose fidelity
    result(
      'compose',
      'compose.valid',
      !post.compose.parseError && x.composeConfig.code === 0,
      post.compose.parseError || (x.composeConfig.code === 0 ? 'docker compose config passes' : x.composeConfig.err.slice(0, 400)),
    ),
  );

  const preServices = pre.compose.parsed?.services || {};
  const lost = Object.keys(preServices).filter(s => !services[s]);
  const added = Object.keys(services).filter(s => !preServices[s]);
  out.push(
    result(
      'compose',
      'compose.services-preserved',
      lost.length === 0 && added.length === 0,
      lost.length || added.length ? `lost: [${lost}] added: [${added}]` : 'same services before and after',
    ),
  );

  const drift = composeDrift(pre, post, preServices, services);
  const driftList = drift.map(d => `${d.service}.${d.key}`).join(', ');
  out.push(
    result(
      'compose',
      'compose.no-unrelated-changes',
      drift.length === 0,
      drift.length ? `fields other than image changed: ${driftList}` : 'only image tags changed',
      'warn',
      drift.length ? drift : undefined,
    ),
  );

  const cBefore = commentLines(pre.compose.text);
  const cAfter = commentLines(post.compose.text);
  out.push(
    result(
      'compose',
      'compose.comments-preserved',
      cAfter >= cBefore,
      cAfter >= cBefore ? `${cAfter} comment lines kept` : `${cBefore - cAfter} of ${cBefore} comment lines dropped by the rewrite`,
      'warn',
    ),
  );

  const escapes = ['$$2y$$05$$', 'replacement=/api/$$1', 'replacement=/$$1'].filter(e => !post.compose.text.includes(e));
  out.push(
    result(
      'compose',
      'compose.dollar-escapes',
      escapes.length === 0,
      escapes.length ? `$$ escapes lost (compose would interpolate them): ${escapes.join(', ')}` : '$$ escapes intact',
    ),
  );

  if (plan.customization) out.push(...customizationChecks(post));
  return out;
};

// ---------------------------------------------------------------- API error handling

const apiChecks = x => {
  const { it, post, target, plan } = x;
  const out = [];

  const badShape = it.api
    .filter(a => a.status >= 400)
    .filter(a => !(a.json?.success === false && typeof a.json.error === 'string'))
    .map(a => `${a.label} -> ${a.status} ${a.contentType || ''} ${JSON.stringify(a.json ?? a.text).slice(0, 160)}`);
  out.push(
    result('errors', 'errors.consistent-shape', badShape.length === 0, badShape.length ? badShape.join(' | ') : 'every error response is {success:false, error}'),
  );

  const items = updateCalls(it).flatMap(a => (a.json?.data?.containers || []).map(c => ({ ...c, call: a.label })));
  const silent = items.filter(c => c.status === 'ERROR' && !c.message);
  out.push(
    result(
      'errors',
      'errors.items-explain-failure',
      silent.length === 0,
      silent.length
        ? `update reported ERROR without any message for: ${[...new Set(silent.map(c => c.id))].join(', ')}`
        : 'every ERROR item carries a message',
      'fail',
    ),
  );

  const lies = items
    .filter(c => c.status === 'OK' && SERVICES[c.id] && c.id !== 'gluesync-conductor')
    .filter(c => {
      const now = post.byService[c.id];
      return now?.state !== 'running' || now.health === 'unhealthy' || now.tag !== target[c.id] || (plan.crashImages || []).includes(c.id);
    })
    .map(c => {
      const now = post.byService[c.id];
      const where = now ? `${describeState(now)} on ${now.tag}, restarts ${now.restartCount}` : 'gone';
      return `${c.id} reported OK ("${c.message}") but is ${where}`;
    });
  out.push(result('errors', 'errors.ok-means-ok', lies.length === 0, lies.length ? [...new Set(lies)].join(' | ') : 'OK items match reality'));

  const refusals = updateCalls(it).filter(a => a.status >= 400);
  if (refusals.length) {
    out.push(
      result(
        'errors',
        'errors.refusal-status',
        false,
        refusals.map(a => `${a.label} -> HTTP ${a.status}: ${a.json?.error || ''} / ${String(a.json?.details || a.error || '').slice(0, 200)} (${a.ms}ms)`).join(' | '),
        'info',
      ),
    );
  }

  const slow = it.api
    .filter(a => !a.label.startsWith('update round') && !a.label.startsWith('session:') && !a.label.startsWith('full restart'))
    .filter(a => a.ms > 10000)
    .map(a => `${a.label} ${a.ms}ms`);
  out.push(result('errors', 'errors.read-latency', slow.length === 0, slow.length ? slow.join('; ') : 'reads under 10s', 'warn'));

  const transport = it.api.filter(a => a.status === 0).map(a => `${a.label}: ${a.error}`);
  out.push(result('errors', 'errors.transport', transport.length === 0, transport.length ? transport.join(' | ') : 'no dropped connections', 'warn'));
  return out;
};

// ---------------------------------------------------------------- resilience

// How often Docker restarted the conductor this iteration (a recreated container counts from zero).
const conductorRestarts = (cPre, cPost) => {
  if (!cPost) return 0;
  return cPre?.id === cPost.id ? cPost.restartCount - cPre.restartCount : cPost.restartCount;
};

const conductorCrashDetail = (cPost, restarts, expected) => {
  if (!cPost) return 'conductor is not running at the end of the iteration';
  if (restarts <= expected) return `conductor restarts by Docker: ${restarts} (expected ${expected})`;
  return `conductor process died and Docker restarted it ${restarts} time(s) (expected ${expected})`;
};

const resilienceChecks = x => {
  const { pre, post, plan, settled, corehubBefore, corehubAfter, it } = x;
  const out = [];
  out.push(
    result(
      'resilience',
      'resilience.converged',
      settled.ok,
      settled.ok ? `stack settled in ${Math.round(settled.ms / 1000)}s` : `did not settle in time: ${JSON.stringify(settled.last)}`,
    ),
  );

  const stuck = settled.last?.services === 503;
  out.push(result('resilience', 'resilience.update-mode-released', !stuck, stuck ? 'conductor still answers 503 "update in progress"' : 'update mode released'));

  const sockets = (corehubAfter?.modules || []).filter(m => m.tag === 'conductor');
  out.push(
    result(
      'resilience',
      'resilience.corehub-session',
      sockets.length === 1,
      sockets.length === 1 ? 'conductor holds exactly one CoreHub connection' : `conductor holds ${sockets.length} CoreHub connections`,
      sockets.length === 0 ? 'fail' : 'warn',
    ),
  );

  const cPre = pre.byService['gluesync-conductor'];
  const cPost = post.byService['gluesync-conductor'];
  const restarts = conductorRestarts(cPre, cPost);
  const expected = plan.expectConductorRestarts || 0;
  // The lines right before each restart of the same container: what it was doing when it died.
  // stdout and stderr of the startup banner can arrive out of order, so banner lines
  // are ignored when looking back.
  const banner = /^(SSL is enabled|SSL certificate verification|For Chrome|For Firefox|- Certificate file|- Key file)/;
  const logs = x.conductorLogs.filter(l => !banner.test(l.line) || l.line.startsWith('SSL is enabled'));
  const lastWords = logs
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => i > 0 && l.line.startsWith('SSL is enabled') && logs[i - 1].incarnation === l.incarnation)
    .map(({ i }) => logs.slice(Math.max(0, i - 3), i).map(p => p.line.slice(0, 300)));
  out.push(
    result(
      'resilience',
      'resilience.conductor-no-crash',
      restarts <= expected && (!!cPost || plan.conductorMayDie),
      conductorCrashDetail(cPost, restarts, expected),
      'fail',
      lastWords.length ? lastWords : undefined,
    ),
  );
  // Only real restarts count: startup lines on stdout/stderr can interleave.
  if (lastWords.length && restarts > 0) {
    // A SIGKILL the profile delivers on purpose cannot be logged; anything beyond that should be.
    const silent = lastWords.filter(w => !w.some(line => /"level":(50|60)/.test(line))).slice(expected);
    out.push(
      result(
        'logging',
        'logging.exit-is-logged',
        silent.length === 0,
        silent.length
          ? `conductor exited ${silent.length} time(s) without an error line; last line before exit: ${silent[0][silent[0].length - 1]}`
          : 'every exit was preceded by an error line',
        'fail',
      ),
    );
  }

  const coreHubUpdated = pre.byService['gluesync-core-hub']?.tag !== post.byService['gluesync-core-hub']?.tag;
  const starts = (corehubAfter?.stats?.starts || 0) - (corehubBefore?.stats?.starts || 0);
  const expectedStarts = (coreHubUpdated ? 1 : 0) + (plan.extraCoreHubStarts || 0);
  out.push(
    result(
      'resilience',
      'resilience.corehub-restarts',
      starts <= expectedStarts,
      `CoreHub process started ${starts} time(s) this iteration, expected ${expectedStarts} (pipelines stop on every CoreHub restart)`,
      'warn',
    ),
  );

  it.metrics.coreHubStarts = starts;
  return out;
};

// ---------------------------------------------------------------- logging

const SECRET_PATTERNS = () => [
  ['proxy password', new RegExp(env.proxyPass.replaceAll('-', String.raw`\-`))],
  ['license content', new RegExp(env.licenseText)],
  ['user session token', /sess-[0-9a-f]{8}-[0-9a-f]{4}/],
  ['CoreHub module token', /mod-conductor-\d{10,}/],
  ['Authorization header value', /Bearer\s+[A-Za-z0-9._-]{8,}/],
];

const fileLogDetail = (fileLog, replaced, resetOnRecreate) => {
  if (resetOnRecreate) {
    return `conductor file log ${fileLog.path} restarted at ${fileLog.firstTs} after the container was recreated: earlier history is gone`;
  }
  if (!fileLog.exists) return `no conductor file log at ${fileLog.path}`;
  return `file log ${fileLog.path}: ${fileLog.lines} lines${replaced ? ', kept across the recreate' : ''}`;
};

const loggingChecks = x => {
  const { it, conductorLogs } = x;
  const out = [];
  out.push(result('logging', 'logging.captured', conductorLogs.length > 0, `${conductorLogs.length} conductor log lines this iteration`));

  const leaks = SECRET_PATTERNS()
    .map(([what, re]) => {
      const hits = conductorLogs.filter(l => re.test(l.line));
      return hits.length ? { what, count: hits.length, sample: hits[0].line.replace(re, '<REDACTED>').slice(0, 240) } : null;
    })
    .filter(Boolean);
  const leakList = leaks.map(l => `${l.what} x${l.count}`).join(', ');
  out.push(
    result(
      'logging',
      'logging.no-secrets',
      leaks.length === 0,
      leaks.length ? `secrets in conductor logs: ${leakList}` : 'no secrets found in logs',
      'fail',
      leaks.length ? leaks : undefined,
    ),
  );

  const parsed = conductorLogs.map(l => {
    try {
      return l.line.startsWith('{') ? JSON.parse(l.line) : null;
    } catch {
      return null;
    }
  });
  const json = parsed.filter(Boolean);
  const timeKinds = new Set(json.map(j => typeof j.time));
  it.metrics.logLines = conductorLogs.length;
  it.metrics.logJsonRatio = conductorLogs.length ? +(json.length / conductorLogs.length).toFixed(2) : null;
  out.push(
    result(
      'logging',
      'logging.single-format',
      timeKinds.size <= 1 && json.length === conductorLogs.length,
      `${json.length}/${conductorLogs.length} lines are JSON; "time" field types: ${[...timeKinds].join(', ') || 'none'}`,
      'info',
    ),
  );

  const emptied = json.filter(j => j.level >= 40 && j.error && typeof j.error === 'object' && !Object.keys(j.error).length);
  out.push(
    result(
      'logging',
      'logging.error-details',
      emptied.length === 0,
      emptied.length
        ? `${emptied.length} warn/error lines carry "error":{} (Error objects under the "error" key serialize empty), e.g. ${[...new Set(emptied.map(j => j.msg))].slice(0, 4).join(' | ')}`
        : 'errors keep their message',
      'fail',
    ),
  );

  const errors = {};
  json.filter(j => j.level >= 50).forEach(j => {
    const urlSuffix = j.url ? ` ${j.url}` : '';
    const key = `${j.msg}${urlSuffix}`.slice(0, 160);
    errors[key] = (errors[key] || 0) + 1;
  });
  const top = Object.entries(errors).sort((a, b) => b[1] - a[1]);
  it.metrics.logErrors = top.reduce((n, [, c]) => n + c, 0);
  if (top.length) out.push(result('logging', 'logging.error-lines', false, top.slice(0, 6).map(([m, c]) => `${c}x ${m}`).join(' | '), 'info'));

  // Requests the conductor accepted but never answered, per incarnation.
  const open = new Map();
  conductorLogs.forEach((l, i) => {
    const j = parsed[i];
    if (!j?.reqId) return;
    const key = `${l.incarnation}:${j.reqId}`;
    if (j.msg === 'incoming request') open.set(key, { url: j.req?.url, method: j.req?.method, incarnation: l.incarnation });
    if (j.msg === 'request completed') open.delete(key);
  });
  const unanswered = [...open.values()].map(r => `${r.method} ${r.url} (incarnation ${r.incarnation})`);
  out.push(
    result(
      'logging',
      'logging.requests-complete',
      unanswered.length === 0,
      unanswered.length ? `requests with no "request completed" line: ${unanswered.join('; ')}` : 'every request has a completion line',
      'warn',
    ),
  );

  // 503 "CoreHub unavailable" / "updating" are expected states, logged at warn.
  const failedUpdates = updateCalls(it).filter(a => a.status >= 500 && a.status !== 503);
  const errorLogged = conductorLogs.some(l => /Error do containers action|failed|error/i.test(l.line) && /"level":50/.test(l.line));
  if (failedUpdates.length) {
    out.push(
      result(
        'logging',
        'logging.failures-logged',
        errorLogged,
        errorLogged ? 'failed update requests have error-level log lines' : 'update requests failed but nothing was logged at error level',
        'warn',
      ),
    );
  }

  if (x.fileLog) {
    const replaced = x.pre.byService['gluesync-conductor']?.id !== x.post.byService['gluesync-conductor']?.id;
    const resetOnRecreate = replaced && x.fileLog.firstTs && x.fileLog.firstTs >= it.startedAt;
    out.push(
      result(
        'logging',
        'logging.file-log-survives-recreate',
        !resetOnRecreate && x.fileLog.exists,
        fileLogDetail(x.fileLog, replaced, resetOnRecreate),
      ),
    );
  }
  return out;
};

export const runChecks = x => [...stackChecks(x), ...apiChecks(x), ...resilienceChecks(x), ...loggingChecks(x)];
