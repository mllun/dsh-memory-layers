# dsh-memory-layers

给 DeepSeek Harness 的分层长期记忆：一个约 600 字、每次会话必读的**热层**，一份按月归档、可按关键词跨月召回的**冷层全文**，以及**日 → 周 → 月**三级抽取式摘要。目标是在不撑大上下文的前提下，让很久以前的细节仍然找得回来。

Layered long-term memory for DeepSeek Harness: a ~600-character hot layer, a month-archived cold layer with keyword recall, and extractive day/week/month summaries that keep injected context small.

- 纯 Host 插件，没有前端资源，没有网络请求，没有第三方运行时依赖。
- 数据全部是 `$DSH_HOME/dsh-memory-layers/` 下的 UTF-8 Markdown，可读、可手改、可备份。
- 摘要只抽取原文并截断，不调用模型、不新增原文没有的句子。

## 为什么不是一个文件

一个 `notes.md` 迟早会长到几千条。要么每次会话把它全塞进上下文，要么模型永远想不起来细节。

这里把记忆拆成三层，每层只承担一件事：

| 层 | 体量 | 何时读 | 何时写 |
| --- | --- | --- | --- |
| 热层 `hot.md` | 约 600 字 | **每次会话开始** | 精简后全量覆盖 |
| 冷层 `cold/YYYY-MM/YYYY-MM-DD.md` | 不限（单条 ≤ 4000 字） | 需要细节时 `mem_recall` | 随手追加 |
| 摘要 `summaries/day|week|month/` | 日 1500 / 周 1000 / 月 700 字 | 回顾某段时间时 | 按天/周/月生成 |

热层放身份、长期约定、正在推进的事；细节写进冷层；想不起细节时按关键词召回；回顾一段时间时看摘要。热层永远不会因为冷层变长而变长。

## 数据布局

```
$DSH_HOME/dsh-memory-layers/
  hot.md                          热层正文 + 候选区
  cold/2026-10/2026-10-21.md      冷层：一天一个文件，按月分目录
  summaries/day/2026-10-21.md     日摘要
  summaries/week/2026-W43.md      周摘要（ISO-8601 周）
  summaries/month/2026-10.md      月摘要
```

`DSH_HOME` 未设置时落在 `~/.dsh`。所有条目共用一个行格式：

```
- [2026-10-21T03:10:00.000Z] [tag] 正文
```

时间是 ISO-8601（UTC）写入时间戳；文件按**本地日期**分区；`tag` 缺省为 `-`。

## 安装

要求：Node.js ≥ 20，DeepSeek Harness 0.2.x（本插件是 Host 插件，依赖 `ctx.get('tools')` 注册工具）。

### 1. 通过插件管理器安装（推荐）

先把仓库克隆到本地任意目录：

```bash
git clone https://github.com/mllun/dsh-memory-layers.git
```

然后在 DSH 里让插件管理器安装这个**包目录**：

```
plugin_manager({ action: "install_bundle", target: "<本仓库的绝对路径>" })
```

安装会把包链接进当前 profile（`dependencies` + `dsh.profile.bundles` + `node_modules`），并立即尝试激活。看到 `application: applied` 后，工具列表里会出现 `mem_hot_get` 等六个工具。

### 2. 手动注册

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-memory-layers
      name: '@local/dsh-memory-layers'
      config:
        hotLimit: 600
```

前提是该包已能被 Node 解析（放在 profile 的 `node_modules` 下，或改成从仓库路径 `file:` / `link:` 安装）。改完需要重启 DSH。

### 卸载

在插件管理器里移除 bundle，或从 `cordis.patch.yml` / `package.json` 的 bundles 列表里删掉。**卸载不会删除记忆数据**；要彻底清空，手动删除数据目录。

## 工具

六个工具，全部经由 `ctx.get('tools')` 注册。

### `mem_hot_get()`

读热层。返回：

| 字段 | 说明 |
| --- | --- |
| `content` | 热层正文（不含候选区） |
| `chars` / `limit` | 正文字数与上限（按 Unicode 码点计） |
| `overLimit` / `hint` | 是否超限，以及精简提示 |
| `candidates` / `candidateCount` | 待提升的候选条目 |

没有 `hot.md` 时返回空正文，不报错、不创建文件。

### `mem_hot_set(content)`

用 `content` **全量覆盖**热层正文（不是追加）。返回写入后的字数、是否超限、精简提示。

- 传空字符串可清空正文（候选区保留）。
- 正文超过上限仍然写入，只返回 `overLimit: true`——不会吞掉内容。
- 默认保留候选区；如果 `content` 自带 `<!-- candidates:start -->` / `<!-- candidates:end -->` 注释块，则用块内条目**替换**候选区。

### `mem_write(text, tag?, important?)`

向**当天**冷层文件追加一条记忆。返回写入的日期、时间戳、tag、候选序号。

- `text` 单行；换行和连续空白会压成空格；单条上限 4000 字。
- `tag` 可选，`[` `]` 会被去掉，避免破坏行格式。
- `important: true` 时同时把这条放进热层候选区（候选**不计入** 600 字），`candidateIndex` 返回从 1 开始的序号；不重要时为 `0`。
- 当天已有完全相同的（`tag` + 内容）条目时返回 `added: false`，不重复写。

### `mem_recall(keyword, limit?)`

跨全部月份召回冷层条目。

- 大小写不敏感的子串匹配；内容或 tag 命中都算。
- `keyword` 里多个词用空格分隔时，条目必须**同时包含全部词**（AND）。
- 结果按时间倒序，默认 10 条，最多 50 条。
- 返回 `scannedFiles` / `scannedEntries` / `matched` / `returned`，便于判断是否需要缩小关键词。

### `mem_summarize(period?, date?, force?)`

生成（或返回已存在的）某一周期的摘要。

| 参数 | 取值 |
| --- | --- |
| `period` | `day`（默认）/ `week` / `month` |
| `date` | `YYYY-MM-DD`，默认今天；用于补生成历史周期 |
| `force` | 默认 `false`；已存在时直接返回，`true` 才重新生成 |

来源：日摘要读当天冷层；周摘要读该周的日摘要（某天缺失则回退那天的冷层）；月摘要读该月的周摘要（缺失的周逐级回退到日摘要、冷层）。

### `mem_stats()`

返回各层体量：热层字数/上限/候选数、冷层文件与条目数（按月列出、含最新日期）、三级摘要的文件数与字数。用来判断该不该精简热层、归档冷层或补生成摘要。

## 热层与候选

热层正文默认上限 **600 字**。`hot.md` 里固定保留一段候选区：

```markdown
<!-- candidates:start -->
- [2026-10-21T03:10:00.000Z] [计划] 周末想去看海
<!-- candidates:end -->
```

- 候选区**不计入** 600 字，用来暂存 `mem_write(..., important: true)` 记下、但还没决定要不要常驻的东西。
- `mem_hot_set` 写正文永远不动候选区，除非你在 `content` 里自己带了候选块。
- 精简热层的推荐做法：把候选里值得留下的提炼进正文，然后 `mem_hot_set` 覆盖正文；不值得的直接删掉（手改 `hot.md` 或重写候选块）。

## 摘要规则：不编造

摘要完全由**抽取**生成，不调用模型：

1. 复制下一层的条目；
2. 每条正文截断到固定字数（日 120 / 周 100 / 月 80 字，超出加 `…`）；
3. 按字数预算（日 1500 / 周 1000 / 月 700 字）保留，放不下的**整条省略**，并在末尾写明省略了几条；
4. 文件头记录来源与生成时间。

所以摘要读起来是条目列表，不是润色过的段落，但它**不可能**说出原文里没有的话。

## 配置

```yaml
- insert:
    - id: dsh-memory-layers
      name: '@local/dsh-memory-layers'
      config:
        hotLimit: 600   # 热层正文字数上限，100–20000，缺省 600
