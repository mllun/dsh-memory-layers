# dsh-memory-layers

给 DeepSeek Harness 的分层长期记忆：一个约 600 字、每次会话必读的**热层**，一份按月归档、可按关键词跨月召回的**冷层全文**，以及**日 → 周 → 月**三级抽取式摘要。目标是在不撑大上下文的前提下，让很久以前的细节仍然找得回来。

Layered long-term memory for DeepSeek Harness: a ~600-character hot layer, a month-archived cold layer with keyword recall, and extractive day/week/month summaries that keep injected context small.

v1.1 起，冷层还能按**最近 N 天**、**标签**、**日期区间**只读查询，热层多了一个不占字数的**主题索引**（`主题|年月`），用来先定位月份再取数。

v1.2 起，热层和候选区从“只存不管”变成**自己管自己**：超限自动腾挪、候选过期下沉、召回留痕并按使用度排序、摘要逐级自动压缩。全部是增量改动——工具名、既有返回字段、`hot.md` 与 `cold/` 结构都没变。

- 纯 Host 插件，没有前端资源，没有网络请求，没有第三方运行时依赖。
- 数据全部是 UTF-8 Markdown（外加一份 `usage.json` 账本），可读、可手改、可备份。
- 摘要只抽取原文并截断，不调用模型、不新增原文没有的句子。
- 四个查询（`mem_recall` / `mem_recent` / `mem_by_tag` / `mem_by_date`）**不改冷层原文**；它们只会在 `usage.json` 里记一笔命中，用来给后续召回排序、并保护常用的记忆不被腾挪。

## 为什么不是一个文件

一个 `notes.md` 迟早会长到几千条。要么每次会话把它全塞进上下文，要么模型永远想不起来细节。

这里把记忆拆成三层，每层只承担一件事：

| 层 | 体量 | 何时读 | 何时写 |
| --- | --- | --- | --- |
| 热层 `hot.md` | 约 600 字 | **每次会话开始** | 精简后全量覆盖（超限自动腾挪） |
| 冷层 `cold/YYYY-MM/YYYY-MM-DD.md` | 不限（单条 ≤ 4000 字） | 需要细节时 `mem_recall` | 随手追加（也会接收腾挪/下沉的块） |
| 摘要 `summaries/day|week|month/` | 日 1500 / 周 1000 / 月 700 字 | 回顾某段时间时 | 按天/周/月生成 |

热层放身份、长期约定、正在推进的事；细节写进冷层；想不起细节时按关键词召回；回顾一段时间时看摘要。热层永远不会因为冷层变长而变长。

## 数据布局

```
<DSH_HOME>/dsh-memory-layers/       ← 默认数据目录（$DSH_HOME 未设时为 ~/.dsh）
  hot.md                          热层正文 + 候选区 + 主题索引区
  cold/2026-10/2026-10-21.md      冷层：一天一个文件，按月分目录
  summaries/day/2026-10-21.md     日摘要
  summaries/week/2026-W43.md      周摘要（ISO-8601 周）
  summaries/month/2026-10.md      月摘要
  usage.json                      召回留痕与条目权重（v1.2）
```

数据目录默认跟着 `DSH_HOME` 走。想放到别的盘（DSH 重装不丢），设环境变量 `DSH_MEMORY_ROOT=D:\某目录`，数据就落在 `D:\某目录\memory`。所有条目共用一个行格式：

```
- [2026-10-21T03:10:00.000Z] [tag] 正文
- [2026-10-21T03:10:00.000Z] [tag] 正文 〔src:private:1234567890#977〕
```

时间是 ISO-8601（UTC）写入时间戳；文件按**本地日期**分区；`tag` 缺省为 `-`。v1.2 起行尾可以带一个可选的来源标记 `〔src:会话key#序号/消息id〕`，`content` 本身不含这段后缀。

热层里另有两个保留区，都不占正文的 600 字：

```markdown
<!-- candidates:start -->
- [2026-10-21T03:10:00.000Z] [计划] 周末想去看海
<!-- candidates:end -->

<!-- topics:start -->
翻唱|2026-10
旅行|2026-09
<!-- topics:end -->
```

## 安装

要求：Node.js ≥ 20，DeepSeek Harness 0.2.x（本插件是 Host 插件，依赖 `ctx.get('tools')` 注册工具）。

