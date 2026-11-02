/**
 * Deterministic procedure execution: run one command, capture a bounded tail of
 * its output, and report an exit-code verdict. No model call happens here; a
 * failure is escalated by the runtime through an `onFailure` sink.
 */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CAPTURE_CHARS = 4000;

function tail(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : value.slice(value.length - limit);
}

/**
 * Runs `source.command` in `source.cwd`.
 * Returns `{ ok, code, signal, timedOut, durationMs, output, error? }`.
 */
export function runProcedure(source, options = {}) {
  const spawnImpl = options.spawn ?? spawn;
  const timeoutMs = Number.isFinite(source.timeoutMs) ? source.timeoutMs : DEFAULT_TIMEOUT_MS;
  const capture = Number.isFinite(source.captureChars) ? source.captureChars : DEFAULT_CAPTURE_CHARS;
  const expectExitCode = Number.isInteger(source.expectExitCode) ? source.expectExitCode : 0;
  const started = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl('/bin/bash', ['-lc', source.command], {
        cwd: source.cwd ?? process.cwd(),
        env: { ...process.env, ...(source.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, timedOut: false, durationMs: 0, output: '', error: String(error?.message ?? error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => { stdout = tail(stdout + chunk.toString(), capture); });
    child.stderr?.on('data', (chunk) => { stderr = tail(stderr + chunk.toString(), capture); });
    child.on?.('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, timedOut: false, durationMs: Date.now() - started, output: '', error: String(error?.message ?? error) });
    });
    child.on?.('close', (code, signal) => {
      clearTimeout(timer);
      const output = tail((stdout + (stderr ? '\n[stderr]\n' + stderr : '')).trim(), capture);
      const ok = !timedOut && code === expectExitCode;
      resolve({
        ok,
        code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        output,
        ...(ok ? {} : { error: timedOut ? `timed out after ${timeoutMs}ms` : `exit ${code}${signal ? ' signal ' + signal : ''}` }),
      });
    });
  });
}
