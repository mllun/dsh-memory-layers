/**
 * The one line format shared by the cold layer, the hot-layer candidate area,
 * and every summary:
 *
 *   - [2026-10-21T03:10:00.000Z] [tag] content
 *   - [2026-10-21T03:10:00.000Z] [tag] content 〔src:conv#seq〕
 *   - [2026-10-21T03:10:00.000Z] [tag] content 〔src:conv#seq/msgId〕
 *
 * Time is an ISO-8601 UTC stamp, tag is a short label (`-` when unused), and
 * content is the rest of the line. Content may itself contain brackets, so the
 * pattern only treats the first two bracket groups specially.
 *
 * The trailing `〔src:…〕` marker (v1.2) records where an entry came from —
 * conversation key, local sequence number, optionally a message id. It is
 * optional: lines written before v1.2 have no marker and parse with
 * `source: null`, so both shapes coexist in the same file.
 *
 * @module lib/entry
 */

/** `- [time] [tag] content`. */
const ENTRY_PATTERN = /^\s*-\s*\[([^\]]+)\]\s*\[([^\]]*)\]\s?(.*)$/;

/** Trailing `〔src:conv#seq/msgId〕`. */
const SOURCE_PATTERN = /\s*〔src:([^#〕]+)#([^〕/]*)(?:\/([^〕]+))?〕\s*$/;

/** Tag used when an entry has no label. */
export const EMPTY_TAG = '-';

/**
 * Normalize a `source` argument into `{ conv, seq, msgId }`.
 * @param {unknown} source
 * @returns {{ conv: string, seq: number | string, msgId: string } | null}
 */
export function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  const conv = String(source.conv ?? '').trim();
  if (conv === '') return null;
  const rawSeq = source.seq;
  const seqText = rawSeq === undefined || rawSeq === null ? '' : String(rawSeq).trim();
  const seq = /^\d+$/.test(seqText) ? Number(seqText) : seqText;
  const msgId = source.msgId === undefined || source.msgId === null ? '' : String(source.msgId).trim();
  return { conv, seq, msgId };
}

/**
 * Render the `〔src:…〕` marker, or `''` when the source is unusable.
 * @param {{ conv: string, seq: number | string, msgId?: string } | null | undefined} source
 * @returns {string}
 */
export function formatSource(source) {
  const normalized = normalizeSource(source);
  if (!normalized) return '';
  const tail = normalized.msgId === '' ? '' : `/${normalized.msgId}`;
  return `〔src:${normalized.conv}#${normalized.seq}${tail}〕`;
}

/**
 * Parse one entry line.
 * @param {string} line
 * @returns {{ time: string, tag: string, content: string, source: object | null } | null}
 *   `null` for non-entry lines (headers, notes, blank lines)
 */
export function parseEntryLine(line) {
  const match = ENTRY_PATTERN.exec(String(line ?? ''));
  if (!match) return null;
  const time = match[1].trim();
  const tag = match[2].trim() === '' ? EMPTY_TAG : match[2].trim();
  let content = match[3].trim();
  let source = null;
  const marker = SOURCE_PATTERN.exec(content);
  if (marker) {
    source = normalizeSource({
      conv: marker[1],
      seq: marker[2].trim(),
      msgId: marker[3] === undefined ? '' : marker[3].trim(),
    });
    content = content.slice(0, marker.index).trim();
  }
  if (time === '' || content === '') return null;
  return { time, tag, content, source };
}

/**
 * Parse every entry line in a document, ignoring headers and prose.
 * @param {string | null | undefined} text
 * @returns {Array<{ time: string, tag: string, content: string, source: object | null }>}
 */
export function parseEntryLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(parseEntryLine)
    .filter(Boolean);
}

/**
 * Format one entry as a single line.
 * @param {{ time: string, tag?: string, content: string, source?: object | null }} entry
 * @returns {string}
 */
export function formatEntryLine(entry) {
  const tag = entry.tag && entry.tag !== '' ? entry.tag : EMPTY_TAG;
  const base = `- [${entry.time}] [${tag}] ${entry.content}`;
  const marker = formatSource(entry.source);
  return marker === '' ? base : `${base} ${marker}`;
}

/**
 * Whether two sources point at the same message.
 * @param {object | null | undefined} left
 * @param {object | null | undefined} right
 * @returns {boolean}
 */
export function sameSource(left, right) {
  const a = normalizeSource(left);
  const b = normalizeSource(right);
  if (!a || !b) return !a && !b;
  return a.conv === b.conv && String(a.seq) === String(b.seq) && a.msgId === b.msgId;
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
