/**
 * Smoke test for dsh-memory-layers.
 *
 * Runs against a temporary DSH_HOME, drives the registered tools through a
 * minimal host context, and covers the acceptance list: hot layer readable,
 * cold layer recallable across months, day/week/month summaries generated,
 * over-limit reported, and data surviving a fresh process. v1.1 adds the
 * read-only window queries (recent / by_tag / by_date), `mode` on recall, and
 * the hot-layer topic index.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), 'dsh-memory-layers-'));
process.env.DSH_HOME = home;

const { apply } = await import('../index.js');
const { isoWeekDates, localDateKey, localMonthKey } = await import('../lib/paths.mjs');

/** Register tools into a fake context and expose them by name. */
function createContext() {
  const registered = new Map();
  const ctx = {
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        register(definition) {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      };
    },
    effect(run) {
      return run();
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, registered };
}

/** Previous calendar month key, e.g. 2026-09 for 2026-10. */
function previousMonthKey(date) {
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return localMonthKey(previous);
}

/** Cold file path for one date key. */
function coldFileFor(dateKey) {
  return path.join(home, 'dsh-memory-layers', 'cold', dateKey.slice(0, 7), `${dateKey}.md`);
}

/** Write one hand-made cold file, used to simulate older days. */
function writeColdDay(dateKey, line) {
  const file = coldFileFor(dateKey);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# ${dateKey} 记忆\n\n${line}\n`, 'utf8');
}

