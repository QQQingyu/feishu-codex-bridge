import { describe, expect, it } from 'vitest';
import { isCommandTextAllowedBeforeMention } from '../src/bot/group-command-gate';

describe('group command gate', () => {
  it('allows selected operational slash commands before mention', () => {
    expect(isCommandTextAllowedBeforeMention('/agent worker west demo')).toBe(true);
    expect(isCommandTextAllowedBeforeMention('/dispatch assign T-001 west demo')).toBe(true);
    expect(isCommandTextAllowedBeforeMention('/help')).toBe(true);
    expect(isCommandTextAllowedBeforeMention('/status')).toBe(true);
  });

  it('does not allow normal text or mention-prefixed command text', () => {
    expect(isCommandTextAllowedBeforeMention('普通群聊文本')).toBe(false);
    expect(isCommandTextAllowedBeforeMention('@Codex /agent status')).toBe(false);
  });
});
