/**
 * dsh-trigger-hub — Host half.
 *
 * Turns schedules, authenticated webhooks and file-watch events into agent
 * sessions (or HTTP posts). The plugin owns transport and config validation;
 * the runtime owns firing, the ledger and the sinks.
 */
import { createRuntime, configError, MAX_BODY_BYTES, ROUTE_BASE } from './src/runtime.js';
import { parseCron, parseDuration } from './src/schedule.js';
import { renderPanel } from './src/panel.js';

export const name = 'dsh-trigger-hub';
export const inject = ['webServer'];


export function apply(ctx, config = {}) {
  let runtime;
  let starting;
  let disposing = false;

  const warn = (message, error) => {
    try {
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('[dsh-trigger-hub] ' + message + (error ? ': ' + String(error?.message ?? error) : ''));
      else console.warn('[dsh-trigger-hub] ' + message, error ?? '');
    } catch { /* never fail the host */ }
  };

  let normalized;
  try {
    normalized = normalizeConfig(config);
  } catch (error) {
    warn('invalid configuration; starting with no sources', error);
    normalized = { sources: [] };
  }
  const hookSources = new Map(normalized.sources.filter((source) => source.kind === 'webhook').map((source) => [source.id, source]));

  const getRuntime = () => {
    if (runtime) return Promise.resolve(runtime);
    starting ??= createRuntime(ctx, normalized)
      .then(async (created) => {
        runtime = created;
        try { created.start(); } catch (error) { warn('start failed', error); }
        if (disposing) await created.stop().catch((error) => warn('stop after dispose failed', error));
        return created;
      })
      .catch((error) => { starting = undefined; throw error; });
    return starting;
  };

  const routes = [
    [ROUTE_BASE + '/state', handleState],
    [ROUTE_BASE + '/health', handleHealth],
    [ROUTE_BASE + '/panel', handlePanel],
  ];
  for (const source of normalized.sources) {
    routes.push([ROUTE_BASE + '/run/' + encodeURIComponent(source.id), (req, res) => handleRun(req, res, source.id)]);
    if (source.kind === 'webhook') {
      routes.push([ROUTE_BASE + '/hook/' + encodeURIComponent(source.id), (req, res) => handleHook(req, res, source.id)]);
    }
  }

  ctx.effect(() => {
    const disposers = [];
    for (const [path, handler] of routes) {
      const off = ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          Promise.resolve(handler(req, res)).catch((error) => fail(res, error));
        },
      });
      if (typeof off === 'function') disposers.push(off);
    }
    return () => { for (const off of disposers) { try { off() } catch (error) { warn('route dispose failed', error); } } };
  }, 'dsh-trigger-hub: routes');

  getRuntime().catch((error) => warn('runtime creation failed', error));

  ctx.effect(() => () => {
    disposing = true;
    if (runtime) runtime.stop().catch((error) => warn('stop failed', error));
  }, 'dsh-trigger-hub: lifecycle');

  async function ready() {
    try { return await getRuntime(); } catch (error) { throw httpError(503, 'not-ready', error?.message ?? 'runtime unavailable'); }
  }

  async function handleHook(req, res, id) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    const source = hookSources.get(id);
    if (!source) return sendJson(res, 404, { ok: false, error: 'unknown-source' });
    if (!checkToken(req, source)) return sendJson(res, 403, { ok: false, error: 'invalid-token' });
    let body;
    try { body = await readJson(req); } catch (error) {
      const tooLarge = error?.code === 'body-too-large';
      return sendJson(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body-too-large' : 'invalid-json' });
    }
    const rt = await ready();
    const result = await rt.fire(id, body, { manual: false });
    if (!result.ok) return sendJson(res, result.reason === 'concurrency' ? 429 : 200, { ok: false, ...result });
    return sendJson(res, 200, { ok: true, runId: result.runId, sessionId: result.sessionId ?? null });
  }

  async function handleRun(req, res, id) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
    const rt = await ready();
    const result = await rt.fire(id, { id: 'manual-' + Date.now(), manual: true }, { manual: true });
    return sendJson(res, result.ok ? 200 : 429, { ok: result.ok, ...result });
  }

  async function handleState(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    if (!isLoopback(req) && !sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted-request' });
    const rt = await ready();
    return sendJson(res, 200, { ok: true, snapshot: rt.snapshot() });
  }

  async function handleHealth(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    if (!isLoopback(req) && !sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted-request' });
    const rt = await ready();
    return sendJson(res, 200, { ok: true, ...rt.health() });
  }

  async function handlePanel(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    if (!isLoopback(req) && !sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted-request' });
    const rt = await ready();
    return sendHtml(res, 200, renderPanel(rt.snapshot()));
  }
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { sources: [] };
  const sources = Array.isArray(raw.sources) ? raw.sources.map(validateSource) : [];
  return {
    stateDir: typeof raw.stateDir === 'string' && raw.stateDir.trim() !== '' ? raw.stateDir.trim() : undefined,
    concurrency: Number.isInteger(raw.concurrency) && raw.concurrency > 0 ? raw.concurrency : 2,
    dedupeWindowMs: Number.isFinite(raw.dedupeWindowMs) && raw.dedupeWindowMs >= 0 ? raw.dedupeWindowMs : 60_000,
    sources,
  };
}

function validateSource(source) {
  if (!source || typeof source !== 'object' || typeof source.id !== 'string' || source.id.trim() === '') {
    throw configError('every source needs a non-empty id');
  }
  const kind = source.kind;
  if (!['schedule', 'webhook', 'watch', 'procedure'].includes(kind)) {
    throw configError(`source ${source.id}: kind must be schedule, webhook, watch or procedure`);
  }
  const validateSink = (sink, label) => {
    if (!['session', 'http'].includes(sink.kind)) throw configError(`source ${source.id}: ${label}.kind must be session or http`);
    if (sink.kind === 'http' && (typeof sink.url !== 'string' || !/^https?:\/\//.test(sink.url))) {
      throw configError(`source ${source.id}: ${label}.url must be an http(s) URL`);
    }
    return sink;
  };
  const sink = source.sink ?? (kind === 'procedure' ? undefined : { kind: 'session' });
  if (sink !== undefined) validateSink(sink, 'sink');
  if (source.onFailure !== undefined) validateSink(source.onFailure, 'onFailure');
  if (source.onSuccess !== undefined) validateSink(source.onSuccess, 'onSuccess');
  if (kind === 'schedule') {
    if (source.cron === undefined && source.every === undefined) throw configError(`source ${source.id}: schedule needs cron or every`);
    if (source.cron !== undefined) parseCron(source.cron);
    else parseDuration(source.every);
  }
  if (kind === 'procedure') {
    if (typeof source.command !== 'string' || source.command.trim() === '') {
      throw configError(`source ${source.id}: procedure needs a command`);
    }
    if (source.cron !== undefined && source.every !== undefined) throw configError(`source ${source.id}: use either cron or every, not both`);
    if (source.cron !== undefined) parseCron(source.cron);
    if (source.every !== undefined) parseDuration(source.every);
    if (source.timeoutMs !== undefined && (!Number.isInteger(source.timeoutMs) || source.timeoutMs <= 0)) {
      throw configError(`source ${source.id}: timeoutMs must be a positive integer`);
    }
  }
  if (kind === 'watch' && (typeof source.path !== 'string' || source.path === '')) {
    throw configError(`source ${source.id}: watch needs a path`);
  }
  if (kind === 'webhook' && source.token === undefined && source.tokenEnv === undefined) {
    throw configError(`source ${source.id}: webhook needs token or tokenEnv`);
  }
  return { ...source, sink };
}

function checkToken(req, source) {
  const expected = source.token ?? (source.tokenEnv ? process.env[source.tokenEnv] : undefined);
  if (typeof expected !== 'string' || expected === '') return false;
  const header = req.headers['x-trigger-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return diff === 0;
}

function isLoopback(req) {
  const remote = String(req.socket?.remoteAddress ?? '').toLowerCase();
  return remote === '' || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function sameOrigin(req) {
  const origin = String(req.headers.origin ?? '');
  if (origin === '') return isLoopback(req);
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch { return false; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(httpError(413, 'body-too-large', 'body exceeds 64 KiB'));
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'invalid-json', 'body is not valid JSON')); }
    });
    req.on('error', (error) => reject(error));
  });
}

function httpError(status, code, message) {
  const error = new Error(message ?? code);
  error.status = status;
  error.code = code;
  return error;
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
  });
  res.end(String(html));
}

function fail(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  try { sendJson(res, status, { ok: false, error: error?.code ?? 'internal-error', detail: error?.message ?? String(error) }); }
  catch { try { if (!res.headersSent) res.end(); } catch { /* socket closed */ } }
}
