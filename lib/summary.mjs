/**
 * Hierarchical summaries: day -> week -> month.
 *
 * A summary is extractive on purpose. It copies entries from the layer below
 * (the day's cold file, the week's day summaries, the month's week summaries),
 * truncates each body to a fixed budget, and records how many lines were
 * dropped. It never invents a sentence that is not in the source, so a summary
 * cannot drift away from what was actually stored.
 *
 * v1.2 makes each layer compress harder than the one below it:
 *
 *  - **day**: every entry survives, but only as its tag plus first sentence
 *    (at most 40 characters);
 *  - **week**: entries sharing a tag collapse into one line holding the first
 *    sentence of the earliest and of the latest entry;
 *  - **month**: only `约定` / `重要` / `翻唱` keep a line of their own, every
 *    other tag becomes one `共 N 条` count line.
 *
 * The header always carries `压缩比：原 N 条 → 保留 M 行`, and the three most
 * frequent tags of the period are appended to the hot-layer topic index so a
 * later search can jump straight to the right month.
 *
 * @module lib/summary
 */
import { formatEntryLine, parseEntryLines } from './entry.mjs';
import { readColdEntries } from './cold.mjs';
import { appendTopicsSync } from './hot.mjs';
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

/** Characters kept from each entry's first sentence. */
export const SENTENCE_CHARS = 40;

/** Tags that keep their own line in a month summary. */
export const MONTH_KEEP_TAGS = ['约定', '重要', '翻唱'];

/** How many frequent tags get pushed into the hot topic index. */
export const TOPIC_SUGGESTIONS = 3;

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
 * First sentence of a body, truncated. Splits on Chinese and Latin sentence
 * punctuation; a body without punctuation is returned whole (truncated).
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function firstSentence(text, max = SENTENCE_CHARS) {
  const raw = String(text ?? '');
  const head = raw.split(/[。！？!?；;\n]/).find((part) => part.trim() !== '') ?? raw;
  return truncate(head.trim(), max);
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
 * @returns {Array<object>}
 */
function collectDayEntries(dateKey) {
  return readColdEntries(dateKey);
}

/**
 * Collect the entries a week summary should cover: the week's day summaries,
 * with a missing day falling back to that day's cold file.
 * @param {Date} date
 * @returns {Array<object>}
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
 * @returns {Array<object>}
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
 * Day layer: one line per entry, tag plus first sentence.
 * @param {Array<{ time: string, tag: string, content: string }>} entries
 * @returns {Array<{ time: string, tag: string, content: string }>}
 */
function dayLines(entries) {
  return entries.map((entry) => ({
    time: entry.time,
    tag: entry.tag,
    content: firstSentence(entry.content),
  }));
}

/**
 * Week layer: one line per tag, holding the first sentence of the earliest and
 * of the latest entry carrying it.
 * @param {Array<{ time: string, tag: string, content: string }>} entries
 * @returns {Array<{ time: string, tag: string, content: string }>}
 */
function weekLines(entries) {
  const order = [];
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.tag)) {
      groups.set(entry.tag, { first: entry, last: entry, count: 0 });
      order.push(entry.tag);
    }
    const group = groups.get(entry.tag);
    group.last = entry;
    group.count += 1;
  }
  return order.map((tag) => {
    const group = groups.get(tag);
    const head = firstSentence(group.first.content);
    const tail = firstSentence(group.last.content);
    const content = group.count === 1 || head === tail ? head : `${head} … ${tail}`;
    return { time: group.first.time, tag, content };
  });
}

/**
 * Month layer: `约定` / `重要` / `翻唱` keep their own line, every other tag
 * collapses into one count line.
 * @param {Array<{ time: string, tag: string, content: string }>} entries
 * @returns {Array<{ time: string, tag: string, content: string }>}
 */
function monthLines(entries) {
  const keep = new Set(MONTH_KEEP_TAGS);
  const kept = [];
  const order = [];
  const groups = new Map();
  for (const entry of entries) {
    if (keep.has(entry.tag)) {
      kept.push({ time: entry.time, tag: entry.tag, content: firstSentence(entry.content) });
      continue;
    }
    if (!groups.has(entry.tag)) {
      groups.set(entry.tag, { count: 0, last: entry });
      order.push(entry.tag);
    }
    const group = groups.get(entry.tag);
    group.count += 1;
    group.last = entry;
  }
  const counts = order.map((tag) => {
    const group = groups.get(tag);
    return { time: group.last.time, tag, content: `共 ${group.count} 条` };
  });
  return kept.concat(counts);
}

