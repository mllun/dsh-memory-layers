/**
 * Paths, dates, and small file helpers for dsh-memory-layers.
 *
 * Everything the plugin owns lives under one data directory, by default
 * `<DSH_HOME>/dsh-memory-layers/` (override with `$DSH_MEMORY_ROOT`):
 *
 *   <data dir>/
 *     hot.md                         核心记忆（热层正文 + 候选区）
 *     cold/YYYY-MM/YYYY-MM-DD.md     按月归档的冷层全文
 *     summaries/day/YYYY-MM-DD.md    日摘要
 *     summaries/week/YYYY-Www.md     周摘要
 *     summaries/month/YYYY-MM.md     月摘要
 *     usage.json                     召回留痕与条目权重（v1.2）
 *
 * Tools never accept a caller-supplied path, so every read and write stays
 * inside this directory. Hand-edited files remain readable: unknown lines are
 * ignored rather than treated as errors.
 *
 * @module lib/paths
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directory name under the DSH home. */
export const DATA_DIR_NAME = 'dsh-memory-layers';

/**
 * Absolute DSH home: `$DSH_HOME`, else `~/.dsh`.
 * @returns {string}
 */
export function dshHome() {
  const raw = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return raw === '' ? path.join(os.homedir(), '.dsh') : path.resolve(raw);
}

/**
 * Resolve the data root once: `$DSH_MEMORY_ROOT` when set, else `''` meaning
 * "keep the data under the DSH home". Relocated installs (data on another
 * drive) simply set the variable — no path is baked into the code.
 * @returns {string} absolute path, or `''`
 */
function resolveDataRoot() {
  const raw = typeof process.env.DSH_MEMORY_ROOT === 'string' ? process.env.DSH_MEMORY_ROOT.trim() : '';
  return raw === '' ? '' : path.resolve(raw);
}

/** Fixed data root, or `''` when the data lives under the DSH home. */
export const DATA_ROOT = resolveDataRoot();

/**
 * Plugin data directory: `$DSH_HOME/dsh-memory-layers` by default, or
 * `$DSH_MEMORY_ROOT/memory` when that variable is set.
 * @returns {string}
 */
export function dataDir() {
  return DATA_ROOT === '' ? path.join(dshHome(), DATA_DIR_NAME) : path.join(DATA_ROOT, 'memory');
}

/** Hot-layer file. @returns {string} */
export function hotFilePath() {
  return path.join(dataDir(), 'hot.md');
}

/**
 * Usage ledger: recall hits, last-hit time, and the decaying weight of every
 * cold entry. Missing or corrupt files are rebuilt on the fly.
 * @returns {string}
 */
export function usageFilePath() {
  return path.join(dataDir(), 'usage.json');
}

/** Root of the monthly cold archive. @returns {string} */
export function coldRootDir() {
  return path.join(dataDir(), 'cold');
}

/** One month directory of the cold archive. @returns {string} */
export function coldMonthDir(monthKey) {
  return path.join(coldRootDir(), monthKey);
}

/** Cold-layer file for one local date key (`YYYY-MM-DD`). @returns {string} */
export function coldFilePath(dateKey) {
  return path.join(coldMonthDir(dateKey.slice(0, 7)), `${dateKey}.md`);
}

/** Root of the three summary layers. @returns {string} */
export function summariesRootDir() {
  return path.join(dataDir(), 'summaries');
}

/** One summary layer directory (`day` / `week` / `month`). @returns {string} */
export function summaryDir(period) {
  return path.join(summariesRootDir(), period);
}

/** Summary file for one period key. @returns {string} */
export function summaryFilePath(period, key) {
  return path.join(summaryDir(period), `${key}.md`);
}

/**
 * mkdir -p and return the directory.
 * @param {string} dir
 * @returns {string}
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read a UTF-8 file, or `null` when it does not exist.
 * @param {string} file absolute path
 * @returns {string | null}
 */
export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * List `*.md` files directly inside a directory, sorted by name.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
export function listMarkdownFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * List immediate subdirectories, sorted by name.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
export function listDirectories(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Write atomically: temp file in the same directory, then rename. A crash
 * mid-write therefore cannot truncate the existing memory file.
 * @param {string} file absolute path
 * @param {string} content UTF-8 text
 */
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
}

/**
 * Count Unicode characters (code points), not UTF-16 units.
 * @param {string} text
 * @returns {number}
 */
export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}

/**
 * Local date key `YYYY-MM-DD`.
 * @param {Date} [date]
 * @returns {string}
 */
export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Local month key `YYYY-MM`.
 * @param {Date} [date]
 * @returns {string}
 */
export function localMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Parse a `YYYY-MM-DD` key into a local-midnight Date.
 * @param {unknown} key
 * @returns {Date | null} `null` when the key is not a real calendar date
 */
export function parseDateKey(key) {
  const text = String(key ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return null;
  return localDateKey(date) === text ? date : null;
}

/**
 * ISO-8601 week key `YYYY-Www`.
 * @param {Date} date
 * @returns {string}
 */
export function isoWeekKey(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = target.getDay() || 7;
  target.setDate(target.getDate() + 4 - weekday);
  const yearStart = new Date(target.getFullYear(), 0, 1);
  const week = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The seven local date keys (Monday..Sunday) of the ISO week containing `date`.
 * @param {Date} date
 * @returns {string[]}
 */
export function isoWeekDates(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = target.getDay() || 7;
  const monday = new Date(target);
  monday.setDate(target.getDate() - (weekday - 1));
  const keys = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + offset);
    keys.push(localDateKey(day));
  }
  return keys;
}

/**
 * The seven local date keys of one ISO week key (`YYYY-Www`).
 * @param {string} weekKey
 * @returns {string[]}
 */
export function dateKeysOfWeek(weekKey) {
  const match = /^(\d{4})-W(\d{2})$/.exec(String(weekKey ?? '').trim());
  if (!match) return [];
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(year, 0, 4);
  const jan4Weekday = jan4.getDay() || 7;
  const monday = new Date(year, 0, 4 - (jan4Weekday - 1));
  monday.setDate(monday.getDate() + (week - 1) * 7);
  const keys = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + offset);
    keys.push(localDateKey(day));
  }
  return keys;
}

/**
 * Every local date key of one month.
 * @param {string} monthKey `YYYY-MM`
 * @returns {string[]}
 */
export function dateKeysOfMonth(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? '').trim());
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(year, month, 0).getDate();
  const keys = [];
  for (let day = 1; day <= lastDay; day += 1) {
    keys.push(localDateKey(new Date(year, month - 1, day)));
  }
  return keys;
}

/**
 * Distinct ISO week keys touched by one month, in calendar order.
 * @param {string} monthKey `YYYY-MM`
 * @returns {string[]}
 */
export function weekKeysOfMonth(monthKey) {
  const seen = new Set();
  for (const dateKey of dateKeysOfMonth(monthKey)) {
    const date = parseDateKey(dateKey);
    if (date) seen.add(isoWeekKey(date));
  }
  return [...seen].sort();
}

/**
 * Serialize read-modify-write operations so concurrent tool calls cannot
 * interleave and lose an entry.
 * @template T
 * @param {() => T} task
 * @returns {Promise<T>}
 */
let queue = Promise.resolve();
export function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Validate a caller-supplied page size.
 * @param {unknown} limit
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function normalizeLimit(limit, fallback, max) {
  if (limit === undefined || limit === null) return fallback;
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`limit 必须是 ≥1 的整数（收到 ${JSON.stringify(limit)}）。`);
  }
  return Math.min(size, max);
}
