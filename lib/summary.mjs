/**
 * Hierarchical summaries: day -> week -> month.
 *
 * A summary is extractive on purpose. It copies entries from the layer below
 * (the day's cold file, the week's day summaries, the month's week summaries),
 * truncates each body to a fixed budget, and records how many entries were
 * dropped. It never invents a sentence that is not in the source, so a summary
 * cannot drift away from what was actually stored.
 *
 * @module lib/summary
 */
import { formatEntryLine, parseEntryLines } from './entry.mjs';
import { readColdEntries } from './cold.mjs';
import {
  charCount,
  dateKeysOfWeek,
  isoWeekDates,
  isoWeekKey,
  localDateKey,
  localMonthKey,
  parseDateKey,
  readTextIfExists,
  serialize,
  summaryFilePath,
  weekKeysOfMonth,
  writeAtomic,
} from './paths.mjs';

/** Supported summary layers. */
export const PERIODS = ['day', 'week', 'month'];

/** Total character budget of one summary body. */
export const SUMMARY_BUDGET = { day: 1500, week: 1000, month: 700 };

/** Maximum characters copied from one source entry. */
export const SUMMARY_ITEM_CHARS = { day: 120, week: 100, month: 80 };

/** Human labels for the three layers. */
const PERIOD_TITLE = { day: '日摘要', week: '周摘要', month: '月摘要' };

/**
 * Truncate to a character budget with a visible ellipsis.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join('')}…`;
}

/**
 * Local date key of one entry, falling back to the owning period.
 * @param {{ time: string }} entry
 * @param {string} fallback
 * @returns {string}
 */
function entryDate(entry, fallback) {
  const date = new Date(entry.time);
  return Number.isNaN(date.getTime()) ? fallback : localDateKey(date);
}

/**
 * Read the entries stored in one summary file.
 * @param {'day' | 'week' | 'month'} period
 * @param {string} key
 * @returns {Array<{ date: string, time: string, tag: string, content: string }>}
 */
export function readSummaryEntries(period, key) {
  const text = readTextIfExists(summaryFilePath(period, key));
  return parseEntryLines(text).map((entry) => ({ date: entryDate(entry, key), ...entry }));
}

/**
 * Collect the entries a day summary should cover.
 * @param {string} dateKey
 * @returns {Array<{ date: string, time: string, tag: string, content: string }>}
 */
function collectDayEntries(dateKey) {
  return readColdEntries(dateKey);
}

/**
 * Collect the entries a week summary should cover: the week's day summaries,
 * with a missing day falling back to that day's cold file.
 * @param {Date} date
 * @returns {Array<{ date: string, time: string, tag: string, content: string }>}
 */
function collectWeekEntries(date) {
  const entries = [];
  for (const dateKey of isoWeekDates(date)) {
    const daySummary = readSummaryEntries('day', dateKey);
    if (daySummary.length > 0) {
      entries.push(...daySummary);
      continue;
    }
    entries.push(...readColdEntries(dateKey));
  }
  return entries;
}

/**
 * Collect the entries a month summary should cover: the month's week
 * summaries, with a missing week falling back to its day summaries and then
 * to the cold files.
 * @param {string} monthKey
 * @returns {Array<{ date: string, time: string, tag: string, content: string }>}
 */
function collectMonthEntries(monthKey) {
  const entries = [];
  for (const weekKey of weekKeysOfMonth(monthKey)) {
    const weekEntries = readSummaryEntries('week', weekKey).filter((entry) =>
      entry.date.startsWith(monthKey),
    );
    if (weekEntries.length > 0) {
      entries.push(...weekEntries);
      continue;
    }
    for (const dateKey of dateKeysOfWeek(weekKey).filter((key) => key.startsWith(monthKey))) {
      const daySummary = readSummaryEntries('day', dateKey);
      if (daySummary.length > 0) entries.push(...daySummary);
      else entries.push(...readColdEntries(dateKey));
    }
  }
  return entries;
}

/**
 * Sort entries oldest first; unparseable timestamps keep their order at the end.
 * @param {Array<{ time: string }>} entries
 * @returns {Array<{ time: string }>}
 */
function sortByTime(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftTime = new Date(left.entry.time).getTime();
      const rightTime = new Date(right.entry.time).getTime();
      const leftValid = Number.isNaN(leftTime) ? Infinity : leftTime;
      const rightValid = Number.isNaN(rightTime) ? Infinity : rightTime;
      if (leftValid === rightValid) return left.index - right.index;
      return leftValid - rightValid;
    })
    .map((item) => item.entry);
}

