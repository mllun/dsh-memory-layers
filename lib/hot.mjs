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
 * v1.2 makes both areas self-managing instead of "store and forget":
 *
 *  - **auto-evict** (`setHot`): when the body exceeds the budget, whole blocks
 *    are moved to the cold layer (`tag=hot-evict`) until it fits again. A block
 *    is only movable when it is long enough, is not a heading, carries no
 *    comment marker, was not recalled in the last 90 days, and — if the usage
 *    ledger tracks it — has decayed below `demoteThreshold`. The cold write
 *    happens first; a failed write rolls the body back untouched.
 *  - **candidate TTL** (`readHotState`): candidates older than
 *    `candidateTtlDays` sink to the cold layer (`tag=candidate-expired`), and a
 *    block holding more than `candidateMax` entries sinks the oldest excess.
 *
 * `mem_hot_set` replaces a block only when its `content` carries that block's
 * markers; otherwise the existing entries are kept.
 *
 * @module lib/hot
 */
import { DEFAULT_HOT_LIMIT } from './config.mjs';
import { appendColdSync } from './cold.mjs';
import { formatEntryLine, parseEntryLine } from './entry.mjs';
import {
  charCount,
  hotFilePath,
  readTextIfExists,
  serialize,
  writeAtomic,
} from './paths.mjs';
import {
  DEFAULT_WEIGHT,
  ageInDays,
  contentKey,
  getUsageRecord,
  hitWithin,
  promoteEntry,
} from './usage.mjs';

export { DEFAULT_HOT_LIMIT };

/** Marker opening the reserved candidate block. */
export const CANDIDATES_START = '<!-- candidates:start -->';
/** Marker closing the reserved candidate block. */
export const CANDIDATES_END = '<!-- candidates:end -->';
/** Marker opening the reserved topic-index block. */
export const TOPICS_START = '<!-- topics:start -->';
/** Marker closing the reserved topic-index block. */
export const TOPICS_END = '<!-- topics:end -->';

/** Tag written when a hot block is evicted to the cold layer. */
export const HOT_EVICT_TAG = 'hot-evict';
/** Tag written when a candidate expires or overflows to the cold layer. */
export const CANDIDATE_EXPIRED_TAG = 'candidate-expired';

/** A recalled entry is protected from eviction for this many days. */
export const RECALL_PROTECTION_DAYS = 90;
/** A tracked entry must also be older than this before it may be demoted. */
export const DEMOTE_MIN_AGE_DAYS = 30;
/** Shortest block auto-eviction will touch. */
export const MIN_EVICT_CHARS = 20;

const DAY_MS = 86400000;

/** `topic|YYYY-MM`, with optional surrounding whitespace. */
const TOPIC_PATTERN = /^\s*(.+?)\s*\|\s*(\d{4}-\d{2})\s*$/;

/** Re-entrancy guard: pruning writes to the cold layer, which may read hot. */
let pruning = false;

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
 *   candidates: Array<{ time: string, tag: string, content: string, source: object | null }>,
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
 * @param {Array<{ time: string, tag: string, content: string, source?: object | null }>} candidates
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
 * Age of one candidate in days; unparseable stamps count as fresh.
 * @param {{ time: string }} candidate
 * @param {number} now
 * @returns {number}
 */
function candidateAge(candidate, now) {
  const at = new Date(candidate.time).getTime();
  if (Number.isNaN(at)) return 0;
  return (now - at) / DAY_MS;
}

/**
 * Whether the usage ledger allows this candidate to sink.
 *
 * Untracked candidates are always movable; a tracked one is protected until its
 * weight has decayed below `demoteThreshold`, so a memory that keeps being
 * recalled is never quietly pushed out.
 * @param {{ content: string }} candidate
 * @param {Record<string, any>} config
 * @param {number} now
 * @returns {boolean}
 */
