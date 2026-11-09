// log-upload-voucher: "collect logs" with a support voucher, against the fake support portal the fake
// backoffice serves (fakes/fake.mjs, createSupportPortal) and reached through the conductor's own
// PROXY_HTTPS, like api.backoffice.molo17.com. The archive goes up in parts while the portal's S3 drops one
// part and answers another with an expired link; every refusal the contract names is tried too.
//
// The hook records `it.logUpload.steps` ({ id, ok, detail, severity? }), turned into checks by logUploadChecks.

import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.mjs';
import { backofficeAdmin } from './setup.mjs';
import { callConductor, containers } from './stack.mjs';
import { docker, inSequence } from './util.mjs';

// The vouchers the fake portal knows (fake.mjs VOUCHERS)
const VALID = 'GSV-SBX0-0000-0001';
const REVOKED = 'GSV-SBX0-0000-0002';
const EXPIRED = 'GSV-SBX0-0000-0003';
const TICKET = 'GSSD-4242';
// Small parts, so that even a small archive goes up in several
const PART_BYTES = 16 * 1024;
const COLLECT_TIMEOUT_MS = 600000;
// Any voucher of the fake portal, typed in any case and with or without dashes
const VOUCHER_IN_LOG = /sbx0-?0000-?000\d/i;

const step = (it, id, ok, detail, severity) => {
  it.logUpload ||= { steps: [] };
  it.logUpload.steps.push({ id, ok: !!ok, detail, ...(severity ? { severity } : {}) });
  it.notes.push(`${id}: ${ok ? 'ok' : 'NOT ok'}, ${detail}`);
};

const portalState = async () => (await backofficeAdmin('/__sandbox/portal/state')).json ?? { requests: [], uploads: [] };
const configure = body => backofficeAdmin('/__sandbox/portal', body);

const collect = (ctx, it, label, body) =>
  callConductor(it, label, 'POST', '/collect-logs', { token: ctx.adminToken, body, timeoutMs: COLLECT_TIMEOUT_MS });

// The portal requests a call made: what came in after `before` requests had been recorded
const newRequests = async before => (await portalState()).requests.slice(before);

const fetchUpload = async id => {
  const res = await fetch(`http://127.0.0.1:${env.ports.backofficeAdmin}/__sandbox/portal/file?id=${encodeURIComponent(id)}`, {
    headers: { 'x-sandbox-admin': env.adminToken },
  });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
};

