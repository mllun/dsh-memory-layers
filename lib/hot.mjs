/**
 * Hot-layer memory: the small core every session reads first.
 *
 * `hot.md` holds free Markdown written by `mem_hot_set`, plus one reserved
 * block where `mem_write(..., important: true)` appends promotion candidates:
 *
 *   <!-- candidates:start -->
 *   - [2026-10-21T03:10:00.000Z] [tag] candidate body
 *   <!-- candidates:end -->
 *
 * The candidate block is excluded from the character count, so candidates can
 * wait for the next cleanup without eating the core budget. Writing body text
 * never disturbs them, and `mem_hot_set` may replace the whole block by
 * including its own candidate markers in `content`.
 *
 * @module lib/hot
 */
import { formatEntryLine, parseEntryLine } from './entry.mjs';
import {
  charCount,
  hotFilePath,
  readTextIfExists,
  serialize,
  writeAtomic,
} from './paths.mjs';

/** Default character budget of the hot layer's body. */
export const DEFAULT_HOT_LIMIT = 600;

/** Marker opening the reserved candidate block. */
export const CANDIDATES_START = '<!-- candidates:start -->';
/** Marker closing the reserved candidate block. */
export const CANDIDATES_END = '<!-- candidates:end -->';

/**
 * Split a raw `hot.md` document into body text and candidates.
 * @param {string | null | undefined} raw
 * @returns {{ body: string, candidates: Array<{ time: string, tag: string, content: string }>, hadBlock: boolean }}
 */
export function splitHot(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf(CANDIDATES_START);
  const end = text.indexOf(CANDIDATES_END);
  if (start < 0 || end < 0 || end < start) {
    return { body: text.trim(), candidates: [], hadBlock: false };
  }
  const body = `${text.slice(0, start)}${text.slice(end + CANDIDATES_END.length)}`.trim();
  const inner = text.slice(start + CANDIDATES_START.length, end);
  const candidates = inner
    .split(/\r?\n/)
    .map(parseEntryLine)
    .filter(Boolean);
  return { body, candidates, hadBlock: true };
}

/**
 * Compose a `hot.md` document from body text and candidates.
 * @param {string} body
 * @param {Array<{ time: string, tag: string, content: string }>} candidates
 * @returns {string}
 */
export function composeHot(body, candidates) {
  const lines = [];
  const head = String(body ?? '').trim();
  if (head !== '') lines.push(head);
  lines.push(CANDIDATES_START);
  for (const candidate of candidates) lines.push(formatEntryLine(candidate));
  lines.push(CANDIDATES_END);
  return `${lines.join('\n')}\n`;
}

/**
 * Read the current hot-layer state.
 * @returns {{ path: string, body: string, candidates: Array<{ time: string, tag: string, content: string }> }}
 */
export function readHotState() {
  const file = hotFilePath();
  const { body, candidates } = splitHot(readTextIfExists(file));
  return { path: file, body, candidates };
}

/**
 * Write hot-layer state atomically.
 * @param {{ body: string, candidates: Array<{ time: string, tag: string, content: string }> }} state
 */
export function writeHotState(state) {
  writeAtomic(hotFilePath(), composeHot(state.body, state.candidates));
}

/**
 * Hint text for a hot layer over its budget, empty otherwise.
 * @param {number} chars
 * @param {number} limit
 * @returns {string}
 */
export function overLimitHint(chars, limit) {
  if (chars <= limit) return '';
  return `热层正文 ${chars} 字，超过上限 ${limit} 字，请用 mem_hot_set 精简：删掉陈旧细节和已完成的待办，把细节留在冷层，只保留长期有效、每次都要用到的信息。`;
}

/**
 * Read the hot layer plus its measured size.
 * @param {number} limit
 * @returns {{
 *   ok: true, path: string, content: string, chars: number, limit: number,
 *   overLimit: boolean, hint: string, candidates: Array<{ time: string, tag: string, content: string }>,
 *   candidateCount: number
 * }}
 */
export function getHot(limit) {
  return serialize(() => {
    const state = readHotState();
    const chars = charCount(state.body);
    return {
      ok: true,
      path: state.path,
      content: state.body,
      chars,
      limit,
      overLimit: chars > limit,
      hint: overLimitHint(chars, limit),
      candidates: state.candidates,
      candidateCount: state.candidates.length,
    };
  });
}

/**
 * Replace the hot-layer body, keeping the candidate block unless `content`
 * supplies its own.
 * @param {{ content?: unknown, limit: number }} input
 * @returns {Promise<{
 *   ok: true, path: string, chars: number, limit: number, overLimit: boolean,
 *   hint: string, candidateCount: number, message: string
 * }>}
 */
export function setHot({ content, limit }) {
  return serialize(() => {
    const previous = readHotState();
    const incoming = splitHot(typeof content === 'string' ? content : '');
    const candidates = incoming.hadBlock
      ? incoming.candidates
      : previous.candidates.concat(incoming.candidates);
    writeHotState({ body: incoming.body, candidates });
    const chars = charCount(incoming.body);
    const overLimit = chars > limit;
    const hint = overLimitHint(chars, limit);
    const message = overLimit
      ? `热层已更新为 ${chars} 字（超过 ${limit} 字上限），请立刻精简。`
      : `热层已更新：正文 ${chars} 字（上限 ${limit}），候选 ${candidates.length} 条。`;
    return {
      ok: true,
      path: hotFilePath(),
      chars,
      limit,
      overLimit,
      hint,
      candidateCount: candidates.length,
      message,
    };
  });
}

/**
 * Append one promotion candidate.
 *
 * The caller owns serialization: this runs inside another `serialize` task,
 * and nesting the queue would deadlock.
 * @param {{ time: string, tag: string, content: string, limit: number }} input
 * @returns {{ candidateIndex: number, candidateCount: number, chars: number, overLimit: boolean, hint: string }}
 */
export function appendCandidateSync({ time, tag, content, limit }) {
  const state = readHotState();
  state.candidates.push({ time, tag, content });
  writeHotState(state);
  const chars = charCount(state.body);
  return {
    candidateIndex: state.candidates.length,
    candidateCount: state.candidates.length,
    chars,
    overLimit: chars > limit,
    hint: overLimitHint(chars, limit),
  };
}