try {
  const { ctx, registered } = createContext();
  apply(ctx, { hotLimit: 600 });

  const names = [
    'mem_hot_get', 'mem_hot_set', 'mem_write', 'mem_recall',
    'mem_recent', 'mem_by_tag', 'mem_by_date',
    'mem_summarize', 'mem_stats',
  ];
  for (const name of names) assert.ok(registered.has(name), `缺少工具 ${name}`);

  const call = (name, args = {}) => registered.get(name).execute(args);

  // --- 热层：空、超限、写入、回读 ------------------------------------------
  const empty = await call('mem_hot_get');
  assert.equal(empty.ok, true);
  assert.equal(empty.chars, 0);
  assert.equal(empty.overLimit, false);
  assert.equal(empty.topicCount, 0);

  const tooLong = '记'.repeat(700);
  const over = await call('mem_hot_set', { content: tooLong });
  assert.equal(over.ok, true);
  assert.equal(over.overLimit, true, '超限必须返回 overLimit=true');
  assert.ok(over.hint.includes('精简'), '超限必须给出精简提示');
  assert.ok(existsSync(path.join(home, 'dsh-memory-layers', 'hot.md')));

  const body = '# 核心\n- 名字：小鲸鱼\n- 约定：每天写日记';
  const saved = await call('mem_hot_set', { content: body });
  assert.equal(saved.chars, Array.from(body).length);
  assert.equal(saved.overLimit, false);
  assert.equal(saved.hint, '');

  const hot = await call('mem_hot_get');
  assert.equal(hot.content, body);
  assert.equal(hot.chars, Array.from(body).length);

  // --- 冷层：写入、去重、important 候选 ------------------------------------
  const first = await call('mem_write', { text: '爸爸喜欢吃辣，尤其火锅', tag: '家庭' });
  assert.equal(first.added, true);
  assert.equal(first.tag, '家庭');
  assert.match(first.time, /^\d{4}-\d{2}-\d{2}T/);

  const second = await call('mem_write', { text: '周末想去看海', tag: '计划', important: true });
  assert.equal(second.added, true);
  assert.equal(second.important, true);
  assert.equal(second.candidateIndex, 1);

  const duplicate = await call('mem_write', { text: '爸爸喜欢吃辣，尤其火锅', tag: '家庭' });
  assert.equal(duplicate.added, false, '当天相同条目不应重复写入');

  const hotAfter = await call('mem_hot_get');
  assert.equal(hotAfter.candidateCount, 1);
  assert.equal(hotAfter.candidates[0].content, '周末想去看海');
  assert.equal(hotAfter.content, body, '候选不应混进热层正文');

  // --- 跨月召回 ------------------------------------------------------------
  const today = new Date();
  const todayKey = localDateKey(today);
  const prevMonth = previousMonthKey(today);
  const oldDateKey = `${prevMonth}-05`;
  writeColdDay(oldDateKey, `- [${oldDateKey}T02:00:00.000Z] [家庭] 爸爸上次吃火锅被辣到`);

  const recalled = await call('mem_recall', { keyword: '辣' });
  assert.ok(recalled.matched >= 2, `应至少命中 2 条，实际 ${recalled.matched}`);
  assert.ok(recalled.items.some((item) => item.date.startsWith(prevMonth)), '应召回上个月的条目');
  assert.ok(recalled.items.some((item) => item.date === todayKey), '应召回今天的条目');
  assert.equal(recalled.mode, 'and', '默认模式是 and');

  const conjunctive = await call('mem_recall', { keyword: '爸爸 火锅' });
  assert.ok(conjunctive.matched >= 1, '多个词需同时命中');
  const none = await call('mem_recall', { keyword: '完全搜不到的词' });
  assert.equal(none.returned, 0);

  // --- 日 / 周 / 月摘要 -----------------------------------------------------
  const daySummary = await call('mem_summarize', { period: 'day' });
  assert.equal(daySummary.ok, true);
  assert.equal(daySummary.created, true);
  assert.ok(daySummary.sourceCount >= 2);
  assert.ok(daySummary.content.includes('爸爸喜欢吃辣'));
  assert.ok(existsSync(daySummary.path), '日摘要应落盘');

  const dayAgain = await call('mem_summarize', { period: 'day' });
  assert.equal(dayAgain.created, false, '已存在时应直接返回');
  assert.ok(dayAgain.content.includes('爸爸喜欢吃辣'));

  const weekSummary = await call('mem_summarize', { period: 'week' });
  assert.equal(weekSummary.created, true);
  assert.ok(weekSummary.content.includes('爸爸喜欢吃辣'));
  assert.ok(existsSync(weekSummary.path), '周摘要应落盘');
  assert.ok(isoWeekDates(today).includes(todayKey));

  const monthSummary = await call('mem_summarize', { period: 'month' });
  assert.equal(monthSummary.created, true);
  assert.ok(monthSummary.content.includes('爸爸喜欢吃辣'));
  assert.ok(existsSync(monthSummary.path), '月摘要应落盘');

  const forceSummary = await call('mem_summarize', { period: 'month', force: true });
  assert.equal(forceSummary.created, true, 'force=true 应重新生成');

  const emptyPeriod = await call('mem_summarize', { period: 'day', date: '1999-01-01' });
  assert.equal(emptyPeriod.created, false);
  assert.equal(emptyPeriod.content, '');

  // --- v1.1 窗口查询：最近 N 天 --------------------------------------------
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  writeColdDay(yesterdayKey, `- [${yesterdayKey}T10:00:00.000Z] [天气] 昨天下了小雨`);

  const recentToday = await call('mem_recent', { days: 1 });
  assert.equal(recentToday.ok, true);
  assert.equal(recentToday.days, 1);
  assert.equal(recentToday.to, todayKey);
  assert.equal(recentToday.from, todayKey);
  assert.ok(recentToday.matched >= 2);
  assert.ok(recentToday.items.every((item) => item.date === todayKey), 'days=1 只应包含今天');

  const recentTwo = await call('mem_recent', { days: 2, limit: 10 });
  assert.equal(recentTwo.days, 2);
  assert.ok(recentTwo.items.some((item) => item.date === yesterdayKey), 'days=2 应包含昨天');
  assert.ok(recentTwo.matched > recentToday.matched, '天数变大应覆盖更多条目');

  const recentDefault = await call('mem_recent');
  assert.equal(recentDefault.days, 3, '默认 3 天');

  // --- v1.1 窗口查询：按标签 -----------------------------------------------
  const family = await call('mem_by_tag', { tag: '家庭' });
  assert.equal(family.ok, true);
  assert.equal(family.tag, '家庭');
  assert.ok(family.matched >= 2, '家庭标签应命中今天与上月两条');
  assert.ok(family.items.every((item) => item.tag === '家庭'));

  const missingTag = await call('mem_by_tag', { tag: '不存在的标签' });
  assert.equal(missingTag.matched, 0);

  const untagged = await call('mem_write', { text: '随手记一条没有标签的' });
  assert.equal(untagged.tag, '-');
  const dashTag = await call('mem_by_tag', { tag: '-' });
  assert.equal(dashTag.matched, 1, '- 应取没有标签的条目');

  // --- v1.1 窗口查询：按日期区间 -------------------------------------------
  const range = await call('mem_by_date', { from: yesterdayKey, to: todayKey });
  assert.equal(range.ok, true);
  assert.equal(range.from, yesterdayKey);
  assert.equal(range.to, todayKey);
  assert.ok(range.matched >= 3, '昨天到今天的区间应包含 3 条以上');
  assert.ok(range.items.some((item) => item.date === yesterdayKey));

  const oldRange = await call('mem_by_date', { from: oldDateKey, to: oldDateKey });
  assert.equal(oldRange.matched, 1, '单日区间应只含上月那一条');

  await assert.rejects(
    () => call('mem_by_date', { from: todayKey, to: yesterdayKey }),
    /from 不能晚于 to/,
  );
  await assert.rejects(
    () => call('mem_by_date', { from: '2026-13-01', to: todayKey }),
    /from 必须是/,
  );

  // --- v1.1 recall mode=or ------------------------------------------------
  await call('mem_write', { text: '喜欢苹果', tag: '水果' });
  await call('mem_write', { text: '喜欢香蕉', tag: '水果' });

  const andMode = await call('mem_recall', { keyword: '苹果 香蕉' });
  assert.equal(andMode.matched, 0, 'and 要求同时包含两词');
  const orMode = await call('mem_recall', { keyword: '苹果 香蕉', mode: 'or' });
  assert.equal(orMode.matched, 2, 'or 命中任一即可');
  assert.equal(orMode.mode, 'or');
  await assert.rejects(
    () => call('mem_recall', { keyword: '苹果', mode: 'xor' }),
    /mode 必须是/,
  );

  // --- v1.1 热层主题索引 --------------------------------------------------
  const bodyWithTopics = `${body}\n\n<!-- topics:start -->\n翻唱|2026-10\n旅行|2026-09\n<!-- topics:end -->`;
  const withTopics = await call('mem_hot_set', { content: bodyWithTopics });
  assert.equal(withTopics.topicCount, 2);
  assert.equal(
    withTopics.chars,
    Array.from(body).length,
    '主题索引不占正文字数',
  );

  const hotWithTopics = await call('mem_hot_get');
  assert.equal(hotWithTopics.topicCount, 2);
  assert.equal(hotWithTopics.topics[0].topic, '翻唱');
  assert.equal(hotWithTopics.topics[0].month, '2026-10');
  assert.equal(hotWithTopics.content, body, '正文不含主题索引块');

  // 只改正文时索引与候选都应保留
  const keepIndex = await call('mem_hot_set', { content: `${body}\n- 新增一行` });
  assert.equal(keepIndex.topicCount, 2, '不带 topics 块时保留原索引');
  assert.equal(keepIndex.candidateCount, 1, '不带 candidates 块时保留原候选');

  // --- 统计 ----------------------------------------------------------------
  const stats = await call('mem_stats');
  assert.equal(stats.hot.chars, Array.from(`${body}\n- 新增一行`).length);
  assert.equal(stats.hot.limit, 600);
  assert.equal(stats.hot.candidates, 1);
  assert.equal(stats.hot.topics, 2);
  assert.equal(stats.cold.files, 3, '今天 + 昨天 + 上个月各一个文件');
  assert.equal(stats.cold.entries, 7);
  assert.ok(stats.cold.months.length >= 2);
  assert.equal(stats.summaries.day.files, 1);
  assert.equal(stats.summaries.week.files, 1);
  assert.equal(stats.summaries.month.files, 1);

  // --- 重启后数据完整：子进程重新读文件 ------------------------------------
  const roundtrip = execFileSync(
    process.execPath,
    [path.join(root, 'roundtrip.mjs')],
    { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' },
  );
  const persisted = JSON.parse(roundtrip.trim());
  assert.equal(persisted.hot, `${body}\n- 新增一行`);
  assert.equal(persisted.coldEntries, 7);
  assert.equal(persisted.topicCount, 2);

  // --- 手动损坏的文件不应让读取崩溃 ----------------------------------------
  writeFileSync(
    coldFileFor(todayKey),
    `${readFileSync(coldFileFor(todayKey), 'utf8')}这不是条目行\n`,
    'utf8',
  );
  const tolerant = await call('mem_recall', { keyword: '火锅' });
  assert.ok(tolerant.matched >= 1);

  const raw = readFileSync(path.join(home, 'dsh-memory-layers', 'hot.md'), 'utf8');
  assert.ok(raw.includes('<!-- candidates:start -->'), '候选区应保留');
  assert.ok(raw.includes('<!-- candidates:end -->'));
  assert.ok(raw.includes('<!-- topics:start -->'), '主题索引区应保留');
  assert.ok(raw.includes('<!-- topics:end -->'));

  console.log('smoke: 全部通过');
} finally {
  rmSync(home, { recursive: true, force: true });
}
