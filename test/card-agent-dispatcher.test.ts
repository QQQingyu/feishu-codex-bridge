import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/agent/types';
import { ActiveRuns } from '../src/bot/active-runs';
import { ChatModeCache } from '../src/bot/chat-mode-cache';
import { PendingQueue } from '../src/bot/pending-queue';
import { handleCardAction } from '../src/card/dispatcher';
import type { Controls } from '../src/commands';
import { DispatchManager } from '../src/dispatch/helper';
import { SessionStore } from '../src/session/store';
import { WorkspaceStore } from '../src/workspace/store';

describe('agent card action dispatcher', () => {
  it('routes agent assignment card clicks through the command dispatcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-card-agent-run-'));
    const projectsDir = join(root, 'projects');
    const fakeCodex = join(root, 'fake-codex');
    await writeFile(
      fakeCodex,
      [
        '#!/bin/sh',
        'while [ "$1" != "" ]; do',
        '  if [ "$1" = "--output-last-message" ]; then',
        '    shift',
        '    printf "worker clicked card result\\n" > "$1"',
        '  fi',
        '  shift || exit 0',
        'done',
        'mkdir -p outputs',
        'printf "worker clicked card result\\n" > outputs/T-001-result.md',
        'printf \'{"thread_id":"44444444-4444-4444-4444-444444444444"}\\n\'',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeCodex, 0o755);

    const manager = new DispatchManager({
      projectsDir,
      codexBin: fakeCodex,
      defaultCwd: root,
      timeoutMs: 30_000,
    });
    const project = await manager.createProject('card action run', '验证卡片点击执行');
    await manager.addTask(project.slug, '点击执行任务', '通过卡片按钮启动 worker');
    await manager.registerWorker(project.slug, 'east', 'oc_worker');
    await manager.assignTask(project.slug, 'T-001', 'east', 'oc_supervisor');

    const sent: Array<{ chatId: string; markdown?: string; card?: unknown }> = [];
    const channel = {
      getChatMode: async () => 'p2p',
      send: async (chatId: string, body: { markdown?: string; card?: unknown }) => {
        sent.push({ chatId, ...body });
      },
      rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [] } }) } } } },
    } as unknown as LarkChannel;
    const sessions = new SessionStore(join(root, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(root, 'workspaces.json'));
    workspaces.setCwd('oc_worker', root);

    const oldProjectsDir = process.env.FEISHU_BRIDGE_PROJECTS_DIR;
    process.env.FEISHU_BRIDGE_PROJECTS_DIR = projectsDir;
    try {
      await handleCardAction({
        channel,
        evt: {
          action: { value: { cmd: 'agent.run', arg: `T-001 ${project.slug}` } },
          operator: { openId: 'ou_admin', name: 'Admin' },
          chatId: 'oc_worker',
          messageId: 'om_assignment',
        } as unknown as CardActionEvent,
        sessions,
        workspaces,
        activeRuns: new ActiveRuns(),
        agent: { displayName: 'Codex', binary: fakeCodex } as AgentAdapter,
        controls: {
          cfg: {
            accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } },
            preferences: { access: { admins: ['ou_admin'] } },
          },
          configPath: join(root, 'config.json'),
          processId: 'test',
          restart: async () => undefined,
          exit: async () => undefined,
        } as Controls,
        pending: new PendingQueue(1, () => undefined),
        chatModeCache: new ChatModeCache(),
      });

      await waitFor(async () => {
        const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
        return board.tasks[0]?.status === 'reviewing';
      });
    } finally {
      if (oldProjectsDir === undefined) {
        delete process.env.FEISHU_BRIDGE_PROJECTS_DIR;
      } else {
        process.env.FEISHU_BRIDGE_PROJECTS_DIR = oldProjectsDir;
      }
    }

    const board = JSON.parse(await readFile(join(project.path, 'task_board.json'), 'utf8'));
    expect(board.tasks[0]).toMatchObject({
      id: 'T-001',
      status: 'reviewing',
      workerChatId: 'oc_worker',
      supervisorChatId: 'oc_supervisor',
    });
    await expect(readFile(join(project.path, 'outputs', 'T-001-result.md'), 'utf8')).resolves.toMatch(
      /worker clicked card result/,
    );
    expect(sent.some((item) => item.chatId === 'oc_worker' && item.markdown?.includes('已启动执行对话：T-001'))).toBe(
      true,
    );
    expect(sent.some((item) => item.chatId === 'oc_worker' && item.card)).toBe(true);
    expect(sent.some((item) => item.chatId === 'oc_supervisor' && item.card)).toBe(true);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