function candidateDemotable(candidate, config, now) {
  const record = getUsageRecord(config, contentKey(candidate.content));
  if (!record) return true;
  return record.weight < config.demoteThreshold && ageInDays(record.lastHitAt, now) > DEMOTE_MIN_AGE_DAYS;
}

/**
 * Move one candidate to the cold layer, keeping its original tag as a prefix.
 * @param {{ tag: string, content: string }} candidate
 * @param {string} tag cold-layer tag to write
 * @param {Record<string, any>} config
 * @returns {boolean} whether the write succeeded
 */
function writeDemotion(candidate, tag, config) {
  try {
    appendColdSync({ text: `[${candidate.tag}] ${candidate.content}`, tag, config });
    return true;
  } catch (error) {
    config.logger?.warn?.(
      `[dsh-memory-layers] 候选下沉失败，已保留在热层：${error?.message ?? error}`,
    );
    return false;
  }
}

/**
 * Expire and trim the candidate block.
 * @param {Array<{ time: string, tag: string, content: string }>} candidates
 * @param {Record<string, any>} config
 * @returns {{ kept: Array<object>, expired: number, overflow: number, changed: boolean }}
 */
function pruneCandidates(candidates, config) {
  if (pruning) return { kept: candidates.slice(), expired: 0, overflow: 0, changed: false };
  const now = Date.now();
  const ttl = Number(config.candidateTtlDays ?? 30);
  const max = Number(config.candidateMax ?? 12);

  const expiredList = [];
  const survivors = [];
  for (const candidate of candidates) {
    const expired = candidateAge(candidate, now) > ttl && candidateDemotable(candidate, config, now);
    if (expired) expiredList.push(candidate);
    else survivors.push(candidate);
  }

  const overflowList = [];
  if (survivors.length > max) {
    const droppable = survivors
      .map((candidate, index) => ({ candidate, index }))
      .filter((item) => candidateDemotable(item.candidate, config, now))
      .sort((left, right) => {
        const leftAt = new Date(left.candidate.time).getTime();
        const rightAt = new Date(right.candidate.time).getTime();
        const leftValue = Number.isNaN(leftAt) ? Infinity : leftAt;
        const rightValue = Number.isNaN(rightAt) ? Infinity : rightAt;
        return leftValue - rightValue || left.index - right.index;
      });
    let excess = survivors.length - max;
    const dropped = new Set();
    for (const item of droppable) {
      if (excess <= 0) break;
      dropped.add(item.index);
      overflowList.push(item.candidate);
      excess -= 1;
    }
    if (dropped.size > 0) {
      const kept = [];
      survivors.forEach((candidate, index) => {
        if (!dropped.has(index)) kept.push(candidate);
      });
      survivors.length = 0;
      survivors.push(...kept);
    }
  }

  if (expiredList.length === 0 && overflowList.length === 0) {
    return { kept: candidates.slice(), expired: 0, overflow: 0, changed: false };
  }

  const demoted = new Set();
  pruning = true;
  try {
    for (const candidate of expiredList) {
      if (writeDemotion(candidate, CANDIDATE_EXPIRED_TAG, config)) demoted.add(candidate);
    }
    for (const candidate of overflowList) {
      if (writeDemotion(candidate, CANDIDATE_EXPIRED_TAG, config)) demoted.add(candidate);
    }
  } finally {
    pruning = false;
  }

  return {
    kept: candidates.filter((candidate) => !demoted.has(candidate)),
    expired: expiredList.filter((candidate) => demoted.has(candidate)).length,
    overflow: overflowList.filter((candidate) => demoted.has(candidate)).length,
    changed: demoted.size > 0,
  };
}

/**
 * Read the current hot-layer state, pruning the candidate block on the way.
 * @param {Record<string, any>} [config]
 * @returns {{
 *   path: string,
 *   body: string,
 *   candidates: Array<{ time: string, tag: string, content: string, source: object | null }>,
 *   topics: Array<{ topic: string, month: string }>,
 *   pruned: { expired: number, overflow: number, kept: number },
 * }}
 */
