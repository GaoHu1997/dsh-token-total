# dsh-token-total

DSH（DeepSeek Harness）Web 插件：**Token 用量统计看板** + **单会话用量（含子智能体）**。

两件事，一个插件：

1. **统计看板** — 侧边栏插件区下方的入口，点开是完整的用量看板（快捷筛选 / 六卡片 / 活跃热力图 / 缓存命中率趋势 + 分模型柱状图 / 按模型与按供应商 Top5）。
2. **单会话统计** — 增强会话输入框下方的原生信息栏，把「Token 用量」从「只有主智能体」改成「主智能体 + 全部子智能体」，让一次会话的真实消耗有地方可看。

所有图表都是手写 SVG，不依赖任何图表库；配色走 DSH 主题变量，自动适配明暗主题。

## 功能

### 统计看板

入口在左侧边栏的插件区（与原生「插件」页并列的独立页面），点开即为看板，分上中下三部分。

#### 上部

- **快捷筛选**：今日 / 近 3 天 / 近 7 天 / 近 1 月 / 近 3 月 / 自定义（起止日期）。
- **一行六个卡片**：总 Tokens、输入 Tokens、输出 Tokens、缓存 Tokens、缓存命中率、请求数量。
  Token 数量用 **K / M / B** 紧凑单位显示主值，下方一行给出精确数字。「请求数量」在本时间段出现过失败调用时，下方会多一行「失败 N · 占比」，没有失败则保持单行显示。
- **活跃热力图**：GitHub 风格，格子颜色深浅表示当天 token 消耗的多少；图例「较少 → 较多」五档。
- 右上角保留 **刷新**（只重取聚合结果），不再提供重建统计按钮。

#### 中部

- **缓存命中率趋势**：一条平滑折线（Catmull-Rom 转贝塞尔）。
- **分模型柱状图**：堆叠柱表示实际 token 消耗，不同模型不同颜色；右轴为 0–100% 缓存命中率。
- **不显示图例**：鼠标悬浮时 tooltip 逐项列出该时间桶内各模型的 token 与命中率。
- **横轴粒度**：今日 / 近 3 天按**小时**分桶，更长的区间按**天**分桶。

#### 下部

- **按模型**：按模型选择器的**显示名称**（不是路由 id）跨供应商聚合，取前 5，展示模型名、总 Tokens、缓存命中率（跨多个供应商时附供应商列表）。排行与趋势使用同一归一化规则：忽略大小写，将空格、下划线和连字符统一为 `-`，例如 `gpt-6.1-sol`、`GPT 6.1 sol`、`gpt 6.1 sol` 合并为 `gpt-6.1-sol`；版本号和后缀仍区分，避免误合并不同模型。无法读取历史路由的模型元数据时，回退到历史引用中的模型名称；不改写原始记录，不需要重建统计。
- **按供应商**：一个供应商下所有模型聚合，取前 5，展示供应商名、总 Tokens、缓存命中率。

### 单会话统计

会话输入框下方原生的「用时与速度 / Token 用量」两枚胶囊被接管并增强：

- **Token 胶囊**显示的是**整棵会话树**（主智能体 + 全部子智能体）的合计，点开弹窗分为「主智能体 / 子智能体 / 会话合计」三行，并给出子智能体会话数。
- 子智能体是独立持久化的会话，通过日志头的 `parentSession` 串成树；插件按需重放这些日志汇总（同一套 `(turn, step)` 去重规则，且跳过 fork 继承来的事件前缀，避免与父会话重复计数）。
- **会话 Token 明细始终开启**：未命中缓存、缓存读 / 写、输出分别列出；底部胶囊的缓存命中率始终显示两位小数。
- **流式吞吐速度始终开启**：输出过程中显示估算的解码速度；暂无有效样本或输出结束后，回到会话累计的精确值。
- 不再提供底部增强功能的开关；旧版本保存的关闭设置不再影响显示。

## 安装

```sh
dsh plugin --profile <profile> add dsh-token-total@latest
```

本地开发时直接指向目录：

```sh
dsh plugin --profile <profile> add "file:D:\work\dsh-token-total"
```

`package.json` 里的 `dsh.bundle.patch` 会让 CLI 在安装后把本插件追加进该 profile 的 `dsh.profile.bundles`，重启后自动挂载，无需手改 profile 配置。若该 profile 的 `cordis.patch.yml` 里还留着旧的手工挂载行，请先删掉，否则会重复挂载（两个宿主实例、两条重复路由）。

