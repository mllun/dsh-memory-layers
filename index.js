/**
 * DSH host plugin: layered long-term memory.
 *
 * One small hot layer, one month-archived cold layer, and three extractive
 * summary layers keep the injected context small while old detail stays
 * searchable:
 *
 *  - mem_hot_get         read the hot layer (core memory, ~600 chars)
 *  - mem_hot_set         replace the hot layer body wholesale (auto-evicts)
 *  - mem_write           append to the cold layer, optionally nominate it
 *                        for the hot layer's candidate block
 *  - mem_recall          keyword recall across every cold month, ranked
 *  - mem_recent          the last N days, newest first
 *  - mem_by_tag          entries with one exact tag
 *  - mem_by_date         entries inside a closed local-date range
 *  - mem_summarize       generate the day / week / month summary
 *  - mem_stats           report the volume of each layer
 *
 * v1.2 turns the hot layer and the candidate area from "store and forget" into
 * self-managing: over-budget bodies evict whole blocks to the cold layer,
 * stale candidates sink on read, recalls leave a trace that ranks later
 * searches and protects what is actually used, summaries compress each tier
 * harder than the one below, and entries may carry `〔src:conv#seq〕` evidence.
 * All of it is additive: no tool was renamed, no field was removed, and
 * `hot.md` / `cold/` stay compatible with v1.1.
 *
 * Every file lives under `$DSH_HOME/dsh-memory-layers/`; tools accept no
 * caller-supplied paths.
 *
 * @module dsh-memory-layers
 */
import { appendCold, byDate, byTag, countColdEntries, MAX_COLD_CHARS, recall, recent } from './lib/cold.mjs';
import { normalizeConfig } from './lib/config.mjs';
import { getHot, setHot } from './lib/hot.mjs';
import { dataDir, localDateKey } from './lib/paths.mjs';
import { createSessionTracker } from './lib/session.mjs';
import { memoryStats } from './lib/stats.mjs';
import { PERIODS, summarize } from './lib/summary.mjs';

export const name = 'dsh-memory-layers';
export const inject = ['tools'];

/** How many new cold entries trigger an automatic day summary. */
const AUTO_SUMMARY_EVERY = 20;

/**
 * `{ conv, seq, msgId? }` — where one entry came from.
 *
 * DSH's tool registry only accepts a closed JSON-Schema subset: `type` must be a
 * single string, and unions have to be expressed with `oneOf`. A `type` array
 * (e.g. `['object', 'null']`) makes `tools.register` throw, which takes the whole
 * plugin down, so nullable fields are spelled as `oneOf: [x, { type: 'null' }]`.
 */
const SOURCE_OBJECT_SCHEMA = {
  type: 'object',
  properties: {
    conv: { type: 'string', description: '会话 key，例如 private:1234567890。' },
    seq: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: '该会话内的本地序号。' },
    msgId: { type: 'string', description: '可选的消息 id。' },
  },
  required: ['conv', 'seq'],
  additionalProperties: false,
};

/** Source of one entry, or `null` for entries written before v1.2. */
const SOURCE_SCHEMA = {
  oneOf: [SOURCE_OBJECT_SCHEMA, { type: 'null' }],
  description: '来源证据；v1.2 之前的旧条目为 null。',
};

/** One candidate entry inside the hot layer. */
const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    time: { type: 'string', description: '写入时的 ISO-8601 时间。' },
    tag: { type: 'string', description: '标签；没有标签时为 -。' },
    content: { type: 'string', description: '候选内容。' },
    source: SOURCE_SCHEMA,
  },
  required: ['time', 'tag', 'content'],
  additionalProperties: false,
};

/** One recalled cold-layer entry. */
const RECALL_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string', description: '条目所属的本地日期 YYYY-MM-DD。' },
    time: { type: 'string', description: 'ISO-8601 时间戳。' },
    tag: { type: 'string', description: '标签；没有标签时为 -。' },
    content: { type: 'string', description: '原文内容。' },
    source: SOURCE_SCHEMA,
    matched: { type: 'integer', description: '命中的检索项（词或二元组）个数。' },
    score: { type: 'number', description: '排序分：matched*2 + weight/5 + 新近加成。' },
  },
  required: ['date', 'time', 'tag', 'content', 'source', 'matched', 'score'],
  additionalProperties: false,
};

