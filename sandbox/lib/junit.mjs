// JUnit XML for CI (GitLab shows it as the pipeline's test report). One <testsuite> per run,
// one <testcase> per iteration (named after the profile) or per enospc case.
//
// A case is { name, time (seconds), failure?: { type, message, text }, out? }.
// A failure becomes <failure>; `out` becomes <system-out> (WARN checks, notes).

import fs from 'node:fs';
import path from 'node:path';

// XML 1.0 forbids most control characters, even escaped.
const INVALID_XML = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;
const esc = value =>
  String(value ?? '')
    .replaceAll(INVALID_XML, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const clip = (text, max = 8000) => (text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters]` : text);

const testcase = (classname, c) => {
  const open = `    <testcase classname="${esc(classname)}" name="${esc(c.name)}" time="${(c.time || 0).toFixed(3)}"`;
  const body = [
    c.failure ? `      <failure type="${esc(c.failure.type)}" message="${esc(c.failure.message)}">${esc(clip(c.failure.text || ''))}</failure>` : null,
    c.out ? `      <system-out>${esc(clip(c.out))}</system-out>` : null,
  ].filter(Boolean);
  return body.length ? [`${open}>`, ...body, '    </testcase>'].join('\n') : `${open}/>`;
};

export const writeJunit = (dir, { suite, classname, startedAt, cases }) => {
  const failures = cases.filter(c => c.failure).length;
  const time = cases.reduce((sum, c) => sum + (c.time || 0), 0).toFixed(3);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${esc(suite)}" tests="${cases.length}" failures="${failures}" errors="0" time="${time}">`,
    `  <testsuite name="${esc(suite)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="0" time="${time}" timestamp="${esc(startedAt.slice(0, 19))}">`,
    ...cases.map(c => testcase(classname, c)),
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
  const file = path.join(dir, 'junit.xml');
  fs.writeFileSync(file, xml);
  return file;
};

// One case per iteration. FAIL (a failed check or a runner error) is a <failure>; WARN passes
// and lists its warnings in <system-out>.
export const iterationCases = run =>
  run.iterations.map(it => {
    const failed = it.checks.filter(c => c.severity === 'fail');
    const warned = it.checks.filter(c => c.severity === 'warn');
    const line = c => `- [${c.area}] ${c.id}: ${c.detail}`;
    const evidence = c => (c.evidence === undefined ? '' : `\n    evidence: ${JSON.stringify(c.evidence).slice(0, 1500)}`);
    const failure =
      it.outcome === 'fail'
        ? {
            type: it.error && !failed.length ? 'RunnerError' : 'CheckFailed',
            message: it.error && !failed.length ? it.error.split('\n')[0] : `failed checks: ${failed.map(c => c.id).join(', ')}`,
            text: [
              ...(it.error ? [`runner error:\n${it.error}`] : []),
              ...(failed.length ? ['failed checks:', ...failed.map(c => line(c) + evidence(c))] : []),
            ].join('\n'),
          }
        : undefined;
    const out = [
      `${it.description}`,
      ...(warned.length ? ['warnings:', ...warned.map(line)] : []),
      ...(it.notes?.length ? ['notes:', ...it.notes.map(n => `- ${n}`)] : []),
    ].join('\n');
    return { name: it.profile, time: (it.durationMs || 0) / 1000, failure, out };
  });
