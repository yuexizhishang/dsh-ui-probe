# dsh-ui-probe

**它在真实运行的 DSH 界面里验收插件**：自动打开目标插件页面，读取真实的尺寸与计算样式、点按钮、填表单、等异步结果出现、抓控制台报错；验收完自动回到原对话。

给做插件的人用——不用眯着眼睛看截图判断"像不像"，而是拿到可核对的值（字号 14px、间距 12px、点击后按钮变红、空状态出现…），也能证明"插件的功能真的在界面上生效"。

包名：`@yuexizhishang/dsh-ui-probe`（仓库根即插件包，直接 `install_bundle` 本目录即可）。

## 版本号约定

- **只在发布时升级**（`1.0.0` → `1.0.1` 修 bug / `1.1.0` 加功能 / `2.0.0` 破坏性变更），不按提交次数升级；
- 未发布前保持 `1.0.0`；
- 插件设置页的"检查更新"比较的就是这个 `version`，所以**发新版前必须先改它**，否则别人看到的永远是"已是最新"。

## 安装

### 方式一：从 GitHub 安装（推荐）

在 Harness 的「设置 → 插件 → 添加插件」里粘贴：

```text
github:yuexizhishang/dsh-ui-probe
```

或完整地址 `https://github.com/yuexizhishang/dsh-ui-probe`。

### 方式二：克隆后从本地安装

```powershell
git clone https://github.com/yuexizhishang/dsh-ui-probe.git
```

然后用 `plugin_manager` 的 `install_bundle`，target 指向**克隆下来的仓库根目录**（绝对路径）。

### 方式三：npm（尚未发布）

仓库里 `package.json` 仍是 `"private": true`。要发 npm 需：删掉 `private`、`npm login`、`npm publish --access public`（scoped 包必须显式 public），之后别人可以粘贴 `@yuexizhishang/dsh-ui-probe@1.0.0`。

## 更新与卸载

| 操作 | 做法 | 是否需要重启 |
|---|---|---|
| 改 Host（`index.js`） | `plugin_manager set_bundle` 关 → 开 | 否（热重载） |
| 改 Client（`client.js`） | 页面 `Ctrl+R` | 否 |
| 卸载 | `remove_bundle`，target = `@yuexizhishang/dsh-ui-probe` | 否 |

**注意**：安装后 profile 里是指向本目录的链接，**移动仓库要先卸载**，移完从新路径重装。

## 装上之后，别人的 DeepSeek 会自动知道吗

会，靠三条**插件自带**的发现通道，不需要写任何人的 skill 目录，也不需要用户配置：

| 通道 | 作用 |
|---|---|
| **工具描述** | `ui_probe` / `ui_page` 出现在模型工具表里（描述里写明用途与禁区） |
| **运行时 skill** | `ctx.skills.register()` 注册 `dsh-ui-probe`，进技能目录；模型按 `description` / `whenToUse` 匹配后自动加载完整指南 |
| **提示词段落** | `ctx.systemPrompt.section()` 注册一小段（order 500），每个会话都注明"要验收 UI 用 `ui_page`，设置/账号/充值禁区" |

- 三者都是**运行时注册**，插件卸载即消失，不留文件；
- skill 内容是插件自带的（`index.js` 里的 `SKILL_CONTENT`），随版本更新；
- 如果用户的 profile 没有 `skills` / `systemPrompt` 服务，代码会跳过对应注册，工具本身仍可用。

## 目录

```
dsh-ui-probe/            ← 仓库根 = npm 包根
  package.json
  cordis.patch.yml
  index.js               Host：工具 + 命名 HTTP 长轮询桥
  client.js              页面：验收会话 / 动作 / 时间线
  locale/{zh,en}.json
  icon.svg
  README.md
  LICENSE
```

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

## 设置页（版本 / 更新 / 卸载）

设置 → 侧栏「UI 探针」里提供三项功能：