/** One entry returned by a window query (recent / by_tag / by_date). */
const WINDOW_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string', description: '条目所属的本地日期 YYYY-MM-DD。' },
    time: { type: 'string', description: 'ISO-8601 时间戳。' },
    tag: { type: 'string', description: '标签；没有标签时为 -。' },
    content: { type: 'string', description: '原文内容。' },
    source: SOURCE_SCHEMA,
  },
  required: ['date', 'time', 'tag', 'content', 'source'],
  additionalProperties: false,
};

/** One block moved out of the hot layer. */
const EVICTED_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', description: '被腾挪的原文块。' },
    chars: { type: 'integer', description: '该块字数。' },
    reason: { type: 'string', description: '为什么选中它。' },
  },
  required: ['content', 'chars', 'reason'],
  additionalProperties: false,
};

/** One summary layer's volume. */
const SUMMARY_LAYER_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'integer', description: '文件数。' },
    chars: { type: 'integer', description: '总字数。' },
    latest: { type: 'string', description: '最新的键；没有文件时为空字符串。' },
  },
  required: ['files', 'chars', 'latest'],
  additionalProperties: false,
};

/** One hot-layer topic index row (`topic|YYYY-MM`). */
const TOPIC_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: '主题名。' },
    month: { type: 'string', description: '对应的冷层月份 YYYY-MM。' },
  },
  required: ['topic', 'month'],
  additionalProperties: false,
};

/** One usage row: an entry preview plus its hit count or weight. */
const USAGE_ROW_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', description: '正文前 40 字。' },
    hits: { type: 'integer', description: '被召回次数。' },
    lastHitAt: { type: 'string', description: '最后一次召回时间。' },
    weight: { type: 'number', description: '当前权重（0–100）。' },
  },
  required: ['content'],
  additionalProperties: false,
};

