# dsh-token-ledger / Token 账本

监控 DeepSeek Harness 的**每日 token 消耗**。数据来自会话日志里 provider 真实上报的
用量，按**本地日期**聚合，提供一个设置页卡片、一个输入框徽标、一条聊天命令和一个模型工具。

## 能看到什么

四个互不重叠的用量桶，全部来自 provider 上报值（不是估算）：

| 桶 | 含义 |
| --- | --- |
| 未缓存输入 | `inputTokens`，未命中前缀缓存的输入 |
| 缓存读取 | `cacheReadTokens`，命中缓存的输入 |
| 缓存写入 | `cacheWriteTokens`，写入缓存的输入 |
| 输出 | `outputTokens`，补全输出（已含 reasoning，不重复计） |

「合计」为四者之和。「缓存命中率」= `缓存读取 / (未缓存输入 + 缓存读取 + 缓存写入)`，
即请求侧输入有多少走了缓存。

## 仪表盘（设置页）

设置 →「Token 账本」除日报表外，还给出一个总览面板：

| 指标 | 口径 |
| --- | --- |
| 累计 Token 数 | 全部历史四桶之和 |
| 峰值 Token 数 | 单日最高（悬停显示是哪一天） |
| 最长聊天时长 | **连续活动**时长，非墙钟差（详见下节） |
| 当前连续天数 | 今天或昨天有活动起，向前连续有消耗的天数 |
| 最长连续天数 | 历史最长连续区间 |

下面是 **Token 活动热力图**（GitHub 贡献图式）：52 周 × 7 天网格，每格一天，
颜色分 5 级（灰=当天无消耗），下方有月份刻度与 少→多 图例，悬停显示当天日期、用量与请求数。

再下面是 **最常用的工具**：按调用次数排序（含条形占比与成功率），
以及**按模型**与**会话明细**（标题、时长、轮次、用量，默认折叠）。

## 三个入口

**设置页卡片**：设置 → Token 账本。可选 7/14/30/90/180/365 天窗口，表格含每日四桶、
合计、命中率与请求数，另有全时段汇总、仪表盘、按模型拆分与会话明细；
可一键导出 CSV（带 BOM，Excel 直接打开）。

**输入框徽标**：显示今日合计（紧凑记法，如 `1.23M`）与近 7 天累计，
每 60 秒刷新，悬停显示明细。

**聊天命令**：

```text
/tokens            近 7 天日报表 + 总览
/tokens 30         近 30 天
/tokens today      只看今日
/tokens csv [days] 导出 CSV 到 harness home
/tokens help       帮助
```

**模型工具** `token_usage`：让 agent 直接回答"今天用了多少 token"、"最常用什么工具"，
参数 `days` 与 `includeSessions`。

## 两项刻意不做的指标

参考过的仪表盘里有「快速模式占比」与「最常用的推理强度」。**本插件不提供这两项**，
因为会话日志里根本没有对应字段——实测扫描 21 个会话的全部事件，键名里不存在
`effort` / `reasoningEffort` / `fastMode` 等任何记录（只有模型自带的
`thinkingSignature: reasoning_content`，那是协议字段而非用户设置）。

与其编一个看起来合理的数字，不如不做。若将来 DSH 把该设置写进会话事件，
补上是几行的事。

## 数据来源与正确性

数据源是 `<DSH_HOME>/sessions/<workspace>/<session>/session.v3.jsonl.zstd`，即会话日志本身，
而不是投影缓存。原因：投影缓存只覆盖"曾被加载过"的会话，且可能落后于日志尾部；
日志是权威且完整的。

两处实现细节值得说明：

**多帧 zstd 必须逐帧解压。** DSH 的会话日志是"每批追加一帧"的 zstd 容器，不是一个连续流。
Node 的 `zlib.createZstdDecompress` 在拼接帧上只解出**第一帧**，实测 4.6 MB / 20 个会话
时流式解压只得到 1 行，逐帧则得到 2474 行——静默丢数据。`lib/zstd-frames.js` 按
RFC 8878 帧头规格精确切帧（不靠 magic 扫描，因为 magic 字节可能出现在压缩载荷内部）。

**折叠语义必须复刻 `tokenUsage` 投影。** 同一 `(turn, step)` 的新样本是**替换**旧样本而非累加，
`llm/retry-started` 才重开计费槽。朴素求和会在重试场景高估。本插件复刻了该语义，
并实测与官方投影缓存**逐字段完全一致**（20/20 会话）。

## 配置

`cordis.patch.yml` 里可调：

