/**
 * Cold-layer memory: the full-text archive, one file per local day under
 * `cold/YYYY-MM/YYYY-MM-DD.md`. Entries are appended with an ISO timestamp and
 * recalled by keyword across every month.
 *
 * v1.2 adds three things here:
 *
 *  - **Source evidence**: `mem_write` may carry `{ conv, seq, msgId }`, which is
 *    appended to the line as `〔src:conv#seq/msgId〕` and parsed back into
 *    `entry.source`. Old lines keep parsing, with `source: null`.
 *  - **Usage trace**: every returned entry is recorded in `usage.json`
 *    (`hits`, `lastHitAt`, `weight`), which is what the hot layer later uses to
 *    decide what may be evicted.
 *  - **Bigram ranking**: a single Chinese keyword of three or more characters is
 *    cut into bigrams, so 「翻唱权重」 also finds an entry that says
 *    「翻唱…权重」. Results are ranked by
 *    `matched * 2 + weight / 5 + recencyBoost`.
 *
 * @module lib/cold
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  EMPTY_TAG,
  formatEntryLine,
  normalizeSource,
  parseEntryLine,
  parseEntryLines,
  sameSource,
} from './entry.mjs';
import { appendCandidateSync } from './hot.mjs';
import {
  charCount,
  coldFilePath,
  coldRootDir,
  listDirectories,
  listMarkdownFiles,
  localDateKey,
  normalizeLimit,
  parseDateKey,
  readTextIfExists,
  serialize,
  writeAtomic,
} from './paths.mjs';
import { DEFAULT_WEIGHT, allUsageRecords, contentKey, touchEntry } from './usage.mjs';

/** Default page size for mem_recall. */
export const DEFAULT_RECALL_LIMIT = 10;
/** Upper bound for a caller-supplied recall page size. */
export const MAX_RECALL_LIMIT = 50;
/** Maximum Unicode characters accepted in one cold-layer entry. */
export const MAX_COLD_CHARS = 4000;
/** Default day span for mem_recent. */
export const DEFAULT_RECENT_DAYS = 3;
/** Default page size for mem_recent. */
export const DEFAULT_RECENT_LIMIT = 50;
/** Default page size for mem_by_tag. */
export const DEFAULT_TAG_LIMIT = 20;
/** Default page size for mem_by_date. */
export const DEFAULT_DATE_LIMIT = 50;
/** Upper bound for the read-only window queries (recent / by_tag / by_date). */
export const MAX_QUERY_LIMIT = 200;

const DAY_MS = 86400000;

/** Any CJK character: bigram splitting only applies to Chinese keywords. */
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Normalize entry text into one line and enforce the length cap.
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeColdText(input) {
  const text = String(input ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') {
    throw new Error('内容不能为空：mem_write 需要一条非空的记忆正文。');
  }
  const length = charCount(text);
  if (length > MAX_COLD_CHARS) {
    throw new Error(`内容过长：${length} 字，单条上限 ${MAX_COLD_CHARS} 字，请拆成几条再写。`);
  }
  return text;
}

/**
 * Normalize a tag into a safe bracket field.
 * @param {unknown} input
 * @returns {string} `-` when empty
 */
export function normalizeTag(input) {
  if (input === undefined || input === null) return EMPTY_TAG;
  const tag = String(input)
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[[\]]/g, '')
    .trim();
  return tag === '' ? EMPTY_TAG : tag;
}

/**
 * Header written at the top of one day file.
 * @param {string} dateKey
 * @returns {string}
 */
function dayHeader(dateKey) {
  return `# ${dateKey} 记忆\n`;
}

/**
 * Read every entry of one local day.
 * @param {string} dateKey `YYYY-MM-DD`
 * @returns {Array<{ date: string, time: string, tag: string, content: string, source: object | null }>}
 */
export function readColdEntries(dateKey) {
  const text = readTextIfExists(coldFilePath(dateKey));
  return parseEntryLines(text).map((entry) => ({ date: dateKey, ...entry }));
}

