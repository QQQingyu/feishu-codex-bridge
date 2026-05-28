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

群聊中的外部编排保留消息会被 bridge 忽略，不会送进 Codex：<code>/study</code>、<code>/stop study</code>，以及形如 <code>[study-room:...]</code> 或 <code>[orchestrator:...]</code> 的消息。这样外部 sidecar 工具可以在同一个群里协调多个 bot agent，而不会触发重复的 Codex run。

## 用户 OAuth

基础聊天不需要用户 OAuth。只有当 Codex 需要访问“我的聊天记录、日历、云文档”等个人资源时，才需要登录 `lark-cli` 用户身份：

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
lark-cli auth login --recommend
```

bot 身份可用不等于用户 OAuth 已完成。很多租户级 API 可以用 bot 身份；读个人资源通常需要用户 OAuth。

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
feishu-codex-bridge ps
feishu-codex-bridge service status
```

再看日志：

```bash
feishu-codex-bridge service logs --follow
```

如果 bridge 已连接但飞书里没反应，优先检查开放平台的权限 scope 和事件订阅。

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
