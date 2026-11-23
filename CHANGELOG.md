# 更新记录

记录每个阶段的改动。**版本号只在真正发布时写进 `package.json`**，未发布的内容先放在「未发布」段落，发版时把标题改成版本号并补上日期。

## 未发布（计划 1.1.0）— 引用定位 / 性能时序 / 批量队列

状态：已实现并在运行中的 DSH 上自测通过，未发布到 npm。

### 新增

- **引用定位（ref）**
  快照返回 `refs: [{ ref, role, text }]`，`act`、`audit`、`outline`、`peek` 都能用 `{ "ref": "e6" }` 指定目标，不再依赖文字匹配——两个控件同名时也能点对。
  ref 在 DOM 变化后自动重建；使用已失效的 ref 会明确提示「重新取一次快照」，而不是误点其他元素。

- **性能时序（timing）**
  每一步返回 `timing`：
  `interactionMs` 是点击到下一帧渲染的耗时（用户感知的「响应快不快」），`waitedMs` 是 `waitFor` 等到元素出现的时间，`longTasks` / `longTaskMs` 记录该步引发的超过 50ms 的主线程卡顿，`totalMs` 是含等待的总耗时。

- **批量队列（run）**
  `{ "action": "run", "steps": [ … ], "stopOnFail": true }` 一次提交整张清单，由页面端顺序执行，返回每一步的结果与汇总：
  `requested / executed / failed / stoppedEarly / lastError / elapsedMs`。适合「模型先把要验证的步骤列出来，再一次性跑完」。

### 兼容性

- 原有的 `act.kind`、`begin` / `end` / `peek`、只读动作行为不变；快照原有字段保留，只新增 `refs`。
- 安全边界不变：设置、账号、余额、充值与账号菜单仍然一律拒绝。
- 插件设置页、技能与提示词注册不变。

### 验证

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