/**
 * Build the summary lines for one period.
 * @param {'day' | 'week' | 'month'} period
 * @param {Array<object>} entries
 * @returns {Array<{ time: string, tag: string, content: string }>}
 */
function buildLines(period, entries) {
  if (period === 'day') return dayLines(entries);
  if (period === 'week') return weekLines(entries);
  return monthLines(entries);
}

/**
 * Render the extractive summary document.
 * @param {{
 *   period: 'day' | 'week' | 'month', key: string,
 *   sourceLabel: string, sourceCount: number,
 *   lines: Array<{ time: string, tag: string, content: string }>,
 *   budget: number, generatedAt: string,
 * }} input
 * @returns {{ content: string, kept: number, omitted: number }}
 */
function renderSummary({ period, key, sourceLabel, sourceCount, lines, budget, generatedAt }) {
  const rendered = [];
  let used = 0;
  for (const line of lines) {
    const text = formatEntryLine(line);
    const cost = charCount(text) + 1;
    if (used + cost > budget) break;
    rendered.push(text);
    used += cost;
  }

  const omitted = lines.length - rendered.length;
  const header = [
    `# ${key} ${PERIOD_TITLE[period]}`,
    '',
    `来源：${sourceLabel}（共 ${sourceCount} 条）`,
    `压缩比：原 ${sourceCount} 条 → 保留 ${rendered.length} 行`,
    `生成：${generatedAt}`,
    '说明：以下条目由原文抽取，未新增内容；超出字数预算的行整行省略。',
    '',
  ];
  const tail = omitted > 0 ? ['', `（另有 ${omitted} 行因字数预算省略）`] : [];
  return {
    content: `${header.join('\n')}${rendered.join('\n')}${tail.join('\n')}\n`,
    kept: rendered.length,
    omitted,
  };
}

/**
 * The most frequent tags of one period, ignoring untagged entries.
 * @param {Array<{ tag: string }>} entries
 * @param {number} [limit]
 * @returns {string[]}
 */
function topTags(entries, limit = TOPIC_SUGGESTIONS) {
  const counts = new Map();
  for (const entry of entries) {
    if (!entry.tag || entry.tag === '-') continue;
    counts.set(entry.tag, (counts.get(entry.tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, limit)
    .map(([tag]) => tag);
}

/**
 * Generate (or return an existing) summary for one period, synchronously.
 *
 * The caller owns serialization: this runs inside another `serialize` task.
 * @param {{ period?: unknown, date?: unknown, force?: unknown }} input
 * @returns {{
 *   ok: true, period: 'day' | 'week' | 'month', key: string, path: string,
 *   created: boolean, sourceCount: number, entries: number, omitted: number,
 *   chars: number, content: string, topicsAdded: number, message: string
 * }}
 */
export function summarizeSync({ period = 'day', date, force = false } = {}) {
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
      topicsAdded: 0,
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
        topicsAdded: 0,
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
    lines: buildLines(wanted, sorted),
    budget: SUMMARY_BUDGET[wanted],
    generatedAt: new Date().toISOString(),
  });
  writeAtomic(file, rendered.content);

  const month = wanted === 'month' ? key : wanted === 'day' ? key.slice(0, 7) : localMonthKey(target);
  let topicsAdded = 0;
  try {
    const added = appendTopicsSync(topTags(sorted).map((topic) => ({ topic, month })));
    topicsAdded = added.length;
  } catch (error) {
    // A read-only summary must never fail because the hot layer could not be
    // updated; the summary itself is already on disk.
    void error;
  }

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
    topicsAdded,
    message: `已生成 ${key} ${PERIOD_TITLE[wanted]}：${rendered.kept} 行（来源 ${sorted.length} 条）`
      + (topicsAdded > 0 ? `，主题索引新增 ${topicsAdded} 行。` : '。'),
  };
}

/**
 * Generate (or return an existing) summary for one period.
 * @param {{ period?: unknown, date?: unknown, force?: unknown }} input
 * @returns {Promise<ReturnType<typeof summarizeSync>>}
 */
export function summarize(input) {
  return serialize(() => summarizeSync(input));
}