```yaml
- insert:
    - id: dsh-token-ledger
      name: 'dsh-token-ledger'
      config:
        enabled: true       # 总开关
        cacheTtlMs: 5000    # 结果 TTL（毫秒）
        root: null          # 显式指定 harness home，默认跟随 DSH_HOME
```

未知配置键会**抛错**而非静默忽略，避免拼写错误被默认值掩盖。

## 环境要求

- **Node.js `^22.15.0 || >=23.8.0`** —— 会话日志是多帧 zstd 容器，解压依赖
  `zlib.zstdDecompressSync`。该 API 在 Node **23.8.0** 上游加入、并回移到 **22.15.0** LTS，
  因此 **23.0–23.7 这一段没有它**，范围不能简写成 `>=22`。同一个范围也写在
  `package.json` 的 `engines.node`，且有测试锁定两处一致。
  缺这个 API 时插件**不会**把用量显示成 0：`readZstdLines` 直接抛错，`scan()` 返回带原因的
  `fatal`，启动日志与 `/api/health` 都会说明——静默的 0 会被误读成「今天没用过」，最难排查。
- **DSH `0.1.5-rc.2`** 线（见 `package.json` 的 `dshTarget`），且 `dsh` CLI 支持 profile
  与 `dsh plugin`——本插件依托 profile/bundle 机制安装。
