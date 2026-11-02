import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, defaultState } from '../src/store.js';

test('store persists across instances and keeps the last 200 runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-store-'));
  const first = createStore({ dir });
  await first.ready();
  await first.transact((state) => {
    state.paused = true;
    state.counters.fired = 3;
    for (let index = 0; index < 210; index += 1) {
      state.runs.push({ runId: 'r' + index, sourceId: 'a', status: 'done', at: new Date().toISOString() });
    }
  });
  assert.equal(first.read().runs.length, 210);
  await first.close();

  const second = createStore({ dir });
  await second.ready();
  assert.equal(second.read().paused, true);
  assert.equal(second.read().counters.fired, 3);
  assert.equal(second.read().runs.length, 200);
  await fs.rm(dir, { recursive: true, force: true });
});

test('store rebuilds a corrupt file instead of crashing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-store-'));
  await fs.writeFile(path.join(dir, 'state.json'), '{ not json', 'utf8');
  const store = createStore({ dir });
  await store.ready();
  assert.deepEqual(store.read().counters, defaultState().counters);
  const files = await fs.readdir(dir);
  assert.ok(files.some((name) => name.startsWith('state.json.corrupt-')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('transact serializes concurrent writers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-store-'));
  const store = createStore({ dir });
  await store.ready();
  await Promise.all(Array.from({ length: 10 }, () => store.transact((state) => { state.counters.fired += 1; })));
  assert.equal(store.read().counters.fired, 10);
  await fs.rm(dir, { recursive: true, force: true });
});
