import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCodexArgs, CodexAdapter } from '../src/agent/codex/adapter';
import type { AgentEvent } from '../src/agent/types';
import { log } from '../src/core/logger';

describe('codex adapter args', () => {
  it('passes reasoning effort as a Codex CLI config override', () => {
    expect(buildCodexArgs({ prompt: 'ignored', reasoningEffort: 'xhigh' }, 'hello')).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'mcp_servers.obsidian.enabled=false',
      '-c',
      'model_reasoning_effort="xhigh"',
      'hello',
    ]);
  });

  it('passes reasoning effort when resuming a Codex session', () => {
    expect(
      buildCodexArgs(
        { prompt: 'ignored', sessionId: 'session-1', reasoningEffort: 'high' },
        'hello',
      ),
    ).toEqual([
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'mcp_servers.obsidian.enabled=false',
      '-c',
      'model_reasoning_effort="high"',
      'session-1',
      'hello',
    ]);
  });

  it('disables optional Obsidian MCP by default so bridge runs are not blocked by local TLS state', () => {
    expect(buildCodexArgs({ prompt: 'ignored' }, 'hello')).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'mcp_servers.obsidian.enabled=false',
      'hello',
    ]);
  });

  it('allows explicitly enabling Obsidian MCP for bridge runs', () => {
    expect(
      buildCodexArgs({ prompt: 'ignored' }, 'hello', {
        enableObsidianMcp: true,
      }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'hello',
    ]);
  });

  it('downgrades known benign stderr noise but still warns on unknown stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-codex-adapter-stderr-'));
    const fakeCodex = join(root, 'fake-codex');
    const knownNoise =
      'ERROR codex_core::session::session: failed to load session metadata';
    const unknownStderr = 'real stderr that needs operator attention';
    await writeFile(
      fakeCodex,
      [
        '#!/bin/sh',
        `printf '%s\\n' '${knownNoise}' >&2`,
        `printf '%s\\n' '${unknownStderr}' >&2`,
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(fakeCodex, 0o755);

    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const run = new CodexAdapter({ binary: fakeCodex }).run({
        prompt: 'trigger stderr',
        cwd: root,
      });

      const events: AgentEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(events).toEqual([]);
      expect(infoSpy).toHaveBeenCalledWith(
        'agent',
        'spawn',
        expect.objectContaining({
          obsidianMcpEnabled: false,
        }),
      );
      expect(infoSpy).toHaveBeenCalledWith('agent', 'stderr-noise', {
        kind: 'codex-session-load',
        line: knownNoise,
      });
      expect(warnSpy).not.toHaveBeenCalledWith('agent', 'stderr', {
        line: knownNoise,
      });
      expect(warnSpy).toHaveBeenCalledWith('agent', 'stderr', {
        line: unknownStderr,
      });
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
