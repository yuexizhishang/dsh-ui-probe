# 更新记录

记录每个阶段的改动。**版本号只在真正发布时写进 `package.json`**，未发布的内容先放在「未发布」段落，发版时把标题改成版本号并补上日期。

> **设计边界：插件只采证，不做判断。** 输出限定为事实与数值——元素几何、计算样式、可见性、等待耗时、控制台报错、请求记录。**通过 / 不通过 / 哪里该改，由对话模型判断**，插件不产出结论，也不内置断言（无 expect / assert）。动作结果里的 `ok: false` 只表示这一步没能执行（找不到目标、超时、被安全边界拒绝）。

## 1.1.0 — 2026-11-23

### 更新记录校对与 peek ref 修复（2026-11-23）

状态：完成；`peek` 的 ref 支持已实测。

**校对（只改记录，不改行为）**：

- 推送说明改成与现状一致：`main` 已绑定 `origin/main`，推送用 `git push origin main --tags`，并写明**标签不会随普通 push 上传**。
- 验证表里的 `ahead 12` 改为"该次提交时领先 12"，避免与后续提交数不符。
- 阶段 3 的 `panel` 字段状态更新为"截至 2026-11-23 仍无真实报错样本"，阶段 5 的 `panelSource` 同样待样本。
- 去掉文档段落与阶段 4 之间孤立的分隔线，补一条「约定 — 插件只采证，判断归对话」记录设计边界的引入时间。

**代码核对时发现并修复的问题**：

- `peek` 的 `audit` 调用只传了 `selector` / `text`，**漏传 `ref`**——与阶段 1 的记录、以及工具 schema 里"`ref` 可用于 audit/outline/peek"的说明都不符。按 ref 调 `peek` 会退化成"找不到目标"。修复为一行：把 `ref` 一并传给 `runAct`。

**验证**：

| 项 | 结果 |
|---|---|
| `node --check client.js` | 通过 |
| `peek { openPanel: "pixel-forge", ref: "e11" }` | `opened: pixel-forge`，`audit.found: 1`（侧栏按钮，`aria-label=像素工坊`），`restored.via: layout.selectPanel + row`，`backInConversation: true` |
| 记录与代码逐项对照 | 阶段 1–6、清理、设置页回退的字段与行为均能在代码里找到对应实现 |

### 仓库整理与自带自检（2026-11-23）

状态：完成。

**问题**：

- 本地留着一条 `backup/history` 分支。它建于 2026-11-03，2026-11-04 发布 1.0.0 时公开历史被换成另一条线，于是它成了一条旧血统（ahead 9 / behind 10），且 `main` 没有 upstream。
- 静态校验一直靠工作区的 `plugin-kit/tools/check-bundle.mjs`，插件仓库自身没有入口：别人 clone 后不知道怎么自检，发布前也容易漏跑。

**改动**：

- 旧血统先归档成标签 `backup/2026-11-03`（指向 `7ff18b5`），再删除 `backup/history` 分支；`main` 已绑定 `origin/main`。公开历史只追加、不重写；推送时用 `git push origin main --tags`——**标签不会随普通 push 上传**，归档标签要显式推。
- 新增 `scripts/check.mjs` 与 `npm run check`：**28 项**零依赖检查——manifest 合法性、patch 指向与插入行名一致、`apply` 导出唯一、factory id 与包名一致、图标类型与 256 KiB 上限、locale 可解析且有 `meta.title`、`files` 覆盖必需文件且路径存在。
- 该脚本只放在仓库里（`files` 不含 `scripts/`），不随 npm 包分发；npm 用户不需要它。

**验证**：

| 项 | 结果 |
|---|---|
| `node scripts/check.mjs` | 28 checks，0 error，退出码 0 |
| 故意把 `package.json` 写坏 | 退出码 1（能报错） |
| `git branch -vv` | `main` 跟踪 `origin/main`（该次提交时领先 12），旧分支已删，tag `backup/2026-11-03` 在 |

### 设置页检查更新加 npm 回退，工具描述压缩（2026-11-23）

状态：已实现；GitHub 主路径实测通过，**npm 回退分支未触发**（当前 GitHub 可达）。

**问题**：

- 设置页「检查更新」只读 `api.github.com`。该接口未认证时按 IP 限流 60 次/小时，超限直接 403，用户看到的是"读不到远端版本"，很像插件坏了。
- `ui_page` 的工具描述 1828 字符，每次调用都随 schema 带给模型，属于固定成本。

