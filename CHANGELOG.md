# 更新记录

记录每个阶段的改动。**版本号只在真正发布时写进 `package.json`**，未发布的内容先放在「未发布」段落，发版时把标题改成版本号并补上日期。

> **设计边界：插件只采证，不做判断。** 输出限定为事实与数值——元素几何、计算样式、可见性、等待耗时、控制台报错、请求记录。**通过 / 不通过 / 哪里该改，由对话模型判断**，插件不产出结论，也不内置断言（无 expect / assert）。动作结果里的 `ok: false` 只表示这一步没能执行（找不到目标、超时、被安全边界拒绝）。

## 未发布（计划 1.1.0）

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

状态：已实现；结构与过滤已实测，`panel` 字段要等下一次真实报错才能观察到取值。

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
