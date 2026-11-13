import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import createPausedPipelinesStore from './pausedPipelinesStore';

const dir = { path: '' };

beforeEach(async () => {
  dir.path = await mkdtemp(join(tmpdir(), 'paused-pipelines-'));
});

afterEach(async () => {
  await rm(dir.path, { recursive: true, force: true });
});

const fileIn = (...parts: string[]) => join(dir.path, ...parts);

describe('pausedPipelinesStore', () => {
  it('reads nothing when no update paused anything', async () => {
    const store = createPausedPipelinesStore(async () => fileIn('x.json'));
    assert.equal(await store.read(), null);
  });

  it('writes the record (creating its folder), reads it back and clears it', async () => {
    const path = fileIn('.conductor', 'update-paused-pipelines.json');
    const store = createPausedPipelinesStore(async () => path);
    const record = {
      pausedAt: '2026-11-12T10:00:00.000Z',
      pipelineIds: ['p1', 'p2'],
    };

    await store.write(record);

    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
    assert.deepEqual(await store.read(), record);
    await store.clear();
    assert.equal(await store.read(), null);
    // Clearing twice is fine
    await store.clear();
  });

  it('ignores a damaged file instead of failing the update', async () => {
    const path = fileIn('broken.json');
    await writeFile(path, '{"pipelineIds": [');
    const store = createPausedPipelinesStore(async () => path);
    assert.equal(await store.read(), null);
  });

  it('keeps only string ids', async () => {
    const path = fileIn('odd.json');
    await writeFile(path, JSON.stringify({ pipelineIds: ['p1', 7, '', null] }));
    const store = createPausedPipelinesStore(async () => path);
    assert.deepEqual(await store.read(), { pausedAt: '', pipelineIds: ['p1'] });
  });
});