/**
 * Render a hot-layer read for humans: body, budget state, candidates, topics.
 * @param {Record<string, any>} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderHot(value) {
  const header = `热层 · ${value.chars}/${value.limit} 字`
    + (value.candidates.length ? ` · 候选 ${value.candidates.length} 条` : '')
    + (value.topics.length ? ` · 主题 ${value.topics.length} 条` : '');
  const body = value.content.trim() === '' ? '（热层还是空的）' : value.content;
  const lines = [header, '', body];
  if (value.hint) lines.push('', value.hint);
  const pruned = value.pruned ?? { expired: 0, overflow: 0 };
  if (pruned.expired > 0 || pruned.overflow > 0) {
    lines.push(
      '',
      `已自动下沉候选：过期 ${pruned.expired} 条 / 超量 ${pruned.overflow} 条（冷层 tag=candidate-expired）。`,
    );
  }
  if (value.candidates.length > 0) {
    lines.push('', '待提升的候选：');
    for (const candidate of value.candidates) {
      lines.push(`- [${candidate.time}] [${candidate.tag}] ${candidate.content}`);
    }
  }
  if (value.topics.length > 0) {
    lines.push('', '主题索引（主题|年月，用于定位冷层月份）：');
    for (const topic of value.topics) lines.push(`- ${topic.topic}|${topic.month}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Render one window query (recent / by_tag / by_date).
 * @param {string} title
 * @param {{ scannedFiles: number, scannedEntries: number, matched: number, returned: number, items: Array<object> }} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderWindow(title, value) {
  const header = `${title} · ${value.matched} 条（扫描 ${value.scannedFiles} 个文件 / ${value.scannedEntries} 条）`;
  if (value.returned === 0) {
    return [{ type: 'text', text: `${header}\n没有匹配的冷层条目。` }];
  }
  const lines = [header];
  for (const item of value.items) {
    lines.push(`- [${item.date}] [${item.tag}] ${item.content}`);
  }
  if (value.matched > value.returned) {
    lines.push(`（仅显示最近 ${value.returned} 条，可加大 limit）`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Register every memory tool on the host context.
 * @param {any} ctx host context
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('[dsh-memory-layers] tools 服务不可用，无法注册记忆工具。');
  }

  const config = normalizeConfig(rawConfig, ctx.logger);
  const hotLimit = config.hotLimit;
  ctx.logger?.info?.(
    `[dsh-memory-layers] data dir: ${dataDir()}（热层上限 ${hotLimit} 字，自动腾挪 ${config.autoEvict ? '开' : '关'}）`,
  );

  const tracker = config.autoLogOnSessionEnd
    ? createSessionTracker({ config, logger: ctx.logger })
    : null;
  if (tracker) {
    for (const event of ['session:close', 'session:end', 'session:closed']) {
      try {
        ctx.on?.(event, () => tracker.close());
      } catch {
        /* the host may not expose this event */
      }
    }
    ctx.effect(() => tracker.start());
  }

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_hot_get',
        description:
          '读取热层记忆（每次会话开始时先读）。热层是核心记忆：身份、长期约定、正在推进的事，'
          + `上限约 ${hotLimit} 字，内容放在数据目录的 hot.md（${dataDir()}\\hot.md）。`
          + '返回正文、字数、是否超限、待提升的候选条目，以及主题索引（每行「主题|年月」，不占正文字数）。'
          + '读取时会把过期（超过候选 TTL）和超量的候选自动下沉到冷层，并在 pruned 里报告条数。'
          + '超限时请接着调用 mem_hot_set 精简；想不起某件事时，可以先用主题索引定位月份，再用 mem_by_date 取该月。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              path: { type: 'string', description: 'hot.md 的绝对路径。' },
              content: { type: 'string', description: '热层正文（不含候选区）。' },
              chars: { type: 'integer', description: '正文字数（按 Unicode 字符计）。' },
              limit: { type: 'integer', description: '当前热层字数上限。' },
              overLimit: { type: 'boolean', description: '正文是否超过上限。' },
              hint: { type: 'string', description: '超限时的精简提示；未超限为空字符串。' },
              candidates: { type: 'array', items: CANDIDATE_SCHEMA },
              candidateCount: { type: 'integer' },
              topics: { type: 'array', items: TOPIC_SCHEMA },
              topicCount: { type: 'integer' },
              pruned: {
                type: 'object',
                properties: {
                  expired: { type: 'integer', description: '本次因过期下沉的候选条数。' },
                  overflow: { type: 'integer', description: '本次因超量下沉的候选条数。' },
                  kept: { type: 'integer', description: '下沉后剩下的候选条数。' },
                },
                required: ['expired', 'overflow', 'kept'],
                additionalProperties: false,
              },
            },
            required: ['ok', 'path', 'content', 'chars', 'limit', 'overLimit', 'hint', 'candidates', 'candidateCount', 'topics', 'topicCount', 'pruned'],
            additionalProperties: false,
          },
          render: (_args, value) => renderHot(value),
        },
        async execute() {
          return getHot(config);
        },
      }),
    'dsh-memory-layers: mem_hot_get',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_hot_set',
        description:
          '全量覆盖热层记忆（覆盖，不是追加）：content 是完整的 Markdown 正文，写入即替换旧正文，'
          + `上限约 ${hotLimit} 字。正文只该放长期有效、每次会话都要用到的信息（身份、约定、当前目标）；细节写进冷层用 mem_recall 召回。`
          + (config.autoEvict
            ? `写入后若超过 ${hotLimit} 字，会按空行切块、自动把最不活跃的块腾挪到冷层（tag=hot-evict），直到降到 ${config.evictTarget} 字左右；`
              + '块太短、是 # 标题、含 <!-- 注释、90 天内被召回、或权重仍高于阈值的块不会被腾。'
            : '（当前关闭了 autoEvict，超限只提示不腾挪。）')
          + '保留的热层候选项和主题索引默认原样留下；如果 content 里自带 candidates:start / candidates:end 注释块，则用块内条目替换候选区；'
          + '自带 topics:start / topics:end 块则用块内「主题|年月」行替换主题索引（两区都不占正文字数）。',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '热层完整正文。传空字符串可清空正文（候选区保留）。',
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              path: { type: 'string' },
              chars: { type: 'integer', description: '写入并腾挪后的正文字数。' },
              charsAfterEvict: { type: 'integer', description: '腾挪后的正文字数（未腾挪时与 chars 相同）。' },
              limit: { type: 'integer' },
              overLimit: { type: 'boolean' },
              hint: { type: 'string' },
              evicted: { type: 'array', items: EVICTED_SCHEMA, description: '本次被腾挪到冷层的块。' },
              evictHint: { type: 'string', description: '一句话说明腾挪结果；没有腾挪时为空字符串。' },
              candidateCount: { type: 'integer' },
              topicCount: { type: 'integer' },
              message: { type: 'string' },
            },
            required: ['ok', 'path', 'chars', 'charsAfterEvict', 'limit', 'overLimit', 'hint', 'evicted', 'evictHint', 'candidateCount', 'topicCount', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            { type: 'text', text: value.hint ? `${value.message}\n${value.hint}` : value.message },
          ],
        },
        async execute(args = {}) {
          if (tracker) tracker.note(args.content);
          return setHot({ content: args.content, config });
        },
      }),
    'dsh-memory-layers: mem_hot_set',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_write',
        description:
          '把一条记忆追加到冷层（长期全文归档：cold/YYYY-MM/YYYY-MM-DD.md，按月分目录），自动带 ISO 时间戳，之后可用 mem_recall 跨月召回。'
          + 'tag 用于分类（可选）。important=true 时同时把这条放进热层候选区（候选不占热层字数），等自己下次精简热层时决定要不要提升。'
          + 'source 可选，用来记录这条记忆出自哪一轮对话（会以 〔src:conv#seq〕 追加在行尾）。'
          + `单条上限 ${MAX_COLD_CHARS} 字，当天完全相同的内容不会重复写入。`
          + `当天条目数每跨过一次 ${AUTO_SUMMARY_EVERY} 的倍数，会自动重生成当天的日摘要。`,
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要记住的内容，单行；换行会被压成空格。' },
            tag: { type: 'string', description: '可选标签，用于分类和召回；省略时记为 -。' },
            important: {
              type: 'boolean',
              description: '是否同时放进热层候选区，默认 false。',
            },
            source: {
              type: 'object',
              description: '可选来源证据：会话 key、本地序号、消息 id。',
              properties: {
                conv: { type: 'string', description: '会话 key，例如 private:1234567890。' },
                seq: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: '该会话内的本地序号。' },
                msgId: { type: 'string', description: '可选的消息 id。' },
              },
              required: ['conv'],
              additionalProperties: false,
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              added: { type: 'boolean', description: 'true 为新写入，false 表示当天已有相同条目。' },
              date: { type: 'string', description: '写入的本地日期 YYYY-MM-DD。' },
              time: { type: 'string', description: 'ISO-8601 时间戳。' },
              tag: { type: 'string' },
              important: { type: 'boolean' },
              candidateIndex: { type: 'integer', description: '放入热层候选后的序号（从 1 开始）；未 important 时为 0。' },
              hotChars: { type: 'integer', description: '写入后热层正文字数（未 important 时为 0）。' },
              hotLimit: { type: 'integer' },
              overLimit: { type: 'boolean' },
              hint: { type: 'string' },
              source: SOURCE_SCHEMA,
              sourceUpdated: { type: 'boolean', description: '重复条目是否只更新了来源标记。' },
              summaryCreated: { type: 'boolean', description: '本次写入是否触发了自动日摘要。' },
              message: { type: 'string' },
            },
            required: ['ok', 'added', 'date', 'time', 'tag', 'important', 'candidateIndex', 'hotChars', 'hotLimit', 'overLimit', 'hint', 'source', 'sourceUpdated', 'summaryCreated', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        async execute(args = {}) {
          const before = countColdEntries(localDateKey());
          if (tracker) tracker.note(args.text);
          const result = await appendCold({
            text: args.text,
            tag: args.tag,
            important: args.important === true,
            source: args.source,
            config,
          });
          let summaryCreated = false;
          if (result.added) {
            const after = countColdEntries(result.date);
            if (Math.floor(after / AUTO_SUMMARY_EVERY) > Math.floor(before / AUTO_SUMMARY_EVERY)) {
              try {
                const summary = await summarize({ period: 'day', date: result.date, force: true });
                summaryCreated = summary.created;
              } catch (error) {
                ctx.logger?.warn?.(
                  `[dsh-memory-layers] 自动日摘要失败（已忽略）：${error?.message ?? error}`,
                );
              }
            }
          }
          return { ...result, summaryCreated };
        },
      }),
    'dsh-memory-layers: mem_write',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_recall',
        description:
          '按关键词在冷层里跨月召回记忆：大小写不敏感的子串匹配；内容或 tag 命中都算。'
          + '单个中文关键词（3 字以上、不含空格）会被切成二元组，所以「翻唱权重」也能找到只写了「翻唱…权重」的条目。'
          + 'mode=and（默认）要求全部检索项命中，mode=or / any 时任一命中即可。'
          + '结果按 score = matched*2 + weight/5 + 新近加成 排序，同分按时间倒序，默认 10 条。'
          + '每返回一条都会在 usage.json 里记一次命中，被频繁召回的条目以后排得更前。'
          + '适合「记得有这件事但细节想不起来」时使用。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '检索词；多个词用空格分隔。' },
            mode: {
              type: 'string',
              enum: ['and', 'or', 'any'],
              default: 'and',
              description: '检索项的组合方式：and 全部命中（默认），or / any 任一命中。',
            },
            limit: {
              type: 'integer',
              default: 10,
              description: '最多返回条数，默认 10，可填 1–50，超过 50 按 50 返回。',
            },
          },
          required: ['keyword'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              keyword: { type: 'string' },
              mode: { type: 'string', description: '本次使用的组合方式：and / or / any。' },
              tokens: { type: 'array', items: { type: 'string' } },
              probes: { type: 'array', items: { type: 'string' }, description: '实际参与匹配的检索项（可能已切成二元组）。' },
              scannedFiles: { type: 'integer', description: '扫描过的冷层文件数。' },
              scannedEntries: { type: 'integer', description: '扫描过的条目数。' },
              matched: { type: 'integer', description: '命中总数。' },
              returned: { type: 'integer', description: '本次返回条数。' },
              items: { type: 'array', items: RECALL_ITEM_SCHEMA },
            },
            required: ['ok', 'keyword', 'mode', 'tokens', 'probes', 'scannedFiles', 'scannedEntries', 'matched', 'returned', 'items'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const header = `「${value.keyword}」命中 ${value.matched} 条（扫描 ${value.scannedFiles} 个文件 / ${value.scannedEntries} 条）`;
            if (value.returned === 0) {
              return [{ type: 'text', text: `${header}\n没有匹配的冷层条目。` }];
            }
            const lines = [header];
            for (const item of value.items) {
              lines.push(`- [${item.date}] [${item.tag}] ${item.content}`);
            }
            if (value.matched > value.returned) {
              lines.push(`（仅显示评分最高的 ${value.returned} 条，可加大 limit 或缩小关键词）`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args = {}) {
          if (tracker) tracker.note(args.keyword);
          return recall({ ...args, config });
        },
      }),
    'dsh-memory-layers: mem_recall',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_recent',
        description:
          '取最近 N 天（含今天）的冷层条目，按时间倒序。days 默认 3（1–365），limit 默认 50（1–200）。'
          + '适合「刚才 / 这两天发生了什么」类问题。检索回退顺序：先 mem_recent(3) 看最近；没有结果再看热层的主题索引定位月份，'
          + '用 mem_by_date 取那个月；最后才用 mem_recall 全文搜。',
        parameters: {
          type: 'object',
          properties: {
            days: {
              type: 'integer',
              default: 3,
              description: '往回看多少天（含今天），默认 3。',
            },
            limit: {
              type: 'integer',
              default: 50,
              description: '最多返回条数，默认 50。',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              days: { type: 'integer', description: '实际覆盖的天数。' },
              from: { type: 'string', description: '区间起始日期 YYYY-MM-DD。' },
              to: { type: 'string', description: '区间结束日期 YYYY-MM-DD（今天）。' },
              scannedFiles: { type: 'integer' },
              scannedEntries: { type: 'integer' },
              matched: { type: 'integer', description: '区间内条目总数。' },
              returned: { type: 'integer' },
              items: { type: 'array', items: WINDOW_ITEM_SCHEMA },
            },
            required: ['ok', 'days', 'from', 'to', 'scannedFiles', 'scannedEntries', 'matched', 'returned', 'items'],
            additionalProperties: false,
          },
          render: (_args, value) => renderWindow(`最近 ${value.days} 天（${value.from} ~ ${value.to}）`, value),
        },
        async execute(args = {}) {
          return recent({ ...args, config });
        },
      }),
    'dsh-memory-layers: mem_recent',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_by_tag',
        description:
          '按标签取冷层条目：不区分大小写的精确匹配，按时间倒序，默认 20 条（最多 200）。'
          + 'tag 传 - 表示取没有标签的条目。适合按分类回顾某类记忆。',
        parameters: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: '标签名；- 表示没有标签的条目。' },
            limit: {
              type: 'integer',
              default: 20,
              description: '最多返回条数，默认 20。',
            },
          },
          required: ['tag'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              tag: { type: 'string', description: '实际匹配的标签。' },
              scannedFiles: { type: 'integer' },
              scannedEntries: { type: 'integer' },
              matched: { type: 'integer', description: '带该标签的条目总数。' },
              returned: { type: 'integer' },
              items: { type: 'array', items: WINDOW_ITEM_SCHEMA },
            },
            required: ['ok', 'tag', 'scannedFiles', 'scannedEntries', 'matched', 'returned', 'items'],
            additionalProperties: false,
          },
          render: (_args, value) => renderWindow(`标签「${value.tag}」`, value),
        },
        async execute(args = {}) {
          return byTag({ ...args, config });
        },
      }),
    'dsh-memory-layers: mem_by_tag',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_by_date',
        description:
          '按本地日期区间取冷层条目：from / to 都是 YYYY-MM-DD，闭区间，按时间倒序，默认 50 条（最多 200）。'
          + '配合热层主题索引使用——先看索引里某个主题涉及哪几个月，再用 mem_by_date 取这些月份；'
          + '检索回退顺序：mem_recent(3) → 主题索引 → mem_by_date。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）。' },
            to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）。' },
            limit: {
              type: 'integer',
              default: 50,
              description: '最多返回条数，默认 50。',
            },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              from: { type: 'string' },
              to: { type: 'string' },
              scannedFiles: { type: 'integer' },
              scannedEntries: { type: 'integer' },
              matched: { type: 'integer', description: '区间内条目总数。' },
              returned: { type: 'integer' },
              items: { type: 'array', items: WINDOW_ITEM_SCHEMA },
            },
            required: ['ok', 'from', 'to', 'scannedFiles', 'scannedEntries', 'matched', 'returned', 'items'],
            additionalProperties: false,
          },
          render: (_args, value) => renderWindow(`${value.from} ~ ${value.to}`, value),
        },
        async execute(args = {}) {
          return byDate({ ...args, config });
        },
      }),
    'dsh-memory-layers: mem_by_date',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_summarize',
        description:
          '生成分级摘要：day 抽取当天的冷层条目；week 合并该周的日摘要（某天缺失则用那天的冷层）；'
          + 'month 合并该月的周摘要（缺失则回退日摘要和冷层）。摘要只抽取原文并截断，不新增内容。'
          + '压缩力度逐级加大：日摘要每条只留首句（≤40 字）；周摘要同 tag 合并成一行（取最早与最晚各一条首句）；'
          + '月摘要只给 约定/重要/翻唱 单独一行，其余 tag 汇总成「共 N 条」。头部会写「压缩比：原 N 条 → 保留 M 行」。'
          + '生成后会把该期最高频的 3 个 tag 补进热层主题索引（已存在的不重复）。'
          + '已存在的摘要直接返回，force=true 才重新生成。date 可选（YYYY-MM-DD），默认今天。',
        parameters: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: PERIODS,
              default: 'day',
              description: '摘要层级，默认 day。',
            },
            date: { type: 'string', description: '可选日期 YYYY-MM-DD，默认今天。' },
            force: { type: 'boolean', description: '已存在时是否重新生成，默认 false。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              period: { type: 'string' },
              key: { type: 'string', description: '摘要对应的日期 / 周 / 月键。' },
              path: { type: 'string' },
              created: { type: 'boolean', description: 'true 表示本次新生成，false 表示无来源或已存在。' },
              sourceCount: { type: 'integer', description: '来源条目数（已存在摘要时为该摘要的条目数）。' },
              entries: { type: 'integer', description: '摘要中保留的行数。' },
              omitted: { type: 'integer', description: '因字数预算省略的行数。' },
              chars: { type: 'integer' },
              topicsAdded: { type: 'integer', description: '本次补进热层主题索引的行数。' },
              content: { type: 'string', description: '摘要全文。' },
              message: { type: 'string' },
            },
            required: ['ok', 'period', 'key', 'path', 'created', 'sourceCount', 'entries', 'omitted', 'chars', 'topicsAdded', 'content', 'message'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            { type: 'text', text: `${value.message}\n\n${value.content}`.trimEnd() },
          ],
        },
        async execute(args = {}) {
          return summarize({ period: args.period, date: args.date, force: args.force === true });
        },
      }),
    'dsh-memory-layers: mem_summarize',
  );

  ctx.effect(
    () =>
      tools.register({
        name: 'mem_stats',
        description:
          '查看记忆各层的体量：热层字数/上限/候选数，冷层文件与条目数（按月列出），以及日/周/月摘要的文件数与字数。'
          + '另外给出使用度：topRecalled（最常被召回的 5 条）、weightTop / weightBottom（权重最高与最低各 5 条）。'
          + '用来判断该不该精简热层、归档冷层或补生成摘要。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              dataDir: { type: 'string' },
              hot: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  chars: { type: 'integer' },
                  limit: { type: 'integer' },
                  overLimit: { type: 'boolean' },
                  candidates: { type: 'integer' },
                  topics: { type: 'integer' },
                },
                required: ['path', 'chars', 'limit', 'overLimit', 'candidates', 'topics'],
                additionalProperties: false,
              },
              cold: {
                type: 'object',
                properties: {
                  files: { type: 'integer' },
                  entries: { type: 'integer' },
                  chars: { type: 'integer' },
                  latest: { type: 'string', description: '最新的键；没有文件时为空字符串。' },
                  months: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        month: { type: 'string' },
                        files: { type: 'integer' },
                        entries: { type: 'integer' },
                        chars: { type: 'integer' },
                      },
                      required: ['month', 'files', 'entries', 'chars'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['files', 'entries', 'chars', 'latest', 'months'],
                additionalProperties: false,
              },
              summaries: {
                type: 'object',
                properties: {
                  day: SUMMARY_LAYER_SCHEMA,
                  week: SUMMARY_LAYER_SCHEMA,
                  month: SUMMARY_LAYER_SCHEMA,
                },
                required: ['day', 'week', 'month'],
                additionalProperties: false,
              },
              topRecalled: { type: 'array', items: USAGE_ROW_SCHEMA, description: '最常被召回的条目。' },
              weightTop: { type: 'array', items: USAGE_ROW_SCHEMA, description: '权重最高的条目。' },
              weightBottom: { type: 'array', items: USAGE_ROW_SCHEMA, description: '权重最低的条目。' },
            },
            required: ['ok', 'dataDir', 'hot', 'cold', 'summaries', 'topRecalled', 'weightTop', 'weightBottom'],
            additionalProperties: false,
          },
          render: (_args, value) => {
            const lines = [
              `数据目录：${value.dataDir}`,
              `热层：${value.hot.chars}/${value.hot.limit} 字` + (value.hot.overLimit ? '（超限，请精简）' : '')
                + (value.hot.candidates > 0 ? ` · 候选 ${value.hot.candidates} 条` : '')
                + (value.hot.topics > 0 ? ` · 主题 ${value.hot.topics} 条` : ''),
              `冷层：${value.cold.files} 个文件 / ${value.cold.entries} 条 / ${value.cold.chars} 字`
                + (value.cold.latest ? `（最新 ${value.cold.latest}）` : ''),
            ];
            for (const month of value.cold.months) {
              lines.push(`  - ${month.month}：${month.files} 文件 / ${month.entries} 条 / ${month.chars} 字`);
            }
            for (const period of PERIODS) {
              const layer = value.summaries[period];
              lines.push(
                `摘要 ${period}：${layer.files} 个文件 / ${layer.chars} 字`
                  + (layer.latest ? `（最新 ${layer.latest}）` : ''),
              );
            }
            if (value.topRecalled.length > 0) {
              lines.push('最常被召回：');
              for (const row of value.topRecalled) {
                lines.push(`  - ${row.hits} 次 · ${row.content}`);
              }
            }
            if (value.weightTop.length > 0) {
              lines.push('权重最高：');
              for (const row of value.weightTop) lines.push(`  - ${row.weight} · ${row.content}`);
            }
            if (value.weightBottom.length > 0) {
              lines.push('权重最低：');
              for (const row of value.weightBottom) lines.push(`  - ${row.weight} · ${row.content}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute() {
          return memoryStats(config);
        },
      }),
    'dsh-memory-layers: mem_stats',
  );
}
