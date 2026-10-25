import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type Docker from 'dockerode';

import loadWithStubs from '../../../testing/loadWithStubs';
import type { AwaitDecidedOrchestrator } from './awaitDecidedOrchestrator.model';

const here = (p: string): string => path.resolve(__dirname, p);

const load = (answers: ReadonlyArray<unknown>) => {
  const asked: number[] = [];
  const awaitDecided = loadWithStubs<{ default: AwaitDecidedOrchestrator }>(
    here('./awaitDecidedOrchestrator'),
    {
      [here('../getOrchestrator/getOrchestrator')]: {
        getDecidedOrchestrator: async () => {
          asked.push(asked.length);
          return answers[Math.min(asked.length - 1, answers.length - 1)];
        },
      },
      [here('../../../utils/logger')]: {
        getLogger: () => ({ warn: () => undefined }),
      },
    },
  ).default;

  return { awaitDecided, asked };
};

const docker = {} as Docker;

// A clock that only moves when the code sleeps
const fakeTime = () => {
  const state = { at: 0 };
  const sleeps: number[] = [];

  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      state.at += ms;
    },
    now: () => state.at,
  };
};

describe('awaitDecidedOrchestrator', () => {
  it('answers at once when the mode is already known', async () => {
    const { awaitDecided, asked } = load([{ mode: 'compose' }]);
    const time = fakeTime();

    assert.deepEqual(await awaitDecided(docker, time), { mode: 'compose' });
    assert.equal(asked.length, 1);
    assert.deepEqual(time.sleeps, []);
  });

  it('retries with a growing pause until Docker answers', async () => {
    const { awaitDecided, asked } = load([
      undefined,
      undefined,
      undefined,
      { mode: 'compose' },
    ]);
    const time = fakeTime();

    assert.deepEqual(await awaitDecided(docker, time), { mode: 'compose' });
    assert.equal(asked.length, 4);
    assert.deepEqual(time.sleeps, [1000, 2000, 4000]);
  });

  it('gives up after the maximum wait', async () => {
    const { awaitDecided } = load([undefined]);
    const time = fakeTime();

    assert.equal(
      await awaitDecided(docker, { ...time, maxWaitMs: 10_000 }),
      undefined,
    );
    assert.equal(
      time.sleeps.reduce((sum, ms) => sum + ms, 0),
      10_000,
    );
  });

  it('caps the pause', async () => {
    const { awaitDecided } = load([undefined]);
    const time = fakeTime();

    await awaitDecided(docker, { ...time, maxWaitMs: 60_000 });

    assert.ok(Math.max(...time.sleeps) <= 8000);
  });
});