### 1. 从 npm 安装（推荐）

```bash
npm i -g dsh-memory-layers   # 或装进当前 profile 的 node_modules
```

包名就是 `dsh-memory-layers`，在 profile 的 `cordis.patch.yml` 里 `name: dsh-memory-layers` 即可。

### 2. 通过插件管理器安装仓库

先把仓库克隆到本地任意目录：

```bash
git clone https://github.com/mllun/dsh-memory-layers.git
```

然后在 DSH 里让插件管理器安装这个**包目录**：

```
plugin_manager({ action: "install_bundle", target: "<本仓库的绝对路径>" })
```

安装会把包链接进当前 profile（`dependencies` + `dsh.profile.bundles` + `node_modules`），并立即尝试激活。看到 `application: applied` 后，工具列表里会出现 `mem_hot_get` 等九个工具。

### 3. 手动注册

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-memory-layers
      name: dsh-memory-layers
      config:
        hotLimit: 600
        autoEvict: true
```

前提是该包已能被 Node 解析（放在 profile 的 `node_modules` 下，或从仓库路径 `file:` / `link:` 安装）。改完需要重启 DSH。

### 卸载

在插件管理器里移除 bundle，或从 `cordis.patch.yml` / `package.json` 的 bundles 列表里删掉。**卸载不会删除记忆数据**；要彻底清空，手动删除数据目录。

## 工具

九个工具，全部经由 `ctx.get('tools')` 注册。其中 `mem_recall`、`mem_recent`、`mem_by_tag`、`mem_by_date` 是只读查询，不修改冷层原文。

### `mem_hot_get()`

读热层。返回：

| 字段 | 说明 |
| --- | --- |
| `content` | 热层正文（不含候选区与主题索引） |
| `chars` / `limit` | 正文字数与上限（按 Unicode 码点计） |
| `overLimit` / `hint` | 是否超限，以及精简提示 |
| `candidates` / `candidateCount` | 待提升的候选条目 |
| `topics` / `topicCount` | 主题索引（`topic` + `month`） |
| `pruned` | 本次读取时自动下沉的候选：`{ expired, overflow, kept }` |

没有 `hot.md` 时返回空正文，不报错、不创建文件。

读取时顺带做一次候选体检：超过 `candidateTtlDays`（默认 30 天）的候选、以及超过 `candidateMax`（默认 12 条）后最旧的几条，会被下沉到当天冷层（`tag=candidate-expired`，正文保留原 tag 前缀，形如 `[原tag] 正文`），下沉条数写在 `pruned` 里。

### `mem_hot_set(content)`

用 `content` **全量覆盖**热层正文（不是追加）。返回写入后的字数、是否超限、精简提示。

- 传空字符串可清空正文（候选区与主题索引保留）。
- 正文超过上限时（`autoEvict` 默认开）会**自动腾挪**：按空行切块，把最不活跃的块整块搬到当天冷层（`tag=hot-evict`），直到字数降到 `evictTarget`（默认 `floor(limit*0.85)`）左右。返回新增的 `evicted`（每块含 `content` / `chars` / `reason`）、`charsAfterEvict`、`evictHint`。
- 只有同时满足这些条件的块才会被腾挪：**≥ 20 字**、**不含 `<!-- `**、**不以 `#` 开头**、**90 天内没被 `mem_recall` 等查询命中过**；如果 `usage.json` 里已有这条的记录，还要求**权重低于 `demoteThreshold`（默认 20）且够老**。热层永远不会被腾空，最后一块无论如何都留着。
- 腾挪**先写冷层成功、再从正文移除**；写失败就整体保持原样，只在 `evictHint` 里说明。
- `autoEvict: false` 时行为与 v1.1 完全一致：超限只返回 `overLimit: true` 与精简提示。
- 默认保留候选区和主题索引；如果 `content` 自带 `<!-- candidates:start -->` / `<!-- candidates:end -->` 注释块，则用块内条目**替换**候选区；自带 `<!-- topics:start -->` / `<!-- topics:end -->` 块则用块内 `主题|年月` 行**替换**主题索引。

### `mem_write(text, tag?, important?, source?)`

