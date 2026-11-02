import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';

function fakeHost() {
  const sessions = new Map();
  const prompts = [];
  const created = [];
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent(id) {
            return sessions.has(id) ? { agent: sessions.get(id) } : { error: { code: 'session/not-found' } };
          },
          async create(options) {
            created.push(options);
            sessions.set(options.sessionId, { id: options.sessionId });
          },
          async prompt(message) {
            prompts.push(message);
          },
        };
      }
      if (name === 'workspaceRegistry') return { create: async (cwd) => ({ id: 'ws-' + path.basename(cwd) }) };
      return undefined;
    },
  };
  return { ctx, sessions, prompts, created };
}

test('a webhook source prompts a fresh session once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-runtime-'));
  const host = fakeHost();
  const runtime = await createRuntime(host.ctx, {
    stateDir: dir,
    dedupeWindowMs: 60_000,
    sources: [{ id: 'ci', kind: 'webhook', token: 'secret', prompt: 'CI: {{payload}}', sink: { kind: 'session', cwd: '/tmp' } }],
  });
  await runtime.start();

  const first = await runtime.fire('ci', { id: 'delivery-1', status: 'failed' });
  assert.equal(first.ok, true);
  assert.equal(host.created.length, 1);
  assert.equal(host.prompts.length, 1);
  assert.match(host.prompts[0].content[0].text, /delivery-1/);

  const duplicate = await runtime.fire('ci', { id: 'delivery-1', status: 'failed' });
  assert.deepEqual(duplicate, { ok: false, reason: 'duplicate' });
  assert.equal(host.prompts.length, 1);

  await runtime.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a manual run ignores the duplicate window but keeps the concurrency check', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-runtime-'));
  const host = fakeHost();
  const runtime = await createRuntime(host.ctx, {
    stateDir: dir,
    dedupeWindowMs: 60_000,
    sources: [{ id: 'notes', kind: 'webhook', token: 'secret', sink: { kind: 'session', cwd: '/tmp' } }],
  });
  await runtime.start();
  await runtime.fire('notes', { id: 'same' });
  const manual = await runtime.fire('notes', { id: 'same' }, { manual: true });
  assert.equal(manual.ok, true);
  await runtime.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('the ledger records runs and failures', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-runtime-'));
  const host = fakeHost();
  const runtime = await createRuntime(host.ctx, {
    stateDir: dir,
    sources: [
      { id: 'bad', kind: 'webhook', token: 'secret', sink: { kind: 'http', url: 'http://127.0.0.1:1/nope' } },
    ],
  });
  await runtime.start();
  const result = await runtime.fire('bad', { id: 'x' });
  assert.equal(result.ok, false);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.counters.fired, 1);
  assert.equal(snapshot.counters.failed, 1);
  await runtime.stop();
  await fs.rm(dir, { recursive: true, force: true });
});
