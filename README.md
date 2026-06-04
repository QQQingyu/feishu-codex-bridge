# feishu-codex-bridge

A local Feishu / Lark bot for calling Codex CLI from chat. You send a message in Feishu / Lark; the bridge runs `codex exec` on your machine and streams the result back to chat.

This project is built with reference to [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge), with thanks for the original design and implementation.

[中文 README](./README.zh.md)

## Requirements

You need:

- Node.js >= 20
- A local terminal for QR scan, install prompts, and `codex login`
- Network access to npm registry, OpenAI / Codex, and the Feishu / Lark open platform

You do not need to preinstall `codex` or `lark-cli`. When missing, the bridge installs them into private directories to avoid global npm permission issues:

```bash
~/.feishu-codex-bridge/codex-cli
~/.feishu-codex-bridge/lark-cli
```

If Codex is installed as a macOS app but `codex` is not in `PATH`, the bridge also checks:

```bash
/Applications/Codex.app/Contents/Resources/codex
```

You can pin a custom binary explicitly:

```bash
export CODEX_BIN="/path/to/codex"
```

## Install

```bash
npm i -g feishu-codex-bridge
feishu-codex-bridge --version
```

## First-Time Setup

Run in a local terminal:

```bash
feishu-codex-bridge start
```

On first run, it guides you through:

1. Find Codex CLI from `CODEX_BIN`, `PATH`, the bridge private install, or macOS `Codex.app`; if missing, ask to install `@openai/codex`.
2. Check Codex login status; if needed, run `codex login`.
3. Show a QR code for Feishu / Lark scan.
4. Create or select a PersonalAgent app.
5. Save app config and move the App Secret into a local encrypted keystore.
6. Check `lark-cli`; if missing, ask to install it into the private directory.
7. Initialize `lark-cli` with the same App ID.

After the terminal prints that it is listening, DM the bot:

```text
/status
Help me inspect this repo
```

`/status` is a chat-side health check. It shows the current cwd, Codex session, active agent, and reasoning effort. Regular messages are sent to Codex.

In groups and topic groups, the default policy is to respond only when mentioned.