export function readHotState(config = {}) {
  const file = hotFilePath();
  const parsed = splitHot(readTextIfExists(file));
  const pruned = pruneCandidates(parsed.candidates, config);
  if (pruned.changed) {
    writeHotState({ body: parsed.body, candidates: pruned.kept, topics: parsed.topics });
  }
  return {
    path: file,
    body: parsed.body,
    candidates: pruned.kept,
    topics: parsed.topics,
    pruned: { expired: pruned.expired, overflow: pruned.overflow, kept: pruned.kept.length },
  };
}

/**
 * Write hot-layer state atomically.
 * @param {{
 *   body: string,
 *   candidates: Array<{ time: string, tag: string, content: string, source?: object | null }>,
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
  return `热层正文 ${chars} 字，超过上限 ${limit} 字，请用 mem_hot_set 精简：删掉陈旧细节和已完成的待办，把细节留在冷层，只保留长期有效、每次都要用到的东西。`;
}

/**
 * Read the hot layer plus its measured size.
 * @param {Record<string, any>} config
 * @returns {Promise<{
 *   ok: true, path: string, content: string, chars: number, limit: number,
 *   overLimit: boolean, hint: string,
 *   candidates: Array<object>, candidateCount: number,
 *   topics: Array<object>, topicCount: number,
 *   pruned: { expired: number, overflow: number, kept: number },
 * }>}
 */
export function getHot(config) {
  return serialize(() => {
    const state = readHotState(config);
    const chars = charCount(state.body);
    return {
      ok: true,
      path: state.path,
      content: state.body,
      chars,
      limit: config.hotLimit,
      overLimit: chars > config.hotLimit,
      hint: overLimitHint(chars, config.hotLimit),
      candidates: state.candidates,
      candidateCount: state.candidates.length,
      topics: state.topics,
      topicCount: state.topics.length,
      pruned: state.pruned,
    };
  });
}

/**
 * Join the blocks that survived eviction.
 * @param {string[]} blocks
 * @param {Set<number>} removed
 * @returns {string}
 */
function joinBlocks(blocks, removed) {
  return blocks
    .filter((_block, index) => !removed.has(index))
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .join('\n\n');
}

/**
 * Choose the blocks that may be evicted, cheapest first.
 *
 * A block is movable only when all of the following hold: it is at least
 * `MIN_EVICT_CHARS` long, carries no `<!-- ` marker, is not a `#` heading, was
 * not recalled within `RECALL_PROTECTION_DAYS`, and — if tracked — has decayed
 * below `demoteThreshold` and is older than `DEMOTE_MIN_AGE_DAYS`.
 *
 * The recall window is deliberately wider than the "30 days" floor in the
 * behaviour spec: a block that was recalled at all in the last quarter is
 * treated as still useful, and anything that was never recalled is governed by
 * its weight instead (an untracked block counts as weight 50, a tracked one
 * uses its decayed weight).
 * @param {string[]} blocks
 * @param {Record<string, any>} config
 * @param {number} now
 * @returns {Array<{ index: number, text: string, weight: number, lastHitAt: string }>}
 */
