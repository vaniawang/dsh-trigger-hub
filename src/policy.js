/**
 * Fire policy for the trigger hub: enabled state, pause, duplicate suppression,
 * concurrency limits and quiet hours. Pure functions over a ledger snapshot.
 */
import { createHash } from 'node:crypto';

/** Stable dedupe key from a source id and the payload's explicit key. */
export function dedupeKey(sourceId, payload) {
  const explicit = payload?.id ?? payload?.delivery ?? payload?.key ?? payload?.sha;
  const basis = explicit === undefined ? JSON.stringify(payload ?? {}) : String(explicit);
  return createHash('sha1').update(`${sourceId}:${basis}`).digest('hex').slice(0, 16);
}

export const ACTIVE_STATUSES = new Set(['running']);

export function activeRuns(state) {
  return (state.runs ?? []).filter((run) => ACTIVE_STATUSES.has(run.status)).length;
}

function inQuietHours(source, now) {
  const quiet = source.quietHours;
  if (!quiet || typeof quiet.from !== 'string' || typeof quiet.to !== 'string') return false;
  const [fromH, fromM] = quiet.from.split(':').map(Number);
  const [toH, toM] = quiet.to.split(':').map(Number);
  if (![fromH, fromM, toH, toM].every(Number.isFinite)) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

/**
 * Decides whether a source may fire now.
 * Returns `{ ok: true }` or `{ ok: false, reason: 'disabled'|'paused'|'duplicate'|'concurrency'|'quiet' }`.
 */
export function shouldFire(source, state, options = {}, now = new Date()) {
  if (source.enabled === false) return { ok: false, reason: 'disabled' };
  if (state.paused === true) return { ok: false, reason: 'paused' };
  if (inQuietHours(source, now)) return { ok: false, reason: 'quiet' };

  const windowMs = Number.isFinite(options.dedupeWindowMs) ? options.dedupeWindowMs : 60_000;
  const key = source.dedupeKey;
  if (key) {
    const last = state.dedupe?.[key];
    if (last !== undefined && now.getTime() - last < windowMs) return { ok: false, reason: 'duplicate' };
  }

  const limit = Number.isFinite(options.concurrency) ? options.concurrency : 2;
  if (activeRuns(state) >= limit) return { ok: false, reason: 'concurrency' };
  return { ok: true };
}

/** Records that a source fired; returns a new ledger. */
export function recordFire(state, { sourceId, kind, key, at, runId, sink, sessionId, status = 'running', detail = '' }) {
  const runs = Array.isArray(state.runs) ? state.runs.slice() : [];
  runs.unshift({ runId, sourceId, kind, at, status, sink, sessionId, detail });
  const dedupe = { ...(state.dedupe ?? {}) };
  if (key) dedupe[key] = new Date(at).getTime();
  return {
    ...state,
    runs: runs.slice(0, 200),
    dedupe,
    counters: {
      ...(state.counters ?? { fired: 0, failed: 0, deduped: 0 }),
      fired: (state.counters?.fired ?? 0) + 1,
    },
  };
}

/** Marks one run done or failed; returns a new ledger. */
export function finishRun(state, runId, status, detail = '') {
  const runs = (state.runs ?? []).map((run) => (run.runId === runId ? { ...run, status, detail } : run));
  const counters = { ...(state.counters ?? { fired: 0, failed: 0, deduped: 0 }) };
  if (status === 'failed') counters.failed = (counters.failed ?? 0) + 1;
  return { ...state, runs, counters };
}