**改动**：

- `selfCheck()` 改为双源：先 GitHub（commit + `package.json`），失败回退 `registry.npmjs.org/<包名>/latest` 读 `version`。新增 `source`（`github` / `npm`）、`canUpdate`、`updateNote` 字段；两个来源都失败才返回 `ok:false`，错误里分别写明两边的原因。
- 更新仍只走 GitHub：npm-only 时**能检查但不能安装**（`skipped: true, reason: 'update needs GitHub'`），避免把本地开发安装（junction）替换成 npm 包。
- 工具描述压到 1324 字符（−28%），保留动作集合、`ref`、控件判定、`effect`、`panelSource`、off-limits、空闲自动返回；流程性内容留在技能文本里。

**验证**：

| 项 | 结果 |
|---|---|
| 直接 `POST /dsh-ui-probe/self {action:"check"}` | `ok:true`，local/remote 均 `1.0.0`，`source:"github"`，`upToDate:true`，`canUpdate:true` |
| 运行中的 `ui_page` 描述（`Tool.listTools`） | 1355 字符（JSON 转义形态），含 `openPanel` / `effect` / `panelSource` |
| npm 端点（Node 直连） | HTTP 200，`version: 1.0.0` |
| 回退分支 | 未触发，如实记录 |

**兼容性**：`/self` 只新增字段，客户端读取的字段不变；安装更新语义收紧（npm-only 时不允许更新），见上。

### 清理 — 重复键、npm 文件、注释与措辞（2026-11-23）

状态：纯清理，无行为变化。

**改动**：

- `index.js`：删掉 act 参数里**重复定义的 `within`**（第二处静默覆盖第一处，前段描述从没生效）；合并为一条说明。`within` 现在只剩 act 与 steps 各一处。
- `package.json`：`files` 补 `CHANGELOG.md`，npm 用户也能看到更新记录。
- 两侧超时常量（`DEFAULT_COMMAND_TIMEOUT_MS` / `COMMAND_TIMEOUT_CEILING_MS`）各加一句「必须与对端一致」的注释，避免将来只改一边。
- README「已知限制」首行改为「不知道面板 id 时自动切面板」，与阶段 6 之后的实际行为一致。
- `.gitignore`：删掉 `.shots/`、`acl-recovery/` 两个早期实验遗留条目。

**验证**：

| 项 | 结果 |
|---|---|
| `node --check` client.js / index.js | 均通过 |
| `check-bundle.mjs` | 0 error / 0 warning |
| `within` 定义数量 | 2（act + steps），此前为 3 |
| `package.json` 解析与 `files` | 正常，含 CHANGELOG.md |

### 阶段 6 — 按面板 id 切换、侧栏按 aria-label 打开、点击只落控件（2026-11-23）

状态：已实现并实机验证（0.2.2-rc.3，Electron 44.7.0）。

**问题**：

- `begin` 只能靠点侧栏切面板，而侧栏按钮在 DOM 里只有文字：`click { text: "像素" }` 命中侧栏标题的 `span`，`{ text: "示例精灵" }` 命中正文 `<p>`，**两次都返回 `ok:true` 却什么都没发生**。
- 面板 id 其实存在（`main` 槽以"侧栏入口 id"为 key，`ctx.layout.selectPanel(id)` 可直接切），但之前完全没用。

**改动**（只加事实与更准的定位）：

- **`begin { openPanel: "<id>" }`**：调 `ctx.layout.selectPanel(id)` 切主面板，不点击；切完用面板标题自检，标题为空就切回 `conversation` 并报错。id 非法时把 shell 的报文原样带出（实测：`main panel "no-such-panel" is not registered`），不再抛堆栈。
- **`begin { openText }`**：先在 `nav button[aria-label]` / `[class*="panelList"] button[aria-label]` 里精确匹配侧栏入口再点，匹配不到才回落到原来的可点击元素扫描。
- **`end`**：面板会话先 `selectPanel('conversation')`，再按会话 id 点侧栏行重新打开该会话（只切面板不会重新打开会话）；`restored.via` 写作 `layout.selectPanel + row`。
- **`origin` 提前取**：切面板会改 `document.title`，现在在切换前记录；`sessionTitle()` 在标题只剩应用名时回落到上一次报告里的 origin。
- **`click { text }` 只落控件**：命中元素向上取最近的可交互祖先（button / role / tabindex / `cursor:pointer`）；候选排序为整段文字完全相等 → 前缀 → 包含；找不到控件时返回 `ok:false` + `matched` + 附近 3 层内的控件候选（带 ref）；发生升级时返回 `resolvedFrom`。

