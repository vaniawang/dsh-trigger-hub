import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcedure } from '../src/procedure.js';
import { createRuntime } from '../src/runtime.js';

test('runProcedure reports success and captures output', async () => {
  const result = await runProcedure({ command: 'printf "hello procedures"' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.match(result.output, /hello procedures/);
});

test('runProcedure reports a non-zero exit as failure', async () => {
  const result = await runProcedure({ command: 'exit 7' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
});

test('runProcedure enforces a timeout', async () => {
  const result = await runProcedure({ command: 'sleep 5', timeoutMs: 150 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('a failing procedure escalates to its onFailure sink and records the run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-procedure-'));
  const prompts = [];
  const sessions = new Map();
  const ctx = {
    get(name) {
      if (name === 'sessionController') return {
        async resolveAgent(id) { return sessions.has(id) ? { agent: { id } } : { error: { code: 'session/not-found' } } },
        async create(options) { sessions.set(options.sessionId, { id: options.sessionId }); },
        async prompt(message) { prompts.push(message); },
      };
      if (name === 'workspaceRegistry') return { create: async () => ({ id: 'workspace' }) };
      return undefined;
    },
    logger: { warn() {} },
  };
  const runtime = await createRuntime(ctx, {
    stateDir: dir,
    sources: [{
      id: 'nightly-tests',
      kind: 'procedure',
      command: 'printf "tests failed"; exit 2',
      onFailure: { kind: 'session', cwd: '/tmp', prompt: 'Procedure failed: {{payload}}' },
    }],
  });
  await runtime.start();
  const result = await runtime.fire('nightly-tests', { id: 'manual-1' }, { manual: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].content[0].text, /Procedure failed/);
  const run = runtime.snapshot().runs[0];
  assert.equal(run.status, 'failed');
  assert.match(run.detail, /exit=2/);
  assert.match(run.output ?? '', /tests failed/);
  await runtime.stop();
  await fs.rm(dir, { recursive: true, force: true });
});