向**当天**冷层文件追加一条记忆。返回写入的日期、时间戳、tag、候选序号、来源。

- `text` 单行；换行和连续空白会压成空格；单条上限 4000 字。
- `tag` 可选，`[` `]` 会被去掉，避免破坏行格式。
- `important: true` 时同时把这条放进热层候选区（候选**不计入** 600 字），`candidateIndex` 返回从 1 开始的序号；不重要时为 `0`。
- `source: { conv, seq, msgId? }` 可选，会以 `〔src:conv#seq〕`（有 `msgId` 时 `〔src:conv#seq/msgId〕`）追加在行尾，之后所有查询都会把它解析回 `source`。
- 当天已有完全相同的（`tag` + 内容）条目时返回 `added: false`，不重复写；若这次带了**不同的** `source`，只更新那一行的来源标记（`sourceUpdated: true`），不新增重复行。
- 当天条目数每跨过一次 **20** 的倍数，会自动 `force` 重生成当天的日摘要（`summaryCreated: true`）；生成失败只记日志，不影响写入。

### `mem_recall(keyword, limit?, mode?)`

跨全部月份召回冷层条目。

- 大小写不敏感的子串匹配；内容或 tag 命中都算。
- 单个中文关键词（**3 字以上、不含空格**）会被切成**二元组**，所以「翻唱权重」也能找到只写了「翻唱…权重」的条目。
- `keyword` 里多个词用空格分隔时，默认要求**同时包含全部检索项**（`mode: "and"`）；传 `mode: "or"` 或 `"any"` 则任一命中即可。
- 结果按 `score = matched*2 + weight/5 + 新近加成` 排序（新近加成：30 天内 +3、90 天内 +1），同分按时间倒序，默认 10 条，最多 50 条。
- 每条返回 `score` / `matched` / `source`；整体返回 `mode` / `tokens` / `probes` / `scannedFiles` / `scannedEntries` / `matched` / `returned`，便于判断是否需要缩小关键词。
- 返回的每条都会在 `usage.json` 里记一次命中（`hits +1`、`weight +6`、刷新 `lastHitAt`），所以常用的记忆下次排得更前、也更不容易被腾挪。

### `mem_recent(days?, limit?)`

取最近 N 天（**含今天**）的冷层条目，按时间倒序，只读。

| 参数 | 默认 | 范围 |
| --- | --- | --- |
| `days` | 3 | 1–365 |
| `limit` | 50 | 1–200 |

返回 `days` / `from` / `to` / `scannedFiles` / `scannedEntries` / `matched` / `returned` / `items`。适合“刚才 / 这两天发生了什么”。

### `mem_by_tag(tag, limit?)`

按标签取冷层条目：**不区分大小写的精确匹配**，按时间倒序，只读，默认 20 条（最多 200）。`tag: "-"` 取没有标签的条目。

### `mem_by_date(from, to, limit?)`

按本地日期区间取冷层条目：`from` / `to` 都是 `YYYY-MM-DD`（闭区间），按时间倒序，只读，默认 50 条（最多 200）。

- `from` 晚于 `to`、日期非法或区间超过 3660 天都会返回可读错误。
- 单日查询直接令 `from === to`。

### 检索回退顺序

想不起某件事时，按这个顺序找：

1. **`mem_recent(3)`** —— 最近三天有没有直接相关的内容；
2. 没有就看**热层主题索引**——索引里每个 `主题|年月` 给出该主题涉及哪几个月；
3. 用 **`mem_by_date(from, to)`** 取那个月（或那几个月）的条目；
4. 仍不确定时，再用 `mem_recall` 全文搜。

### `mem_summarize(period?, date?, force?)`

生成（或返回已存在的）某一周期的摘要。

| 参数 | 取值 |
| --- | --- |
| `period` | `day`（默认）/ `week` / `month` |
| `date` | `YYYY-MM-DD`，默认今天；用于补生成历史周期 |
| `force` | 默认 `false`；已存在时直接返回，`true` 才重新生成 |

来源：日摘要读当天冷层；周摘要读该周的日摘要（某天缺失则回退那天的冷层）；月摘要读该月的周摘要（缺失的周逐级回退到日摘要、冷层）。

生成后会把该期**最高频的 3 个 tag** 补进热层主题索引（`tag|YYYY-MM`），已存在的行不重复、不覆盖。

