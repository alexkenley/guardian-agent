import { describe, expect, it } from 'vitest';
import { resolveTelegramDeliveryChatIds } from './telegram-delivery.js';

describe('resolveTelegramDeliveryChatIds', () => {
  it('prefers configured chat ids when no preferred user id is provided', () => {
    expect(resolveTelegramDeliveryChatIds({
      configuredChatIds: [111, 222],
      telegramChannel: {
        getKnownChatIds: () => [333],
      } as any,
    })).toEqual([111, 222]);
  });

  it('prefers matching configured chat ids when a preferred telegram user id is present', () => {
    expect(resolveTelegramDeliveryChatIds({
      configuredChatIds: [111, 222],
      preferredUserIds: ['222'],
      telegramChannel: {
        getKnownChatIds: () => [333],
      } as any,
    })).toEqual([222]);
  });

  it('falls back to known telegram chats when no allowlist exists', () => {
    expect(resolveTelegramDeliveryChatIds({
      configuredChatIds: [],
      telegramChannel: {
        getKnownChatIds: () => [333, 444],
      } as any,
    })).toEqual([333, 444]);
  });

  it('uses a preferred numeric telegram user id when no allowlist exists', () => {
    expect(resolveTelegramDeliveryChatIds({
      configuredChatIds: [],
      preferredUserIds: ['555'],
      telegramChannel: {
        getKnownChatIds: () => [333],
      } as any,
    })).toEqual([555]);
  });
});
