// Session handling checks: the conductor has no sessions of its own, it asks CoreHub
// (/authentication/me) and caches the answer. These probes run every iteration; the
// slow ones (revocation window, CoreHub outage, hang) only on "deep" iterations.

import { callConductor, corehub } from './stack.mjs';
import { sleep, waitFor } from './util.mjs';

const NONEXISTENT = '__sandbox_nonexistent_service__';

export const sessionSuite = async (it, { deep }) => {
  const results = [];
  const check = (id, ok, detail, severity = 'fail') =>
    results.push({ area: 'session', id, ok, severity: ok ? 'pass' : severity, detail });
  const call = (label, method, p, opts) => callConductor(it, `session: ${label}`, method, p, { timeoutMs: 20000, ...opts });

  const viewer = await corehub.login('viewer');
  const monitor = await corehub.login('monitor');
  const admin = await corehub.login('admin');

  const anon = await call('no credentials', 'GET', '/containers?type=all');
  check('session.anonymous-rejected', anon.status === 401, `GET /containers without credentials -> ${anon.status}`);

  const bogus = await call('unknown token', 'GET', '/services', { token: 'not-a-real-token' });
  check('session.unknown-token-rejected', bogus.status === 401, `unknown bearer token -> ${bogus.status}`);

  const viewerRead = await call('viewer read', 'GET', '/services', { token: viewer });
  check('session.viewer-can-read', viewerRead.status === 200, `VIEWER GET /services -> ${viewerRead.status}`);

  const viewerAction = await call('viewer action', 'POST', '/containers', {
    token: viewer,
    body: { action: 'restart', ids: [NONEXISTENT] },
  });
  check('session.viewer-cannot-control', viewerAction.status === 403, `VIEWER POST /containers -> ${viewerAction.status}`);

  const viewerConfig = await call('viewer config', 'PUT', '/env/legacy-update', { token: viewer, body: { enabled: false } });
  check('session.viewer-cannot-configure', viewerConfig.status === 403, `VIEWER PUT /env/legacy-update -> ${viewerConfig.status}`);

  // MONITOR may restart/start/stop (like start/stop replication) but not change
  // what is deployed. The id does not exist, so an allowed call changes nothing.
  const monitorRestart = await call('monitor restart', 'POST', '/containers', {
    token: monitor,
    body: { action: 'restart', ids: [NONEXISTENT] },
  });
  check('session.monitor-can-restart', monitorRestart.status === 200, `MONITOR restart -> ${monitorRestart.status}`);
  const monitorUpdate = await call('monitor update', 'POST', '/containers', {
    token: monitor,
    body: { action: 'undeploy', ids: [NONEXISTENT] },
  });
  check('session.monitor-cannot-undeploy', monitorUpdate.status === 403, `MONITOR undeploy -> ${monitorUpdate.status}`);

  const cookie = await call('cookie auth', 'GET', '/services', { cookie: `gs-auth=${admin}` });
  check('session.cookie-accepted', cookie.status === 200, `gs-auth cookie -> ${cookie.status}`);

  const shortLived = await corehub.login('admin', 2);
  await sleep(3500);
  const expired = await call('expired session', 'GET', '/services', { token: shortLived });
  check('session.expired-rejected', expired.status === 401, `session expired at CoreHub, first use -> ${expired.status}`);

  if (deep) {
    await deepSessionChecks(check, call, admin);
  }

  return results;
};

// The slow probes: revocation window, CoreHub auth failing, hanging or answering garbage.
const deepSessionChecks = async (check, call, admin) => {
  // Revocation: a token used once (and so cached), then logged out at CoreHub.
  const revoked = await corehub.login('admin');
  await call('pre-revoke use', 'GET', '/services', { token: revoked });
  await corehub.admin('/__sandbox/revoke', { token: revoked });
  const rejected = await waitFor(
    'revoked token rejected',
    async () => (await call('after revoke', 'GET', '/services', { token: revoked })).status === 401,
    { timeoutMs: 45000, intervalMs: 2000 },
  );
  const acceptedForMs = rejected.ok ? rejected.ms : null;
  check(
    'session.revocation-window',
    acceptedForMs !== null && acceptedForMs <= 7000,
    acceptedForMs === null
      ? 'revoked token still accepted after 45s'
      : `revoked token kept working for ${(acceptedForMs / 1000).toFixed(1)}s (introspection cache, CONDUCTOR_AUTH_CACHE_TTL)`,
    'warn',
  );

  // CoreHub /authentication/me failing: expect 503, never 401 (users would be told they are logged out).
  // The bearer token is used once first so it sits in the introspection cache.
  await call('warm cache', 'GET', '/services', { token: admin });
  await corehub.chaos({ auth: { mode: 'error500', until: Date.now() + 15000 } });
  const outageFresh = await call('auth 500, fresh token', 'GET', '/services', { token: await corehub.login('manager') });
  const outageCached = await call('auth 500, cached token', 'GET', '/services', { token: admin });
  await corehub.chaos({ auth: null });
  check('session.outage-is-503', outageFresh.status === 503, `CoreHub auth 500, uncached token -> ${outageFresh.status}`);
  check(
    'session.outage-cached-token',
    outageCached.status === 200,
    `CoreHub auth 500, cached token -> ${outageCached.status}`,
    'info',
  );

  // CoreHub hanging: the conductor must answer within its 5s introspection timeout.
  await corehub.chaos({ auth: { mode: 'hang', until: Date.now() + 20000 } });
  const hang = await call('auth hang, fresh token', 'GET', '/services', { token: await corehub.login('manager') });
  await corehub.chaos({ auth: null });
  check(
    'session.hang-bounded',
    hang.status === 503 && hang.ms < 8000,
    `CoreHub auth hanging -> ${hang.status || hang.error} after ${hang.ms}ms`,
  );

  // Garbage from CoreHub (HTML instead of JSON).
  await corehub.chaos({ auth: { mode: 'garbage', until: Date.now() + 10000 } });
  const garbage = await call('auth garbage', 'GET', '/services', { token: await corehub.login('manager') });
  await corehub.chaos({ auth: null });
  check('session.garbage-is-503', garbage.status === 503, `CoreHub auth returns HTML -> ${garbage.status}`);
};
