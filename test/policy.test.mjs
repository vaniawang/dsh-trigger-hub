import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey, shouldFire, recordFire, finishRun, activeRuns } from '../src/policy.js';

const baseState = () => ({ runs: [], dedupe: {}, counters: { fired: 0, failed: 0, deduped: 0 }, paused: false });

test('dedupeKey is stable and payload-sensitive', () => {
  assert.equal(dedupeKey('ci', { id: '42' }), dedupeKey('ci', { id: '42' }));
  assert.notEqual(dedupeKey('ci', { id: '42' }), dedupeKey('ci', { id: '43' }));
  assert.notEqual(dedupeKey('ci', { id: '42' }), dedupeKey('pr', { id: '42' }));
});

test('shouldFire honours enabled, pause, quiet hours and duplicate window', () => {
  const now = new Date('2026-11-02T10:00:00');
  assert.deepEqual(shouldFire({ id: 'a', dedupeKey: 'k' }, baseState(), {}, now), { ok: true });
  assert.equal(shouldFire({ id: 'a', enabled: false }, baseState(), {}, now).reason, 'disabled');

  const paused = { ...baseState(), paused: true };
  assert.equal(shouldFire({ id: 'a' }, paused, {}, now).reason, 'paused');

  const quiet = { id: 'a', quietHours: { from: '09:00', to: '18:00' } };
  assert.equal(shouldFire(quiet, baseState(), {}, now).reason, 'quiet');

  const state = baseState();
  Object.assign(state, recordFire(state, { sourceId: 'a', kind: 'webhook', key: 'k', at: now.toISOString(), runId: 'r1', sink: 'session' }));
  assert.equal(shouldFire({ id: 'a', dedupeKey: 'k' }, state, { dedupeWindowMs: 60_000 }, now).reason, 'duplicate');
  const later = new Date(now.getTime() + 61_000);
  assert.equal(shouldFire({ id: 'a', dedupeKey: 'k' }, state, { dedupeWindowMs: 60_000 }, later).ok, true);
});

test('concurrency limit counts running runs only', () => {
  let state = baseState();
  state = recordFire(state, { sourceId: 'a', kind: 'webhook', key: 'k1', at: new Date().toISOString(), runId: 'r1', sink: 'session' });
  state = finishRun(state, 'r1', 'done');
  assert.equal(activeRuns(state), 0);
  state = recordFire(state, { sourceId: 'a', kind: 'webhook', key: 'k2', at: new Date().toISOString(), runId: 'r2', sink: 'session' });
  assert.equal(activeRuns(state), 1);
  assert.equal(shouldFire({ id: 'a' }, state, { concurrency: 1 }).reason, 'concurrency');
  assert.equal(shouldFire({ id: 'a' }, state, { concurrency: 2 }).ok, true);
});

test('recordFire caps the ledger and increments counters', () => {
  let state = baseState();
  for (let index = 0; index < 210; index += 1) {
    state = recordFire(state, { sourceId: 'a', kind: 'webhook', key: String(index), at: new Date().toISOString(), runId: 'r' + index, sink: 'session' });
  }
  assert.equal(state.runs.length, 200);
  assert.equal(state.counters.fired, 210);
  const failed = finishRun(state, 'r209', 'failed', 'boom');
  assert.equal(failed.counters.failed, 1);
});
