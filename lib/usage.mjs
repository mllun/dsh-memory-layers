/**
 * Usage ledger (`usage.json`): how often each cold entry was recalled, when it
 * was last touched, and a slowly decaying weight.
 *
 * Shape on disk:
 *
 *   { "version": 1, "entries": { "<sha1(content)>": {
 *       hits, firstHitAt, lastHitAt, weight, lastDecayAt } } }
 *
 * Three rules matter here:
 *
 *  1. **Reads never fail.** A missing or corrupt file is treated as empty and
 *     rebuilt on the next write; nothing in the recall path may throw because
 *     of the ledger.
 *  2. **Writes are throttled.** Recall touches one record per returned entry,
 *     so a single call would otherwise rewrite the file dozens of times. Writes
 *     coalesce inside `usageThrottleMs`, with a trailing write scheduled so no
 *     hit is lost, plus a flush on process exit.
 *  3. **Weight decays with a half-life.** A weight of 50 that has not been
 *     touched for one half-life (30 days) becomes 25, and so on. Decay is
 *     applied when the file is read, only once at least one full day has
 *     passed, so repeated reads cannot compound rounding drift. Weight never
 *     goes below 0 and a low weight never deletes an entry — it only makes the
 *     entry eligible to be demoted out of the hot layer.
 *
 * @module lib/usage
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readTextIfExists, usageFilePath, writeAtomic } from './paths.mjs';

/** Weight of an entry that has never been touched. */
export const DEFAULT_WEIGHT = 50;
/** Weight ceiling. */
export const MAX_WEIGHT = 100;
/** Weight gained by one recall / window-query hit. */
export const RECALL_WEIGHT_GAIN = 6;
/** Weight gained when an entry is promoted into the hot-layer body. */
export const PROMOTION_WEIGHT_GAIN = 15;

const DAY_MS = 86400000;

/**
 * Stable identity of one memory: sha1 of its content.
 * @param {string} content
 * @returns {string}
 */
export function contentKey(content) {
  return createHash('sha1').update(String(content ?? ''), 'utf8').digest('hex');
}

/**
 * Round to one decimal so repeated arithmetic cannot drift.
 * @param {number} value
 * @returns {number}
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Clamp a weight into `[0, 100]`.
 * @param {number} value
 * @returns {number}
 */
function clampWeight(value) {
  return Math.max(0, Math.min(MAX_WEIGHT, value));
}

/** In-memory mirror of `usage.json`, keyed by file stamp. */
let state = null;
/** Timestamp of the last successful write, used by the throttle. */
let lastWriteAt = 0;
/** Pending trailing write. */
let pendingTimer = null;
/** Whether the process-exit flush is installed. */
let exitHooked = false;

/**
 * Stamp of the ledger file, so an external edit invalidates the cache.
 * @returns {string}
 */
function fileStamp() {
  try {
    const stats = statSync(usageFilePath());
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * Parse the ledger, tolerating any amount of damage.
 * @param {string | null} raw
 * @returns {Record<string, { hits: number, firstHitAt: string, lastHitAt: string, weight: number, lastDecayAt: string }>}
 */
function parseLedger(raw) {
  if (raw === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const source = parsed && typeof parsed === 'object' ? parsed.entries : null;
  if (!source || typeof source !== 'object') return {};
  const entries = {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object') continue;
    const hits = Number(value.hits);
    const weight = Number(value.weight);
    entries[key] = {
      hits: Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 0,
      firstHitAt: typeof value.firstHitAt === 'string' ? value.firstHitAt : '',
      lastHitAt: typeof value.lastHitAt === 'string' ? value.lastHitAt : '',
      weight: Number.isFinite(weight) ? clampWeight(weight) : DEFAULT_WEIGHT,
      lastDecayAt: typeof value.lastDecayAt === 'string' ? value.lastDecayAt : '',
    };
  }
  return entries;
}

/**
 * Apply half-life decay in place. Only runs once a whole day has passed since
 * the last decay, which keeps the result identical to continuous decay without
 * letting every read shave a fraction off the weight.
 * @param {Record<string, { weight: number, lastDecayAt: string }>} entries
 * @param {number} halfLifeDays
 * @param {number} now epoch ms
 * @returns {boolean} whether anything changed
 */
function applyDecay(entries, halfLifeDays, now) {
  const life = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 30;
  let changed = false;
  for (const record of Object.values(entries)) {
    const base = record.lastDecayAt === '' ? NaN : new Date(record.lastDecayAt).getTime();
    if (Number.isNaN(base)) {
      record.lastDecayAt = new Date(now).toISOString();
      changed = true;
      continue;
    }
    const days = (now - base) / DAY_MS;
    if (!Number.isFinite(days) || days < 1) continue;
    record.weight = round1(clampWeight(record.weight * 0.5 ** (days / life)));
    record.lastDecayAt = new Date(now).toISOString();
    changed = true;
  }
  return changed;
}

/**
 * Write the ledger out, dropping unknown fields and rounding weights.
 * @param {{ entries: Record<string, object> }} current
 * @returns {boolean} whether the write succeeded
 */
function persist(current) {
  const entries = {};
  for (const [key, record] of Object.entries(current.entries)) {
    entries[key] = {
      hits: record.hits,
      firstHitAt: record.firstHitAt,
      lastHitAt: record.lastHitAt,
      weight: round1(clampWeight(record.weight)),
      lastDecayAt: record.lastDecayAt,
    };
  }
  try {
    writeAtomic(usageFilePath(), `${JSON.stringify({ version: 1, entries })}\n`);
    lastWriteAt = Date.now();
    if (state) {
      state.stamp = fileStamp();
      state.dirty = false;
    }
    return true;
  } catch (error) {
    current.logger?.warn?.(`[dsh-memory-layers] usage.json 写入失败，已忽略：${error?.message ?? error}`);
    return false;
  }
}

/**
 * Flush a pending write when the process ends, so throttling cannot drop hits.
 */
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    try {
      if (state && state.dirty) persist(state);
    } catch {
      /* best effort on the way out */
    }
  });
}