```

配置非法（非整数、越界）时回退到 600 并在日志里给一条 warn，不会让插件激活失败。

## 使用建议

1. 会话开始：`mem_hot_get()`；超限就先 `mem_hot_set()` 精简。
2. 遇到值得长期记住的细节：`mem_write(text, tag)`；确实重要再 `important: true`。
3. 想起某件事但细节模糊：`mem_recall("关键词 另一词")`。
4. 每天/每周收尾：`mem_summarize("day")`、`mem_summarize("week")`；每月再说一次 `mem_summarize("month")`。
5. 不确定记忆是否臃肿：`mem_stats()`。

## 注意事项

- **数据只在本机、明文、不加密。** 敏感内容请自行权衡是否写入。
- **没有自动注入。** 插件不会把热层塞进系统提示；模型必须在会话开始时主动调用 `mem_hot_get`。这是有意为之：注入会和其他记忆插件冲突，也违背“控制体量”的初衷。想让它自动生效，请在自己的 agent preset / 指令里约定“每次会话先调 `mem_hot_get`”。
- **单进程串行。** 读改写走同一个进程内队列，写入用临时文件 + rename（崩溃不会截断已有文件）。但**多个 DSH 实例同时写同一数据目录**没有文件锁，可能互相覆盖；建议只开一个实例写记忆，或给不同实例配不同的 `DSH_HOME`。
- **热层上限是提示不是硬限制。** 超过 `hotLimit` 仍然写入，只是返回 `overLimit` 和精简建议；精简由调用方负责。
- **摘要不会自动更新。** 冷层新增条目后，已存在的日/周/月摘要不会变化；需要 `force: true` 重新生成。
- **没有删除/归档工具。** 冷层一天一个文件、摘要一个周期一个文件，要归档或删除直接操作文件即可；工具从不删除你的数据。
- **时间戳是 UTC，分区是本地日期。** 跨时区使用时，`date` 参数按运行机器的本地日历解释。
- **手动编辑是允许的。** 标题、说明等非条目行会被忽略而不是报错；但请保持条目行的 `- [时间] [tag] 内容` 格式，否则该行对 `mem_recall` 不可见。
- **不要放在系统目录或 DSH 安装目录下运行**；数据目录固定在 `DSH_HOME` 下，工具不接受外部路径。

## 验收对照

| 验收项 | 对应行为 |
| --- | --- |
| 热层每次可读 | `mem_hot_get` 在无文件时返回空正文，不报错 |
| 冷层可召回 | `mem_recall` 扫描全部月份目录，跨月返回 |
| 日/周/月摘要可生成 | `mem_summarize` 三种 `period` 均落盘 |
| 超限有提示 | `mem_hot_get` / `mem_hot_set` / `mem_write(important)` 都返回 `overLimit` 与 `hint` |
| 重启后数据完整 | 全部是磁盘上的 UTF-8 文件，随进程重启保留 |

## 开发与测试

```bash
npm test   # node test/smoke.mjs
```

测试使用临时 `DSH_HOME`，覆盖：热层空读/超限/覆盖、写入去重、候选、跨月与多词召回、三级摘要与 `force`、统计，以及用子进程重读验证持久化。

```
index.js         工具注册与输出渲染
lib/paths.mjs    数据目录、日期/ISO 周、原子写、串行队列
lib/entry.mjs    条目行格式的解析与格式化
lib/hot.mjs      热层正文 + 候选区
lib/cold.mjs     冷层写入、读取、关键词召回
lib/summary.mjs  日/周/月抽取式摘要
lib/stats.mjs    各层体量统计
```

## 许可

MIT，见 [LICENSE](LICENSE)。