/**
 * Number of entries already stored for one local day.
 * @param {string} dateKey
 * @returns {number}
 */
export function countColdEntries(dateKey) {
  return readColdEntries(dateKey).length;
}

/**
 * Every cold-layer file, oldest first (path order matches date order).
 * @returns {string[]}
 */
export function listColdFiles() {
  const files = [];
  for (const monthDir of listDirectories(coldRootDir())) {
    for (const file of listMarkdownFiles(monthDir)) files.push(file);
  }
  return files.sort();
}

/**
 * Date key encoded in one cold-layer file path.
 * @param {string} file
 * @returns {string}
 */
function dateKeyOfFile(file) {
  return path.basename(file, '.md');
}

/**
 * Rewrite the source marker of one existing line, leaving its text alone.
 * @param {string} dateKey
 * @param {{ time: string, tag: string, content: string }} entry
 * @param {{ conv: string, seq: number | string, msgId: string }} source
 * @returns {boolean} whether a line was rewritten
 */
function updateEntrySource(dateKey, entry, source) {
  const file = coldFilePath(dateKey);
  const text = readTextIfExists(file);
  if (text === null) return false;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseEntryLine(lines[index]);
    if (!parsed) continue;
    if (parsed.time !== entry.time || parsed.tag !== entry.tag || parsed.content !== entry.content) {
      continue;
    }
    lines[index] = formatEntryLine({ ...parsed, source });
    writeAtomic(file, lines.join('\n'));
    return true;
  }
  return false;
}

/**
 * Append one memory to the cold layer, synchronously.
 *
 * The caller owns serialization: this runs inside another `serialize` task.
 * @param {{ text?: unknown, tag?: unknown, important?: unknown, source?: unknown, config: Record<string, any> }} input
 * @returns {{
 *   ok: true, added: boolean, date: string, time: string, tag: string,
 *   important: boolean, candidateIndex: number, hotChars: number,
 *   hotLimit: number, overLimit: boolean, hint: string,
 *   source: object | null, sourceUpdated: boolean, message: string
 * }}
 */
export function appendColdSync({ text, tag, important = false, source, config }) {
  const content = normalizeColdText(text);
  const normalizedTag = normalizeTag(tag);
  const wantedSource = normalizeSource(source);
  const now = new Date();
  const dateKey = localDateKey(now);
  const time = now.toISOString();
  const wantedImportant = important === true;
  const file = coldFilePath(dateKey);
  const existing = readColdEntries(dateKey);
  const duplicate = existing.find(
    (entry) => entry.tag === normalizedTag && entry.content === content,
  );

  if (duplicate) {
    const sourceUpdated =
      wantedSource !== null && !sameSource(duplicate.source, wantedSource)
        ? updateEntrySource(dateKey, duplicate, wantedSource)
        : false;
    const promotion = wantedImportant
      ? appendCandidateSync({ time: duplicate.time, tag: normalizedTag, content, config })
      : null;
    const keptSource = sourceUpdated ? wantedSource : duplicate.source;
    return {
      ok: true,
      added: false,
      date: dateKey,
      time: duplicate.time,
      tag: normalizedTag,
      important: wantedImportant,
      candidateIndex: promotion ? promotion.candidateIndex : 0,
      hotChars: promotion ? promotion.chars : 0,
      hotLimit: config.hotLimit,
      overLimit: promotion ? promotion.overLimit : false,
      hint: promotion ? promotion.hint : '',
      source: keptSource ?? null,
      sourceUpdated,
      message: `${dateKey} 已有完全相同的条目，未重复写入。`
        + (sourceUpdated ? '已更新该条目的来源标记。' : '')
        + (promotion ? `已放入热层候选第 ${promotion.candidateIndex} 条。` : ''),
    };
  }

  const current = readTextIfExists(file);
  const base = current === null || current.trim() === '' ? `${dayHeader(dateKey)}\n` : current;
  const separator = base.endsWith('\n') ? '' : '\n';
  const line = formatEntryLine({ time, tag: normalizedTag, content, source: wantedSource });
  writeAtomic(file, `${base}${separator}${line}\n`);

  const promotion = wantedImportant
    ? appendCandidateSync({ time, tag: normalizedTag, content, config })
    : null;

  const hint = promotion ? promotion.hint : '';
  const message = `已写入 ${dateKey} 冷层第 ${existing.length + 1} 条。`
    + (wantedSource ? `来源 ${wantedSource.conv}#${wantedSource.seq}。` : '')
    + (promotion ? `同时放入热层候选第 ${promotion.candidateIndex} 条。` : '')
    + (hint === '' ? '' : ` ${hint}`);

  return {
    ok: true,
    added: true,
    date: dateKey,
    time,
    tag: normalizedTag,
    important: wantedImportant,
    candidateIndex: promotion ? promotion.candidateIndex : 0,
    hotChars: promotion ? promotion.chars : 0,
    hotLimit: config.hotLimit,
    overLimit: promotion ? promotion.overLimit : false,
    hint,
    source: wantedSource,
    sourceUpdated: false,
    message,
  };
}