### `mem_stats()`

返回各层体量：热层字数/上限/候选数/主题索引数、冷层文件与条目数（按月列出、含最新日期）、三级摘要的文件数与字数。用来判断该不该精简热层、归档冷层或补生成摘要。

v1.2 起还会给出使用度（正文只取前 40 字）：

| 字段 | 说明 |
| --- | --- |
| `topRecalled` | 最常被召回的 5 条：`hits` / `lastHitAt` |
| `weightTop` | 权重最高的 5 条 |
| `weightBottom` | 权重最低的 5 条（最可能被腾挪） |

## 热层：候选与主题索引

热层正文默认上限 **600 字**。`hot.md` 里固定保留两个区，**都不计入** 600 字：

### 候选区

```markdown
<!-- candidates:start -->
- [2026-10-21T03:10:00.000Z] [计划] 周末想去看海
<!-- candidates:end -->
```

- 用来暂存 `mem_write(..., important: true)` 记下、但还没决定要不要常驻的东西。
- `mem_hot_set` 写正文永远不动候选区，除非你在 `content` 里自己带了候选块。
- 精简热层的推荐做法：把候选里值得留下的提炼进正文，然后 `mem_hot_set` 覆盖正文；不值得的直接删掉（手改 `hot.md` 或重写候选块）。

### 主题索引

```markdown
<!-- topics:start -->
翻唱|2026-10
旅行|2026-09
<!-- topics:end -->
```

- 每行 `主题|年月`（标准 `YYYY-MM`），告诉未来的自己“这个主题涉及哪几个月”，用 `mem_by_date` 直接取那几个月，不必全文搜。
- 由你自己维护：`mem_hot_set` 的 `content` 里带 `topics` 块时整体替换索引；不带则保留原索引。
- 索引行不是冷层条目，不参与 `mem_recall`，也不占正文预算；写错了只会被忽略（或手改 `hot.md` 修正）。
- 一个主题可以有多个月份（多行），不同主题也可以指向同一个月。

## 摘要规则：不编造

摘要完全由**抽取**生成，不调用模型：

1. 复制下一层的条目；
2. 按层级压缩（见下表）；
3. 按字数预算（日 1500 / 周 1000 / 月 700 字）保留，放不下的**整行省略**，并在末尾写明省略了几行；
4. 文件头记录来源、生成时间和 `压缩比：原 N 条 → 保留 M 行`。

| 层级 | 压缩方式 |
| --- | --- |
| `day` | 每条都留，但只保留 tag + **首句**（至多 40 字） |
| `week` | 同 tag 合并成一行，取该 tag **最早与最晚**各一条的首句，中间用 ` … ` 连接 |
| `month` | 只有 `约定` / `重要` / `翻唱` 保留独立行；其余 tag 各汇总成一行 `共 N 条` |

所以摘要读起来是条目列表，不是润色过的段落，但它**不可能**说出原文里没有的话。

## 召回留痕与权重（v1.2）

`usage.json` 记着每条冷层记忆被召回了几次、最后一次是什么时候、当前权重多少：

```json
{ "version": 1, "entries": { "<sha1(正文)>": {
  "hits": 3, "firstHitAt": "…", "lastHitAt": "…",
  "weight": 68, "lastDecayAt": "…" } } }
```

- 命中一次召回/窗口查询：`weight += 6`（上限 100），刷新 `lastHitAt`。
- 被 `mem_hot_set` 提升进热层正文：`weight += 15`（只对已在账本里的条目生效，避免新写的正文立刻变成“动不得”）。
- 衰减：每次读取账本时按半衰期算 `weight *= 0.5 ^ (经过天数 / halfLifeDays)`，默认半衰期 30 天，只对**已过整天**的间隔生效（避免每次读都抖一下），最低 0。
- 只有 `weight < demoteThreshold`（默认 20）**且**够老的条目，才允许被腾挪/下沉；权重再低也不会被删除，只会沉到冷层。
- 写盘按 `usageThrottleMs`（默认 5 秒）节流合并，进程退出前会把没落盘的命中补写；文件缺失或损坏时静默重建，检索不会因此失败。

## 配置

