import type { GuardianAgentConfig } from '../../config/types.js';
import type { CLIChannel } from '../../channels/cli.js';
import type { TelegramChannel } from '../../channels/telegram.js';
import type { WebChannel } from '../../channels/web.js';
import type { HorizonRoutineOutcome } from './horizon-scanner.js';

async function sendTelegramIfConfigured(
  telegramChannel: Pick<TelegramChannel, 'send'> | null,
  chatIds: readonly number[],
  text: string,
): Promise<void> {
  if (!telegramChannel || chatIds.length === 0) {
    return;
  }
  for (const chatId of chatIds) {
    await telegramChannel.send(String(chatId), text);
  }
}

function describeFollowUpAction(action: NonNullable<HorizonRoutineOutcome['followUpActions']>[number]): string {
  switch (action) {
    case 'open_brief':
      return 'Open Briefs to review it.';
    case 'regenerate':
      return 'Regenerate it from Briefs if the context changes.';
    case 'run_now':
      return 'Run it again when you want a fresh pass.';
    case 'snooze':
      return 'Snooze it if you want to see it later.';
    case 'dismiss':
      return 'Dismiss it if no action is needed.';
  }
}

function formatOutcomeText(outcome: HorizonRoutineOutcome): string {
  const summary = outcome.summary?.trim() || outcome.text.trim();
  const title = outcome.title?.trim();
  const actions = [...new Set((outcome.followUpActions ?? []).map(describeFollowUpAction))];
  const sections = [
    title || null,
    summary || null,
    actions.length > 0 ? `Next: ${actions.join(' ')}` : null,
  ].filter((value): value is string => Boolean(value));
  return sections.join('\n\n').trim();
}

function resolveDeliveryChannels(
  requestedChannels: readonly HorizonRoutineOutcome['channels'][number][],
  args: {
    configRef: { current: GuardianAgentConfig };
    getCliChannel: () => Pick<CLIChannel, 'send'> | null;
    getTelegramChannel: () => Pick<TelegramChannel, 'send'> | null;
    getWebChannel: () => Pick<WebChannel, 'send'> | null;
  },
): Array<'web' | 'cli' | 'telegram'> {
  const requested = [...new Set(requestedChannels)];
  const resolved: Array<'web' | 'cli' | 'telegram'> = [];
  const hasTelegramTarget = (args.configRef.current.channels.telegram?.allowedChatIds ?? []).length > 0 && Boolean(args.getTelegramChannel());
  const hasWeb = Boolean(args.getWebChannel());
  const hasCli = Boolean(args.getCliChannel());

  for (const channel of requested) {
    if (channel === 'telegram') {
      if (hasTelegramTarget) {
        resolved.push('telegram');
        continue;
      }
      if (!requested.includes('web') && hasWeb) {
        resolved.push('web');
        continue;
      }
      if (!requested.includes('cli') && hasCli) {
        resolved.push('cli');
      }
      continue;
    }
    if (channel === 'web' && hasWeb) {
      resolved.push('web');
      continue;
    }
    if (channel === 'cli' && hasCli) {
      resolved.push('cli');
    }
  }

  return [...new Set(resolved)];
}

export function createSecondBrainRoutineNotifier(args: {
  configRef: { current: GuardianAgentConfig };
  getCliChannel: () => Pick<CLIChannel, 'send'> | null;
  getTelegramChannel: () => Pick<TelegramChannel, 'send'> | null;
  getWebChannel: () => Pick<WebChannel, 'send'> | null;
}): (outcome: HorizonRoutineOutcome) => Promise<void> {
  return async (outcome: HorizonRoutineOutcome): Promise<void> => {
    const text = formatOutcomeText(outcome);
    if (!text) {
      return;
    }
    const channels = resolveDeliveryChannels(outcome.channels, args);
    if (channels.length === 0) {
      return;
    }

    for (const channel of channels) {
      if (channel === 'telegram') {
        await sendTelegramIfConfigured(
          args.getTelegramChannel(),
          args.configRef.current.channels.telegram?.allowedChatIds ?? [],
          text,
        );
        continue;
      }
      if (channel === 'web') {
        const webChannel = args.getWebChannel();
        if (!webChannel) {
          continue;
        }
        await webChannel.send(args.configRef.current.assistant.identity.primaryUserId, text);
        continue;
      }
      if (channel === 'cli') {
        const cliChannel = args.getCliChannel();
        if (!cliChannel) {
          continue;
        }
        await cliChannel.send(args.configRef.current.assistant.identity.primaryUserId, text);
      }
    }
  };
}