/**
 * Append one memory to the cold layer.
 * @param {{ text?: unknown, tag?: unknown, important?: unknown, source?: unknown, config: Record<string, any> }} input
 * @returns {Promise<ReturnType<typeof appendColdSync>>}
 */
export function appendCold(input) {
  return serialize(() => appendColdSync(input));
}

/**
 * Cut one Chinese keyword into unique bigrams.
 * @param {string} token lowercased keyword
 * @returns {string[]}
 */
function bigrams(token) {
  const chars = Array.from(token);
  const seen = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) {
    seen.add(`${chars[index]}${chars[index + 1]}`);
  }
  return [...seen];
}

/**
 * Ranking bonus for a recent entry: 3 within 30 days, 1 within 90, else 0.
 * @param {string} time ISO stamp
 * @param {number} now
 * @returns {number}
 */
function recencyBoost(time, now) {
  const at = new Date(time).getTime();
  if (Number.isNaN(at)) return 0;
  const days = (now - at) / DAY_MS;
  if (days <= 30) return 3;
  if (days <= 90) return 1;
  return 0;
}

/**
 * Recall cold-layer entries across every month by keyword.
 *
 * Matching is case-insensitive substring search on content or tag. Several
 * words separated by spaces are combined with AND by default; `mode: 'or'` (or
 * its alias `any`) accepts entries that contain any one of them. A single
 * Chinese keyword of three or more characters is additionally cut into bigrams
 * so partial matches still rank.
 *
 * Results are ranked by `matched * 2 + weight / 5 + recencyBoost`, ties broken
 * newest first, and every returned entry is recorded in the usage ledger.
 * @param {{ keyword?: unknown, limit?: unknown, mode?: unknown, config?: Record<string, any> }} input
 * @returns {Promise<{
 *   ok: true, keyword: string, mode: 'and' | 'or' | 'any', tokens: string[],
 *   probes: string[], scannedFiles: number, scannedEntries: number, matched: number,
 *   returned: number, items: Array<object>
 * }>}
 */
