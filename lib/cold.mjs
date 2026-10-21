/**
 * Cold-layer memory: the full-text archive, one file per local day under
 * `cold/YYYY-MM/YYYY-MM-DD.md`. Entries are appended with an ISO timestamp and
 * recalled by keyword across every month.
 *
 * @module lib/cold
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EMPTY_TAG, formatEntryLine, parseEntryLines } from './entry.mjs';
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
 * @returns {Array<{ date: string, time: string, tag: string, content: string }>}
 */
export function readColdEntries(dateKey) {
  const text = readTextIfExists(coldFilePath(dateKey));
  return parseEntryLines(text).map((entry) => ({ date: dateKey, ...entry }));
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
 * Append one memory to the cold layer.
 * @param {{ text?: unknown, tag?: unknown, important?: unknown, hotLimit: number }} input
 * @returns {Promise<{
 *   ok: true, added: boolean, date: string, time: string, tag: string,
 *   important: boolean, candidateIndex: number, hotChars: number,
 *   hotLimit: number, overLimit: boolean, hint: string, message: string
 * }>}
 */
export function appendCold({ text, tag, important = false, hotLimit }) {
  return serialize(() => {
    const content = normalizeColdText(text);
    const normalizedTag = normalizeTag(tag);
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
      const promotion = wantedImportant
        ? appendCandidateSync({ time: duplicate.time, tag: normalizedTag, content, limit: hotLimit })
        : null;
      return {
        ok: true,
        added: false,
        date: dateKey,
        time: duplicate.time,
        tag: normalizedTag,
        important: wantedImportant,
        candidateIndex: promotion ? promotion.candidateIndex : 0,
        hotChars: promotion ? promotion.chars : 0,
        hotLimit,
        overLimit: promotion ? promotion.overLimit : false,
        hint: promotion ? promotion.hint : '',
        message: `${dateKey} 已有完全相同的条目，未重复写入。`
          + (promotion ? `已放入热层候选第 ${promotion.candidateIndex} 条。` : ''),
      };
    }

    const current = readTextIfExists(file);
    const base = current === null || current.trim() === '' ? `${dayHeader(dateKey)}\n` : current;
    const separator = base.endsWith('\n') ? '' : '\n';
    const line = formatEntryLine({ time, tag: normalizedTag, content });
    writeAtomic(file, `${base}${separator}${line}\n`);

    const promotion = wantedImportant
      ? appendCandidateSync({ time, tag: normalizedTag, content, limit: hotLimit })
      : null;

    const hint = promotion ? promotion.hint : '';
    const message = `已写入 ${dateKey} 冷层第 ${existing.length + 1} 条。`
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
      hotLimit,
      overLimit: promotion ? promotion.overLimit : false,
      hint,
      message,
    };
  });
}

/**
 * Recall cold-layer entries across every month by keyword.
 *
 * Matching is case-insensitive substring search on content or tag. Several
 * words separated by spaces are combined with AND by default; `mode: 'or'`
 * accepts entries that contain any one of them. Results are newest first.
 * @param {{ keyword?: unknown, limit?: unknown, mode?: unknown }} input
 * @returns {Promise<{
 *   ok: true, keyword: string, mode: 'and' | 'or', tokens: string[],
 *   scannedFiles: number, scannedEntries: number, matched: number,
 *   returned: number,
 *   items: Array<{ date: string, time: string, tag: string, content: string }>
 * }>}
 */
export function recall({ keyword, limit, mode = 'and' } = {}) {
  return serialize(() => {
    const text = String(keyword ?? '').trim();
    if (text === '') {
      throw new Error('关键词不能为空：mem_recall 需要一个检索词；多个词用空格分隔。');
    }
    const wantedMode = String(mode ?? 'and').trim().toLowerCase();
    if (wantedMode !== 'and' && wantedMode !== 'or') {
      throw new Error(`mode 必须是 and 或 or（收到 ${JSON.stringify(mode)}）。`);
    }
    const tokens = text
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const size = normalizeLimit(limit, DEFAULT_RECALL_LIMIT, MAX_RECALL_LIMIT);
    const files = listColdFiles();
    const hits = [];
    let scannedEntries = 0;

    for (const file of files) {
      const dateKey = dateKeyOfFile(file);
      const entries = parseEntryLines(readTextIfExists(file));
      scannedEntries += entries.length;
      for (const entry of entries) {
        const haystack = `${entry.tag} ${entry.content}`.toLowerCase();
        const matched = wantedMode === 'or'
          ? tokens.some((token) => haystack.includes(token))
          : tokens.every((token) => haystack.includes(token));
        if (matched) hits.push({ date: dateKey, ...entry });
      }
    }

    hits.sort((left, right) => {
      if (left.time === right.time) return 0;
      return left.time < right.time ? 1 : -1;
    });

    return {
      ok: true,
      keyword: text,
      mode: wantedMode,
      tokens,
      scannedFiles: files.length,
      scannedEntries,
      matched: hits.length,
      returned: Math.min(hits.length, size),
      items: hits.slice(0, size),
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
 * @returns {Array<{ date: string, time: string, tag: string, content: string }>}
 */
function withDate(file, entries) {
  const date = dateKeyOfFile(file);
  return entries.map((entry) => ({ date, ...entry }));
}

/**
 * Read every cold-layer entry whose date falls inside `[fromKey, toKey]`.
 * Absent days are skipped; nothing is created.
 * @param {string[]} dateKeys
 * @returns {{ files: number, items: Array<{ date: string, time: string, tag: string, content: string }> }}
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
 * (today included), newest first. Read-only.
 * @param {{ days?: unknown, limit?: unknown }} input
 * @returns {Promise<{
 *   ok: true, days: number, from: string, to: string, scannedFiles: number,
 *   scannedEntries: number, matched: number, returned: number,
 *   items: Array<{ date: string, time: string, tag: string, content: string }>
 * }>}
 */
export function recent({ days = DEFAULT_RECENT_DAYS, limit } = {}) {
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
 * newest first. `-` selects entries without a tag. Read-only.
 * @param {{ tag?: unknown, limit?: unknown }} input
 * @returns {Promise<{
 *   ok: true, tag: string, scannedFiles: number, scannedEntries: number,
 *   matched: number, returned: number,
 *   items: Array<{ date: string, time: string, tag: string, content: string }>
 * }>}
 */
export function byTag({ tag, limit } = {}) {
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
 * newest first. Both bounds are `YYYY-MM-DD`. Read-only.
 * @param {{ from?: unknown, to?: unknown, limit?: unknown }} input
 * @returns {Promise<{
 *   ok: true, from: string, to: string, scannedFiles: number,
 *   scannedEntries: number, matched: number, returned: number,
 *   items: Array<{ date: string, time: string, tag: string, content: string }>
 * }>}
 */
export function byDate({ from, to, limit } = {}) {
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
