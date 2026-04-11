import type { TelegramChannel } from '../channels/telegram.js';

function normalizeChatIds(chatIds: readonly number[]): number[] {
  const normalized = new Set<number>();
  for (const chatId of chatIds) {
    if (Number.isSafeInteger(chatId)) {
      normalized.add(chatId);
    }
  }
  return [...normalized];
}

function normalizePreferredTelegramUserIds(userIds: readonly string[] | undefined): number[] {
  if (!userIds || userIds.length === 0) {
    return [];
  }
  const normalized = new Set<number>();
  for (const userId of userIds) {
    const trimmed = userId.trim();
    if (!trimmed) {
      continue;
    }
    const chatId = Number(trimmed);
    if (Number.isSafeInteger(chatId)) {
      normalized.add(chatId);
    }
  }
  return [...normalized];
}

export function resolveTelegramDeliveryChatIds(args: {
  configuredChatIds: readonly number[];
  preferredUserIds?: readonly string[];
  telegramChannel: Pick<TelegramChannel, 'getKnownChatIds'> | null;
}): number[] {
  const configuredChatIds = normalizeChatIds(args.configuredChatIds);
  const preferredChatIds = normalizePreferredTelegramUserIds(args.preferredUserIds);

  if (configuredChatIds.length > 0) {
    if (preferredChatIds.length > 0) {
      const matchingConfiguredChatIds = configuredChatIds.filter((chatId) => preferredChatIds.includes(chatId));
      if (matchingConfiguredChatIds.length > 0) {
        return matchingConfiguredChatIds;
      }
    }
    return configuredChatIds;
  }

  if (preferredChatIds.length > 0) {
    return preferredChatIds;
  }

  return normalizeChatIds(args.telegramChannel?.getKnownChatIds() ?? []);
}
