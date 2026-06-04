import { describe, expect, it } from 'vitest';
import { buildLaunchdPlist, collectLaunchdEnv } from '../src/cli/commands/service';

describe('launchd service plist', () => {
  it('carries allowlisted MCP environment variables into the service process', () => {
    const env = collectLaunchdEnv({
      PATH: '/usr/bin',
      OBSIDIAN_LOCAL_REST_API_KEY: 'obsidian-secret',
      FEISHU_BRIDGE_ENABLE_OBSIDIAN_MCP: '1',
      OPENAI_API_KEY: 'must-not-leak',
    });
    const plist = buildLaunchdPlist({
      nodePath: '/node',
      entryPath: '/bridge.mjs',
      workingDirectory: '/work',
      pathEnv: '/usr/bin',
      env,
    });

    expect(plist).toContain('<key>OBSIDIAN_LOCAL_REST_API_KEY</key>');
    expect(plist).toContain('<string>obsidian-secret</string>');
    expect(plist).toContain('<key>FEISHU_BRIDGE_ENABLE_OBSIDIAN_MCP</key>');
    expect(plist).toContain('<string>1</string>');
    expect(plist).not.toContain('OPENAI_API_KEY');
    expect(plist).not.toContain('must-not-leak');
  });
});
