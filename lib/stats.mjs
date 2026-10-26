/**
 * Volume report for all three memory layers, used to decide when to trim the
 * hot layer or archive the cold one.
 *
 * v1.2 adds the usage ledger to the report: the five most recalled entries, and
 * the five heaviest / lightest entries by weight. Content is resolved from the
 * cold layer (the ledger only stores a hash), so an entry that no longer exists
 * is simply left out.
 *
 * @module lib/stats
 */
import path from 'node:path';
import { parseEntryLines } from './entry.mjs';
import { readHotState } from './hot.mjs';
import {
  charCount,
  coldRootDir,
  dataDir,
  listDirectories,
  listMarkdownFiles,
  readTextIfExists,
  serialize,
  summaryDir,
} from './paths.mjs';
import { allUsageRecords, contentKey, preview } from './usage.mjs';

/** Summary layers reported by mem_stats. */
const SUMMARY_PERIODS = ['day', 'week', 'month'];

/** How many rows each usage list reports. */
const USAGE_ROWS = 5;

/**
 * Count entries and body characters of every Markdown file in one directory,
 * remembering each content hash so usage rows can show their text.
 * @param {string[]} files
 * @param {Map<string, string>} contents hash -> content
 * @returns {{ entries: number, chars: number }}
 */
function countEntries(files, contents) {
  let entries = 0;
  let chars = 0;
  for (const file of files) {
    const parsed = parseEntryLines(readTextIfExists(file));
    entries += parsed.length;
    for (const entry of parsed) {
      chars += charCount(entry.content);
      contents.set(contentKey(entry.content), entry.content);
    }
  }
  return { entries, chars };
}

/**
 * Build the three usage lists from the ledger.
 * @param {Record<string, any>} config
 * @param {Map<string, string>} contents
 * @returns {{
 *   topRecalled: Array<{ content: string, hits: number, lastHitAt: string }>,
 *   weightTop: Array<{ content: string, weight: number }>,
 *   weightBottom: Array<{ content: string, weight: number }>,
 * }}
 */
function usageReport(config, contents) {
  const rows = [];
  for (const [key, record] of Object.entries(allUsageRecords(config))) {
    const content = contents.get(key);
    if (content === undefined) continue;
    rows.push({ content: preview(content), hits: record.hits, lastHitAt: record.lastHitAt, weight: record.weight });
  }
  const topRecalled = rows
    .filter((row) => row.hits > 0)
    .sort((left, right) => right.hits - left.hits || (left.lastHitAt < right.lastHitAt ? 1 : -1))
    .slice(0, USAGE_ROWS)
    .map(({ content, hits, lastHitAt }) => ({ content, hits, lastHitAt }));
  const weightTop = rows
    .slice()
    .sort((left, right) => right.weight - left.weight || right.hits - left.hits)
    .slice(0, USAGE_ROWS)
    .map(({ content, weight }) => ({ content, weight }));
  const weightBottom = rows
    .slice()
    .sort((left, right) => left.weight - right.weight || right.hits - left.hits)
    .slice(0, USAGE_ROWS)
    .map(({ content, weight }) => ({ content, weight }));
  return { topRecalled, weightTop, weightBottom };
}

/**
 * @param {Record<string, any>} config normalized plugin config
 * @returns {Promise<{
 *   ok: true, dataDir: string,
 *   hot: { path: string, chars: number, limit: number, overLimit: boolean, candidates: number, topics: number },
 *   cold: { files: number, entries: number, chars: number, latest: string,
 *           months: Array<{ month: string, files: number, entries: number, chars: number }> },
 *   summaries: Record<'day' | 'week' | 'month', { files: number, chars: number, latest: string }>,
 *   topRecalled: Array<object>, weightTop: Array<object>, weightBottom: Array<object>,
 * }>}
 */
export function memoryStats(config) {
  return serialize(() => {
    const hot = readHotState(config);
    const hotChars = charCount(hot.body);
    const contents = new Map();

    const months = [];
    let coldFiles = 0;
    let coldEntries = 0;
    let coldChars = 0;
    let coldLatest = '';
    for (const monthDir of listDirectories(coldRootDir())) {
      const files = listMarkdownFiles(monthDir);
      const counted = countEntries(files, contents);
      coldFiles += files.length;
      coldEntries += counted.entries;
      coldChars += counted.chars;
      if (files.length > 0) coldLatest = path.basename(files[files.length - 1], '.md');
      months.push({
        month: path.basename(monthDir),
        files: files.length,
        entries: counted.entries,
        chars: counted.chars,
      });
    }

    const summaries = {};
    for (const period of SUMMARY_PERIODS) {
      const files = listMarkdownFiles(summaryDir(period));
      let chars = 0;
      for (const file of files) chars += charCount(readTextIfExists(file));
      summaries[period] = {
        files: files.length,
        chars,
        latest: files.length > 0 ? path.basename(files[files.length - 1], '.md') : '',
      };
    }

    const usage = usageReport(config, contents);

    return {
      ok: true,
      dataDir: dataDir(),
      hot: {
        path: hot.path,
        chars: hotChars,
        limit: config.hotLimit,
        overLimit: hotChars > config.hotLimit,
        candidates: hot.candidates.length,
        topics: hot.topics.length,
      },
      cold: {
        files: coldFiles,
        entries: coldEntries,
        chars: coldChars,
        latest: coldLatest,
        months,
      },
      summaries,
      ...usage,
    };
  });
}