**验证**：

| 场景 | 结果 |
|---|---|
| `begin { openPanel: "pixel-forge" }` | `openedBy: layout.selectPanel`，`panel: 像素工坊 (heading)` |
| `begin { openText: "人设工坊" }` | `openedBy: sidebar aria-label`，`panel: 人设工坊` |
| `click { text: "示例精灵" }`（该词原本只命中正文段落） | `resolvedFrom: p` → 点中真实按钮，`effect.mutations: 12` |
| `click { text: "像素" }`（原本命中侧栏 `span`） | `resolvedFrom: span` → 面板内按钮 `(660.7, 121.7)`，`effect.mutations: 3` |
| `click { text: "放大倍数" }`（纯文字，无控件） | `ok:false`，`matched: span`，`candidates`: 两个 combobox |
| `end`（openPanel 会话） | `restored.via: layout.selectPanel + row`，`backInConversation: true` |
| `begin { openPanel: "no-such-panel" }` | `ok:false`，报文含 `main panel "no-such-panel" is not registered`，页面留在原处 |

**兼容性**：`index.js` 新增 `openPanel` 参数与其 schema 描述，需重载宿主后生效（客户端半边会自行热加载）；旧调用行为不变。

### 阶段 5 — 点击有没有反应、报错归因来源、资源加载失败（2026-11-23）

状态：点击变化摘要与报错归因**已实机验证**；资源加载失败监听已实现，本次没有可触发的失败资源，**未实测**。

**问题**（三处都是"看到的现象与真实情况不一致"）：

- `click` 只回元素信息。点了没反应、或误点到别的元素，都返回 `ok: true`：实测三次误点（侧栏标题里的 `span`、正文 `<p>`、已激活的 tab）全部报告成功，只能靠人肉比对快照才发现。
- 报错归因取 `[class*="panelTitle"]` 的第一个匹配。实测打开「像素工坊」时它取到的是**侧栏条目**，文本是「插件」——归因直接是错的。
- `img` / `script` / `link` 的加载失败不冒泡，现有的 `window` `error` 监听（冒泡阶段）收不到。

**改动**（只加事实）：

- `click` 结果新增 `effect`：`mutations` / `nodesAdded` / `nodesRemoved` / `focusChanged` / `focus` / `focusText` / `scrollChanged` / `titleChanged` / `urlChanged`。点击前后用 `MutationObserver` 计数，只统计不改判。
- `panelLabel()` 换成 `panelInfo()`：优先可见标题（排除 `aside` / `nav` 里的侧栏条目），其次面板内的 `panelTitle`，最后 `document.title`；每条报错带 `panelSource`，`info` 动作也返回当前 `panel` 与来源。
- 新增捕获阶段 `error` 监听：记录 `resource.img` / `resource.script` / `resource.link` 等类型与地址（截 300 字）。

**验证**（0.2.2-rc.3）：

| 场景 | 结果 |
|---|---|
| `info`（对话中） | `panel: { title: null, source: "conversation" }` |
| `info`（打开像素工坊） | `panel: { title: "像素工坊", source: "heading" }` |
| `info`（切到人设工坊） | `panel: { title: "人设工坊", source: "heading" }` |
| 点击侧栏「人设工坊」 | `effect: { mutations: 6, nodesAdded: 4, nodesRemoved: 2 }`，快照标题随之变成「人设工坊」 |
| 误点侧栏标题 `span` / 正文 `<p>` / 已激活 tab | `effect` 全为 0——误点在第一次返回里就能看出来 |
| 资源加载失败 | 未触发到失败资源，**未实测** |

**兼容性**：只加字段，不改既有字段语义；`errors[].panel` 在对话里由侧栏文本变成 `null`（并用 `panelSource: "conversation"` 标明）。

### 文档 — README 补齐新增能力（2026-11-23）

状态：纯文案改动，不涉及行为。依据是代码与已记录的实测结果，没有新增未验证的说法。

**问题**：README 停在 1.0.0 的功能面，阶段 1–4 加进来的引用定位、批量队列、耗时数值、报错随结果返回、命令超时全都没写；市场页正文直接抓 GitHub 的 README，对外描述与插件实际能力已经不一致。

**改动**：

