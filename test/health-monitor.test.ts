import { describe, expect, it } from 'vitest';
import {
  buildHealthMonitorPlist,
  normalizeHealthMonitorInterval,
} from '../src/cli/commands/health-monitor';

describe('health monitor launchd plist', () => {
  it('runs the bridge health monitor command on a fixed interval', () => {
    const plist = buildHealthMonitorPlist({
      nodePath: '/node',
      entryPath: '/bridge/bin/feishu-codex-bridge.mjs',
      workingDirectory: '/work',
      pathEnv: '/usr/bin',
      intervalSeconds: 900,
    });

    expect(plist).toContain('<string>com.feishu-codex-bridge.health</string>');
    expect(plist).toContain('<string>/node</string>');
    expect(plist).toContain('<string>/bridge/bin/feishu-codex-bridge.mjs</string>');
    expect(plist).toContain('<string>health-monitor</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>900</integer>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <false/>');
  });

  it('clamps interval to avoid accidental high-frequency polling', () => {
    expect(normalizeHealthMonitorInterval(undefined)).toBe(900);
    expect(normalizeHealthMonitorInterval('5')).toBe(60);
    expect(normalizeHealthMonitorInterval('900')).toBe(900);
    expect(normalizeHealthMonitorInterval('999999')).toBe(86_400);
    expect(normalizeHealthMonitorInterval('bad')).toBe(900);
  });
});
