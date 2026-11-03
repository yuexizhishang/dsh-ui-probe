# dsh-ui-probe

DeepSeek Harness 的**本地可视化插件页面验收工具**：在对话里调用它，切到目标插件页面，按对话决定的内容做验收——读真实 DOM 与计算样式、点按钮、填输入框、等异步效果、抓控制台错误，结束后自动回到原对话。

## 目录

```
dsh-ui-probe/
  bundle/          # 插件本体（可直接 install_bundle 的包）
    package.json
    cordis.patch.yml
    index.js       # Host 半边：工具 + 命名 HTTP 桥
    client.js      # 页面半边：长轮询、动作执行、时间线
    locale/
    icon.svg
  README.md
  .gitignore
```

## 安装与更新

| 操作 | 命令 | 是否需要重启 |
|---|---|---|
| 安装 | `plugin_manager install_bundle`，target = 本仓库 `bundle/` 的**绝对路径** | 首次可能 `restart-required`；重装同一包通常直接 `applied` |
| 改 Host（index.js） | `plugin_manager set_bundle` 关 → 开 | 否（热重载） |
| 改 Client（client.js） | 页面 `Ctrl+R` | 否 |
| 卸载 | `plugin_manager remove_bundle`，target = `@local/ui-probe` | 否 |

**注意**：安装后 profile 里是一个指向 `bundle/` 的链接。**不要搬动这个目录**——要移动就先卸载，移完再从新路径重装。

## 两个工具

### `ui_probe`（只读诊断）
桥状态：`connected`、`polls/holds/results`、`heldOpen`、`pending`、Electron 版本。

### `ui_page`（验收会话）

```
begin { openText|openSelector, settleMs }   打开目标面板，记下来源会话（agent.id + 标题）；省略入参 = 原地验收
act   { act: { kind, ... } }                 一步，可重复 N 次；界面全程停在面板
end                                          返回时间线 + 快照 + errors，然后回到原会话
```

`act.kind`：`click` / `waitFor` / `audit` / `snapshot` / `wait` / `type` / `key`。
另有 `peek`（打开→读→立刻回）与 `restore-origin`（回到记录的起点）。

**三重兜底**：`end` 显式收尾；30 秒无新 `act` 自动收尾；页面刷新/崩溃后按 `sessionStorage` 里的起点自动点回。回退优先用 `[data-session-id]`（Host 把调用方 `agent.id` 下发），失败才退回标题，两者都失败会明确 `failed`，不乱点。

## 已验证（2026-11-03）

- 会话：`begin/act/end`、8 步时间线、`errors: []`、`restored.via: session-id`；
- 点击：第三方插件面板里点按钮，class 变为 `lc-gran-on`、色值从灰字透明底变白字深底；
- 端到端：装回 `sidebar-notes` 样例 → 打开便签 → 填 textarea → 点"清空"（按钮 45.3→69.3px、变红）→ 连点"确认清空" → 出现"还没有内容"空状态 → 自动回对话；
- 输入：Lexical 输入框写入（`execCommand-insertText`）、清空（`range+beforeinput-deleteContentBackward`）、按键；
- 开销：空闲约 1 次/分钟（55 秒长轮询），页面隐藏时停发。

## 已知边界

| 做不到 | 原因 |
|---|---|
| 截像素图 | Host 在 Electron 子进程，`BrowserWindow.getAllWindows()` 为空；像素只能外部 Win32 `PrintWindow`（需一次不受权权限，但不抢前台、不受遮挡） |
| 面板 A → 面板 B 自动回 A | 页面没有可靠的"当前面板"标记；用显式 `click` 或 `restore-origin` |
| Canvas/自绘编辑器输入 | 只支持 input/textarea 与标准 contenteditable |
| 并发调用 | Host 单请求队列，同时只有一个任务 |

## 实现要点

- 页面用**长轮询**访问 `Host` 的命名 HTTP 路由 `/dsh-ui-probe`；命名路由**不需要认证令牌**（页面同源 `dsh-app://app/`）。
- Host 只保留**最新一个**挂起请求，旧页面代际的残留会被释放为 `{id:null}`，避免同一任务被多个页面实例执行。
- 客户端不用 `eval`，动作是固定词表，避开 CSP。
- `type` 的 `ok` 来自**回读校验**，写不进去就报 `ok:false` + `note`，不假装成功。
