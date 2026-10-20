/**
 * The one line format shared by the cold layer, the hot-layer candidate area,
 * and every summary:
 *
 *   - [2026-10-21T03:10:00.000Z] [tag] content
 *
 * Time is an ISO-8601 UTC stamp, tag is a short label (`-` when unused), and
 * content is the rest of the line. Content may itself contain brackets, so the
 * pattern only treats the first two bracket groups specially.
 *
 * @module lib/entry
 */

/** `- [time] [tag] content`. */
const ENTRY_PATTERN = /^\s*-\s*\[([^\]]+)\]\s*\[([^\]]*)\]\s?(.*)$/;

/** Tag used when an entry has no label. */
export const EMPTY_TAG = '-';

/**
 * Parse one entry line.
 * @param {string} line
 * @returns {{ time: string, tag: string, content: string } | null} `null` for
 *   non-entry lines (headers, notes, blank lines)
 */
export function parseEntryLine(line) {
  const match = ENTRY_PATTERN.exec(String(line ?? ''));
  if (!match) return null;
  const time = match[1].trim();
  const tag = match[2].trim() === '' ? EMPTY_TAG : match[2].trim();
  const content = match[3].trim();
  if (time === '' || content === '') return null;
  return { time, tag, content };
}

/**
 * Parse every entry line in a document, ignoring headers and prose.
 * @param {string | null | undefined} text
 * @returns {Array<{ time: string, tag: string, content: string }>}
 */
export function parseEntryLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(parseEntryLine)
    .filter(Boolean);
}

/**
 * Format one entry as a single line.
 * @param {{ time: string, tag?: string, content: string }} entry
 * @returns {string}
 */
export function formatEntryLine(entry) {
  const tag = entry.tag && entry.tag !== '' ? entry.tag : EMPTY_TAG;
  return `- [${entry.time}] [${tag}] ${entry.content}`;
}

/**
 * Local `HH:mm` for an ISO stamp, falling back to the raw stamp.
 * @param {string} iso
 * @returns {string}
 */
export function localClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
