import { describe, expect, it } from 'vitest';
import { parseCommandLine } from '../src/commands';

describe('command args parser', () => {
  it('preserves multiline command arguments', () => {
    expect(parseCommandLine('/agent add 真实执行写回\n任务说明正文')).toEqual({
      cmd: '/agent',
      args: 'add 真实执行写回\n任务说明正文',
    });
  });

  it('keeps normal single-line command arguments unchanged', () => {
    expect(parseCommandLine('/agent assign T-001 west demo')).toEqual({
      cmd: '/agent',
      args: 'assign T-001 west demo',
    });
  });
});
