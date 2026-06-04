import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { tryHandleCommand, type CommandContext } from '../src/commands';
import type { AppConfig } from '../src/config/schema';

describe('/new chat access control', () => {
  it('adds a newly created chat to the chat allowlist when one is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-new-chat-access-'));
    const configPath = join(root, 'config.json');
    const cfg: AppConfig = {
      accounts: {
        app: {
          id: 'cli_test',
          secret: 'test-secret',
          tenant: 'feishu',
        },
      },
      preferences: {
        access: {
          allowedUsers: ['ou_user'],
          allowedChats: ['oc_dm'],
          admins: ['ou_user'],
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const sent: Array<{ chatId: string; payload: unknown; opts?: unknown }> = [];
    const ctx = {
      channel: {
        rawClient: {
          im: {
            v1: {
              chat: {
                create: async () => ({
                  data: { chat_id: 'oc_new_group' },
                }),
              },
            },
          },
        },
        send: async (chatId: string, payload: unknown, opts?: unknown) => {
          sent.push({ chatId, payload, opts });
        },
      },
      msg: {
        chatId: 'oc_dm',
        chatType: 'p2p',
        content: '/new chat E2E group',
        messageId: 'om_command',
        senderId: 'ou_user',
        resources: [],
      },
      scope: 'oc_dm',
      chatMode: 'p2p',
      workspaces: {
        cwdFor: () => '/work',
        setCwd: () => {},
      },
      controls: {
        cfg,
        configPath,
        processId: 'test',
        restart: async () => {},
        exit: async () => {},
      },
      sessions: {},
      activeRuns: {},
      agent: {},
    } as unknown as CommandContext;

    await expect(tryHandleCommand(ctx)).resolves.toBe(true);

    expect(cfg.preferences?.access?.allowedChats).toEqual(['oc_dm', 'oc_new_group']);
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as AppConfig;
    expect(saved.preferences?.access?.allowedChats).toEqual(['oc_dm', 'oc_new_group']);
    expect(sent.map((m) => m.chatId)).toEqual(['oc_new_group', 'oc_dm']);
  });
});