export function recall({ keyword, limit, mode = 'and', config = {} } = {}) {
  return serialize(() => {
    const text = String(keyword ?? '').trim();
    if (text === '') {
      throw new Error('关键词不能为空：mem_recall 需要一个检索词；多个词用空格分隔。');
    }
    const wantedMode = String(mode ?? 'and').trim().toLowerCase();
    if (wantedMode !== 'and' && wantedMode !== 'or' && wantedMode !== 'any') {
      throw new Error(`mode 必须是 and、or 或 any（收到 ${JSON.stringify(mode)}）。`);
    }
    const tokens = text
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const useBigrams = tokens.length === 1 && charCount(text) >= 3 && CJK_PATTERN.test(tokens[0]);
    const probes = useBigrams ? bigrams(tokens[0]) : tokens;
    const anyMode = wantedMode !== 'and';
    const size = normalizeLimit(limit, DEFAULT_RECALL_LIMIT, MAX_RECALL_LIMIT);
    const files = listColdFiles();
    const usage = allUsageRecords(config);
    const now = Date.now();
    const hits = [];
    let scannedEntries = 0;

    for (const file of files) {
      const dateKey = dateKeyOfFile(file);
      const entries = parseEntryLines(readTextIfExists(file));
      scannedEntries += entries.length;
      for (const entry of entries) {
        const haystack = `${entry.tag} ${entry.content}`.toLowerCase();
        const matched = probes.filter((probe) => haystack.includes(probe)).length;
        const ok = anyMode ? matched > 0 : probes.length > 0 && matched === probes.length;
        if (!ok) continue;
        const record = usage[contentKey(entry.content)];
        const weight = record ? record.weight : DEFAULT_WEIGHT;
        hits.push({
          date: dateKey,
          ...entry,
          matched,
          score: Math.round((matched * 2 + weight / 5 + recencyBoost(entry.time, now)) * 100) / 100,
        });
      }
    }

    hits.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.time === right.time) return 0;
      return left.time < right.time ? 1 : -1;
    });

    const page = hits.slice(0, size);
    for (const item of page) touchEntry(config, contentKey(item.content));

    return {
      ok: true,
      keyword: text,
      mode: wantedMode,
      tokens,
      probes,
      scannedFiles: files.length,
      scannedEntries,
      matched: hits.length,
      returned: page.length,
      items: page,
    };
  });
}

/**
 * Sort entries newest first, comparing ISO timestamps as strings.
 * @param {Array<{ time: string }>} items
 * @returns {Array<{ time: string }>}
 */
function newestFirst(items) {
  return items.slice().sort((left, right) => {
    if (left.time === right.time) return 0;
    return left.time < right.time ? 1 : -1;
  });
}

/**
 * Attach the owning date key to every entry of one cold file.
 * @param {string} file
 * @param {Array<{ time: string, tag: string, content: string }>} entries
 * @returns {Array<object>}
 */
function withDate(file, entries) {
  const date = dateKeyOfFile(file);
  return entries.map((entry) => ({ date, ...entry }));
}

/**
 * Record every returned entry in the usage ledger, ignoring ledger failures so
 * a query can never fail because of it.
 * @param {Record<string, any>} config
 * @param {Array<{ content: string }>} items
 */
function traceUsage(config, items) {
  for (const item of items) touchEntry(config, contentKey(item.content));
}

/**
 * Read every cold-layer entry whose date falls inside `[fromKey, toKey]`.
 * Absent days are skipped; nothing is created.
 * @param {string[]} dateKeys
 * @returns {{ files: number, items: Array<object> }}
 */
function readDateKeys(dateKeys) {
  const items = [];
  let files = 0;
  for (const dateKey of dateKeys) {
    if (!existsSync(coldFilePath(dateKey))) continue;
    files += 1;
    items.push(...readColdEntries(dateKey));
  }
  return { files, items };
}

/**
 * Return the most recent cold-layer entries from the last `days` calendar days
 * (today included), newest first. The cold layer is never modified; the usage
 * ledger records the hits.
 * @param {{ days?: unknown, limit?: unknown, config?: Record<string, any> }} input
 * @returns {Promise<{
 *   ok: true, days: number, from: string, to: string, scannedFiles: number,
 *   scannedEntries: number, matched: number, returned: number, items: Array<object>
 * }>}
 */
export function recent({ days = DEFAULT_RECENT_DAYS, limit, config = {} } = {}) {
  return serialize(() => {
    const size = normalizeLimit(limit, DEFAULT_RECENT_LIMIT, MAX_QUERY_LIMIT);
    const span = Number(days ?? DEFAULT_RECENT_DAYS);
    if (!Number.isInteger(span) || span < 1 || span > 365) {
      throw new Error(`days 必须是 1–365 的整数（收到 ${JSON.stringify(days)}）。`);
    }
    const today = new Date();
    const keys = [];
    for (let offset = span - 1; offset >= 0; offset -= 1) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      keys.push(localDateKey(day));
    }
    const { files, items } = readDateKeys(keys);
    const sorted = newestFirst(items).slice(0, size);
    traceUsage(config, sorted);
    return {
      ok: true,
      days: span,
      from: keys[0],
      to: keys[keys.length - 1],
      scannedFiles: files,
      scannedEntries: items.length,
      matched: items.length,
      returned: sorted.length,
      items: sorted,
    };
  });
}