```yaml
- insert:
    - id: dsh-memory-layers
      name: dsh-memory-layers
      config:
        hotLimit: 600            # 热层正文字数上限，100–20000，缺省 600
        autoEvict: true          # 热层超限时自动腾挪到冷层，缺省 true
        evictTarget: 510         # 腾挪目标字数，缺省 floor(hotLimit*0.85)
        candidateTtlDays: 30     # 候选超过天数即下沉，缺省 30
        candidateMax: 12         # 候选数量上限，缺省 12
        usageThrottleMs: 5000    # usage.json 写盘节流，缺省 5000
        halfLifeDays: 30         # 权重半衰期（天），缺省 30
        demoteThreshold: 20      # 下沉权重阈值，缺省 20
        autoLogOnSessionEnd: false  # 会话结束自动落档，缺省 false
        autoLogMinTurns: 4       # 自动落档的最少轮次，缺省 4
```

配置非法（非整数、越界）时回退到默认值并在日志里给一条 warn，不会让插件激活失败。

数据目录默认 `$DSH_HOME/dsh-memory-layers`；想放到别的盘（DSH 重装不丢）就设环境变量 `DSH_MEMORY_ROOT`，数据落在 `$DSH_MEMORY_ROOT/memory`。

## 使用建议

1. 会话开始：`mem_hot_get()`；超限就 `mem_hot_set()` 写一版精简正文（写进去的那一刻，剩下的超限部分也会被自动腾挪）。
2. 遇到值得长期记住的细节：`mem_write(text, tag)`；确实重要再 `important: true`。想让记忆能追溯来源就带上 `source`。
3. 主题索引不用手写了：生成摘要时会自动补高频 tag；想手工加，`mem_hot_set` 带 `topics` 块即可。
4. 想不起某件事：`mem_recent(3)` → 看主题索引定位月份 → `mem_by_date` → 最后才 `mem_recall`。
5. 按分类回顾：`mem_by_tag("家庭")`。
6. 每天/每周收尾：`mem_summarize("day")`、`mem_summarize("week")`；每月再说一次 `mem_summarize("month")`。日摘要在当天满 20 条时会自动重生成。
7. 不确定记忆是否臃肿：`mem_stats()`；看 `weightBottom` 就知道下次会被腾挪的是哪几条。

## 注意事项

- **数据只在本机、明文、不加密。** 敏感内容请自行权衡是否写入。
- **没有自动注入。** 插件不会把热层塞进系统提示；模型必须在会话开始时主动调用 `mem_hot_get`。这是有意为之：注入会和其他记忆插件冲突，也违背“控制体量”的初衷。想让它自动生效，请在自己的 agent preset / 指令里约定“每次会话先调 `mem_hot_get`”。
- **查询不改冷层，但会写账本。** `mem_recall` / `mem_recent` / `mem_by_tag` / `mem_by_date` 只扫描已有的冷层文件，不创建目录、不改任何条目；它们只会更新 `usage.json`（命中次数与权重）。想让某条记忆彻底“冷”下去，手改 `usage.json` 或删掉它即可。
- **热层会自己腾挪，但不会腾空。** 超过 `hotLimit` 时最不活跃的块会被搬到冷层（`tag=hot-evict`），标题、候选区、主题索引、90 天内被召回过的、以及权重还高的块都不动；最后一块无论如何都留着。想完全手动，就 `autoEvict: false`。
- **候选区有保质期。** 超过 `candidateTtlDays` 或超量的候选会在**下一次读取热层**时下沉（`tag=candidate-expired`），不会悄悄消失。
- **主题索引现在会自动补。** 每次生成摘要后，该期最高频的 3 个 tag 会以 `tag|YYYY-MM` 补进索引；已存在的行不重复、不覆盖。你手写的行仍然保留，`mem_hot_set` 带 `topics` 块时仍然整体替换。
- **摘要会自动重生成日层。** 当天冷层条目数每跨过 20 的倍数，`mem_write` 会顺手 `force` 重生成当天的日摘要；周/月摘要仍要自己调，或用 `force: true`。
- **单进程串行。** 读改写走同一个进程内队列，写入用临时文件 + rename（崩溃不会截断已有文件）。但**多个 DSH 实例同时写同一数据目录**没有文件锁，可能互相覆盖；建议只开一个实例写记忆，或给不同实例配不同的 `DSH_MEMORY_ROOT`。
- **会话自动落档是尽力而为。** `autoLogOnSessionEnd: true` 时，插件把它在工具调用里看到的最后 3 轮文本压成一条 ≤200 字的 `tag=session` 记录；它看不到完整对话原文，所以这条摘要只覆盖插件能观察到的部分。同一场会话（相同 `source.seq`）不会重复写。
- **没有删除/归档工具。** 冷层一天一个文件、摘要一个周期一个文件，要归档或删除直接操作文件即可；工具从不删除你的数据。
- **时间戳是 UTC，分区是本地日期。** 跨时区使用时，`date` / `from` / `to` 按运行机器的本地日历解释。
- **手动编辑是允许的。** 标题、说明等非条目行会被忽略而不是报错；但请保持条目行的 `- [时间] [tag] 内容` 格式，否则该行对 `mem_recall` 不可见；主题索引行请保持 `主题|YYYY-MM`；`usage.json` 删掉会按“权重 50、从未命中”重建。
- **不要放在系统目录或 DSH 安装目录下运行**；数据目录固定，工具不接受外部路径。