For service mode, complete this step first; see [Background Service](#background-service).

## Platform Settings

The QR wizard can create the app shell, but you still need to confirm scopes and events in the developer console. Without these settings, the bridge may connect successfully while the bot still cannot receive messages or send replies.

Permission scopes:

- `im:message`
- `im:message:send_as_bot`
- `im:resource`
- `im:chat`, required for group creation
- `drive:drive`, required for cloud-doc comments

Event subscriptions, long-connection mode:

- `im.message.receive_v1`
- `card.action.trigger`
- `drive.notice.comment_add_v1`, required for cloud-doc `@bot` comments
- `im.message.reaction.created_v1` / `deleted_v1`, optional
- `im.chat.member.bot.added_v1`, optional

The bridge and `lark-cli` must use the same Feishu / Lark app. Do not run this for `lark-cli`:

```bash
lark-cli config init --new
```

Otherwise bot messages, API permissions, and OAuth identities are split across apps and become hard to debug.

## Background Service

Complete one foreground setup first. After the terminal is listening and `/status` works in chat, press `Ctrl+C` to stop the foreground process, then install the macOS `launchd` service:

```bash
feishu-codex-bridge service install launchd
feishu-codex-bridge service status
feishu-codex-bridge service logs --follow
```

Running two bridge processes for the same Feishu / Lark app causes unreliable event delivery. Stop the foreground process before installing the service.

Restart or uninstall:

```bash
feishu-codex-bridge service restart
feishu-codex-bridge service uninstall
```

Service logs:

- `~/.feishu-codex-bridge/service.log`
- `~/.feishu-codex-bridge/service.err.log`

## Daily Use

The bridge keeps a local long-lived bot process and turns each chat message into a local Codex run:

```text
Feishu/Lark chat
  -> bridge WebSocket
  -> local codex exec / resume
  -> optional lark-cli calls
  -> streaming card / text reply
```

Responsibilities are split:

- **bridge** receives events, maps chats to sessions, downloads attachments, renders cards, and keeps the bot alive.
- **Codex CLI** reasons, edits files, runs commands, and resumes Codex sessions.
- **Lark CLI** gives Codex a practical API tool for messages, docs, calendars, groups, OAuth, and other Lark resources.

Common chat commands:

| Command | Effect |
|---|---|
| <code>/status</code> | Show cwd, session, agent, and reasoning effort |
| <code>/new</code> / <code>/reset</code> | Reset the current chat’s Codex session |
| <code>/resume [N]</code> | List and resume recent Codex sessions under the current cwd |
| <code>/cd &lt;path&gt;</code> | Change cwd for the current chat and reset the session |
| <code>/ws list/save/use/remove</code> | Manage named workspaces |
| <code>/config</code> | Adjust reply mode, tools, concurrency, timeout, reasoning effort, access control |
| <code>/timeout [N&#124;off&#124;default]</code> | Override idle timeout for the current session |
| <code>/stop</code> | Stop the current Codex run |
| <code>/ps</code> | List bridge processes on this host |
| <code>/exit &lt;id&#124;#&gt;</code> | Stop a bridge process |
| <code>/reconnect</code> | Reconnect the Feishu / Lark WebSocket |
| <code>/doctor [description]</code> | Ask Codex to diagnose recent bridge logs |
| <code>/account</code> | View or change the Feishu / Lark app used by the bridge |
| <code>/help</code> | Show the help card |

### Multi-Dialog Dispatch

`/agent` implements a supervisor-worker Codex workflow: the supervisor creates a project, dispatches tasks, workers execute isolated subtasks, and the supervisor reviews results. The supervisor usually lives in a DM; workers can be another DM, a group, or a topic.

Minimal flow:

```text
/agent new project-name
project goal

/agent add task-title
task instructions

/agent worker east project-slug

/agent assign T-001 east project-slug

/agent plan T-001 project-slug

/agent approve T-001 project-slug

/agent run T-001 project-slug

/agent result T-001 project-slug

/agent review T-001 project-slug

/agent clean project-slug
```

For Huaring-style project governance, put the project brief in the `/agent new` body:

```text
/agent new 【企业策划】project-name
核心目标：the problem or effect this project targets
交付物：final deliverables
关键节点：deadline or milestones
参考方向：references, style preferences, special requirements
```

Projects are stored under `~/.openclaw/workspace/projects/<project-slug>/` by default. Important files:

- `project.md`: project brief with business line, core goal, deliverables, milestones, references, and the matching business-line delivery template.
- `07_上下文窗口治理机制.md`: long-term rules for supervisor, worker, write boundaries, and overreach checks.
- `09_dispatch_board.md`: human-readable board generated from `task_board.json`; workers must not edit it directly.
- `templates/worker_startup_instruction.md`: worker startup instruction template.
- `plans/T-xxx-plan.md`: execution plan for complex tasks; it must be approved with `/agent approve` before execution.
- `worker_runs/T-xxx/`: isolated workspace where the worker runs and writes files.
- `worker_state/T-xxx.json`: per-worker state file.
- `outputs/T-xxx-result.md`: task result imported by the supervisor from the isolated worker workspace.
- `reviews/T-xxx-review.md`: supervisor review record, including result sections, self-review dimensions, and overreach checks.
- `handoff.md`: appended supervisor review handoff records for merge, recap, and later continuation.

Workers run inside `worker_runs/<task-id>/` and may only write their own isolated `outputs/<task-id>-result.md` and `worker_state/<task-id>.json`. The supervisor imports only that task result; if the project root has unauthorized changes, `/agent review` marks the task as `rework`.

`/agent review` requires these result sections: `核心结论`, `执行过程摘要`, `产出或发现`, `风险/阻塞`, `下一步建议`, and `自动复核`. The self-review must cover `事实准确性`, `逻辑完整性`, `执行可行性`, `表达质量`, `遗漏风险`, and `方案影响`. Review cards make “自动验收” the primary action so a task is not accepted before the supervisor review runs.

Tasks marked with terms such as `复杂`, `需要计划确认`, `多阶段`, `调研报告`, or `实施方案` require `/agent plan T-xxx` followed by `/agent approve T-xxx` before they can run. Research, study, policy, market, data, competitor, real-estate, and explicit case-study tasks such as `案例调研`, `案例研究`, `参考案例`, `案例分析`, or `案例资料` require an information-source list. Source entries must include a link and publication or access time; a single source without `待验证` is returned to `rework`, while two or more recognizable sources pass the source gate. Validation, rehearsal, and test tasks do not require source lists by default when they explicitly say they should not browse, should not read external material, or are not research tasks.

To also check whether source URLs are reachable, enable strict URL checking:

```bash
export FEISHU_BRIDGE_AGENT_SOURCE_URL_CHECK=1
export FEISHU_BRIDGE_AGENT_SOURCE_URL_TIMEOUT_MS=5000
```

Strict URL checking is off by default so network instability, anti-bot behavior, or temporary timeouts do not incorrectly reject otherwise usable work.

`/agent clean [project-slug]` removes `worker_runs/T-xxx/` directories only for `accepted` / `done` tasks. It keeps `reviewing`, `running`, `rework`, and other active traces available for review.

## User OAuth

Basic chat does not require user OAuth. You only need it when Codex must access personal resources such as your own chat history, docs, or calendar:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
lark-cli auth login --recommend
```

Bot identity being ready does not mean user OAuth is complete. Tenant/bot APIs can work with bot identity; personal resources usually require user OAuth.

## Optional Obsidian MCP

Bridge runs disable the globally configured Codex `obsidian` MCP by default, so a self-signed local Obsidian Local REST API certificate or a stopped local service does not add noise to the Feishu/Lark message path. To let Codex launched from Feishu/Lark use Obsidian MCP directly, set this before starting the service:

```bash
export FEISHU_BRIDGE_ENABLE_OBSIDIAN_MCP=1
```

Before enabling it, verify that `https://127.0.0.1:27124/mcp/` can complete MCP `initialize` and that `OBSIDIAN_LOCAL_REST_API_KEY` is present in the launchd service environment.

## Develop From Source

The npm package already contains `dist/` and can run directly. A fresh clone needs dependencies and a build first:

```bash
npx pnpm@10.20.0 install
npx pnpm@10.20.0 build
node bin/feishu-codex-bridge.mjs --help
```

Common checks:

```bash
npx pnpm@10.20.0 typecheck
npx pnpm@10.20.0 test
```

## Configuration Files

| Path | Purpose |
|---|---|
| `~/.feishu-codex-bridge/config.json` | Bridge app config and preferences |
| `~/.feishu-codex-bridge/secrets.enc` | Encrypted App Secret store |
| `~/.feishu-codex-bridge/sessions.json` | Chat/topic to Codex session mapping |
| `~/.feishu-codex-bridge/workspaces.json` | Named workspaces |
| `~/.feishu-codex-bridge/processes.json` | Live bridge process registry |
| `~/.feishu-codex-bridge/codex-cli/` | Bridge-managed private Codex CLI install |
| `~/.feishu-codex-bridge/lark-cli/` | Bridge-managed private Lark CLI install |
| `~/.feishu-codex-bridge/logs/YYYY-MM-DD.log` | Structured runtime logs |
| `~/.feishu-codex-bridge/media/<chatId>/` | Downloaded image/file cache, cleaned after 24h |

### Codex Reasoning Effort

By default the bridge does not override Codex CLI reasoning effort. Codex inherits `model_reasoning_effort` from `~/.codex/config.toml`.

To pin it for bridge runs only, use `/config` in Feishu / Lark or edit:

```json
{
  "preferences": {
    "codexReasoningEffort": "xhigh"
  }
}
```

Allowed values: `minimal`, `low`, `medium`, `high`, `xhigh`. Remove the field, or select default in `/config`, to inherit the global Codex config again.

### Access Control

The default mode is open: anyone who can find the bot can DM it, and group users can mention it. Tighten this in `/config`:

- `allowedUsers`: open_id allowlist for interacting with the bot.
- `allowedChats`: group chat_id allowlist; DMs are not restricted by this field.
- `admins`: users allowed to run sensitive commands such as `/account`, `/config`, `/exit`, `/reconnect`, `/doctor`, `/cd`, and `/ws`.

Find IDs from logs:

```bash
grep '"event":"enter"' ~/.feishu-codex-bridge/logs/$(date +%Y-%m-%d).log | tail -5
```

## Common Fixes

**Bot is silent**

Check process and service state:

```bash
feishu-codex-bridge health
feishu-codex-bridge ps
feishu-codex-bridge service status
```

Follow logs:

```bash
feishu-codex-bridge service logs --follow
```

`health` is the quick live check: launchd state, recent WebSocket logs, installed runtime markers, and common noisy log signatures. If the bridge is connected but chat is silent, check open-platform scopes and event subscriptions first.

For passive stability observation, install the health monitor. It only records health output; it does not restart the bridge or kill Codex runs:

```bash
feishu-codex-bridge health-monitor install --interval 900
feishu-codex-bridge health-monitor status
feishu-codex-bridge health-monitor logs
```

**Codex CLI is missing or not logged in**

```bash
feishu-codex-bridge doctor
```

If needed, rerun foreground setup:

```bash
feishu-codex-bridge start
```

**Codex cannot find `lark-cli`**

```bash
feishu-codex-bridge doctor
```

For direct terminal usage:

```bash
export PATH="$HOME/.feishu-codex-bridge/lark-cli/node_modules/.bin:$PATH"
```

**`lark-cli` App ID differs from the bridge App ID**

Rerun foreground setup:

```bash
feishu-codex-bridge start
```

Accept the prompt to switch `lark-cli` back to the bridge app. Do not run `lark-cli config init --new`.

**Codex run hangs**

Send `/stop` in chat. For recurring hangs, set a global idle timeout in `/config`, or set one for the current session:

```text
/timeout 10
```

## License

[MIT](./LICENSE)
