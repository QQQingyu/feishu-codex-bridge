import type { LarkChannel, SendOptions, SendResult } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

export interface SafeCardStreamController {
  update(next: object | ((current: object) => object)): Promise<void>;
  readonly messageId: string;
  readonly current: object;
}

export interface SafeCardStreamSpec {
  initial: object;
  producer: (controller: SafeCardStreamController) => Promise<void>;
}

type CardChannel = Pick<LarkChannel, 'send' | 'updateCard'>;
const UPDATE_THROTTLE_MS = 120;

export async function streamCardSafely(
  channel: CardChannel,
  chatId: string,
  spec: SafeCardStreamSpec,
  opts?: SendOptions,
): Promise<SendResult> {
  const sent = await channel.send(chatId, { card: spec.initial }, opts);
  const messageId = sent.messageId;
  let current = spec.initial;
  let disabled = false;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const patchOnce = async (): Promise<void> => {
    if (disabled || !pending) return;
    pending = false;
    const snapshot = current;
    try {
      await channel.updateCard(messageId, snapshot);
    } catch (err) {
      disabled = true;
      pending = false;
      log.fail('stream', err, { step: 'card-update', messageId });
    }
  };

  const enqueuePatch = (): void => {
    inFlight = inFlight.then(patchOnce, patchOnce);
    void inFlight;
  };

  const schedulePatch = (): void => {
    if (disabled || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      enqueuePatch();
    }, UPDATE_THROTTLE_MS);
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    await inFlight;
    while (pending && !disabled) {
      await patchOnce();
    }
  };

  const controller: SafeCardStreamController = {
    get messageId() {
      return messageId;
    },
    get current() {
      return current;
    },
    async update(next) {
      if (disabled) return;
      current = typeof next === 'function' ? next(current) : next;
      pending = true;
      schedulePatch();
    },
  };

  try {
    await spec.producer(controller);
    await flush();
    return sent;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