- 动作清单补上「按编号操作」「抓报错」「量耗时」三条，收尾一句改为包含每步耗时。
- 新增「跑一整串动作」一节：清单能写哪些步骤、按顺序执行并统一返回、失败停或继续、每步默认 90 秒可调、「哪一步失败」怎么读。
- 新增「数值怎么读」一节：总耗时 / 交互耗时 / 等待耗时 / 长任务 / 报错面板各指什么，并写明插件只给事实、结论由对话下。
- 「已知限制」补两条：元素编号随页面变化失效（旧编号明确报错）、报错只能归因到面板级。
- 安装、设置页、安全边界三节保持原样；不写实现细节与未发布版本号。

### 阶段 4 — 打开失败给候选，且只认可点击元素（2026-11-23）

状态：已实现并实测。

**问题一**：`begin` 的名字写错只回 `opener not found: <名字>`，没有别的信息。模型只能再花一次 `snapshot` 去探，或者误判“面板不存在”。

**问题二**（测试时发现，比问题一严重）：名字在聊天记录里出现过时，`resolveTarget` 会匹配到正文里的 `span`，于是点击一个不可点元素、什么都没打开，却返回 `ok: true, opened: "span._text_…"`。**假成功**。

**改动**：

- opener 必须是真正的控件（`button` / `a[href]` / `summary` / `role=button|tab|menuitem|treeitem|option` / 按钮型 input）。先前版本用 `[tabindex]` 兜底，会让滚动容器也通过，已去掉。
- 找不到时返回事实清单：`candidates`（最多 24 条，含 `ref` / `role` / `text`）、`candidateCount`、以及一句 `hint`。
- 新增 `openRef`：可以直接用候选里的 `ref` 打开，不必再猜文字。

**验证**：

| 场景 | 结果 |
|---|---|
| `openText: "QWERTY不存在的面板"` | `ok: false` + 24 条候选（`e6 插件`、`e11 像素工坊`…）+ `candidateCount: 58` |
| 修复前同场景 | 匹配到正文 `span` 并返回 `ok: true`（假成功） |

### 阶段 3 — 控制台错误按面板归因（2026-11-23）

状态：已实现；结构与过滤已实测。`panel` 字段至今**仍没有真实报错样本**（截至 2026-11-23），阶段 5 新增的 `panelSource` 同样待样本。

**问题**：控制台报错是页面级的，捕获时会把别的插件的失败也算进来——本工作区实测抓到过 `Sidebar Session opening failed`（来自侧栏插件），和被测插件无关，混在同一条时间线里无法区分。

**改动**（只加事实，不做判断）：

- 每条错误记录补三个字段：`panel`（报错那一刻屏幕上面板的标题）、`step`（会话进行到第几步）、`duringSession`（是否在会话期间）。
- `end` 报告新增 `errorSummary`：`{ total, duringWindow, byPanel: [{ panel, count, kinds }] }`。
- `errors` 动作支持两个过滤参数：`sinceSession`（只看本次会话开始之后的）和 `panel`（只看标题包含该文字的面板），并返回同一份 `byPanel` 计数。
- **报错放进统一返回**：`run`、`act`、`peek` 的返回值里直接带本次窗口内的 `errors` 与 `errorSummary`，不需要再补一次 `errors` 调用——一次调用就回答「这一步做了什么、有没有报错」。

**验证**：

| 场景 | 结果 |
|---|---|
| 会话中查询 `errors { sinceSession: true }` | 返回 `{ count: 0, total: 0, errors: [], byPanel: [] }`，新增字段就位 |
| `run` 返回 | 含 `errors: []` 与 `errorSummary: { total, duringWindow, byPanel }` |
| `act` 返回 | 同样含 `errors` 与 `errorSummary` |
| `end` 报告 | 含 `errorSummary` |

本次没有真实报错发生，所以 `panel` 的取值路径只做了代码核对，没有实测样本——如实记录。

### 阶段 2 — 命令超时与空闲计时（2026-11-23）

状态：已实现并实机验证，未发布到 npm。

**问题**：会话的空闲计时（30 秒）和宿主请求超时（30 秒）都在队列执行期间生效。实测一个 40 秒队列（两个 20 秒 wait）在跑完第 1 步后就被自动收尾，剩余步骤不执行；同时工具调用返回 `no answer from the DSH page within 30000ms`，页面已经算出的结果直接丢失。

**改动**：

