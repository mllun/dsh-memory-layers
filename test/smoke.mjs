/**
 * Smoke test for dsh-memory-layers.
 *
 * Runs against a temporary DSH_HOME, drives the registered tools through a
 * minimal host context, and covers the acceptance list: hot layer readable,
 * cold layer recallable across months, day/week/month summaries generated,
 * over-limit reported, and data surviving a fresh process.
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

try {
  const { ctx, registered } = createContext();
  apply(ctx, { hotLimit: 600 });

  const names = ['mem_hot_get', 'mem_hot_set', 'mem_write', 'mem_recall', 'mem_summarize', 'mem_stats'];
  for (const name of names) assert.ok(registered.has(name), `缺少工具 ${name}`);

  const call = (name, args = {}) => registered.get(name).execute(args);

  // --- 热层：空、超限、写入、回读 ------------------------------------------
  const empty = await call('mem_hot_get');
  assert.equal(empty.ok, true);
  assert.equal(empty.chars, 0);
  assert.equal(empty.overLimit, false);

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
  const oldFile = path.join(home, 'dsh-memory-layers', 'cold', prevMonth, `${prevMonth}-05.md`);
  mkdirSync(path.dirname(oldFile), { recursive: true });
  writeFileSync(
    oldFile,
    `# ${prevMonth}-05 记忆\n\n- [${prevMonth}-05T02:00:00.000Z] [家庭] 爸爸上次吃火锅被辣到\n`,
    'utf8',
  );

  const recalled = await call('mem_recall', { keyword: '辣' });
  assert.ok(recalled.matched >= 2, `应至少命中 2 条，实际 ${recalled.matched}`);
  assert.ok(
    recalled.items.some((item) => item.date.startsWith(prevMonth)),
    '应召回上个月的条目',
  );
  assert.ok(
    recalled.items.some((item) => item.date === todayKey),
    '应召回今天的条目',
  );

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

  // --- 统计 ----------------------------------------------------------------
  const stats = await call('mem_stats');
  assert.equal(stats.hot.chars, Array.from(body).length);
  assert.equal(stats.hot.limit, 600);
  assert.equal(stats.hot.candidates, 1);
  assert.equal(stats.cold.files, 2, '今天 + 上个月各一个文件');
  assert.equal(stats.cold.entries, 3);
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
  assert.equal(persisted.hot, body);
  assert.equal(persisted.coldEntries, 3);

  // --- 手动损坏的文件不应让读取崩溃 ----------------------------------------
  const todayFile = path.join(home, 'dsh-memory-layers', 'cold', todayKey.slice(0, 7), `${todayKey}.md`);
  writeFileSync(todayFile, `${readFileSync(todayFile, 'utf8')}这不是条目行\n`, 'utf8');
  const tolerant = await call('mem_recall', { keyword: '火锅' });
  assert.ok(tolerant.matched >= 1);

  const raw = readFileSync(path.join(home, 'dsh-memory-layers', 'hot.md'), 'utf8');
  assert.ok(raw.includes('<!-- candidates:start -->'), '候选区应保留');
  assert.ok(raw.includes('<!-- candidates:end -->'));

  console.log('smoke: 全部通过');
} finally {
  rmSync(home, { recursive: true, force: true });
}