/**
 * Render the extractive summary document.
 * @param {{
 *   period: 'day' | 'week' | 'month', key: string,
 *   sourceLabel: string, sourceCount: number,
 *   entries: Array<{ time: string, tag: string, content: string }>,
 *   perItem: number, budget: number, generatedAt: string,
 * }} input
 * @returns {{ content: string, kept: number, omitted: number }}
 */
function renderSummary({ period, key, sourceLabel, sourceCount, entries, perItem, budget, generatedAt }) {
  const lines = [];
  let used = 0;
  let kept = 0;

  for (const entry of entries) {
    const line = formatEntryLine({
      time: entry.time,
      tag: entry.tag,
      content: truncate(entry.content, perItem),
    });
    const cost = charCount(line) + 1;
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
    kept += 1;
  }

  const omitted = entries.length - kept;
  const header = [
    `# ${key} ${PERIOD_TITLE[period]}`,
    '',
    `来源：${sourceLabel}（共 ${sourceCount} 条）`,
    `生成：${generatedAt}`,
    '说明：以下条目由原文抽取，未新增内容；超出字数预算的条目整条省略。',
    '',
  ];
  const tail = omitted > 0 ? ['', `（另有 ${omitted} 条因字数预算省略）`] : [];
  return {
    content: `${header.join('\n')}${lines.join('\n')}${tail.join('\n')}\n`,
    kept,
    omitted,
  };
}

/**
 * Generate (or return an existing) summary for one period.
 * @param {{ period?: unknown, date?: unknown, force?: unknown }} input
 * @returns {Promise<{
 *   ok: true, period: 'day' | 'week' | 'month', key: string, path: string,
 *   created: boolean, sourceCount: number, entries: number, omitted: number,
 *   chars: number, content: string, message: string
 * }>}
 */
export function summarize({ period = 'day', date, force = false } = {}) {
  return serialize(() => {
    const wanted = String(period ?? 'day').trim().toLowerCase();
    if (!PERIODS.includes(wanted)) {
      throw new Error(`period 必须是 day、week 或 month（收到 ${JSON.stringify(period)}）。`);
    }

    let target = new Date();
    if (date !== undefined && date !== null && String(date).trim() !== '') {
      const parsed = parseDateKey(date);
      if (!parsed) {
        throw new Error(`date 必须是 YYYY-MM-DD 的真实日期（收到 ${JSON.stringify(date)}）。`);
      }
      target = parsed;
    }

    const key =
      wanted === 'day' ? localDateKey(target) : wanted === 'week' ? isoWeekKey(target) : localMonthKey(target);

    const entries =
      wanted === 'day'
        ? collectDayEntries(key)
        : wanted === 'week'
          ? collectWeekEntries(target)
          : collectMonthEntries(key);

    const sourceLabel =
      wanted === 'day'
        ? `cold/${key.slice(0, 7)}/${key}.md`
        : wanted === 'week'
          ? 'summaries/day（缺失时回退 cold）'
          : 'summaries/week（缺失时回退 summaries/day 与 cold）';

    const file = summaryFilePath(wanted, key);

    if (entries.length === 0) {
      return {
        ok: true,
        period: wanted,
        key,
        path: file,
        created: false,
        sourceCount: 0,
        entries: 0,
        omitted: 0,
        chars: 0,
        content: '',
        message: `${key} 没有可用的记录，未生成摘要。`,
      };
    }

    if (force !== true) {
      const existing = readTextIfExists(file);
      if (existing !== null && existing.trim() !== '') {
        const existingEntries = parseEntryLines(existing).length;
        return {
          ok: true,
          period: wanted,
          key,
          path: file,
          created: false,
          sourceCount: existingEntries,
          entries: existingEntries,
          omitted: 0,
          chars: charCount(existing),
          content: existing,
          message: `${key} 的摘要已存在（${existingEntries} 条），直接返回；需要重新生成请传 force=true。`,
        };
      }
    }

    const sorted = sortByTime(entries);
    const rendered = renderSummary({
      period: wanted,
      key,
      sourceLabel,
      sourceCount: sorted.length,
      entries: sorted,
      perItem: SUMMARY_ITEM_CHARS[wanted],
      budget: SUMMARY_BUDGET[wanted],
      generatedAt: new Date().toISOString(),
    });
    writeAtomic(file, rendered.content);

    return {
      ok: true,
      period: wanted,
      key,
      path: file,
      created: true,
      sourceCount: sorted.length,
      entries: rendered.kept,
      omitted: rendered.omitted,
      chars: charCount(rendered.content),
      content: rendered.content,
      message: `已生成 ${key} ${PERIOD_TITLE[wanted]}：${rendered.kept} 条（来源 ${sorted.length} 条）。`,
    };
  });
}
