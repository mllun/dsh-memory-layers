/**
 * One place where the plugin's YAML config is validated and defaulted.
 *
 * Every field falls back to its documented default instead of throwing, so a
 * typo in `cordis.patch.yml` can never stop the plugin from activating — the
 * worst case is a `warn` line in the host log.
 *
 * @module lib/config
 */

/** Default character budget of the hot-layer body. */
export const DEFAULT_HOT_LIMIT = 600;

/** Default share of the budget that auto-eviction aims for. */
export const DEFAULT_EVICT_RATIO = 0.85;

/** Every default, in one place, mirroring the README table. */
export const CONFIG_DEFAULTS = {
  hotLimit: DEFAULT_HOT_LIMIT,
  autoEvict: true,
  candidateTtlDays: 30,
  candidateMax: 12,
  usageThrottleMs: 5000,
  halfLifeDays: 30,
  demoteThreshold: 20,
  autoLogOnSessionEnd: false,
  autoLogMinTurns: 4,
};

/**
 * Coerce a numeric config value into an integer range.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @param {{ warn?: (message: string) => void } | undefined} logger
 * @returns {number}
 */
function integer(value, fallback, min, max, name, logger) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    logger?.warn?.(
      `[dsh-memory-layers] ${name}=${JSON.stringify(value)} 无效，已回退到 ${fallback}（允许 ${min}–${max}）。`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Coerce a config value into a boolean, accepting the strings YAML may keep.
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function boolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'yes' || text === '1' || text === 'on') return true;
  if (text === 'false' || text === 'no' || text === '0' || text === 'off') return false;
  return fallback;
}

/**
 * Normalize the whole config block.
 * @param {Record<string, unknown>} [raw]
 * @param {{ warn?: (message: string) => void } | undefined} [logger]
 * @returns {{
 *   hotLimit: number,
 *   autoEvict: boolean,
 *   evictTarget: number,
 *   candidateTtlDays: number,
 *   candidateMax: number,
 *   usageThrottleMs: number,
 *   halfLifeDays: number,
 *   demoteThreshold: number,
 *   autoLogOnSessionEnd: boolean,
 *   autoLogMinTurns: number,
 * }}
 */
export function normalizeConfig(raw = {}, logger) {
  const hotLimit = integer(raw.hotLimit, DEFAULT_HOT_LIMIT, 100, 20000, 'hotLimit', logger);
  const fallbackTarget = Math.floor(hotLimit * DEFAULT_EVICT_RATIO);
  const evictTarget = integer(
    raw.evictTarget,
    fallbackTarget,
    1,
    hotLimit,
    'evictTarget',
    logger,
  );
  return {
    hotLimit,
    autoEvict: boolean(raw.autoEvict, CONFIG_DEFAULTS.autoEvict),
    evictTarget,
    candidateTtlDays: integer(
      raw.candidateTtlDays,
      CONFIG_DEFAULTS.candidateTtlDays,
      1,
      3650,
      'candidateTtlDays',
      logger,
    ),
    candidateMax: integer(raw.candidateMax, CONFIG_DEFAULTS.candidateMax, 0, 500, 'candidateMax', logger),
    usageThrottleMs: integer(
      raw.usageThrottleMs,
      CONFIG_DEFAULTS.usageThrottleMs,
      0,
      600000,
      'usageThrottleMs',
      logger,
    ),
    halfLifeDays: integer(raw.halfLifeDays, CONFIG_DEFAULTS.halfLifeDays, 1, 3650, 'halfLifeDays', logger),
    demoteThreshold: integer(
      raw.demoteThreshold,
      CONFIG_DEFAULTS.demoteThreshold,
      0,
      100,
      'demoteThreshold',
      logger,
    ),
    autoLogOnSessionEnd: boolean(raw.autoLogOnSessionEnd, CONFIG_DEFAULTS.autoLogOnSessionEnd),
    autoLogMinTurns: integer(raw.autoLogMinTurns, CONFIG_DEFAULTS.autoLogMinTurns, 1, 1000, 'autoLogMinTurns', logger),
  };
}
