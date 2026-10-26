// Watches the compose file while an iteration runs, so a blank or broken file is
// caught even when the conductor repairs it a moment later. Every sample is judged
// on its own: non-empty, valid YAML, and every service of the kit present.
//
// Reads the host copy of the file by default. While a disk fault is active the
// conductor sees a different file (a tmpfs copy bind-mounted over the single-file
// mount), and lib/diskFault.mjs feeds that one in through `push` instead.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env, SERVICES } from './env.mjs';

// What is wrong with this compose text, or null when it is usable.
export const composeProblem = text => {
  if (!text.trim()) return 'blank';
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    return `unparseable: ${e.message.split('\n')[0]}`;
  }
  const services = parsed?.services;
  if (!services || typeof services !== 'object') return 'no services mapping';
  const missing = Object.keys(SERVICES).filter(s => !services[s]);
  return missing.length ? `missing services: ${missing.join(', ')}` : null;
};

const MAX_EVIDENCE = 20;
const HARD_PROBLEM = /^(blank|file unreadable)/;

export class ComposeSampler {
  constructor({ file = path.join(env.kitDir, 'docker-compose.yml'), intervalMs = 25 } = {}) {
    this.file = file;
    this.intervalMs = intervalMs;
    this.samples = 0;
    this.torn = 0;
    this.badCount = 0;
    this.bad = [];
    this.pending = null;
    this.timer = null;
    // paused: the profile damages the file on purpose. external: another reader
    // (the disk fault's stream) supplies the samples.
    this.paused = false;
    this.external = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  pause() {
    this.paused = true;
    this.pending = null;
  }

  resume() {
    this.paused = false;
  }

  tick() {
    if (this.paused || this.external) return;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      this.push('', 'host', `file unreadable: ${e.code || e.message}`);
      return;
    }
    this.push(text, 'host');
  }

  // A read that catches a write half way through looks broken once and is fine at
  // the next sample; that is a torn read of an in-flight update, not a bad file.
  // An empty or missing file is never excused. Two broken samples in a row are real.
  push(text, source, knownProblem) {
    const problem = knownProblem || composeProblem(text);
    this.samples += 1;
    if (this.pending) {
      if (HARD_PROBLEM.test(this.pending.problem) || problem) this.addBad(this.pending);
      else this.torn += 1;
      this.pending = null;
    }
    if (problem) {
      this.pending = { at: new Date().toISOString(), source, size: Buffer.byteLength(text), problem, head: text.slice(0, 120) };
    }
  }

  addBad(sample) {
    if (this.bad.length < MAX_EVIDENCE) this.bad.push(sample);
    this.badCount += 1;
  }

  finish() {
    clearInterval(this.timer);
    if (this.pending) this.addBad(this.pending);
    this.pending = null;
    return { samples: this.samples, torn: this.torn, badCount: this.badCount, bad: this.bad, intervalMs: this.intervalMs };
  }
}