## 验收对照

| 验收项 | 对应行为 |
| --- | --- |
| 热层每次可读 | `mem_hot_get` 在无文件时返回空正文，不报错 |
| 冷层可召回 | `mem_recall` 扫描全部月份目录，跨月返回 |
| 日/周/月摘要可生成 | `mem_summarize` 三种 `period` 均落盘 |
| 超限有提示 | `mem_hot_get` / `mem_hot_set` / `mem_write(important)` 都返回 `overLimit` 与 `hint` |
| 最近 N 天可查 | `mem_recent(days)` 只读区间内实际存在的日期文件 |
| 按标签可查 | `mem_by_tag(tag)` 精确匹配（大小写不敏感），`-` 匹配无标签 |
| 按日期区间可查 | `mem_by_date(from, to)` 闭区间，非法/倒置/过大区间报可读错误 |
| 多词组合可切换 | `mem_recall(mode)` 支持 `and` / `or` / `any`，默认 `and` 保持向后兼容 |
| 主题索引不占字数 | `mem_hot_get.chars` 只统计正文，索引与候选另计 |
| 重启后数据完整 | 全部是磁盘上的 UTF-8 文件，随进程重启保留 |
| 热层超限自腾 | `mem_hot_set` 返回 `evicted` / `charsAfterEvict` / `evictHint`，被腾的块能在当天冷层 grep 到 |
| 候选自动下沉 | `mem_hot_get` 返回 `pruned`，下沉条目 tag 为 `candidate-expired` |
| 召回留痕可查 | 连续召回后 `usage.json` 的 `hits` 增长，`mem_stats.topRecalled` 能列出 |
| 权重会衰减 | 把 `lastDecayAt` 改到 60 天前，一次读取后权重约为原值 1/4 |
| 来源可追溯 | 带 `source` 写入的行以 `〔src:conv#seq〕` 结尾，查询能取回 `source` 对象 |
| 摘要逐级压缩 | 三种摘要头部都有 `压缩比：原 N 条 → 保留 M 行`，月摘要行数明显少于来源条目 |

## 开发与测试

```bash
npm test          # 冒烟 + 宿主 schema 校验
npm run test:smoke
npm run test:schema
```

- `test/smoke.mjs` 用临时数据根（`DSH_MEMORY_ROOT` 指向临时目录，**不会碰真实记忆**），覆盖：热层空读/超限/覆盖/主题索引、写入去重、候选、跨月与多词召回（`and`/`or`）、最近 N 天 / 按标签 / 按日期区间查询、三级摘要与 `force`、统计，以及用子进程重读验证持久化；v1.2 另外覆盖自动腾挪（含保护规则与冷层留痕）、候选 TTL、召回留痕与权重衰减、二元组召回、`source` 证据、分级压缩与主题索引补行、会话自动落档。
- `test/schema.mjs` 直接引用 DSH 安装目录里的 `dsh-tools`，用宿主自己的 `assertSupportedJsonSchema` / `validateJsonSchemaValue` 检查九个工具的 `parameters`、`output.schema`，并把每个工具的返回值过一遍校验。找不到宿主时自动跳过（可用 `DSH_TOOLS_PATH` 指定）。