function evictCandidates(blocks, config, now) {
  const threshold = Number(config.demoteThreshold ?? 20);
  const picked = [];
  blocks.forEach((block, index) => {
    const text = block.trim();
    if (text === '') return;
    if (charCount(text) < MIN_EVICT_CHARS) return;
    if (text.includes('<!-- ')) return;
    if (text.startsWith('#')) return;
    const record = getUsageRecord(config, contentKey(text));
    if (hitWithin(record, RECALL_PROTECTION_DAYS, now)) return;
    if (record && !(record.weight < threshold && ageInDays(record.lastHitAt, now) > DEMOTE_MIN_AGE_DAYS)) {
      return;
    }
    picked.push({
      index,
      text,
      weight: record ? record.weight : DEFAULT_WEIGHT,
      lastHitAt: record ? record.lastHitAt : '',
    });
  });
  picked.sort((left, right) => {
    if (left.weight !== right.weight) return left.weight - right.weight;
    const leftAt = left.lastHitAt === '' ? -Infinity : new Date(left.lastHitAt).getTime();
    const rightAt = right.lastHitAt === '' ? -Infinity : new Date(right.lastHitAt).getTime();
    if (leftAt !== rightAt) return leftAt - rightAt;
    return charCount(right.text) - charCount(left.text);
  });
  return picked;
}

/**
 * One-line explanation of why a block was movable.
 * @param {{ weight: number, lastHitAt: string }} candidate
 * @param {number} now
 * @returns {string}
 */
function evictReason(candidate, now) {
  if (candidate.lastHitAt === '') return `weight ${candidate.weight}，从未被召回`;
  const days = Math.round(ageInDays(candidate.lastHitAt, now));
  return `weight ${candidate.weight}，${days} 天未召回`;
}

/**
 * Evict whole blocks until the body fits the target.
 * @param {string} body
 * @param {number} target
 * @param {Record<string, any>} config
 * @returns {{ body: string, evicted: Array<{ content: string, chars: number, reason: string }>, error: string }}
 */
function evictBlocks(body, target, config) {
  const blocks = body.split(/\n[ \t]*\n/);
  const now = Date.now();
  const picked = evictCandidates(blocks, config, now);
  if (picked.length === 0) return { body, evicted: [], error: '' };

  const removed = new Set();
  const evicted = [];
  const total = blocks.filter((block) => block.trim() !== '').length;
  let chars = charCount(body);
  let error = '';
  for (const candidate of picked) {
    if (chars <= target) break;
    // Never empty the hot layer: one block always stays, even when it alone
    // blows the budget. The caller then gets the usual "please trim" hint.
    if (total - removed.size <= 1) break;
    try {
      appendColdSync({ text: candidate.text, tag: HOT_EVICT_TAG, config });
    } catch (failure) {
      error = failure?.message ?? String(failure);
      break;
    }
    removed.add(candidate.index);
    chars = charCount(joinBlocks(blocks, removed));
    evicted.push({
      content: candidate.text,
      chars: charCount(candidate.text),
      reason: evictReason(candidate, now),
    });
  }
  // A failed cold write rolls the whole eviction back: the body is written
  // untouched, and the blocks already copied are simply duplicated in cold.
  if (error !== '') return { body, evicted: [], error };
  if (removed.size === 0) return { body, evicted: [], error };
  return { body: joinBlocks(blocks, removed), evicted, error };
}

/**
 * Raise the weight of lines that just entered the hot body.
 * @param {string} previousBody
 * @param {string} body
 * @param {Record<string, any>} config
 */
function bumpPromotions(previousBody, body, config) {
  const known = new Set(
    previousBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || known.has(line)) continue;
    for (const variant of new Set([line, line.replace(/^[-*+]\s+/, '')])) {
      promoteEntry(config, contentKey(variant));
    }
  }
}

/**
 * Replace the hot-layer body, keeping the candidate and topic blocks unless
 * `content` supplies its own.
 * @param {{ content?: unknown, config: Record<string, any> }} input
 * @returns {Promise<{
 *   ok: true, path: string, chars: number, charsAfterEvict: number, limit: number,
 *   overLimit: boolean, hint: string, evicted: Array<object>, evictHint: string,
 *   candidateCount: number, topicCount: number, message: string
 * }>}
 */
