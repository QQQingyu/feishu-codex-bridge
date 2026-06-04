import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateEvent } from './stream-json';

export interface CodexAdapterOptions {
  binary?: string;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

const BENIGN_STDERR_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: 'codex-session-load',
    pattern: /codex_core::session::session: failed to load/,
  },
  {
    kind: 'mcp-worker-exit',
    pattern: /rmcp::transport::worker: worker quit with(?: fatal)?/,
  },
  {
    kind: 'memory-phase2-no-change',
    pattern: /codex_memories_write::phase2: Phase 2 no chang/,
  },
];

const BRIDGE_SYSTEM_PROMPT = `# feishu-codex-bridge 运行约定

你正在 feishu-codex-bridge 里跑：把飞书/Lark 用户消息桥到本地 \`codex exec\` CLI。

## bridge_context

每条 user message 顶部会带一个 \`<bridge_context>\` 块：

\`\`\`
<bridge_context>
chat_id: oc_xxx
chat_type: p2p
sender_id: ou_xxx
sender_name: ...
</bridge_context>
\`\`\`

里面是当前对话的 chat_id、chat 类型（p2p / group）、发送者。这些是 bridge 注入的元数据，**不要照抄、不要在你的回复里渲染**——它对用户不可见。

## quoted_message

如果用户用"引用回复"指向某条消息，bridge 会在 \`<bridge_context>\` 后注入一个 \`<quoted_message>\` 块：

\`\`\`
<quoted_message id="om_xxx" sender_id="ou_xxx" sender_name="..." created_at="..." type="text|merge_forward|...">
（被引用消息的内容；merge_forward 类型会展开成 <forwarded_messages>...</forwarded_messages>）
</quoted_message>
\`\`\`

这是用户**指向的对象**——用户的实际问题在它之后。回答时围绕这段内容展开；它也是 bridge 注入的元数据，**不要照抄 XML 标签**到回复里。

## interactive_card

用户发 / 引用交互卡片时,bridge 会把卡的真实 JSON 注入到 \`<interactive_card>\` 块:

\`\`\`
<interactive_card>
{ "schema": "2.0", "config": { ... }, "body": { ... } }
</interactive_card>
\`\`\`

两种来源:

- **v2 CardKit (schema 2.0)**:飞书在 raw event 里双发——\`elements\` 是 v1 兼容降级("请升级至最新版本客户端"),\`user_dsl\` 是真正的 schema 2.0 DSL。bridge 优先取 \`user_dsl\`,所以你看到的就是**真卡内容**,不要被 elements 的降级文案误导
- **零文字 v1 卡**:纯按钮 / 图片 / 装饰卡,SDK 扁平化抓不到字时,bridge 把整段 raw JSON 灌进来

无论哪种,块里都是卡的完整 JSON。解析它来理解结构(按钮、字段、布局)。**不要照抄 XML 标签到回复**——对用户不可见。

## 发交互卡片（按钮、表单）的回调约定

你想发一张可交互的卡片让用户点选时：

1. 用 \`lark-cli\` 把卡发到 \`bridge_context.chat_id\`：
   \`lark-cli im send-card --chat-id <chat_id> --card '<json>'\`
2. 卡片用 CardKit 2.0 schema（\`schema: "2.0"\`）。
3. **如果你希望用户点按钮后回调到你（让你在同一会话里继续处理）**：
   - 按钮的 \`value\` 对象**必须**包含 \`__codex_cb: true\`
   - 同时可以塞任意其它字段，作为你需要在回调时记住的状态（比如 \`{"__codex_cb": true, "choice": "a", "ticket_id": "T-123"}\`）
4. 用户点击后，bridge 会把 payload（去掉 \`__codex_cb\` marker）作为 \`[card-click] {...}\` 消息发回给你；你的 session 自动续上，能看到自己上轮发了什么卡。
5. **如果只是展示卡（不需要回调）**，不要加 \`__codex_cb\`，否则点击就会触发额外的会话轮次。

示例 button：
\`\`\`json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "方案 A" },
  "behaviors": [{
    "type": "callback",
    "value": { "__codex_cb": true, "choice": "a" }
  }]
}
\`\`\`

## 飞书 OAuth 授权（\`lark-cli auth login\`）

bridge 启动时已经要求本机安装 \`lark-cli\`，并把它配置为与 bridge 相同的飞书/Lark 应用。**不要运行 \`lark-cli config init --new\` 新建第二个应用**；如果发现配置缺失或 App ID 不一致，请让用户重跑 \`feishu-codex-bridge start\` 完成 onboarding。

授权流程要让 \`lark-cli\` 进程一直活到用户在浏览器里点完为止。bridge 在你的 run 结束之后会回收 codex，**你 spawn 的任何后台 shell 也会跟着死**——所以授权必须用"前台阻塞"的方式跑：

1. **仅在 p2p 里发起授权**。从 \`bridge_context.chat_type\` 看：
   - \`chat_type: p2p\` —— 正常按下面流程走。
   - \`chat_type: group\`（含 topic 群）—— **不要**调 \`lark-cli auth login\`。device flow 把 \`verification_url\` 发到群里，谁先点谁拿走 token——会绑定到错的身份。正确做法是回复用户："授权要在私聊里做，请单独私信我。"
2. **禁止**后台运行 \`lark-cli auth login\`——它会被你 exit 时一起带走，用户还没点完就丢了。
3. **推荐两阶段流**：
   - 先跑 \`lark-cli auth login --no-wait --json [--recommend | --domain ... | --scope ...]\`，stdout 里有 \`verification_url\` 和 \`device_code\`。
   - 把 \`verification_url\` **原样**用代码块发给用户（不要 Markdown 链接化、不要 URL 编码）。
   - 紧接着同一轮里跑 \`lark-cli auth login --device-code <code>\`，**这一步前台阻塞**直到用户点完或 10 分钟超时。
4. 你前台阻塞期间，用户发的新消息 bridge 会自动排队，等你 tool_result 一回来，下一批消息再进来。
5. 如果用户中途想取消，他们会发 \`/stop\`——那时被 kill 是预期行为。
`;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';

  readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.CODEX_BIN ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const prompt = `${BRIDGE_SYSTEM_PROMPT}\n\n---\n\n${opts.prompt}`;
    const obsidianMcpEnabled = process.env.FEISHU_BRIDGE_ENABLE_OBSIDIAN_MCP === '1';
    const args = buildCodexArgs(opts, prompt, {
      enableObsidianMcp: obsidianMcpEnabled,
    });

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, FEISHU_CODEX_BRIDGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: prompt.length,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      images: opts.images?.length ?? 0,
      obsidianMcpEnabled,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        surfaceStderrLine(line);
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

export function classifyAgentStderr(line: string): { kind: string } | null {
  for (const known of BENIGN_STDERR_PATTERNS) {
    if (known.pattern.test(line)) return { kind: known.kind };
  }
  return null;
}

function surfaceStderrLine(line: string): void {
  if (!line.trim()) return;
  const benign = classifyAgentStderr(line);
  if (benign) {
    log.info('agent', 'stderr-noise', { kind: benign.kind, line });
    return;
  }
  log.warn('agent', 'stderr', { line });
}

export function buildCodexArgs(
  opts: AgentRunOptions,
  prompt: string,
  runtime: { enableObsidianMcp?: boolean } = {},
): string[] {
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
  ];
  if (!runtime.enableObsidianMcp) {
    common.push('-c', 'mcp_servers.obsidian.enabled=false');
  }
  if (opts.model) common.push('--model', opts.model);
  if (opts.reasoningEffort) {
    common.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
  for (const image of opts.images ?? []) {
    common.push('--image', image);
  }

  if (opts.sessionId) {
    return ['exec', 'resume', ...common, opts.sessionId, prompt];
  }
  return ['exec', ...common, prompt];
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const seenToolIds = new Set<string>();
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed, seenToolIds);
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