/**
 * Return cold-layer entries carrying one exact tag (case-insensitive),
 * newest first. `-` selects entries without a tag. The cold layer is never
 * modified; the usage ledger records the hits.
 * @param {{ tag?: unknown, limit?: unknown, config?: Record<string, any> }} input
 * @returns {Promise<{
 *   ok: true, tag: string, scannedFiles: number, scannedEntries: number,
 *   matched: number, returned: number, items: Array<object>
 * }>}
 */
export function byTag({ tag, limit, config = {} } = {}) {
  return serialize(() => {
    const raw = String(tag ?? '').trim();
    if (raw === '') {
      throw new Error('tag 不能为空：mem_by_tag 需要一个标签；用 - 取没有标签的条目。');
    }
    const normalizedTag = normalizeTag(raw);
    const wanted = normalizedTag.toLowerCase();
    const size = normalizeLimit(limit, DEFAULT_TAG_LIMIT, MAX_QUERY_LIMIT);
    const files = listColdFiles();
    const items = [];
    for (const file of files) {
      items.push(...withDate(file, parseEntryLines(readTextIfExists(file))));
    }
    const hits = items.filter((entry) => entry.tag.toLowerCase() === wanted);
    const sorted = newestFirst(hits).slice(0, size);
    traceUsage(config, sorted);
    return {
      ok: true,
      tag: normalizedTag,
      scannedFiles: files.length,
      scannedEntries: items.length,
      matched: hits.length,
      returned: sorted.length,
      items: sorted,
    };
  });
}

/**
 * Return cold-layer entries inside a closed local-date range `[from, to]`,
 * newest first. Both bounds are `YYYY-MM-DD`. The cold layer is never modified;
 * the usage ledger records the hits.
 * @param {{ from?: unknown, to?: unknown, limit?: unknown, config?: Record<string, any> }} input
 * @returns {Promise<{
 *   ok: true, from: string, to: string, scannedFiles: number,
 *   scannedEntries: number, matched: number, returned: number, items: Array<object>
 * }>}
 */
export function byDate({ from, to, limit, config = {} } = {}) {
  return serialize(() => {
    const size = normalizeLimit(limit, DEFAULT_DATE_LIMIT, MAX_QUERY_LIMIT);
    const fromKey = String(from ?? '').trim();
    const toKey = String(to ?? '').trim();
    const fromDate = parseDateKey(fromKey);
    const toDate = parseDateKey(toKey);
    if (!fromDate) {
      throw new Error(`from 必须是 YYYY-MM-DD 的真实日期（收到 ${JSON.stringify(from)}）。`);
    }
    if (!toDate) {
      throw new Error(`to 必须是 YYYY-MM-DD 的真实日期（收到 ${JSON.stringify(to)}）。`);
    }
    if (fromDate.getTime() > toDate.getTime()) {
      throw new Error(`from 不能晚于 to（${fromKey} > ${toKey}）。`);
    }
    const keys = [];
    for (
      let day = fromDate;
      day.getTime() <= toDate.getTime();
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    ) {
      keys.push(localDateKey(day));
      if (keys.length > 3660) {
        throw new Error('日期区间过大：最多 3660 天（约 10 年），请缩小 from/to。');
      }
    }
    const { files, items } = readDateKeys(keys);
    const sorted = newestFirst(items).slice(0, size);
    traceUsage(config, sorted);
    return {
      ok: true,
      from: keys[0],
      to: keys[keys.length - 1],
      scannedFiles: files,
      scannedEntries: items.length,
      matched: items.length,
      returned: sorted.length,
      items: sorted,
    };
  });
}