export function setHot({ content, config }) {
  return serialize(() => {
    const limit = config.hotLimit;
    const previous = readHotState(config);
    const incoming = splitHot(typeof content === 'string' ? content : '');
    const candidates = incoming.hadCandidates
      ? incoming.candidates
      : previous.candidates.concat(incoming.candidates);
    const topics = incoming.hadTopics ? incoming.topics : previous.topics.concat(incoming.topics);

    const before = charCount(incoming.body);
    let body = incoming.body;
    let evicted = [];
    let evictError = '';
    if (config.autoEvict !== false && before > limit) {
      const target = Number.isFinite(config.evictTarget) ? config.evictTarget : Math.floor(limit * 0.85);
      const result = evictBlocks(body, target, config);
      body = result.body;
      evicted = result.evicted;
      evictError = result.error;
    }

    writeHotState({ body, candidates, topics });
    bumpPromotions(previous.body, body, config);

    const chars = charCount(body);
    const overLimit = chars > limit;
    const evictedChars = evicted.reduce((total, item) => total + item.chars, 0);
    const evictHint = evictError !== ''
      ? `自动腾挪中断（${evictError}），热层保持原样。`
      : evicted.length > 0
        ? `已自动腾挪 ${evicted.length} 块 / ${evictedChars} 字到冷层（tag=${HOT_EVICT_TAG}）：${before} → ${chars} 字。`
        : overLimit
          ? '热层仍超限，但没有可腾挪的块（太短、是标题、90 天内被召回、权重受保护，或只剩最后一块），请手动精简。'
          : '';
    const message = overLimit
      ? `热层已更新为 ${chars} 字（超过 ${limit} 字上限），请立刻精简。`
      : `热层已更新：正文 ${chars} 字（上限 ${limit}），候选 ${candidates.length} 条，主题索引 ${topics.length} 条。`;

    return {
      ok: true,
      path: hotFilePath(),
      chars,
      charsAfterEvict: chars,
      limit,
      overLimit,
      hint: overLimitHint(chars, limit),
      evicted,
      evictHint,
      candidateCount: candidates.length,
      topicCount: topics.length,
      message: evictHint === '' ? message : `${message} ${evictHint}`,
    };
  });
}

/**
 * Append one promotion candidate.
 *
 * The caller owns serialization: this runs inside another `serialize` task,
 * and nesting the queue would deadlock.
 * @param {{ time: string, tag: string, content: string, config: Record<string, any> }} input
 * @returns {{ candidateIndex: number, candidateCount: number, chars: number, overLimit: boolean, hint: string }}
 */
export function appendCandidateSync({ time, tag, content, config }) {
  const state = readHotState(config);
  state.candidates.push({ time, tag, content, source: null });
  writeHotState(state);
  const chars = charCount(state.body);
  return {
    candidateIndex: state.candidates.length,
    candidateCount: state.candidates.length,
    chars,
    overLimit: chars > config.hotLimit,
    hint: overLimitHint(chars, config.hotLimit),
  };
}

/**
 * Add missing `topic|YYYY-MM` rows to the hot-layer topic index.
 *
 * Reads the raw document instead of `readHotState` so summary generation can
 * never trigger candidate pruning, and skips rows that already exist so a
 * hand-written index is never overwritten.
 * @param {Array<{ topic: string, month: string }>} entries
 * @returns {Array<{ topic: string, month: string }>} the rows actually added
 */
export function appendTopicsSync(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const state = splitHot(readTextIfExists(hotFilePath()));
  const existing = new Set(state.topics.map((topic) => `${topic.topic}|${topic.month}`));
  const added = [];
  for (const entry of entries) {
    const topic = String(entry?.topic ?? '').trim();
    const month = String(entry?.month ?? '').trim();
    if (topic === '' || !/^\d{4}-\d{2}$/.test(month)) continue;
    const line = `${topic}|${month}`;
    if (existing.has(line)) continue;
    existing.add(line);
    added.push({ topic, month });
  }
  if (added.length === 0) return [];
  writeHotState({ body: state.body, candidates: state.candidates, topics: state.topics.concat(added) });
  return added;
}