- **零第三方运行时依赖**：只 import Node 内置模块，不 import 任何 `@deepseek-ai/*`。
  好处是插件与宿主版本解耦——宿主升级只要不破坏[契约依赖](#harness-契约依赖)就仍能工作。
- **数据前提**：harness home 下存在 `sessions/` 目录（DSH 正常使用过就有）。不存在时
  `/api/health` 回报 `sessionsRootExists: false`，仪表盘显示空数据而非报错。
- **可选能力**（缺了不影响加载，只是少了对应入口）：`/tokens` 命令需要宿主挂载 `commands`
  服务，`token_usage` 工具需要 `tools` 服务，仪表盘与徽标需要 `webServer` 服务。

## 安装

包位于仓库根，无构建步骤，从 GitHub 直接装：

```sh
dsh plugin --profile web add github:doremifaso12345/dsh-token-ledger
```

把 `web` 换成你要装的 profile 名。装完重启 `dsh web`。

本地开发用 `link:`，路径**由 shell 展开**而不是写死——写死的绝对路径对别人没有意义，
而相对路径会被 pnpm 解析到 **profile 目录**而非当前目录（所以 `link:../dsh-token-ledger`
这种写法会失败）：

```sh
# 在本仓库目录内执行
dsh plugin --profile web add "link:$(pwd)"     # bash / zsh / PowerShell
dsh plugin --profile web add "link:%CD%"       # cmd.exe
```

验证安装（端口换成 `dsh web` 实际监听的）：

```sh
curl http://127.0.0.1:PORT/dsh-token-ledger/api/health
```

这个响应同时回报数据根、会话目录是否存在，以及 Node 的 zstd 能力——
「为什么数字全是 0」通常一个请求就能定位。

## HTTP 端点

| 端点 | 说明 |
| --- | --- |
| `GET /dsh-token-ledger/api/summary?days=N` | 聚合报告（`days` 升序数组，便于画图） |
| `POST /dsh-token-ledger/api/refresh?days=N` | 强制跳过缓存重算 |
| `GET /dsh-token-ledger/api/export.csv?days=N` | CSV 下载 |
| `GET /dsh-token-ledger/api/health` | 自检：harness home、会话目录是否存在 |

## 「最长聊天时长」的口径

把它定义为**连续活动时长**，而不是首尾事件时间差。

原因：实测本机有个会话首尾相差 48 小时，但中间是隔夜中断——直接相减会把它算成
「聊天时长 48 小时」，明显不合理。现在的做法是取出所有带用量的事件时刻排序，
只累加不超过 30 分钟的相邻间隔；超过即视为会话中断，不计入时长。

于是同一个会话得到 1 小时 56 分，这才是「实际在一起的连续时段」。

## 测试

```sh
node test/ledger.test.mjs      # 数据层：折叠语义、时区、增量缓存、与官方投影一致性
node test/smoke.test.mjs       # 冒烟：配置校验、三面注册、路由分支、命令与工具
node test/kernel.test.mjs      # 真实 Cordis 内核：加载、卸载、真实 HTTP
node test/client.test.mjs      # 客户端半：真实 react 渲染两个组件
node test/regression.test.mjs  # 回归：服务缺席/部分可用时不得抛错
node test/render.test.mjs      # jsdom 真实挂载：验证异步数据到手后的仪表盘
node test/installed.test.mjs   # 安装副本：profile 里那一份的端到端
node test/profile.test.mjs     # profile 装配：bundle 声明与补丁层解析
node test/env.test.mjs         # 环境契约：Node 版本范围语义与 zstd 守卫
```

`render.test.mjs` 值得单说：`react-dom/server` 的静态渲染**不执行 `useEffect`**，
所以「数据到手后的界面」根本渲染不出来——早期测试只证明了空态不抛错，那是个盲区。
该测试用 jsdom 造真实 DOM、用 `react-dom/client` 真正挂载，让 effect 与 fetch
承诺链跑完，再断言指标条、热力图格数与分级、月份刻度、工具排行确实产出内容。

`ledger.test.mjs` 第 6 组是**一致性测试**：把日志折叠到投影缓存的 `seq` 水位线，
再与官方 `tokenUsage.val.totals` 逐字段比对。跳过水位线会误报——活跃会话的日志与缓存
同时推进，两次读取之间存在写入窗口。

`env.test.mjs` 用真实 `semver` 验证版本范围确实排除了没有 zstd 的 23.0–23.7，
并断言 `package.json` 的 `engines` 与代码常量一致。这两处曾漂移过一次（原先写 `>=18`）。

## Harness 契约依赖

锚定 **`dshTarget` = `0.1.5-rc.2`**。本插件依赖的是下面这些接缝，而不是宿主的公开版本号——
宿主升级时按这份清单核对，比看版本号更可靠：

- **`ctx.inject([...], cb)`**（Cordis）：`ctx` 是 Proxy，读**未声明**的服务属性会**立即抛错**
  （`cannot get property "x" without inject`），并在 apply 阶段被记为 fiber 失败。三面注册
  因此都走 `inject`，服务缺席时只是那一面不注册。**这是曾经让 DSH 起不来的那个坑**
  （见[启动故障与修复](#启动故障与修复101)）。
- **`webServer.register({ kind: 'prefix', path, handler })`**：挂 `/dsh-token-ledger/*` 路由。
- **`commands.register({ name, description, input, handler })`**，handler 返回
  `{ kind: 'success' | 'error', text }`：`/tokens` 命令。
- **`tools.register({ name, description, parameters, output: { schema, render }, execute })`**：
  `token_usage` 工具（原 JSON-Schema 工具定义，避免与宿主版本耦合）。
- **客户端 `window.__ModuleLoader__.load({ id, factory })`**：factory 用 `require("react")`，
  导出 `name` / `inject` / `apply`。bundle 自带的 `exports.inject = ['slots', 'locale']`
  是**真实的客户端服务名**，必须存在；而 `package.json` 里 `dsh.client.inject` 只是模块图排序提示。
- **两个 list 槽位**：`settings.section`（由 `dsh-client-ui-settings-general` 在其
  `sidebar.settings` 子树中声明）与 `conversation.input.dock`（由 `dsh-client-ui-conversation`
  声明，scope 为 session）。注册需要 `id` / `order`，`settings.section` 还需要 `label`。
- **`ctx.locale.register(ns, dict)` / `ctx.locale.bind(ns)`**：中英文案。
- **数据格式契约**（比 API 更容易变）：会话日志位于
  `sessions/<workspace>/<session>/session.v3.jsonl.zstd`，是**多帧 zstd 容器**，
  每行事件的 `version` 为 3；用量在 `assistant/message` 事件的 `data.usage` 里
  （`inputTokens` / `outputTokens` / `totalTokens` / `cacheReadTokens`）。
- **投影缓存格式**（仅一致性测试用）：`storages/session_projcache/sessions/*.json` 的
  `record.rows.tokenUsage.val.totals` 与 `seq` 水位线。

刻意不依赖的：宿主的 `tokenUsage` 投影本身（缓存是派生数据、可能滞后，插件直接读日志）、
以及任何 `@deepseek-ai/*` 包的 import——所以插件在宿主大版本更新时更可能继续可用。

## 热力图两处 CSS 缺陷与修复（1.0.4）

1.0.3 上线后热力图有两个视觉问题，都是 CSS 层面的：

**图例色块全部无色。** `.dshTlLegendBox` 与 `.dshTlL1..4` 同为单类选择器
（specificity 都是 0,1,0），胜负只由**源码顺序**决定。而我把
`.dshTlLegendBox{...background:heat0...}` 写在了等级色规则**之后**，
于是空色把所有等级色覆盖掉，五级图例全长一个样。

修法：图例容器不再声明 `background`，空色单独给一个 `.dshTlL0` 级，
与 `.dshTlL1..4` 并列定义。

**月份标签被裁成半个字。** 月份标签用 `grid-column` 定位在 11px 宽的网格列里，
但「3月」两个字约 20px，而我给 `.dshTlHeatMonth` 加了 `overflow:hidden`，
于是第二个字被切掉，看起来像「3F」。

修法：去掉 `overflow:hidden`，让文字溢出列宽显示。
标签间距由 `MIN_LABEL_GAP = 3` 列（≥42px）保证，溢出不会互相压字。

两处都补了回归断言：`render.test.mjs` 新增「样式结构回归」组，
检查等级色必须排在 `.dshTlCell` 之后、`.dshTlLegendBox` 不得带 `background`、
`.dshTlHeatMonth` 不得有 `overflow:hidden`，并断言图例五级各自带对类名。

这类问题只有真实渲染才暴露得出来，所以同时在真实 DSH 界面里截图核对过。

## 界面故障与修复（1.0.2）

1.0.1 装好后输入框下方出现一条**横贯全宽的黑色横杠**。三个原因叠加：

**变量作用域断裂。** 自定义的 `--tl-*` 变量定义在 `.dshTlRoot` 上，但徽标
`.dshTlBadge` 渲染在该元素之外，于是所有变量都是未定义值。

**硬编码深色。** 徽标写死 `background:#20242f`，在浅色主题下就成了黑底。

**被 flex 拉伸。** `conversation.input.dock` 是 flex 行容器，子项默认沿交叉轴拉伸，
`display:inline-flex` 也挡不住——于是胶囊被拉成整行色带。

修复：

- 所有配色改用宿主语义变量 `--dsw-alias-*`（`bg-layer-*` / `label-*` / `border-l*` /
  `state-*`），宿主已按浅色与深色分别赋值，插件自动跟随主题；变量都带兜底值。
- 徽标外包一层 `.dshTlBadgeWrap`，设 `align-self:center` + `flex:0 0 auto` + `width:fit-content`，
  从布局上根除拉伸。
- 样式节点 id 带版本（`-style-v2`）并主动清理旧节点，避免升级后残留旧样式。

顺带修正了定位：宿主自己的统计条报的是**本会话**实时数据
（`7 轮 43 步 · 156 tok/s · 4.6M tok · 缓存命中 91%`），所以徽标改为只补它没有的
**今日 / 近 7 天**累计，不再重复同一行的缓存命中率。

`client.test.mjs` 新增「主题安全」断言组，硬性检查：CSS 中不得出现任何裸色值、
必须引用宿主变量、CSS 用到的每个变量键都必须有定义、徽标 wrapper 必须设定防拉伸属性、
不得残留旧变量命名。这类问题只有真实渲染才看得见，因此测试同时用真实 react 渲染两个组件。

## 启动故障与修复（1.0.1）

1.0.0 装上后 **DSH 无法启动**，只能卸载才进得去。日志：

```text
plugin failures: {"stage":"apply","entryId":"dsh-token-ledger",
  "message":"cannot get property \"tools\" without inject"}
DSH entry failed: dsh: plugin tree failed to load
```

根因是我对 Cordis 上下文的理解错误。`ctx` 是 Proxy：**访问未在 `inject` 中声明的服务属性
会立即抛错**，而不是返回 `undefined`。我原先写

```js
if (ctx.tools !== undefined) { ctx.tools.register({...}) }   // 错误
```

想做"服务缺席就降级"，结果在**读取的那一刻**就抛错，把整个 profile 拖垮。

正确写法是声明式依赖，服务缺席时该面安静跳过：

```js
ctx.inject(['tools'], (sub) => { sub.tools.register({...}) })
```

`webServer`、`commands`、`tools` 三面现在都用这个方式。

**为什么原来的测试没抓到**：测试里的 ctx 替身直接提供了 `ctx.tools` 属性，恰好绕过了
Proxy 语义——测试通过，真实启动却失败。现在加了 `regression.test.mjs`，用真实 Cordis
Context、在服务全缺席/部分可用的组合下断言 fiber 必须 `active`；`client.test.mjs`
则用真实 react 渲染组件，覆盖客户端一侧。

教训：**配置能组合 ≠ 能启动**。装配验证必须包含一次真实启动。

## 性能

20 个会话 / 4.6 MB：首次全量折叠约 200 ms，之后靠 `(mtime, size)` 增量缓存降至约 3 ms
（实测 20/20 命中）。TTL 之上的这层缓存让徽标轮询的代价可忽略。

## 许可

MIT
