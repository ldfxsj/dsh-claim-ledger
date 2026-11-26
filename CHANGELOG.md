# Changelog

按版本倒序。每一条都是这台机器上实际跑过、测试过的改动，不是计划。

## 0.6.0

- **完整面板**：徽章点开后不再是「最后 5 条被推翻」，而是**逐条断言列表**——每行 `t12 行动 ✓ 引文`，
  下面附该条的核验说明；可按「全部 / 行动 / 陈述 / ✗被推翻 / ?测不到」筛选。
- **状态形状升级**：投影状态里多带 `rows`（每条的 `turn/stance/kind/verdict/quote/note`，引文裁 120 字、
  说明裁 160 字）与 `hidden`；`stateVersion` 1 → **2**（形状变了就不该拿旧检查点去 parse）。
- **面板有上限**：一次会话可能几百条断言，客户端只带最近 `PANEL_CAP = 300` 条，更早的用一行字报数。
- 测试 71 → **73**（新增「面板记录有上限：超出的只报数」与「live 台账空时退回落盘快照」；投影用例补 `rows/hidden` 形状断言）。
- **假空修掉**：`badge: true` 在插件刚重载、内存台账还没收到某会话时，原先会对一个明明记过的会话报 `0 条断言`；现在退回落盘快照，并且会话 id 的 `session-` 前缀两个方向都试（`recorded` 同样）。
- 客户端仍是纯显示面：只做筛选与排版，判定与计数全来自宿主那份台账。

## 0.5.0

- **客户端徽章**：`client.js` 在 `conversation.composer.dock` 上注册一行可展开的徽章（排在内置 `activity` 0、`usage` 1 之后，并排新增不替换），点开看被推翻的 5 条与覆盖率。
- **徽章走投影**：`src/projection.mjs` 注册 key `claim-ledger`（`stateVersion` 1），`apply` 只在 `turn/end` 换对象、`wire.view` 原样返回；宿主按 `Object.is` 判定变化。不起任何 HTTP 路由——本机路由等于给任意网页开无鉴权读接口。
- **一份台账两处读**：新增 `src/live.mjs`，自动记账与投影共用同一个逐会话增量台账，避免两处各算一遍得出不一致的数字。`createRecorder` 改成接受外部 `store`。
- **schema 兜底**：zod 拿不到时退化成手写 `.parse` 形状校验，徽章不会因缺依赖整块消失；`stateVersion` 为非负安全整数。
- **`badge` 参数**：`claim_audit({ badge: true })` 直接返回徽章那份 JSON，用来核对徽章与最近一次审计是否一致。
- 测试 68 → **71**（新增 `test/projection.test.mjs`：key/stateVersion、只有回合结束才换引用、schema 兜底与 zod 两档）。
- 已知边界：客户端渲染在本机无法自动验证，改 `client.js` 后需刷新页面；注册失败只写 `errors.log`，不影响工具。

## 0.4.0

- **增量审计**：`createLedger()` 把「每回合处理」抽成可累加的一步，`audit()` 成了它的薄壳。自动记账不再每个 `turn/end` 全量重算。
- **证据倒排索引**：`tokenIndex` / `callIndex` 取代线性扫证据池。329 回合的会话单次审计 2 523 ms → 85.7 ms，增量 62.2 ms，最慢一回合 1.8 ms。
- **增量归并**：`createGrouper()` 单趟把事件并成回合，`tail` 直接复用，避免 `groupTurns(全部事件)` 的 O(回合²)。
- **Config**：`enabled` / `dir` / `debounceMs` / `live` 四个配置项；用带兜底的动态 import 拿 `@deepseek-ai/schemastery`，宿主里解析不到时插件照常激活。
- **生命周期**：订阅 `session/disposed` 清内存；`pruneLedger()` 按条数/天数/体积清理台账；`errors.log` 可用 `claim_audit({ errors: true })` 读。
- **未取证清单**：`claim_audit({ unbacked: true })` 逐条列出「有完成动词但没有事实 token」的句子（最多 200 条）。
- **checks 支持正则**：`{ rules: [{ pattern, flags, check }] }`，坏正则跳过而不崩。

## 0.3.1

- **覆盖率**：统计「完成性断言」里有多少句真的进了台账。10 个会话 207 句，可查 21 句（10%）。
- 徽章追加 `· 覆盖 10%`，表格末尾给 3 条例子，`recorded` 面板同样显示。

## 0.3.0

- **写入取证**：`write` / `edit` 的调用参数进入证据池，写文件断言按「入参命中 + 文件存在 + 内容干净」判定。
- `file_clean` 核验：BOM、非法 UTF-8、U+FFFD 替换字符。文件在但内容坏 → `refuted`。
- `--live=local`：只跑本机文件核验，不发网络请求、不起进程。
- 项目自身编码自检（`test/encoding.test.mjs`）。

## 0.2.3

- 省略号截断的路径不再当事实（`D:\…\x.docx` 不进核验）。
- 引号里的话不算立场；转述「我装不了」不再因路径存在被升级成 `✓`。
- README 被 shell 往返写坏后整份重写——这一条是事故记录，也是局限第 4 条的来源。

## 0.2.2

- **走势**：`claim_audit({ trends: true })` / `cli.mjs trends`，按会话、按断言类型看 `?` 的比例与「从没被核实过的类型」。

## 0.2.1

- **立场分类**：行动（「我做了什么」）/ 陈述（「世界是什么样的」）。徽章与表格分开显示。
- 存在性探针：只证明路径在，不证明句中其它说法；不在 markdown 链接里探。
- 否认 / 失败类断言不能靠 token 出现在输出里升级，要有报错输出或现场核验。

## 0.2.0

- **自动记账**：`session/event` 里 `turn/end` 后落盘快照、journal、errors；`claim_audit({ recorded: true })` 读回。
- 自动档只跑本机文件核验。

## 0.1.1

- 修多帧 zstd：会话日志是逐帧压缩的，只解第一帧会得到「0 回合」。
- 子代理会话目录名不带 `session-` 前缀也能解析。

## 0.1.0

- Host bundle：`claim_audit` 只读工具，可审计任意会话文件或会话 id。
- 三态台账、证据池、封闭核验词表、CJK 宽度表格。
