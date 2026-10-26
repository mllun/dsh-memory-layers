/**
 * Smoke test for dsh-memory-layers.
 *
 * Runs against a temporary memory root, drives the registered tools through a
 * minimal host context, and covers the acceptance lists of v1.0/v1.1 and v1.2:
 *
 *  - v1.0/v1.1: hot layer readable, cold layer recallable across months,
 *    day/week/month summaries, over-limit reporting, window queries
 *    (recent / by_tag / by_date), `mode` on recall, hot topic index.
 *  - v1.2: auto-evict, candidate TTL, usage trace + weight decay, bigram
 *    ranking, source evidence, tiered summary compression, session auto-log.
 *
 * The data root is redirected with DSH_MEMORY_ROOT so the real memory of this
 * machine is never touched.
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
process.env.DSH_MEMORY_ROOT = home;

const dataDir = path.join(home, 'memory');
const { apply } = await import('../index.js');
const { isoWeekDates, localDateKey, localMonthKey } = await import('../lib/paths.mjs');
const { flushUsage, resetUsageCache } = await import('../lib/usage.mjs');
const { createSessionTracker } = await import('../lib/session.mjs');

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
    on() {},
    logger: { info() {}, warn() {} },
  };
  const call = (name, args = {}) => registered.get(name).execute(args);
  return { ctx, registered, call };
}

/** Previous calendar month key, e.g. 2026-09 for 2026-10. */
function previousMonthKey(date) {
  const previous = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return localMonthKey(previous);
}

/** Cold file path for one date key. */
function coldFileFor(dateKey) {
  return path.join(dataDir, 'cold', dateKey.slice(0, 7), `${dateKey}.md`);
}

/** Hot-layer file. */
function hotFile() {
  return path.join(dataDir, 'hot.md');
}

/** Usage ledger file. */
function usageFile() {
  return path.join(dataDir, 'usage.json');
}

/** Write one hand-made cold file, used to simulate older days. */
function writeColdDay(dateKey, line) {
  const file = coldFileFor(dateKey);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# ${dateKey} 记忆\n\n${line}\n`, 'utf8');
}

