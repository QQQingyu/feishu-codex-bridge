# feishu-codex-bridge

在飞书 / Lark 里调用本机 Codex CLI 的个人 bot。你在聊天里发消息，bridge 在你的电脑上运行 `codex exec`，再把结果流式回到飞书 / Lark。

本项目参考 [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) 制作，感谢原项目的设计和实现启发。

[English README](./README.md)

## 前置条件

需要：

- Node.js >= 20
- 本机 Terminal；首次配置需要扫码、确认安装、完成 `codex login`
- 能访问 npm registry、OpenAI / Codex、飞书 / Lark 开放平台

不需要提前安装 `codex` 或 `lark-cli`。缺失时，bridge 会安装到自己的私有目录，避免公司电脑没有全局 npm 写权限：

```bash
~/.feishu-codex-bridge/codex-cli
~/.feishu-codex-bridge/lark-cli
```

如果 Codex 是 macOS app，但 `codex` 不在 `PATH`，bridge 也会检查：

```bash
/Applications/Codex.app/Contents/Resources/codex
```

也可以显式指定 Codex CLI：

```bash
export CODEX_BIN="/path/to/codex"
```

## 安装

```bash
npm i -g feishu-codex-bridge
feishu-codex-bridge --version
```

## 首次配置

在本机 Terminal 运行：

```bash
feishu-codex-bridge start
```

首次运行会引导你完成：

1. 从 `CODEX_BIN`、`PATH`、bridge 私有安装目录、macOS `Codex.app` 查找 Codex CLI；缺失时询问是否安装 `@openai/codex`。
2. 检查 Codex 登录状态；未登录时引导运行 `codex login`。
3. 显示二维码，用飞书 / Lark 扫码。
4. 创建或选择一个 PersonalAgent 应用。
5. 保存应用配置，并把 App Secret 放进本地加密 keystore。
6. 检查 `lark-cli`；缺失时询问是否安装到私有目录。
7. 用同一个 App ID 初始化 `lark-cli`。

看到终端输出“正在监听消息”后，在飞书 / Lark 私聊 bot：

```text
/status
帮我看一下这个项目
```

`/status` 是聊天里的快速自检，用来看当前 cwd、Codex session、agent 和 reasoning effort。普通文本消息会交给 Codex 处理。

群聊和话题群默认需要 `@bot` 才会响应。

后台服务请等首次配置完成后再安装，见「后台常驻」。

## 开放平台配置

扫码向导能创建应用，但你仍需要在开放平台确认权限和事件。缺少这些配置时，bridge 可能已经连接成功，但 bot 收不到消息或发不出回复。

权限 scope：

- `im:message`
- `im:message:send_as_bot`
- `im:resource`
- `im:chat`，创建群需要
- `drive:drive`，云文档评论需要

事件订阅，使用长连接模式：

- `im.message.receive_v1`
- `card.action.trigger`
- `drive.notice.comment_add_v1`，云文档 `@bot` 需要
- `im.message.reaction.created_v1` / `deleted_v1`，可选
- `im.chat.member.bot.added_v1`，可选

bridge 和 `lark-cli` 必须使用同一个飞书 / Lark 应用。不要为 `lark-cli` 运行：

```bash
lark-cli config init --new
```

否则 bot 收消息、API 权限、OAuth 用户身份会落到不同 app 上，后面很难排查。

## 后台常驻

先完成一次前台配置。看到“正在监听消息”并确认飞书里能收到 `/status` 后，按 `Ctrl+C` 停掉前台进程，再安装 macOS `launchd` 服务：

```bash
feishu-codex-bridge service install launchd
feishu-codex-bridge service status
feishu-codex-bridge service logs --follow
```

同一个飞书 / Lark 应用不要同时运行两个 bridge 进程；这会导致事件投递不稳定。安装 service 前先停掉前台进程。

重启或卸载：

```bash
feishu-codex-bridge service restart
feishu-codex-bridge service uninstall
```

服务日志：

- `~/.feishu-codex-bridge/service.log`
- `~/.feishu-codex-bridge/service.err.log`

## 日常使用

bridge 本地启动一个长连接 bot，把每条飞书 / Lark 消息转成一次本机 Codex 调用：

```text
Feishu/Lark chat
  -> bridge WebSocket
  -> local codex exec / resume
  -> optional lark-cli calls
  -> streaming card / text reply
```

三层能力各自分工：

- **bridge**：收发消息、会话映射、卡片流式更新、附件下载、后台常驻。
- **Codex CLI**：理解用户意图、读写本机项目、执行命令、延续 Codex session。
- **Lark CLI**：让 Codex 访问飞书 API，例如消息、云文档、日历、群管理和 OAuth。

常用聊天命令：

