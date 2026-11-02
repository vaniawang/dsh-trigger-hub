/**
 * Durable JSON ledger for the trigger hub. One file, atomic writes, a serialized
 * transaction queue. Pure Node, no dependencies.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function defaultState() {
  return {
    version: 1,
    paused: false,
    runs: [],
    dedupe: {},
    counters: { fired: 0, failed: 0, deduped: 0 },
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state must be an object');
  const base = defaultState();
  return {
    ...base,
    ...raw,
    runs: Array.isArray(raw.runs) ? raw.runs.slice(0, 200) : [],
    dedupe: raw.dedupe && typeof raw.dedupe === 'object' ? raw.dedupe : {},
    counters: { ...base.counters, ...(raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) },
  };
}

export function createStore({ dir, stateFile = 'state.json' }) {
  const root = path.resolve(dir);
  const file = path.resolve(root, stateFile);
  let state = defaultState();
  let queue = Promise.resolve();
  let readyPromise = null;

  async function persist(next) {
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function load() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      state = normalize(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const corrupt = `${file}.corrupt-${Date.now()}`;
        await fs.rename(file, corrupt).catch(() => {});
      }
      state = defaultState();
      await persist(state);
    }
  }

  return {
    dir: root,
    ready() {
      readyPromise ??= load();
      return readyPromise;
    },
    read() { return state; },
    transact(fn) {
      const run = async () => {
        await this.ready();
        const draft = structuredClone(state);
        fn(draft);
        await persist(draft);
        state = draft;
        return state;
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async close() { await queue.catch(() => {}); },
  };
}
