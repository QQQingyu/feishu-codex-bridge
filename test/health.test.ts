import { describe, expect, it } from 'vitest';
import { evaluateHealth, formatHealthReport, resolveInstalledCliPath } from '../src/cli/commands/health';

describe('health evaluation', () => {
  const base = {
    service: {
      loaded: true,
      running: true,
      pid: 123,
      lastExitCode: 0,
    },
    distMarkers: {
      obsidianModeLogged: true,
      newChatAllowlisted: true,
    },
    recentLogLines: [
      '{"ts":"2026-06-04T11:02:47.211Z","phase":"chat","event":"mode-resolved","mode":"group"}',
      '{"ts":"2026-06-04T11:02:47.845Z","phase":"intake","event":"command"}',
      '{"ts":"2026-06-04T11:03:01.000Z","phase":"ws","event":"connected"}',
      '{"ts":"2026-06-04T11:03:02.000Z","phase":"agent","event":"spawn","obsidianMcpEnabled":false}',
    ],
  };

  it('returns ok when service, dist markers, websocket, and logs are healthy', () => {
    const result = evaluateHealth(base);

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ['launchd service', 'ok'],
      ['dist markers', 'ok'],
      ['websocket connection', 'ok'],
      ['agent spawn telemetry', 'ok'],
      ['recent log noise', 'ok'],
    ]);
  });

  it('reports failure when launchd service is not running', () => {
    const result = evaluateHealth({
      ...base,
      service: { loaded: true, running: false, pid: undefined, lastExitCode: 78 },
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: 'launchd service',
      status: 'fail',
    });
  });

  it('warns when recent logs contain optional Obsidian MCP worker noise', () => {
    const result = evaluateHealth({
      ...base,
      recentLogLines: [
        ...base.recentLogLines,
        'ERROR rmcp::transport::worker: worker quit with error',
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'recent log noise',
      status: 'warn',
    });
  });

  it('treats recent inbound events as websocket activity when the connected event rolled out of the log tail', () => {
    const result = evaluateHealth({
      ...base,
      recentLogLines: [
        '{"ts":"2026-06-04T12:13:03.935Z","phase":"intake","event":"enter"}',
        '{"ts":"2026-06-04T12:13:04.543Z","phase":"agent","event":"spawn","obsidianMcpEnabled":false}',
      ],
    });

    expect(result.checks.find((check) => check.name === 'websocket connection')).toMatchObject({
      status: 'ok',
    });
  });

  it('formats a compact report with a nonzero-ready summary', () => {
    const report = formatHealthReport(evaluateHealth(base));

    expect(report).toContain('health: ok');
    expect(report).toContain('✓ launchd service');
    expect(report).toContain('✓ recent log noise');
  });

  it('resolves npm bin wrapper entry to the bundled dist CLI', async () => {
    await expect(
      resolveInstalledCliPath('/tmp/feishu-codex-bridge/bin/feishu-codex-bridge.mjs'),
    ).resolves.toBe('/tmp/feishu-codex-bridge/dist/cli.js');
  });
});