| 命令 | 作用 |
|---|---|
| <code>/status</code> | 查看当前 cwd、session、agent、reasoning effort |
| <code>/new</code> / <code>/reset</code> | 重置当前 chat 的 Codex session |
| <code>/resume [N]</code> | 列出并恢复当前 cwd 下的历史 Codex session |
| <code>/cd &lt;path&gt;</code> | 切换当前 chat 的工作目录，并重置 session |
| <code>/ws list/save/use/remove</code> | 管理命名工作空间 |
| <code>/config</code> | 调整回复、工具显示、并发、timeout、reasoning effort、访问控制 |
| <code>/timeout [N&#124;off&#124;default]</code> | 当前 session 的 idle timeout 覆盖 |
| <code>/stop</code> | 停止当前正在跑的 Codex 任务 |
| <code>/ps</code> | 列出本机 bridge 进程 |
| <code>/exit &lt;id&#124;#&gt;</code> | 关闭指定 bridge 进程 |
| <code>/reconnect</code> | 重连飞书 / Lark WebSocket |
| <code>/doctor [描述]</code> | 把近期 bridge 日志交给 Codex 做故障诊断 |
| <code>/account</code> | 查看或更换 bridge 使用的飞书 / Lark 应用 |
| <code>/help</code> | 查看帮助卡片 |

### 多对话调度

`/agent` 用于复现“主控派活、分项执行、主控验收”的 Codex 多线程协作流程。主控一般在私聊里新建项目和分派任务，执行对话可以是另一个私聊、群聊或话题。

最小流程：

```text
/agent new 项目名
项目目标

/agent add 任务标题
任务说明

/agent worker east 项目slug

/agent assign T-001 east 项目slug

/agent plan T-001 项目slug

/agent approve T-001 项目slug

/agent run T-001 项目slug

/agent result T-001 项目slug

/agent review T-001 项目slug

/agent clean 项目slug
```

创建项目时建议按华荣项目字段填写目标正文：

```text
/agent new 【企业策划】项目名
核心目标：这个项目要解决什么问题
交付物：最终需要产出什么
关键节点：截止日期或重要时间点
参考方向：参考资料、风格偏好、特殊要求
```

项目目录默认在 `~/.openclaw/workspace/projects/<project-slug>/`，核心文件：

- `project.md`：项目立项底稿，包含业务线、核心目标、交付物、关键节点、参考方向和对应业务线交付模板。
- `07_上下文窗口治理机制.md`：长期规则，定义主控对话、执行对话、写入边界和越权检查。
- `09_dispatch_board.md`：主控可读看板，由 `task_board.json` 自动同步生成，执行对话不得直接修改。
- `templates/worker_startup_instruction.md`：执行对话启动指令模板。
- `plans/T-xxx-plan.md`：复杂任务的执行计划，经 `/agent approve` 批准后才能执行。
- `worker_runs/T-xxx/`：执行对话隔离工作区，worker 只在这里运行和写入。
- `worker_state/T-xxx.json`：执行对话自己的状态文件。
- `outputs/T-xxx-result.md`：主控从隔离工作区导入后的执行结果文件。
- `reviews/T-xxx-review.md`：主控验收记录，包含结果章节、自动复核维度和越权风险检查。
- `handoff.md`：主控验收后的沉淀记录，用于后续合并、复盘和交接。

执行对话运行在 `worker_runs/<task-id>/` 隔离目录里，只允许在隔离目录内写自己的 `outputs/<task-id>-result.md` 和 `worker_state/<task-id>.json`。主控只导入该任务的结果文件；如果项目根目录出现非授权改动，`/agent review` 会把任务打回 `rework`。

`/agent review` 不只检查文件是否存在，还要求结果包含：核心结论、执行过程摘要、产出或发现、风险/阻塞、下一步建议、自动复核。自动复核必须覆盖：事实准确性、逻辑完整性、执行可行性、表达质量、遗漏风险、方案影响。结果卡的主按钮是“自动验收”，用于避免直接人工通过绕过复核。

带有“复杂、需要计划确认、多阶段、调研报告、实施方案”等特征的任务，会要求先 `/agent plan T-xxx` 生成执行计划，再 `/agent approve T-xxx` 批准后执行。调研、研究、政策、市场、数据、竞品、房地产，以及明确要求“案例调研、案例研究、参考案例、案例分析、案例资料”的任务，会强制检查信息来源清单；来源条目必须包含链接和发布时间/检索时间。单一来源未标注“待验证”会进入 `rework`，两条以上可识别来源才视为通过。验证、演练、测试类任务如果明确说明不联网、不读取外部资料或不是调研，默认不要求来源清单。

如果还要检查来源 URL 是否真实可访问，可以开启严格模式：

```bash
export FEISHU_BRIDGE_AGENT_SOURCE_URL_CHECK=1
export FEISHU_BRIDGE_AGENT_SOURCE_URL_TIMEOUT_MS=5000
```

严格模式默认关闭，避免网络波动、反爬或临时超时把可用结果误判为返工。

`/agent clean [项目slug]` 会清理已 `accepted` / `done` 任务的 `worker_runs/T-xxx/` 隔离执行目录，保留 `reviewing`、`running`、`rework` 等仍需追溯的执行现场。

## 用户 OAuth

基础聊天不需要用户 OAuth。只有当 Codex 需要访问“我的聊天记录、日历、云文档”等个人资源时，才需要登录 `lark-cli` 用户身份：

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
lark-cli auth login --recommend
```

bot 身份可用不等于用户 OAuth 已完成。很多租户级 API 可以用 bot 身份；读个人资源通常需要用户 OAuth。

## 可选 Obsidian MCP

桥接服务默认禁用 Codex 全局配置里的 `obsidian` MCP，避免本地 Obsidian Local REST API 的自签 HTTPS 证书或未启动状态影响飞书消息主链路。如果确实需要让飞书会话里的 Codex 直接调用 Obsidian MCP，可以在启动服务前设置：

```bash
export FEISHU_BRIDGE_ENABLE_OBSIDIAN_MCP=1
```

开启前应确认 `https://127.0.0.1:27124/mcp/` 能完成 MCP `initialize`，并且 `OBSIDIAN_LOCAL_REST_API_KEY` 已进入 launchd 服务环境。

## 源码开发

从 npm 安装的包已经包含 `dist/`，可以直接运行。clone 仓库开发时需要先安装依赖并构建：

```bash
npx pnpm@10.20.0 install
npx pnpm@10.20.0 build
node bin/feishu-codex-bridge.mjs --help
```

常用检查：

```bash
npx pnpm@10.20.0 typecheck
npx pnpm@10.20.0 test
```

## 配置文件

| 路径 | 内容 |
|---|---|
| `~/.feishu-codex-bridge/config.json` | bridge 应用配置和偏好 |
| `~/.feishu-codex-bridge/secrets.enc` | 加密保存的 App Secret |
| `~/.feishu-codex-bridge/sessions.json` | chat / 话题到 Codex session 的映射 |
| `~/.feishu-codex-bridge/workspaces.json` | 命名工作空间 |
| `~/.feishu-codex-bridge/processes.json` | 正在运行的 bridge 进程注册表 |
| `~/.feishu-codex-bridge/codex-cli/` | bridge 私有安装的 Codex CLI |
| `~/.feishu-codex-bridge/lark-cli/` | bridge 私有安装的 Lark CLI |
| `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` | bridge 结构化运行日志 |
| `~/.feishu-codex-bridge/media/<chatId>/` | 下载的图片和文件缓存，24h 清理 |

### Codex reasoning effort

默认不覆盖 Codex CLI 全局配置，继承 `~/.codex/config.toml` 里的 `model_reasoning_effort`。

如果只想固定 bridge 的调用强度，可以在飞书 / Lark `/config` 里设置 **Codex reasoning effort**，或直接改：

```json
{
  "preferences": {
    "codexReasoningEffort": "xhigh"
  }
}
```

支持值：`minimal`、`low`、`medium`、`high`、`xhigh`。恢复继承全局配置时，在 `/config` 里选默认，或删除该字段。

### 访问控制

默认是开放模式：能找到 bot 的人可以私聊，群里 `@bot` 可以触发。需要收紧时，在 `/config` 里配置：

- `allowedUsers`：允许交互的用户 `open_id` 列表。
- `allowedChats`：允许响应的群 `chat_id` 列表，私聊不受它限制。
- `admins`：允许执行 `/account`、`/config`、`/exit`、`/reconnect`、`/doctor`、`/cd`、`/ws` 的用户。

找 `open_id` / `chat_id`：

```bash
grep '"event":"enter"' ~/.feishu-codex-bridge/logs/$(date +%Y-%m-%d).log | tail -5
```

## 故障排查

**bot 没反应**

先确认进程和服务：

```bash
feishu-codex-bridge health
feishu-codex-bridge ps
feishu-codex-bridge service status
```

再看日志：

```bash
feishu-codex-bridge service logs --follow
```

`health` 用来做快速 live 巡检：launchd 状态、近期 WebSocket 日志、已安装运行时代码标记、常见噪声日志。如果 bridge 已连接但飞书里没反应，优先检查开放平台的权限 scope 和事件订阅。

需要被动观察稳定性时，安装 health monitor。它只记录 health 输出，不会自动重启 bridge，也不会杀掉正在跑的 Codex：

```bash
feishu-codex-bridge health-monitor install --interval 900
feishu-codex-bridge health-monitor status
feishu-codex-bridge health-monitor logs
```

**Codex CLI 缺失或没登录**

```bash
feishu-codex-bridge doctor
```

需要修复时，重新前台跑：

```bash
feishu-codex-bridge start
```

**Codex 说找不到 `lark-cli`**

```bash
feishu-codex-bridge doctor
```

如果普通 Terminal 里要直接用 `lark-cli`：

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

**`lark-cli` App ID 和 bridge 不一致**

重新前台跑：

```bash
feishu-codex-bridge start
```

按提示切换到 bridge 当前应用。不要运行 `lark-cli config init --new`。

**Codex 卡住**

可以在飞书 / Lark 发 `/stop`。长期使用建议在 `/config` 设置全局 run idle timeout，或对当前 session 使用：

```text
/timeout 10
```

## License

[MIT](./LICENSE)
