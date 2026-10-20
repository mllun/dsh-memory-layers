/**
 * Volume report for all three memory layers, used to decide when to trim the
 * hot layer or archive the cold one.
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

/** Summary layers reported by mem_stats. */
const SUMMARY_PERIODS = ['day', 'week', 'month'];

/**
 * Count entries and body characters of every Markdown file in one directory.
 * @param {string[]} files
 * @returns {{ entries: number, chars: number }}
 */
function countEntries(files) {
  let entries = 0;
  let chars = 0;
  for (const file of files) {
    const parsed = parseEntryLines(readTextIfExists(file));
    entries += parsed.length;
    for (const entry of parsed) chars += charCount(entry.content);
  }
  return { entries, chars };
}

/**
 * @param {number} limit hot-layer character budget
 * @returns {Promise<{
 *   ok: true, dataDir: string,
 *   hot: { path: string, chars: number, limit: number, overLimit: boolean, candidates: number },
 *   cold: { files: number, entries: number, chars: number, latest: string,
 *           months: Array<{ month: string, files: number, entries: number, chars: number }> },
 *   summaries: Record<'day' | 'week' | 'month', { files: number, chars: number, latest: string }>
 * }>}
 */
export function memoryStats(limit) {
  return serialize(() => {
    const hot = readHotState();
    const hotChars = charCount(hot.body);

    const months = [];
    let coldFiles = 0;
    let coldEntries = 0;
    let coldChars = 0;
    let coldLatest = '';
    for (const monthDir of listDirectories(coldRootDir())) {
      const files = listMarkdownFiles(monthDir);
      const counted = countEntries(files);
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

    return {
      ok: true,
      dataDir: dataDir(),
      hot: {
        path: hot.path,
        chars: hotChars,
        limit,
        overLimit: hotChars > limit,
        candidates: hot.candidates.length,
      },
      cold: {
        files: coldFiles,
        entries: coldEntries,
        chars: coldChars,
        latest: coldLatest,
        months,
      },
      summaries,
    };
  });
}
