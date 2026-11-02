/**
 * Trigger hub runtime: sources (schedule, webhook, watch) and sinks
 * (agent session or HTTP). The HTTP surface lives in index.js.
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs, watch as fsWatch } from 'node:fs';
import { createStore, defaultState } from './store.js';
import { delayUntilNext, scheduleOf } from './schedule.js';
import { dedupeKey, recordFire, shouldFire, finishRun } from './policy.js';
import { runProcedure } from './procedure.js';

const DEFAULT_TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval };
const MAX_BODY_BYTES = 64 * 1024;

export const ROUTE_BASE = '/dsh-trigger-hub';

/** Creates the runtime and opens the ledger. `start()` installs timers/watchers. */
export async function createRuntime(ctx, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const timers = { ...DEFAULT_TIMERS, ...(options.timers ?? {}) };
  const logger = options.logger ?? console;
  const stateDir = options.stateDir ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-trigger-hub');
  const store = options.store ?? createStore({ dir: stateDir });
  await store.ready();

  const sources = Array.isArray(options.sources) ? options.sources.filter((source) => source && typeof source.id === 'string') : [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : 2;
  const dedupeWindowMs = Number.isFinite(options.dedupeWindowMs) ? options.dedupeWindowMs : 60_000;
  const timersById = new Map();
  const watchers = [];
  let stopped = false;
  const running = new Map();

  const getService = (name) => { try { return ctx.get?.(name) } catch { return undefined } };
  const log = (message, error) => {
    try {
      if (typeof logger?.warn === 'function') logger.warn('[dsh-trigger-hub] ' + message + (error ? ': ' + String(error?.message ?? error) : ''));
    } catch { /* logging must not fail the host */ }
  };

  /** Creates or resumes the Session a session sink writes into. */
  async function ensureSession(sessionId, sink) {
    const controller = getService('sessionController');
    const cwd = typeof sink?.cwd === 'string' && sink.cwd !== '' ? sink.cwd : process.cwd();
    if (controller && typeof controller.resolveAgent === 'function') {
      let result = await controller.resolveAgent(sessionId);
      if (result?.agent) return result.agent;
      if (typeof controller.create === 'function') {
        const registry = getService('workspaceRegistry');
        const workspace = registry && typeof registry.create === 'function' ? await registry.create(cwd) : undefined;
        await controller.create({ sessionId, ...(workspace?.id ? { workspaceId: workspace.id } : { cwd }), ...(sink?.preset ? { agentPreset: sink.preset } : {}) });
        result = await controller.resolveAgent(sessionId);
        if (result?.agent) return result.agent;
      }
    }
    const agents = getService('agents');
    if (agents && typeof agents.create === 'function') {
      const handle = await agents.create({ sessionId, meta: { cwd, ...(sink?.preset ? { agentPreset: sink.preset } : {}) } });
      if (handle?.agent) return handle.agent;
    }
    throw new Error('no session service can create ' + sessionId);
  }

  function promptText(source, payload, sink) {
    const template = typeof sink?.prompt === 'string' && sink.prompt.trim() !== '' ? sink.prompt : source.prompt;
    if (typeof template === 'string' && template.trim() !== '') {
      return template.replace(/\{\{\s*payload\s*\}\}/g, JSON.stringify(payload ?? {}, null, 2));
    }
    return `[Trigger] ${source.id}\n${JSON.stringify(payload ?? {}, null, 2)}`;
  }

  async function runSink(source, payload, runId, sink = source.sink) {
    if (!sink) return { detail: 'no sink' };
    if (sink.kind === 'http') {
      const response = await fetch(sink.url, {
        method: sink.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(sink.headers ?? {}) },
        body: JSON.stringify({ source: source.id, runId, payload }),
      });
      if (!response.ok) throw new Error(`sink HTTP ${response.status}`);
      return { detail: `HTTP ${response.status}` };
    }
    const sessionId = `trigger-hub-${source.id}-${runId}`;
    await ensureSession(sessionId, sink);
    const controller = getService('sessionController');
    if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController.prompt is unavailable');
    await controller.prompt({
      requestId: `trigger-hub-${runId}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText(source, payload, sink) }],
    }, new AbortController().signal);
    return { sessionId, detail: 'prompted ' + sessionId };
  }

  /** Fires one source once. Returns a compact result for HTTP/manual callers. */
  async function fire(sourceId, payload = {}, { manual = false } = {}) {
    if (stopped) return { ok: false, reason: 'stopped' };
    const source = byId.get(sourceId);
    if (!source) return { ok: false, reason: 'unknown-source' };
    const state = store.read();
    const key = payload?.id === undefined && payload?.delivery === undefined && payload?.key === undefined
      ? undefined
      : dedupeKey(sourceId, payload);
    const decision = shouldFire({ ...source, dedupeKey: key }, state, { concurrency, dedupeWindowMs }, new Date(now()));
    if (!decision.ok && !(manual && decision.reason === 'duplicate')) {
      if (decision.reason === 'duplicate') {
        await store.transact((draft) => { draft.counters.deduped = (draft.counters.deduped ?? 0) + 1; });
      }
      return { ok: false, reason: decision.reason };
    }
    const runId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await store.transact((draft) => {
      Object.assign(draft, recordFire(draft, {
        sourceId, kind: source.kind, key, at: new Date(now()).toISOString(), runId,
        sink: (source.sink ?? { kind: 'session' }).kind, status: 'running',
      }));
    });
    const promise = (async () => {
      try {
        if (source.kind === 'procedure') {
          const outcome = await runProcedure(source);
          const summary = outcome.timedOut
            ? `timed out after ${outcome.durationMs}ms`
            : `exit=${outcome.code ?? 'null'} in ${outcome.durationMs}ms`;
          const sink = outcome.ok ? source.sink : (source.onFailure ?? source.sink);
          let sinkDetail = 'no sink';
          if (sink) {
            try { sinkDetail = (await runSink(source, { ...payload, procedure: outcome }, runId, sink)).detail; }
            catch (error) { sinkDetail = 'sink failed: ' + String(error?.message ?? error); }
          }
          const status = outcome.ok ? 'done' : 'failed';
          await store.transact((draft) => {
            Object.assign(draft, finishRun(draft, runId, status, `${summary}; ${sinkDetail}`, outcome.output));
          });
          return { ok: outcome.ok, runId, status, detail: summary, output: outcome.output };
        }
        const result = await runSink(source, payload, runId);
        await store.transact((draft) => { Object.assign(draft, finishRun(draft, runId, 'done', result.detail)); });
        return { ok: true, runId, ...result };
      } catch (error) {
        await store.transact((draft) => { Object.assign(draft, finishRun(draft, runId, 'failed', String(error?.message ?? error))); });
        log('run failed: ' + sourceId, error);
        return { ok: false, runId, reason: 'sink-failed', detail: String(error?.message ?? error) };
      } finally {
        running.delete(runId);
      }
    })();
    running.set(runId, promise);
    return promise;
  }

  function scheduleSource(source) {
    if (stopped || source.enabled === false) return;
    let delay;
    try { delay = delayUntilNext(source, new Date(now())); } catch (error) { log('invalid schedule: ' + source.id, error); return; }
    if (delay === null) return;
    const timer = timers.setTimeout(async () => {
      timersById.delete(source.id);
      if (stopped) return;
      await fire(source.id, { id: `schedule-${now()}`, scheduled: true }).catch((error) => log('scheduled fire failed', error));
      scheduleSource(source);
    }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    timersById.set(source.id, timer);
  }

  function watchSource(source) {
    if (stopped || source.enabled === false || source.kind !== 'watch') return;
    if (typeof source.path !== 'string' || source.path === '') { log('watch source without path: ' + source.id); return; }
    const debounceMs = Number.isFinite(source.debounceMs) ? source.debounceMs : 1500;
    let pending;
    let lastEvent = 0;
    try {
      const watcher = fsWatch(source.path, { persistent: false }, (event, filename) => {
        lastEvent = now();
        if (pending) timers.clearTimeout(pending);
        pending = timers.setTimeout(() => {
          pending = undefined;
          void fire(source.id, { id: `watch-${source.id}-${lastEvent}`, event, file: filename ?? null }).catch((error) => log('watch fire failed', error));
        }, debounceMs);
        if (typeof pending?.unref === 'function') pending.unref();
      });
      watcher.on?.('error', (error) => log('watch error: ' + source.id, error));
      watchers.push(watcher);
    } catch (error) {
      log('cannot watch ' + source.path, error);
    }
  }

  function start() {
    if (stopped) return;
    for (const source of sources) {
      const scheduled = source.kind === 'schedule'
        || (source.kind === 'procedure' && (source.cron !== undefined || source.every !== undefined));
      if (scheduled) scheduleSource(source);
      else if (source.kind === 'watch') watchSource(source);
    }
  }

  async function stop() {
    stopped = true;
    for (const timer of timersById.values()) timers.clearTimeout(timer);
    timersById.clear();
    for (const watcher of watchers) { try { watcher.close?.() } catch { /* already closed */ } }
    await Promise.allSettled([...running.values()]);
    await store.close();
  }

  function snapshot() {
    const state = store.read();
    return {
      paused: state.paused === true,
      counters: state.counters ?? { fired: 0, failed: 0, deduped: 0 },
      sources: sources.map((source) => ({
        id: source.id, kind: source.kind, enabled: source.enabled !== false,
        schedule: (source.kind === 'schedule' || source.kind === 'procedure') ? (source.cron ?? source.every ?? null) : null,
        last: (state.runs ?? []).find((run) => run.sourceId === source.id) ?? null,
      })),
      runs: (state.runs ?? []).slice(0, 50),
      concurrency, dedupeWindowMs,
    };
  }

  function health() {
    const state = store.read();
    return { state: 'ready', paused: state.paused === true, sources: sources.length, failed: state.counters?.failed ?? 0 };
  }

  return { start, stop, fire, snapshot, health, stateDir, config: { concurrency, dedupeWindowMs } };
}

export function configError(message) {
  return new Error('dsh-trigger-hub config: ' + message);
}

export { defaultState, MAX_BODY_BYTES };
