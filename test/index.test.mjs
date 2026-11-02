import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

function fakeHost() {
  const routes = new Map();
  const sessions = new Map();
  const prompts = [];
  const ctx = {
    logger: { warn() {} },
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {}; },
    webServer: { register({ path: route, handler }) { routes.set(route, handler); return () => routes.delete(route); } },
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent(id) { return sessions.has(id) ? { agent: { id } } : { error: { code: 'session/not-found' } } },
          async create(options) { sessions.set(options.sessionId, { id: options.sessionId }); },
          async prompt(message) { prompts.push(message); },
        };
      }
      if (name === 'workspaceRegistry') return { create: async () => ({ id: 'workspace' }) };
      if (name === 'agents') return { get: () => undefined, create: async () => { throw new Error('unused'); } };
      return undefined;
    },
  };
  return { ctx, routes, sessions, prompts };
}

function request({ method = 'GET', headers = {}, body = '', remote = '127.0.0.1' } = {}) {
  const listeners = {};
  const req = {
    method, headers, socket: { remoteAddress: remote },
    on(event, handler) { (listeners[event] ??= []).push(handler); },
  };
  setImmediate(() => {
    for (const handler of listeners.data ?? []) handler(Buffer.from(body));
    for (const handler of listeners.end ?? []) handler();
  });
  return req;
}

function response() {
  return {
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(payload) { this.body = payload; },
  };
}

async function call(routes, route, options) {
  const res = response();
  routes.get(route)(request(options), res);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return res;
}

test('routes, health, token auth and a session prompt', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-hub-index-'));
  const host = fakeHost();
  apply(host.ctx, {
    stateDir: dir,
    sources: [{ id: 'ci', kind: 'webhook', token: 'secret', prompt: 'CI {{payload}}', sink: { kind: 'session', cwd: '/tmp' } }],
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual([...host.routes.keys()].sort(), [
    '/dsh-trigger-hub/health',
    '/dsh-trigger-hub/hook/ci',
    '/dsh-trigger-hub/panel',
    '/dsh-trigger-hub/run/ci',
    '/dsh-trigger-hub/state',
  ]);

  const health = await call(host.routes, '/dsh-trigger-hub/health', {});
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  const denied = await call(host.routes, '/dsh-trigger-hub/hook/ci', { method: 'POST', body: '{"id":"1"}' });
  assert.equal(denied.status, 403);

  const accepted = await call(host.routes, '/dsh-trigger-hub/hook/ci', {
    method: 'POST', headers: { 'x-trigger-token': 'secret' }, body: '{"id":"1"}',
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.body).ok, true);
  assert.equal(host.prompts.length, 1);
  assert.match(host.prompts[0].content[0].text, /CI/);

  await fs.rm(dir, { recursive: true, force: true });
});

test('a webhook source without a token is rejected at configuration time', async () => {
  const host = fakeHost();
  apply(host.ctx, { stateDir: path.join(os.tmpdir(), 'trigger-hub-index-invalid'), sources: [{ id: 'bad', kind: 'webhook' }] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const health = await call(host.routes, '/dsh-trigger-hub/health', {});
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).sources, 0);
});