/** Append one entry line to a hand-made cold day. */
function appendColdDay(dateKey, line) {
  const file = coldFileFor(dateKey);
  mkdirSync(path.dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : `# ${dateKey} 记忆\n`;
  writeFileSync(file, `${current}${line}\n`, 'utf8');
}

/** ISO stamp `days` days in the past. */
function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** Read the usage ledger from disk (flushing the throttled writer first). */
function readUsage() {
  flushUsage();
  if (!existsSync(usageFile())) return { entries: {} };
  return JSON.parse(readFileSync(usageFile(), 'utf8'));
}

/** Overwrite the usage ledger and drop the in-memory copy. */
function writeUsage(ledger) {
  writeFileSync(usageFile(), `${JSON.stringify(ledger)}\n`, 'utf8');
  resetUsageCache();
}

/** A padding helper so blocks clear the 20-character eviction floor. */
function block(label, chars = 120) {
  return `${label}：${'填充'.repeat(Math.ceil(chars / 2))}`;
}

try {
  // ------------------------------------------------------------------------
  // v1.0 / v1.1 behaviour, with autoEvict off to prove the old path is intact
  // ------------------------------------------------------------------------
  const { ctx, registered, call } = createContext();
  apply(ctx, { hotLimit: 600, autoEvict: false });

  const names = [
    'mem_hot_get', 'mem_hot_set', 'mem_write', 'mem_recall',
    'mem_recent', 'mem_by_tag', 'mem_by_date',
    'mem_summarize', 'mem_stats',
  ];
  for (const name of names) assert.ok(registered.has(name), `缺少工具 ${name}`);

  // --- 热层：空、超限、写入、回读 ------------------------------------------
  const empty = await call('mem_hot_get');
  assert.equal(empty.ok, true);
  assert.equal(empty.chars, 0);
  assert.equal(empty.overLimit, false);
  assert.equal(empty.topicCount, 0);
  assert.deepEqual(empty.pruned, { expired: 0, overflow: 0, kept: 0 });

  const tooLong = '记'.repeat(700);
  const over = await call('mem_hot_set', { content: tooLong });
  assert.equal(over.ok, true);
  assert.equal(over.overLimit, true, '超限必须返回 overLimit=true');
  assert.ok(over.hint.includes('精简'), '超限必须给出精简提示');
  assert.equal(over.charsAfterEvict, 700, 'autoEvict=false 时不腾挪');
  assert.deepEqual(over.evicted, [], 'autoEvict=false 时不腾挪');
  assert.ok(existsSync(hotFile()));

  const body = '# 核心\n- 名字：测试角色\n- 约定：每天写日记';
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
  assert.equal(first.source, null, '不传 source 时来源为空');
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
  assert.equal(recalled.items[0].source, null, '旧格式条目的 source 为 null');
  assert.ok(Number.isFinite(recalled.items[0].score), '条目应带 score');

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
  assert.ok(daySummary.content.includes('压缩比：原'), '头部应写压缩比');
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
  assert.ok(monthSummary.content.includes('压缩比：原'), '月摘要头部应写压缩比');
  assert.ok(
    monthSummary.content.includes('[家庭] 共'),
    '月摘要里非保留 tag 应汇总成「共 N 条」一行',
  );
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
  assert.ok(Array.isArray(stats.topRecalled), 'v1.2 新增 topRecalled');
  assert.ok(stats.topRecalled.length > 0, '召回过的条目应出现在 topRecalled 里');
  assert.ok(stats.topRecalled[0].hits >= 1);
  assert.ok(stats.topRecalled[0].content.length <= 40, 'topRecalled 只留前 40 字');

  // --- 重启后数据完整：子进程重新读文件 ------------------------------------
  const roundtrip = execFileSync(
    process.execPath,
    [path.join(root, 'roundtrip.mjs')],
    { env: { ...process.env, DSH_HOME: home, DSH_MEMORY_ROOT: home }, encoding: 'utf8' },
  );
  const persisted = JSON.parse(roundtrip.trim());
  assert.equal(persisted.hot, `${body}\n- 新增一行`);
  assert.equal(persisted.coldEntries, 7);
  assert.equal(persisted.topicCount, 2);

  // --- 手动损坏的文件不应让读取崩溃 ----------------------------------------
  writeFileSync(coldFileFor(todayKey), `${readFileSync(coldFileFor(todayKey), 'utf8')}这不是条目行\n`, 'utf8');
  const tolerant = await call('mem_recall', { keyword: '火锅' });
  assert.ok(tolerant.matched >= 1);

  const raw = readFileSync(hotFile(), 'utf8');
  assert.ok(raw.includes('<!-- candidates:start -->'), '候选区应保留');
  assert.ok(raw.includes('<!-- candidates:end -->'));
  assert.ok(raw.includes('<!-- topics:start -->'), '主题索引区应保留');
  assert.ok(raw.includes('<!-- topics:end -->'));

  // ------------------------------------------------------------------------
  // v1.2
  // ------------------------------------------------------------------------
  const v12 = createContext();
  apply(v12.ctx, { hotLimit: 600 });

  // --- 变更六：source 证据 -------------------------------------------------
  const sourced = await v12.call('mem_write', {
    text: '带来源的条目：今天调了翻唱参数',
    tag: '翻唱',
    source: { conv: 'private:1234567890', seq: 977 },
  });
  assert.equal(sourced.added, true);
  assert.equal(sourced.source.conv, 'private:1234567890');
  const sourcedLine = readFileSync(coldFileFor(sourced.date), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.includes('带来源的条目'));
  assert.ok(
    sourcedLine.endsWith('〔src:private:1234567890#977〕'),
    `行尾应带来源标记，实际：${sourcedLine}`,
  );

  const sourcedRecall = await v12.call('mem_recall', { keyword: '带来源的条目' });
  assert.equal(sourcedRecall.returned, 1);
  assert.equal(sourcedRecall.items[0].source.conv, 'private:1234567890');
  assert.equal(sourcedRecall.items[0].source.seq, 977);
  assert.ok(!sourcedRecall.items[0].content.includes('〔src'), 'content 不含来源后缀');

  const sameTextNewSource = await v12.call('mem_write', {
    text: '带来源的条目：今天调了翻唱参数',
    tag: '翻唱',
    source: { conv: 'private:1234567890', seq: 978 },
  });
  assert.equal(sameTextNewSource.added, false, '相同内容不新增行');
  assert.equal(sameTextNewSource.sourceUpdated, true, '只更新来源');
  const updatedLines = readFileSync(coldFileFor(sourced.date), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('带来源的条目'));
  assert.equal(updatedLines.length, 1, '来源更新不应产生重复行');
  assert.ok(updatedLines[0].endsWith('〔src:private:1234567890#978〕'));

  const msgIdWrite = await v12.call('mem_write', {
    text: '带 msgId 的来源条目',
    tag: '翻唱',
    source: { conv: 'private:1', seq: 12, msgId: 'm-9' },
  });
  const msgIdLine = readFileSync(coldFileFor(msgIdWrite.date), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.includes('带 msgId 的来源条目'));
  assert.ok(msgIdLine.endsWith('〔src:private:1#12/m-9〕'));

  // --- 变更四：二元组召回 ------------------------------------------------
  const ngramDay = '2026-10-02';
  writeColdDay(ngramDay, `- [${ngramDay}T03:00:00.000Z] [翻唱] 翻唱的时候注意权重分配`);
  appendColdDay(ngramDay, `- [${ngramDay}T03:00:00.000Z] [天气] 今天天气不错`);

  const strictNgram = await v12.call('mem_recall', { keyword: '翻唱权重' });
  assert.equal(strictNgram.matched, 0, 'and 模式要求全部二元组命中');
  const looseNgram = await v12.call('mem_recall', { keyword: '翻唱权重', mode: 'any' });
  assert.ok(looseNgram.matched >= 1, 'any 模式任一二元组命中即可');
  assert.ok(looseNgram.items.some((item) => item.content.includes('翻唱的时候注意权重分配')));
  assert.equal(looseNgram.mode, 'any');
  assert.ok(looseNgram.probes.includes('翻唱'));
  assert.ok(looseNgram.probes.includes('权重'));
  assert.ok(looseNgram.items[0].matched >= 2, 'matched 记录命中的二元组个数');

  // --- 变更三：召回留痕 ---------------------------------------------------
  const traceDay = '2026-10-03';
  writeColdDay(traceDay, `- [${traceDay}T04:00:00.000Z] [翻唱] 高频条目：混音参数定稿`);
  appendColdDay(traceDay, `- [${traceDay}T04:00:00.000Z] [翻唱] 低频条目：混音参数待定`);
  for (let round = 0; round < 5; round += 1) {
    await v12.call('mem_recall', { keyword: '混音参数定稿', limit: 1 });
  }
  const ledger = readUsage();
  const hotRecord = Object.values(ledger.entries).find((entry) => entry.hits >= 5);
  assert.ok(hotRecord, '连续召回后 usage.json 应记录命中次数');
  assert.ok(hotRecord.weight >= 80, `权重应由 50 涨到 >= 80，实际 ${hotRecord.weight}`);

  const ranked = await v12.call('mem_recall', { keyword: '混音参数' });
  assert.ok(ranked.items.length >= 2);
  assert.ok(
    ranked.items[0].content.includes('定稿'),
    '被频繁召回的条目应排在时间相同但只出现一次的条目前面',
  );
  assert.ok(ranked.items[0].score >= ranked.items[1].score);

  const tracedStats = await v12.call('mem_stats');
  assert.ok(tracedStats.topRecalled.length > 0, 'mem_stats 应列出最常被召回的条目');
  assert.ok(tracedStats.topRecalled[0].hits >= 5);
  assert.ok(tracedStats.topRecalled.length <= 5);
  assert.ok(tracedStats.weightTop.length > 0 && tracedStats.weightTop[0].weight >= 80);
  assert.ok(tracedStats.weightBottom.length > 0);
  assert.ok(tracedStats.weightBottom[0].weight <= tracedStats.weightTop[0].weight);

  // --- 变更七：权重半衰期 -------------------------------------------------
  const decayTarget = Object.entries(readUsage().entries).find(([, record]) => record.hits >= 5);
  assert.ok(decayTarget, '需要一个已知条目做衰减测试');
  const [decayKey, decayRecord] = decayTarget;
  writeUsage({
    version: 1,
    entries: {
      [decayKey]: {
        ...decayRecord,
        weight: 80,
        lastDecayAt: daysAgo(60),
      },
    },
  });
  const decayStats = await v12.call('mem_stats');
  const decayed = decayStats.weightTop.find((row) => row.weight !== undefined);
  assert.ok(decayed, '衰减后仍应能看到权重');
  assert.ok(
    Math.abs(decayed.weight - 20) <= 2,
    `60 天（两个半衰期）后 weight 应约为 20，实际 ${decayed.weight}`,
  );

  // --- 变更一：热层自动腾挪 -----------------------------------------------
  const lowBlock = block('低权重块', 140);
  const heavyBlock = block('高权重块', 140);
  const fillerOne = block('填充块甲', 140);
  const fillerTwo = block('填充块乙', 140);
  const heading = '# 核心记忆（标题不可腾挪）';

  // 先写入一次（正文很短，不会触发腾挪），再回填权重
  const seedBody = `${heading}\n\n${lowBlock}`;
  const seeded = await v12.call('mem_hot_set', { content: seedBody });
  assert.equal(seeded.ok, true);
  assert.deepEqual(seeded.evicted, [], '未超限时不应腾挪');

  const crypto = await import('node:crypto');
  const keyOf = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex');
  const freshBlock = block('刚被召回块', 140);
  const staleBlock = block('六十天前召回块', 140);
  const seededUsage = readUsage();
  writeUsage({
    version: 1,
    entries: {
      ...seededUsage.entries,
      // 从未被召回、权重已经很低 → 最该被腾
      [keyOf(lowBlock)]: {
        hits: 0,
        firstHitAt: '',
        lastHitAt: '',
        weight: 10,
        lastDecayAt: new Date().toISOString(),
      },
      // 45 天前召回、权重仍高 → 不动
      [keyOf(heavyBlock)]: {
        hits: 9,
        firstHitAt: daysAgo(120),
        lastHitAt: daysAgo(45),
        weight: 60,
        lastDecayAt: new Date().toISOString(),
      },
      // 5 天前召回 → 保护
      [keyOf(freshBlock)]: {
        hits: 1,
        firstHitAt: daysAgo(5),
        lastHitAt: daysAgo(5),
        weight: 5,
        lastDecayAt: new Date().toISOString(),
      },
      // 60 天前召回、权重已衰减到很低 → 90 天内命中过，仍不得腾挪
      [keyOf(staleBlock)]: {
        hits: 1,
        firstHitAt: daysAgo(60),
        lastHitAt: daysAgo(60),
        weight: 8,
        lastDecayAt: new Date().toISOString(),
      },
    },
  });

  const bigBody = [
    heading,
    lowBlock,
    heavyBlock,
    freshBlock,
    staleBlock,
    fillerOne,
    fillerTwo,
    block('填充块丙', 160),
  ].join('\n\n');
  const evictedResult = await v12.call('mem_hot_set', { content: bigBody });
  assert.equal(evictedResult.ok, true);
  assert.ok(evictedResult.evicted.length > 0, '超限后应自动腾挪');
  assert.ok(
    evictedResult.chars <= 510,
    `腾挪后应降到 evictTarget(510) 附近，实际 ${evictedResult.chars}`,
  );
  assert.equal(evictedResult.charsAfterEvict, evictedResult.chars);
  assert.ok(evictedResult.evictHint.includes('hot-evict'));
  const evictedTexts = evictedResult.evicted.map((item) => item.content);
  assert.ok(
    evictedTexts.some((text) => text.includes('低权重块')),
    '低权重且 40 天未命中的块应被腾挪',
  );
  assert.ok(
    !evictedTexts.some((text) => text.includes('高权重块')),
    'weight=60 的块不应被腾挪',
  );
  assert.ok(
    !evictedTexts.some((text) => text.includes('刚被召回块')),
    '30 天内被命中过的块即使权重低也不得腾挪',
  );
  assert.ok(
    !evictedTexts.some((text) => text.includes('六十天前召回块')),
    '90 天内被命中过的条目不得出现在 evicted 里',
  );
  assert.ok(!evictedTexts.some((text) => text.startsWith('#')), '# 标题永不被腾挪');
  assert.ok(evictedResult.evicted.every((item) => item.chars >= 20 && item.reason.length > 0));

  const coldAfterEvict = readFileSync(coldFileFor(localDateKey()), 'utf8');
  for (const item of evictedResult.evicted) {
    assert.ok(
      coldAfterEvict.includes(item.content),
      '每个被腾挪的块都应能在当天冷层里找到',
    );
  }
  assert.ok(coldAfterEvict.includes('[hot-evict]'));

  const hotAfterEvict = readFileSync(hotFile(), 'utf8');
  assert.ok(hotAfterEvict.includes('<!-- candidates:start -->'), '腾挪后候选区仍在');
  assert.ok(hotAfterEvict.includes('<!-- topics:start -->'), '腾挪后主题索引区仍在');
  assert.ok(hotAfterEvict.includes(heading), '标题仍在正文里');
  assert.ok(hotAfterEvict.includes('刚被召回块'), '受保护的块仍在正文里');

  // --- 变更二：候选 TTL ---------------------------------------------------
  const candidateDay = localDateKey();
  const candidates = [];
  for (let index = 0; index < 15; index += 1) {
    const age = index === 0 ? 40 : index;
    candidates.push(
      `- [${daysAgo(age)}] [候选] 候选条目第 ${index} 号内容 ${'补'.repeat(12)}`,
    );
  }
  writeFileSync(
    hotFile(),
    [
      '# 核心',
      '正文一行',
      '<!-- candidates:start -->',
      ...candidates,
      '<!-- candidates:end -->',
      '',
      '<!-- topics:start -->',
      '翻唱|2026-10',
      '<!-- topics:end -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const prunedHot = await v12.call('mem_hot_get');
  assert.equal(prunedHot.candidateCount, 12, '候选应被压到 candidateMax=12');
  assert.equal(prunedHot.pruned.expired, 1, '40 天前的候选应过期下沉');
  assert.equal(prunedHot.pruned.overflow, 2, '超出上限的最旧 2 条应下沉');
  assert.equal(prunedHot.pruned.kept, 12);
  assert.ok(
    !prunedHot.candidates.some((candidate) => candidate.content.includes('第 0 号')),
    '过期候选应从候选区消失',
  );
  const coldWithCandidates = readFileSync(coldFileFor(candidateDay), 'utf8');
  assert.ok(coldWithCandidates.includes('[candidate-expired] [候选] 候选条目第 0 号'), '下沉条目保留原 tag 前缀');
  assert.ok(prunedHot.content.includes('正文一行'), '正文不受影响');
  assert.equal(prunedHot.topicCount, 1, '主题索引不受影响');

  // --- 变更五：摘要自动分级 -----------------------------------------------
  await v12.call('mem_hot_set', { content: '# 核心\n正文一行' });
  const countToday = () => readFileSync(coldFileFor(localDateKey()), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\[/.test(line)).length;
  let summaryCreated = false;
  let guard = 0;
  while (!summaryCreated && guard < 40) {
    const written = await v12.call('mem_write', {
      text: `自动摘要测试条目 ${guard}：${'内容'.repeat(8)}`,
      tag: guard % 3 === 0 ? '约定' : '自动',
    });
    summaryCreated = written.summaryCreated;
    guard += 1;
  }
  assert.ok(summaryCreated, `跨过 20 条时应自动生成日摘要（当天已有 ${countToday()} 条）`);
  const autoDayFile = path.join(dataDir, 'summaries', 'day', `${localDateKey()}.md`);
  assert.ok(existsSync(autoDayFile), '日摘要文件应自动出现');
  const autoDayText = readFileSync(autoDayFile, 'utf8');
  assert.ok(autoDayText.includes('压缩比：原'));
  assert.ok(autoDayText.includes('自动摘要测试条目'), '自动摘要应覆盖新条目');

  // 周摘要也要重生成，否则月摘要读到的还是旧的周摘要
  await v12.call('mem_summarize', { period: 'week', force: true });
  const monthAuto = await v12.call('mem_summarize', { period: 'month', force: true });
  assert.ok(monthAuto.content.includes('压缩比：原'));
  assert.ok(
    monthAuto.content.includes('[约定] '),
    '月摘要应保留 约定 的独立行',
  );
  const monthLineCount = monthAuto.content
    .split(/\r?\n/)
    .filter((line) => /^\s*-\s*\[/.test(line)).length;
  assert.ok(monthLineCount < monthAuto.sourceCount, '月摘要行数应明显少于原条目数');
  assert.ok(monthAuto.topicsAdded >= 0);

  const topicsAfterSummaries = await v12.call('mem_hot_get');
  const topicRows = topicsAfterSummaries.topics.map((topic) => `${topic.topic}|${topic.month}`);
  assert.equal(new Set(topicRows).size, topicRows.length, '主题索引不应出现重复行');
  assert.ok(topicRows.length > 0, '摘要生成后应把高频 tag 补进主题索引');

  const repeatMonth = await v12.call('mem_summarize', { period: 'month', force: true });
  const topicsAfterRepeat = await v12.call('mem_hot_get');
  assert.equal(
    topicsAfterRepeat.topicCount,
    topicsAfterSummaries.topicCount,
    '重复生成摘要不应重复补主题索引行',
  );
  assert.ok(repeatMonth.created);

  // --- 变更八：会话结束自动落档 -------------------------------------------
  const sessionConfig = {
    hotLimit: 600,
    autoEvict: true,
    evictTarget: 510,
    candidateTtlDays: 30,
    candidateMax: 12,
    usageThrottleMs: 5000,
    halfLifeDays: 30,
    demoteThreshold: 20,
    autoLogOnSessionEnd: true,
    autoLogMinTurns: 4,
  };
  const tracker = createSessionTracker({ config: sessionConfig, conv: 'private:42' });
  for (let turn = 1; turn <= 6; turn += 1) tracker.note(`第 ${turn} 轮：聊了翻唱参数和画画`);
  const closed = tracker.close();
  assert.equal(closed.logged, true, '6 轮对话结束后应自动落档');
  const sessionLine = readFileSync(coldFileFor(localDateKey()), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.includes('[session]'));
  assert.ok(sessionLine, '冷层应出现 tag=session 的条目');
  assert.ok(sessionLine.endsWith('〔src:private:42#6〕'), '自动落档应带 source');
  const sessionContent = sessionLine.replace(/^\s*-\s*\[[^\]]+\]\s*\[[^\]]*\]\s*/, '').replace(/\s*〔src:[^〕]*〕$/, '');
  assert.ok(Array.from(sessionContent).length <= 200, '自动落档不超过 200 字');

  const again = tracker.close();
  assert.equal(again.logged, false);
  assert.equal(again.reason, 'duplicate', '同一场会话重复触发不应重复写入');
  const sessionLines = readFileSync(coldFileFor(localDateKey()), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('[session]'));
  assert.equal(sessionLines.length, 1);

  const disabledTracker = createSessionTracker({
    config: { ...sessionConfig, autoLogOnSessionEnd: false },
    conv: 'private:43',
  });
  for (let turn = 1; turn <= 6; turn += 1) disabledTracker.note(`第 ${turn} 轮`);
  assert.equal(disabledTracker.close().logged, false, 'autoLogOnSessionEnd=false 时不落档');

  const shortTracker = createSessionTracker({ config: sessionConfig, conv: 'private:44' });
  shortTracker.note('只有一轮');
  assert.equal(shortTracker.close().logged, false, '不足 autoLogMinTurns 轮不落档');

  console.log('smoke: 全部通过');
} finally {
  rmSync(home, { recursive: true, force: true });
}