> **写工具 schema 时注意**：DSH 的 `tools.register` 只接受一个**闭合的 JSON-Schema 子集**——`type` 必须是**单个字符串**，联合类型只能用 `oneOf`；可用关键字仅 `type / oneOf / properties / required / additionalProperties / items / enum / const` 加注解（`description` / `title` / `default` / `examples`）。`type: ['object','null']`、`minimum`、`maximum`、`pattern`、`$ref` 之类都会让注册**直接抛错**，整个插件在 DSH 里静默不注册（v1.2 第一次上线就踩了这个坑，现已由 `test/schema.mjs` 兜住）。

```
index.js         工具注册与输出渲染
lib/config.mjs   配置校验与默认值
lib/paths.mjs    数据目录、日期/ISO 周、原子写、串行队列
lib/entry.mjs    条目行格式（含 〔src:…〕 来源标记）的解析与格式化
lib/usage.mjs    usage.json：命中留痕、权重、半衰期衰减、节流落盘
lib/hot.mjs      热层正文 + 候选区 + 主题索引 + 自动腾挪/下沉
lib/cold.mjs     冷层写入、读取、关键词召回（二元组/评分）与窗口查询
lib/summary.mjs  日/周/月抽取式摘要（逐级压缩）
lib/stats.mjs    各层体量与使用度统计
lib/session.mjs  会话结束自动落档
```

## 变更记录

### v1.2.0

- 热层超限**自动腾挪**：按空行切块，把最不活跃的块搬到冷层（`tag=hot-evict`），`mem_hot_set` 新增 `evicted` / `charsAfterEvict` / `evictHint`。
- 候选区**自动下沉**：超过 `candidateTtlDays` 或超量的候选在读取时沉到冷层（`tag=candidate-expired`），`mem_hot_get` 新增 `pruned`。
- 新增 `usage.json` 召回账本：`hits` / `lastHitAt` / `weight` / `lastDecayAt`，半衰期衰减，写盘节流；`mem_stats` 新增 `topRecalled` / `weightTop` / `weightBottom`。
- `mem_recall` 支持中文二元组切分与 `mode: "any"`，结果按 `matched*2 + weight/5 + 新近加成` 排序，新增 `score` / `matched` / `probes`。
- `mem_write` 新增 `source: { conv, seq, msgId }`，行尾追加 `〔src:conv#seq〕`；所有查询返回 `source`；重复条目只更新来源，不新增行。
- 摘要逐级压缩：日留首句、周同 tag 合并、月只留 `约定/重要/翻唱` + 计数行，头部新增 `压缩比`；生成后自动把高频 tag 补进热层主题索引。
- `mem_write` 跨过当天 20 条时自动重生成日摘要；新增 `autoLogOnSessionEnd` / `autoLogMinTurns` 会话结束自动落档（默认关）。
- 数据目录默认跟着 `DSH_HOME`，支持用 `DSH_MEMORY_ROOT` 放到别的盘（DSH 重装不丢）；代码里不写死任何路径。
- 全部为新增字段，工具名与既有返回字段不变；`hot.md` 与 `cold/` 结构向后兼容。
- 工具 schema 收敛到 DSH 支持的 JSON-Schema 子集（`source` 用 `oneOf` 表达可空、去掉 `minimum`/`maximum`），并新增 `test/schema.mjs` 用宿主自己的校验器回归。

### v1.1.0

- 新增 `mem_recent(days, limit)`：最近 N 天（含今天）的冷层条目。
- 新增 `mem_by_tag(tag, limit)`：按标签精确匹配。
- 新增 `mem_by_date(from, to, limit)`：按本地日期闭区间取条目。
- `mem_recall` 新增 `mode: "and" | "or"`，默认 `and`，向后兼容。
- 热层新增主题索引区（`主题|YYYY-MM`），不占正文字数；`mem_hot_get` / `mem_hot_set` / `mem_stats` 同步支持。
- 新工具全部只读，不修改冷层原文。

### v1.0.0

- 首个版本：热层、按月冷层、日/周/月抽取式摘要、候选区，六个工具。

## 许可

MIT，见 [LICENSE](LICENSE)。
