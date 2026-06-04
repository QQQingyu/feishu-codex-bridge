import { describe, expect, it, vi } from 'vitest';
import { streamCardSafely } from '../src/card/safe-stream';
import { log } from '../src/core/logger';

vi.mock('../src/core/logger', () => ({
  log: {
    fail: vi.fn(),
  },
}));

describe('safe card streaming', () => {
  it('suppresses card update failures and stops future patches', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const channel = {
      send: vi.fn(async () => ({ messageId: 'om_stream' })),
      updateCard: vi.fn(async () => {
        throw new Error('The message was withdrawn.');
      }),
    };

    try {
      const result = await streamCardSafely(channel, 'oc_test', {
        initial: { schema: '2.0', body: { elements: [] } },
        producer: async (ctrl) => {
          expect(ctrl.messageId).toBe('om_stream');
          await ctrl.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'first' }] } });
          await ctrl.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'second' }] } });
        },
      });

      await Promise.resolve();
      expect(result).toEqual({ messageId: 'om_stream' });
      expect(channel.send).toHaveBeenCalledWith(
        'oc_test',
        { card: { schema: '2.0', body: { elements: [] } } },
        undefined,
      );
      expect(channel.updateCard).toHaveBeenCalledTimes(1);
      expect(channel.updateCard).toHaveBeenCalledWith('om_stream', {
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: 'second' }] },
      });
      expect(log.fail).toHaveBeenCalledWith('stream', expect.any(Error), {
        step: 'card-update',
        messageId: 'om_stream',
      });
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('updates current card state after successful patches', async () => {
    const channel = {
      send: vi.fn(async () => ({ messageId: 'om_stream' })),
      updateCard: vi.fn(async () => undefined),
    };

    await streamCardSafely(channel, 'oc_test', {
      initial: { count: 0 },
      producer: async (ctrl) => {
        await ctrl.update((current) => ({ count: Number((current as { count: number }).count) + 1 }));
        expect(ctrl.current).toEqual({ count: 1 });
        expect(channel.updateCard).not.toHaveBeenCalled();
      },
    });

    expect(channel.updateCard).toHaveBeenCalledWith('om_stream', { count: 1 });
  });
});