const archiveKind = bytes => {
  if (!bytes || bytes.length < 6) return null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
  if (bytes.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  return null;
};

// Lists the archive the portal received with the tar of the conductor image (GNU tar with gzip, zstd and
// xz), through the kit folder the conductor mounts.
const listArchive = async bytes => {
  const name = `.sbx-portal-upload-${Date.now()}`;
  const hostFile = path.join(env.kitDir, name);
  fs.writeFileSync(hostFile, bytes);
  try {
    const conductor = (await containers()).find(c => c.service === 'gluesync-conductor' && c.state === 'running');
    const r = await docker(['exec', conductor.id, 'tar', '-tf', `/opt/gluesync-conductor/root-folder/${name}`]);
    return r.code === 0 ? r.out.split('\n').filter(Boolean) : null;
  } finally {
    fs.rmSync(hostFile, { force: true });
  }
};

const ops = requests => requests.map(r => `${r.op ?? r.method}${r.part ? `:${r.part}` : ''}=${r.status ?? 'dropped'}`).join(' ');

// The happy path, with a dropped part and an expired link on the way
const uploadWithVoucher = async (ctx, it) => {
  await configure({
    reset: true,
    partBytes: PART_BYTES,
    faults: [
      { op: 'put', part: 2, action: 'destroy', times: 1 },
      { op: 'put', part: 3, action: 'status', status: 403, body: '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', times: 1 },
    ],
  });
  // As a person pastes it: lower case, spaces around
  const res = await collect(ctx, it, 'logs: collect with a voucher', { voucher: `  ${VALID.toLowerCase()} ` });
  const state = await portalState();
  const body = res.json ?? {};
  const upload = state.uploads.find(u => u.ticketKey === TICKET && u.completed) ?? state.uploads.at(-1);
  step(
    it,
    'logs.voucher-upload-ok',
    res.status === 200 && body.success && body.uploadedVia === 'portal' && body.ticketKey === TICKET && body.verified === true && !body.archivePath,
    `HTTP ${res.status}: uploadedVia ${body.uploadedVia}, ticket ${body.ticketKey}, size ${body.size}, verified ${body.verified}, archivePath ${body.archivePath ?? 'none'}${res.status === 200 ? '' : ` / ${body.error ?? res.error} ${body.code ?? ''} ${body.details ?? ''}`}`,
  );
  if (!upload) {
    step(it, 'logs.portal-received', false, `the portal saw no upload (${ops(state.requests)})`);
    return;
  }
  const partCount = Object.keys(upload.parts).length;
  step(
    it,
    'logs.portal-received',
    upload.completed && !upload.aborted && upload.verified && upload.multipart && partCount === upload.count && upload.size === upload.declared && upload.size === body.size,
    `upload ${upload.id}: ${upload.count} part(s) of ${PART_BYTES} bytes, ${partCount} stored, declared ${upload.declared}, joined ${upload.size}, completed ${upload.completed}, aborted ${upload.aborted}`,
  );
  const unused = state.faults.filter(f => (f.times ?? 1) > 0);
  const puts = n => state.requests.filter(r => r.op === 'put' && r.part === String(n));
  const recovered = unused.length === 0 && puts(2).length >= 2 && puts(3).length >= 2 && state.requests.some(r => r.op === 'links');
  step(
    it,
    'logs.part-faults-recovered',
    recovered,
    unused.length
      ? `the archive had ${upload.count} part(s): ${unused.length} injected fault(s) never fired`
      : `part 2 dropped once and sent ${puts(2).length} times, part 3 refused as expired once, sent ${puts(3).length} times after ${state.requests.filter(r => r.op === 'links').length} fresh link request(s)`,
  );
  const api = state.requests.filter(r => r.path.startsWith('/support-api'));
  const s3 = state.requests.filter(r => r.path.startsWith('/sbx-s3'));
  const leaks = [
    ...api.filter(r => r.voucherHeader !== VALID).map(r => `${r.op} header ${r.voucherHeader ?? 'missing'}`),
    ...s3.filter(r => r.voucherHeader).map(r => `S3 PUT ${r.part} carried the voucher header`),
    ...state.requests.filter(r => r.voucherInUrl || r.voucherInBody).map(r => `${r.op} has the voucher in its ${r.voucherInUrl ? 'URL' : 'body'}`),
  ];
  step(it, 'logs.voucher-only-in-header', leaks.length === 0, leaks.length ? leaks.join('; ') : `normalized voucher in X-Gluesync-Voucher on all ${api.length} portal calls, never on the ${s3.length} S3 PUTs, never in a URL or body`);

  const bytes = await fetchUpload(upload.id);
  const kind = archiveKind(bytes);
  const entries = kind ? await listArchive(bytes) : null;
  const wanted = ['gluesync-conductor', 'gluesync-core-hub'];
  const missing = wanted.filter(w => !entries?.some(e => e.includes(w)));
  step(
    it,
    'logs.archive-readable',
    !!kind && !!entries && missing.length === 0,
    !kind
      ? `the bytes the portal joined are not an archive (${bytes?.subarray(0, 8).toString('hex') ?? 'nothing'})`
      : `${kind} archive of ${bytes.length} bytes, ${entries?.length ?? 'unreadable:'} entries${missing.length ? `, nothing for ${missing.join(', ')}` : `, logs of ${wanted.join(' and ')} inside`}`,
  );
};

// Every refusal of the contract, each with what it may and may not have done at the portal
const refusals = async (ctx, it) => {
  const cases = [
    { id: 'logs.voucher-format-refused', body: { voucher: 'GSV-1234' }, status: 400, code: 'voucher_format', portalOps: [] },
    { id: 'logs.voucher-with-email-refused', body: { voucher: VALID, email: 'someone@example.com' }, status: 400, code: 'validation', portalOps: [] },
    { id: 'logs.voucher-revoked-refused', body: { voucher: REVOKED }, status: 400, code: 'voucher_invalid', portalOps: ['check'] },
    { id: 'logs.voucher-expired-refused', body: { voucher: EXPIRED }, status: 400, code: 'voucher_expired', portalOps: ['check'] },
  ];
  await configure({ reset: true });
  // One at a time, so that each sees only its own portal calls
  await inSequence(cases, async c => {
    const before = (await portalState()).requests.length;
    const res = await collect(ctx, it, `logs: ${c.id.replace('logs.', '')}`, c.body);
    const seen = await newRequests(before);
    const seenOps = [...new Set(seen.map(r => r.op))];
    const ok = res.status === c.status && res.json?.code === c.code && seenOps.every(o => c.portalOps.includes(o));
    step(it, c.id, ok, `HTTP ${res.status} code ${res.json?.code ?? 'none'} in ${res.ms}ms (${res.json?.error ?? ''}); portal calls: ${seen.length ? ops(seen) : 'none'}`);
  });

  // An archive bigger than the portal takes: refused before any byte goes up, and kept on the host
  await configure({ reset: true, maxBytes: 1024 });
  const res = await collect(ctx, it, 'logs: archive too large', { voucher: VALID });
  const seen = await newRequests(0);
  step(
    it,
    'logs.too-large-refused',
    res.status === 400 && res.json?.code === 'file_too_large' && res.json?.maxBytes === 1024 && !seen.some(r => r.op === 'put'),
    `HTTP ${res.status} code ${res.json?.code ?? 'none'}, maxBytes ${res.json?.maxBytes}, details ${String(res.json?.details ?? '').slice(0, 160)}; portal calls: ${ops(seen)}`,
  );
  await configure({ reset: true });
};

export const logUploadWithVoucher = async (ctx, it) => {
  try {
    await uploadWithVoucher(ctx, it);
    await refusals(ctx, it);
  } finally {
    await configure({ reset: true });
  }
};

export const logUploadChecks = (it, conductorLogs) => {
  const steps = [...(it.logUpload?.steps || [])];
  if (!steps.length) steps.push({ id: 'logs.evidence', ok: false, detail: 'the profile recorded nothing' });
  const hits = conductorLogs.filter(l => VOUCHER_IN_LOG.test(l.line));
  steps.push({
    id: 'logs.voucher-not-logged',
    ok: hits.length === 0,
    detail: hits.length ? `${hits.length} conductor log line(s) carry a voucher: ${hits[0].line.replace(VOUCHER_IN_LOG, '<VOUCHER>').slice(0, 200)}` : 'no voucher in the conductor log',
  });
  return steps;
};
