/**
 * Hot-layer memory: the small core every session reads first.
 *
 * `hot.md` holds free Markdown written by `mem_hot_set`, plus two reserved
 * blocks:
 *
 *   <!-- candidates:start -->
 *   - [2026-10-21T03:10:00.000Z] [tag] candidate body
 *   <!-- candidates:end -->
 *
 *   <!-- topics:start -->
 *   翻唱|2026-10
 *   <!-- topics:end -->
 *
 * The candidate block is where `mem_write(..., important: true)` parks entries
 * until the next cleanup; the topic index maps a subject to the cold months
 * worth searching (`topic|YYYY-MM` per line). Neither block counts toward the
 * body character budget, so they never crowd the core memory.
 *
 * `mem_hot_set` replaces a block only when its `content` carries that block's
 * markers; otherwise the existing entries are kept.
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
/** Marker opening the reserved topic-index block. */
export const TOPICS_START = '<!-- topics:start -->';
/** Marker closing the reserved topic-index block. */
export const TOPICS_END = '<!-- topics:end -->';

/** `topic|YYYY-MM`, with optional surrounding whitespace. */
const TOPIC_PATTERN = /^\s*(.+?)\s*\|\s*(\d{4}-\d{2})\s*$/;

/**
 * Parse one topic-index line.
 * @param {string} line
 * @returns {{ topic: string, month: string } | null}
 */
export function parseTopicLine(line) {
  const match = TOPIC_PATTERN.exec(String(line ?? ''));
  if (!match) return null;
  const topic = match[1].trim();
  const month = match[2];
  if (topic === '') return null;
  return { topic, month };
}

/**
 * Parse every topic-index line in one block, ignoring blanks and comments.
 * @param {string} inner
 * @returns {Array<{ topic: string, month: string }>}
 */
function parseTopicLines(inner) {
  return String(inner ?? '')
    .split(/\r?\n/)
    .map(parseTopicLine)
    .filter(Boolean);
}

/**
 * Remove one reserved block from a document.
 * @param {string} text
 * @param {string} start marker
 * @param {string} end marker
 * @returns {{ inner: string, rest: string, found: boolean }}
 */
function takeBlock(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < 0 || to < from) return { inner: '', rest: text, found: false };
  return {
    inner: text.slice(from + start.length, to),
    rest: `${text.slice(0, from)}${text.slice(to + end.length)}`,
    found: true,
  };
}

/**
 * Split a raw `hot.md` document into body text, candidates, and topics.
 * @param {string | null | undefined} raw
 * @returns {{
 *   body: string,
 *   candidates: Array<{ time: string, tag: string, content: string }>,
 *   topics: Array<{ topic: string, month: string }>,
 *   hadCandidates: boolean,
 *   hadTopics: boolean,
 * }}
 */
export function splitHot(raw) {
  const first = takeBlock(String(raw ?? ''), CANDIDATES_START, CANDIDATES_END);
  const second = takeBlock(first.rest, TOPICS_START, TOPICS_END);
  return {
    body: second.rest.trim(),
    candidates: first.inner
      .split(/\r?\n/)
      .map(parseEntryLine)
      .filter(Boolean),
    topics: parseTopicLines(second.inner),
    hadCandidates: first.found,
    hadTopics: second.found,
  };
}

/**
 * Compose a `hot.md` document from body text, candidates, and topics.
 * @param {string} body
 * @param {Array<{ time: string, tag: string, content: string }>} candidates
 * @param {Array<{ topic: string, month: string }>} topics
 * @returns {string}
 */
export function composeHot(body, candidates = [], topics = []) {
  const lines = [];
  const head = String(body ?? '').trim();
  if (head !== '') lines.push(head);
  lines.push(CANDIDATES_START);
  for (const candidate of candidates) lines.push(formatEntryLine(candidate));
  lines.push(CANDIDATES_END);
  lines.push('');
  lines.push(TOPICS_START);
  for (const topic of topics) lines.push(`${topic.topic}|${topic.month}`);
  lines.push(TOPICS_END);
  return `${lines.join('\n')}\n`;
}

/**
 * Read the current hot-layer state.
 * @returns {{
 *   path: string,
 *   body: string,
 *   candidates: Array<{ time: string, tag: string, content: string }>,
 *   topics: Array<{ topic: string, month: string }>,
 * }}
 */
export function readHotState() {
  const file = hotFilePath();
  const { body, candidates, topics } = splitHot(readTextIfExists(file));
  return { path: file, body, candidates, topics };
}

/**
 * Write hot-layer state atomically.
 * @param {{
 *   body: string,
 *   candidates: Array<{ time: string, tag: string, content: string }>,
 *   topics: Array<{ topic: string, month: string }>,
 * }} state
 */
export function writeHotState(state) {
  writeAtomic(hotFilePath(), composeHot(state.body, state.candidates, state.topics));
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
 *   overLimit: boolean, hint: string,
 *   candidates: Array<{ time: string, tag: string, content: string }>,
 *   candidateCount: number,
 *   topics: Array<{ topic: string, month: string }>,
 *   topicCount: number,
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
      topics: state.topics,
      topicCount: state.topics.length,
    };
  });
}

/**
 * Replace the hot-layer body, keeping the candidate and topic blocks unless
 * `content` supplies its own.
 * @param {{ content?: unknown, limit: number }} input
 * @returns {Promise<{
 *   ok: true, path: string, chars: number, limit: number, overLimit: boolean,
 *   hint: string, candidateCount: number, topicCount: number, message: string
 * }>}
 */
export function setHot({ content, limit }) {
  return serialize(() => {
    const previous = readHotState();
    const incoming = splitHot(typeof content === 'string' ? content : '');
    const candidates = incoming.hadCandidates
      ? incoming.candidates
      : previous.candidates.concat(incoming.candidates);
    const topics = incoming.hadTopics
      ? incoming.topics
      : previous.topics.concat(incoming.topics);
    writeHotState({ body: incoming.body, candidates, topics });
    const chars = charCount(incoming.body);
    const overLimit = chars > limit;
    const hint = overLimitHint(chars, limit);
    const message = overLimit
      ? `热层已更新为 ${chars} 字（超过 ${limit} 字上限），请立刻精简。`
      : `热层已更新：正文 ${chars} 字（上限 ${limit}），候选 ${candidates.length} 条，主题索引 ${topics.length} 条。`;
    return {
      ok: true,
      path: hotFilePath(),
      chars,
      limit,
      overLimit,
      hint,
      candidateCount: candidates.length,
      topicCount: topics.length,
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