> Electron 桌面端的 `desktop` profile 由应用独占管理，CLI 会拒绝写入（`profile "desktop" is managed exclusively by the Electron application`）。请用应用内的插件管理器安装，或另建一个 profile 验证。

## 数据来源与统计口径

- **事件来源**：`sessionPersistence` 的会话日志。兼容 `assistant/message` 的顶层 `usage`，也读取消息及失败 `assistant/attempt` 的原始流式用量；同一次请求以最后一份用量为准，修正值按差额更新。插件订阅 `session/event` 实时增量累加，同时一次性回扫已有历史会话；`llm/retry-started` 会清空当前 `(turn, step)` 槽位，因此失败尝试和后续重试分别计入，不重复累加同一次请求的多份报告。
- **本地持久化**：聚合结果写入 storage-domain 的 `token_total_history` 域（`$DSH_HOME/storages/` 下），纯本地、无外部依赖。回扫游标按会话记录已消费的事件序号，重启后从断点继续。
- **单会话统计**：不走聚合存储（那里没有会话维度），而是按需重放该会话及全部子孙会话的自有日志；已加载会话优先使用实时事件快照，避免持久化缓冲造成漏算。结果缓存 4 秒，任意会话的新事件都会使缓存失效，包含此前尚未发现的子会话。前端从首次读取起每 4 秒刷新，显示时使用原生实时主会话用量、主会话压缩调用用量与子树用量之和，胶囊与弹窗共用同一口径；切换会话时立即清除旧会话读数。读取失败不会把部分子树当作成功结果覆盖已有读数。
- **缓存命中率** = 缓存命中 token ÷ 输入 token 总量（命中 + 未命中）。
- **失败数量**：以宿主记录的 `assistant/attempt` 事件为准。宿主只有在流以错误结束、或调用在提交任何内容之前被取消时才写 `assistant/attempt`，其余调用一律写 `assistant/message`，两者恰好划分全部调用，所以该事件就是「一次失败的 provider 调用」的精确边界（`interrupted: true` 但已有内容的 `assistant/message` 不计为失败）。失败数是请求数的子集，不额外计入请求；失败调用若在流中断前已上报用量，token 仍按用量计入、不会丢失。该计数晚于日 / 小时两份游标引入，因此老版本升级后会额外做一次只写失败数的增量回扫（`failuresReady` 标记完成，不重复累加 token）。

## HTTP 接口

宿主侧注册一个前缀路由 `/token-total/api`，全部为 `POST` + JSON：

| 路径 | 作用 |
| --- | --- |
| `/token-total/api/range` | 取某个时间范围的聚合（`{range, from?, to?}`） |
| `/token-total/api/session` | 取某会话树的用量（`{sessionId}`，返回 `self` / `subagents` / `total` / `subagentSessions`） |
| `/token-total/api/status` | 回扫进度 |
| `/token-total/api/reset` | 清空统计并重新回扫 |

请求经过与官方 `/api` 网关同源的信任栅栏（Host / Origin / `sec-fetch-site` 三重校验，防 DNS rebinding）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `source` | `session-log` | 统计来源 |
| `backfillConcurrency` | `4` | 历史回扫的并发会话数 |

## 兼容性

- DSH `>= 0.1.7-rc.1`（`peerDependencies`）；实测运行于 `0.2.1-rc.2`，会话日志格式 v3 与 v4 均可读取（v3 走 alpha 的 `open/read` 接口，v4 走句柄分页读取）。
- 浏览器半区只依赖 `@deepseek-ai/dsh-client-{locale,ui-slots,ui-primitives}` 与 React 18，不打入任何 Node 内置模块。

## 开发

```sh
pnpm install
pnpm run build        # tsc 声明 + 宿主/浏览器两个 bundle
pnpm run typecheck    # 宿主半区
pnpm run typecheck:client
pnpm test             # 模型/供应商聚合、会话树、重试用量、底部展示与刷新回归测试
```

产物：`lib/index.js`（宿主，ESM）、`lib/client.js`（浏览器，CJS 包装进 `__ModuleLoader__.load`）、`lib/types/**/*.d.ts`。CSS Modules 在构建时被内联成 `<style data-plugin-css>` 注入，因此 Web 外壳不需要 CSS 管线。

## 许可

MIT。本项目的宿主与浏览器实现改编自 [dsh-usage-statistics-panel](https://github.com/HaoyueQin/dsh-usage-statistics-panel)（MIT, Copyright (c) 2026 HaoyueQin），在其基础上按本项目的需求重做了卡片、筛选、图表与列表，并新增了整棵会话树（含子智能体）的用量统计。原始版权声明保留在 [LICENSE](./LICENSE) 中。
