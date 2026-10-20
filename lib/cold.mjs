/**
 * Cold-layer memory: the full-text archive, one file per local day under
 * `cold/YYYY-MM/YYYY-MM-DD.md`. Entries are appended with an ISO timestamp and
 * recalled by keyword across every month.
 *
 * @module lib/cold
 */
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
 * Matching is case-insensitive substring search; several words separated by
 * spaces must all appear in the same entry. An entry matches on its content or
 * its tag. Results are newest first.
 * @param {{ keyword?: unknown, limit?: unknown }} input
 * @returns {Promise<{
 *   ok: true, keyword: string, tokens: string[], scannedFiles: number,
 *   scannedEntries: number, matched: number, returned: number,
 *   items: Array<{ date: string, time: string, tag: string, content: string }>
 * }>}
 */
export function recall({ keyword, limit } = {}) {
  return serialize(() => {
    const text = String(keyword ?? '').trim();
    if (text === '') {
      throw new Error('关键词不能为空：mem_recall 需要一个检索词；多个词用空格分隔，条目需同时包含全部词。');
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
        if (tokens.every((token) => haystack.includes(token))) {
          hits.push({ date: dateKey, ...entry });
        }
      }
    }

    hits.sort((left, right) => {
      if (left.time === right.time) return 0;
      return left.time < right.time ? 1 : -1;
    });

    return {
      ok: true,
      keyword: text,
      tokens,
      scannedFiles: files.length,
      scannedEntries,
      matched: hits.length,
      returned: Math.min(hits.length, size),
      items: hits.slice(0, size),
    };
  });
}
