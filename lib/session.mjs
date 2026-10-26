/**
 * Session-end auto-log (v1.2).
 *
 * When enabled, the plugin keeps a short in-memory tail of the turns it saw and,
 * once a conversation ends (a `session:close`-style host event, or 30 idle
 * minutes), writes the last three turns into the cold layer as one entry tagged
 * `session`, carrying a `source` marker so the same conversation is never
 * logged twice.
 *
 * The summary is extractive only: it joins the tail, collapses whitespace and
 * truncates to 200 characters. It never invents a sentence.
 *
 * This tracker is off by default (`autoLogOnSessionEnd: false`), so a plain
 * install behaves exactly like v1.1.
 *
 * @module lib/session
 */
import { appendColdSync, readColdEntries } from './cold.mjs';
import { localDateKey } from './paths.mjs';

/** Cold-layer tag used by auto-logged sessions. */
export const SESSION_TAG = 'session';
/** Hard cap on one auto-logged entry. */
export const SESSION_SUMMARY_CHARS = 200;
/** How many trailing turns are folded into the entry. */
export const SESSION_TAIL_TURNS = 3;
/** Idle time that counts as "the session ended". */
export const IDLE_CLOSE_MS = 30 * 60 * 1000;
/** How many turns are kept in memory. */
const BUFFER_TURNS = 50;

/**
 * Truncate to `max` characters.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * Create one tracker. Callers wire `note()` into tool execution and `close()`
 * into whatever session-end signal the host exposes.
 * @param {{
 *   config: Record<string, any>,
 *   logger?: { warn?: (message: string) => void, info?: (message: string) => void },
 *   conv?: string,
 * }} input
 * @returns {{
 *   note: (text: unknown) => void,
 *   close: (conv?: string) => { logged: boolean, reason: string, seq?: number },
 *   start: () => () => void,
 *   turns: () => number,
 * }}
 */
export function createSessionTracker({ config, logger, conv = 'local' }) {
  const buffer = [];
  let seq = 0;
  let lastAt = Date.now();
  let timer = null;

  /**
   * Record one turn of the conversation tail.
   * @param {unknown} text
   */
  function note(text) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value === '') return;
    seq += 1;
    lastAt = Date.now();
    buffer.push({ seq, at: new Date(lastAt).toISOString(), text: value });
    while (buffer.length > BUFFER_TURNS) buffer.shift();
  }

  /**
   * Whether this conversation tail is already in today's cold layer.
   * @param {string} targetConv
   * @param {number} targetSeq
   * @returns {boolean}
   */
  function alreadyLogged(targetConv, targetSeq) {
    try {
      return readColdEntries(localDateKey()).some(
        (entry) =>
          entry.tag === SESSION_TAG
          && entry.source
          && entry.source.conv === targetConv
          && String(entry.source.seq) === String(targetSeq),
      );
    } catch {
      return false;
    }
  }

  /**
   * Close one conversation and log its tail, when the config allows it.
   * @param {string} [targetConv]
   * @returns {{ logged: boolean, reason: string, seq?: number }}
   */
  function close(targetConv = conv) {
    if (!config.autoLogOnSessionEnd) return { logged: false, reason: 'disabled' };
    if (buffer.length < config.autoLogMinTurns) return { logged: false, reason: 'too-few-turns' };
    const tail = buffer.slice(-SESSION_TAIL_TURNS);
    const last = tail[tail.length - 1];
    if (alreadyLogged(targetConv, last.seq)) return { logged: false, reason: 'duplicate' };
    const text = truncate(tail.map((turn) => turn.text).join(' / '), SESSION_SUMMARY_CHARS);
    try {
      appendColdSync({
        text,
        tag: SESSION_TAG,
        source: { conv: targetConv, seq: last.seq },
        config,
      });
      return { logged: true, reason: 'logged', seq: last.seq };
    } catch (error) {
      logger?.warn?.(`[dsh-memory-layers] 会话自动落档失败（已忽略）：${error?.message ?? error}`);
      return { logged: false, reason: 'write-failed' };
    }
  }

  /**
   * Start the idle watcher; returns its disposer.
   * @returns {() => void}
   */
  function start() {
    if (timer) return () => {};
    const tick = setInterval(() => {
      if (Date.now() - lastAt < IDLE_CLOSE_MS) return;
      if (buffer.length === 0) return;
      close();
    }, 60 * 1000);
    timer = tick;
    tick.unref?.();
    return () => {
      clearInterval(tick);
      timer = null;
    };
  }

  return { note, close, start, turns: () => buffer.length };
}