| 功能 | 行为 |
|---|---|
| 自动检查 | 打开设置页即请求 GitHub（`api.github.com/repos/<repo>/commits/main` + `raw.githubusercontent.com/.../package.json`），显示当前版本、最新版本、提交号与状态 |
| 更新并安装 | 远端版本更新时可用；调用 `pluginManager.installBundle('github:<repo>#<sha>')`，只有远端更新才动作（已是最新则跳过） |
| 卸载插件 | 二次确认后调用 `pluginManager.removeBundle('@yuexizhishang/dsh-ui-probe')`；只移除本插件的依赖与启用行，**不删除仓库、不删除任何用户文件** |

- **判断依据是 `package.json` 的 `version`**：只推代码不改版本号，别人看到的还是"已是最新"。发新版时先改版本号再推送。
- 更新走 GitHub 的 commit sha，装完若提示 `restart-required`，重启 DSH 生效。
- 这是设置页自己的网络请求（Host 侧 `fetch`），失败会原样显示（例如仓库尚未公开时是 `HTTP 404`）。

## 权限边界（硬限制，不可越过）

**设置、账号、余额、充值区域，以及账号菜单，对自动化完全封闭。**

- **账号菜单触发器**（`aria-label="账号菜单"`）直接拒绝——**菜单不会被打开**；
- 账号菜单（含"退出登录"的 `role="menu"`）、设置面板内的一切点击/输入/按键都会被**拒绝**，返回 `refused: 'off-limits'`；
- 兜底：任何点击若意外打开了账号菜单或设置面板，会立刻关闭并返回 `refused: 'account-menu-opened'` / `refused: 'settings-opened'`；
- `begin` 的打开目标同样受此限制；
- 唯一例外是本插件自己的设置区块（`[data-plugin="dsh-ui-probe-settings"]`），也就是版本/更新/卸载那一页。

这个插件**不会自己去打开设置**——它只是注册了一个设置页。设置由用户自己打开，插件只负责渲染其中一栏。

## 已验证（2026-11-03）

- 设置页（2026-11-03 实测）：`settings.section` 注册为「UI 探针」（order 90）；打开设置时自动检查 GitHub；仓库未推送时状态显示「错误 / GitHub API: HTTP 404 from …/commits/main」，**不假装成功**；三个按钮齐全，`更新并安装` 在非"有可用更新"时禁用；卸载文案明确"不删除仓库或任何用户文件"。
- 会话：`begin/act/end`、8 步时间线、`errors: []`、`restored.via: session-id`；
- 点击：第三方插件面板里点按钮，class 变为 `lc-gran-on`、色值从灰字透明底变白字深底；
- 端到端：装回 `sidebar-notes` 样例 → 打开便签 → 填 textarea → 点"清空"（按钮 45.3→69.3px、变红）→ 连点"确认清空" → 出现"还没有内容"空状态 → 自动回对话；
- 输入：Lexical 输入框写入（`execCommand-insertText`）、清空（`range+beforeinput-deleteContentBackward`）、按键；
- 开销：空闲约 1 次/分钟（55 秒长轮询），页面隐藏时停发。

## 已知边界

| 做不到 | 原因 |
|---|---|
| 截像素图 | Host 在 Electron 子进程，`BrowserWindow.getAllWindows()` 为空；像素只能外部 Win32 `PrintWindow`（需一次不受限权限，但不抢前台、不受遮挡） |
| 面板 A → 面板 B 自动回 A | 页面没有可靠的"当前面板"标记；用显式 `click` 或 `restore-origin` |
| Canvas/自绘编辑器输入 | 只支持 input/textarea 与标准 contenteditable |
| 并发调用 | Host 单请求队列，同时只有一个任务 |

## 实现要点

- 页面用**长轮询**访问 Host 的命名 HTTP 路由 `/dsh-ui-probe`；命名路由**不需要认证令牌**（页面同源 `dsh-app://app/`）。
- Host 只保留**最新一个**挂起请求，旧页面代际的残留会被释放为 `{id:null}`，避免同一任务被多个页面实例执行。
- 客户端不用 `eval`，动作是固定词表，避开 CSP。
- `type` 的 `ok` 来自**回读校验**，写不进去就报 `ok:false` + `note`，不假装成功。

## 许可

MIT，见 [LICENSE](LICENSE)。