- **空闲计时只在结果返回后开始**：请求开始前清掉计时器，结果回写完成后再启动。队列跑多久都不会被自己的空闲计时打断。
- **每个命令独立的超时**：默认 90000 毫秒，对话可用 `commandTimeoutMs` 调整（1000–600000），队列中的每一步也能单独覆盖。超时的命令返回 `{ ok: false, timedOut: true, timeoutMs, error: "command timed out after …ms: <kind>" }`，是否继续由 `stopOnFail` 决定。
- **宿主请求超时按命令预算计算**：`act` = 一个命令预算 + 15 秒余量，`run` = 各步预算之和 + 15 秒余量，上限 600 秒。不再是固定 30 秒。

**验证**：

| 场景 | 结果 |
|---|---|
| 40 秒队列（2×20 秒 wait + snapshot） | 3 步全部执行，`failed: 0`，`elapsedMs: 40033` |
| `commandTimeoutMs: 2000` + 5 秒 wait | 第 1 步 `timedOut: true`、`timeoutMs: 2000`，队列停止，`lastError` 说明原因 |

### 约定 — 插件只采证，判断归对话（2026-11-23）

把设计边界写进本文件开头，作为后续所有阶段的前提：

- 插件输出只允许事实与数值：几何、计算样式、可见性、耗时、报错、请求记录。
- 不内置断言（无 expect / assert），不输出"合格 / 不合格 / 建议修改"。
- 动作结果里的 `ok: false` 只表示这一步没能执行（找不到目标、超时、被安全边界拒绝），不是对界面质量的评价。

### 阶段 1 — 引用定位 / 性能时序 / 批量队列（2026-11-23）

状态：已实现并实机验证，未发布到 npm。

#### 新增

- **引用定位（ref）**
  快照返回 `refs: [{ ref, role, text }]`，`act`、`audit`、`outline`、`peek` 都能用 `{ "ref": "e6" }` 指定目标，不再依赖文字匹配——两个控件同名时也能点对。
  ref 在 DOM 变化后自动重建；使用已失效的 ref 会明确提示「重新取一次快照」，而不是误点其他元素。

- **性能时序（timing）**
  每一步返回 `timing`：
  `interactionMs` 是点击到下一帧渲染的耗时（用户感知的「响应快不快」），`waitedMs` 是 `waitFor` 等到元素出现的时间，`longTasks` / `longTaskMs` 记录该步引发的超过 50ms 的主线程卡顿，`totalMs` 是含等待的总耗时。

- **批量队列（run）**
  `{ "action": "run", "steps": [ … ], "stopOnFail": true }` 一次提交整张清单，由页面端顺序执行，返回每一步的结果与汇总：
  `requested / executed / failed / stoppedEarly / lastError / elapsedMs`。适合「模型先把要验证的步骤列出来，再一次性跑完」。

#### 兼容性

- 原有的 `act.kind`、`begin` / `end` / `peek`、只读动作行为不变；快照原有字段保留，只新增 `refs`。
- 安全边界不变：设置、账号、余额、充值与账号菜单仍然一律拒绝。
- 插件设置页、技能与提示词注册不变。

#### 验证

在 DSH 0.2.2-rc.3 上实机验证：

| 项目 | 结果 |
|---|---|
| ref 点击 | `{"kind":"click","ref":"e6"}` 打开「插件」面板，结果回填 `"ref":"e6"` |
| 交互耗时 | `interactionMs = 27.9 ms` |
| 等待耗时 | `waitFor` 命中 `waitedMs = 2 ms` |
| 队列 | 提交 5 步 → 执行 4 步 → 第 4 步失败 → `stoppedEarly: true`，`lastError` 指向失败原因 |
| 过期 ref | 返回 `ref "e999" is not in the current snapshot; take a new snapshot…` |

## 1.0.0 — 2026-11-04

首个公开发布，上传 npm 并收录进插件市场。

- 会话式界面验收：`begin` / `act` / `end`，动作含 click、waitFor、audit、snapshot、wait、type、key
- 快捷 `peek`：打开 → 读一次 → 立刻回到原对话
- 只读动作：`audit`、`find`、`outline`、`info`、`errors`
- 自动收尾：30 秒无动作结束、页面刷新后恢复、回到来源会话
- 安全边界：设置、账号、余额、充值、账号菜单对自动化封闭
- 设置页：检查更新、更新并安装、卸载插件
- 发现机制：注册 `dsh-ui-probe` 技能与系统提示段落
