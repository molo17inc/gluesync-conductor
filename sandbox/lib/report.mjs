import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './util.mjs';

const AREAS = ['stack', 'compose', 'errors', 'resilience', 'session', 'logging'];
const AREA_TITLES = { compose: 'compose (docker-compose.yml rewrites, never-blank, last-good backup, disk faults)' };
const SEVERITY_ORDER = { fail: 0, warn: 1, info: 2 };

const pct = (arr, p) => {
  const s = arr.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const secs = ms => (typeof ms === 'number' ? `${Math.round(ms / 1000)}s` : '—');

// Groups every non-passing check across iterations into findings.
export const findings = run => {
  const byId = new Map();
  run.iterations.forEach((it, k) =>
    it.checks
      .filter(c => c.severity !== 'pass')
      .forEach(c => {
        const f = byId.get(c.id) || { id: c.id, area: c.area, severity: c.severity, occurrences: 0, profiles: new Set(), iterations: [], samples: [] };
        f.occurrences += 1;
        f.profiles.add(it.profile);
        f.iterations.push(k + 1);
        if (SEVERITY_ORDER[c.severity] < SEVERITY_ORDER[f.severity]) f.severity = c.severity;
        if (f.samples.length < 3 && !f.samples.some(s => s.detail === c.detail)) f.samples.push({ iteration: k + 1, profile: it.profile, detail: c.detail, evidence: c.evidence });
        byId.set(c.id, f);
      }),
  );
  return [...byId.values()]
    .map(f => ({ ...f, profiles: [...f.profiles] }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.occurrences - a.occurrences);
};

export const writeReport = (dir, run) => {
  const its = run.iterations;
  const all = findings(run);
  const metric = key => its.map(it => it.metrics?.[key]);
  const summary = {
    iterations: its.length,
    pass: its.filter(i => i.outcome === 'pass').length,
    warn: its.filter(i => i.outcome === 'warn').length,
    fail: its.filter(i => i.outcome === 'fail').length,
    conductorSelfUpdate: { p50: pct(metric('conductorSelfUpdateMs'), 50), max: pct(metric('conductorSelfUpdateMs'), 100) },
    updateDuration: { p50: pct(metric('updateMs'), 50), max: pct(metric('updateMs'), 100) },
    memMiB: metric('memMiB'),
    fds: metric('fds'),
    logErrors: metric('logErrors'),
    composeSamples: its.reduce((n, it) => n + (it.sampler?.samples || 0), 0),
    composeBadSamples: its.reduce((n, it) => n + (it.sampler?.badCount || 0), 0),
  };
  writeJson(path.join(dir, 'report.json'), { ...run, summary, findings: all });

  const finished = run.finishedAt ? `, finished ${run.finishedAt}` : ' (in progress)';
  const lines = [
    `# Conductor sandbox run ${path.basename(dir)}`,
    '',
    `Seed ${run.seed}. ${its.length} iteration(s): **${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail**. ` +
      `Started ${run.startedAt}${finished}.`,
    '',
    `Conductor self-update downtime: median ${secs(summary.conductorSelfUpdate.p50)}, worst ${secs(summary.conductorSelfUpdate.max)}. ` +
      `Full update (all rounds): median ${secs(summary.updateDuration.p50)}, worst ${secs(summary.updateDuration.max)}.`,
    '',
    `Conductor memory per iteration (MiB): ${summary.memMiB.map(v => v ?? '—').join(', ')}`,
    `Conductor open file descriptors: ${summary.fds.map(v => v ?? '—').join(', ')}`,
    `docker-compose.yml sampled ${summary.composeSamples} times (every ~25ms while an iteration runs): ${summary.composeBadSamples} blank or invalid.`,
    '',
  ];

  if (run.baseline && run.baseline.liveCommentLines < run.baseline.templateCommentLines) {
    lines.push(
      `Before any update, the conductor's startup healers had already rewritten the kit: ${run.baseline.templateCommentLines - run.baseline.liveCommentLines} of ${run.baseline.templateCommentLines} comment lines in the shipped compose file are gone.`,
      '',
    );
  }
  lines.push(
    '## Iterations',
    '',
    '| # | Profile | Expect | Outcome | Rounds | Self-update | Duration | Failed checks |',
    '|---|---|---|---|---|---|---|---|',
  );
  its.forEach((it, k) => {
    const failed = it.checks.filter(c => c.severity === 'fail').map(c => c.id);
    lines.push(
      `| ${k + 1} | ${it.profile} | ${it.expect} | ${it.outcome}${it.error ? ' (runner error)' : ''} | ${it.rounds
        .map(r => `${r.phase}:${(r.statuses || [r.error]).join('/')}`)
        .join(' → ')} | ${secs(it.metrics?.conductorSelfUpdateMs)} | ${secs(it.durationMs)} | ${failed.join(', ') || '—'} |`,
    );
  });
  lines.push('', '## Findings', '');
  AREAS.forEach(area => {
    const inArea = all.filter(f => f.area === area);
    if (!inArea.length) return;
    lines.push(`### ${AREA_TITLES[area] || area}`, '');
    inArea.forEach(f => {
      lines.push(`- **${f.severity.toUpperCase()} \`${f.id}\`**: ${f.occurrences}/${its.length} iterations (profiles: ${f.profiles.join(', ')})`);
      f.samples.forEach(s => lines.push(`  - it ${s.iteration} (${s.profile}): ${s.detail}`));
    });
    lines.push('');
  });

  const notes = its.flatMap((it, k) => (it.notes || []).map(n => `- it ${k + 1} (${it.profile}): ${n}`));
  if (notes.length) lines.push('## Runner notes', '', ...notes, '');
  const errors = its.filter(it => it.error).map((it, k) => `- it ${k + 1} (${it.profile}): ${it.error.split('\n')[0]}`);
  if (errors.length) lines.push('## Runner errors', '', ...errors, '');

  lines.push('## Profiles', '');
  [...new Map(its.map(it => [it.profile, it.description])).entries()].forEach(([n, d]) => lines.push(`- \`${n}\`: ${d}`));
  lines.push('', 'Per-iteration API transcripts, compose before/after, and log slices are in the `iter-*` folders.');

  const md = path.join(dir, 'report.md');
  fs.writeFileSync(md, `${lines.join('\n')}\n`);
  return { md };
};