/**
 * Schedule the trailing write that ends the current throttle window.
 * @param {number} delay ms
 */
function scheduleSave(delay) {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (state && state.dirty) persist(state);
  }, Math.max(0, delay));
  pendingTimer.unref?.();
}

/**
 * Load the ledger, reusing the in-memory copy while the file is untouched.
 * @param {Record<string, unknown>} config
 * @returns {{ entries: Record<string, any>, stamp: string, dirty: boolean, logger?: object }}
 */
export function loadUsage(config = {}) {
  hookExit();
  const stamp = fileStamp();
  if (state && state.stamp === stamp) return state;
  state = {
    entries: parseLedger(readTextIfExists(usageFilePath())),
    stamp,
    dirty: false,
    logger: config.logger,
  };
  if (applyDecay(state.entries, config.halfLifeDays, Date.now())) state.dirty = true;
  return state;
}

/**
 * Persist the ledger, respecting the throttle window.
 * @param {Record<string, unknown>} config
 * @param {{ force?: boolean }} [options]
 * @returns {boolean} whether the file was written now
 */
export function saveUsage(config = {}, { force = false } = {}) {
  const current = loadUsage(config);
  current.logger = config.logger;
  if (!current.dirty) return false;
  const throttle = Number.isFinite(config.usageThrottleMs) ? config.usageThrottleMs : 5000;
  const wait = throttle - (Date.now() - lastWriteAt);
  if (!force && lastWriteAt > 0 && wait > 0) {
    scheduleSave(wait);
    return false;
  }
  return persist(current);
}

/**
 * Flush any pending write immediately (used by tests and on shutdown).
 * @param {Record<string, unknown>} [config] accepted so callers need no state
 * @returns {boolean}
 */
export function flushUsage(config = {}) {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (!state) return false;
  state.logger = config.logger ?? state.logger;
  return persist(state);
}

/**
 * Drop the in-memory copy; the next call re-reads the file.
 */
export function resetUsageCache() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  state = null;
  lastWriteAt = 0;
}

/**
 * Read one record without creating it.
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @returns {{ hits: number, firstHitAt: string, lastHitAt: string, weight: number, lastDecayAt: string } | null}
 */
export function getUsageRecord(config, key) {
  const current = loadUsage(config);
  return current.entries[key] ?? null;
}

/**
 * Every tracked record, keyed by content hash.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, { hits: number, firstHitAt: string, lastHitAt: string, weight: number, lastDecayAt: string }>}
 */
export function allUsageRecords(config) {
  return loadUsage(config).entries;
}

/**
 * Record one recall hit: `hits + 1`, refresh `lastHitAt`, `weight + 6`.
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @param {number} [gain]
 * @returns {object | null}
 */
export function touchEntry(config, key, gain = RECALL_WEIGHT_GAIN) {
  try {
    const current = loadUsage(config);
    const now = new Date().toISOString();
    const record = current.entries[key] ?? {
      hits: 0,
      firstHitAt: '',
      lastHitAt: '',
      weight: DEFAULT_WEIGHT,
      lastDecayAt: now,
    };
    record.hits += 1;
    if (record.firstHitAt === '') record.firstHitAt = now;
    record.lastHitAt = now;
    record.weight = round1(clampWeight(record.weight + gain));
    if (record.lastDecayAt === '') record.lastDecayAt = now;
    current.entries[key] = record;
    current.dirty = true;
    saveUsage(config);
    return record;
  } catch {
    return null;
  }
}

/**
 * Raise the weight of an entry that was just promoted into the hot body.
 * Only tracked entries move: promoting an unknown line must not create a
 * record, otherwise freshly written hot text could never be evicted.
 * @param {Record<string, unknown>} config
 * @param {string} key
 * @returns {boolean} whether a record was updated
 */
export function promoteEntry(config, key) {
  try {
    const current = loadUsage(config);
    const record = current.entries[key];
    if (!record) return false;
    record.weight = round1(clampWeight(record.weight + PROMOTION_WEIGHT_GAIN));
    current.dirty = true;
    saveUsage(config);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an entry was hit within the last `days` days.
 * @param {{ lastHitAt: string } | null} record
 * @param {number} days
 * @param {number} [now]
 * @returns {boolean}
 */
export function hitWithin(record, days, now = Date.now()) {
  if (!record || record.lastHitAt === '') return false;
  const at = new Date(record.lastHitAt).getTime();
  if (Number.isNaN(at)) return false;
  return now - at <= days * DAY_MS;
}

/**
 * Age in days since `iso`, `Infinity` when unknown.
 * @param {string} iso
 * @param {number} [now]
 * @returns {number}
 */
export function ageInDays(iso, now = Date.now()) {
  if (!iso) return Infinity;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return Infinity;
  return (now - at) / DAY_MS;
}

/**
 * Truncate to the first `max` characters, for the stats previews.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function preview(text, max = 40) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}
