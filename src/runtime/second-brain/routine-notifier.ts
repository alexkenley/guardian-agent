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
    const channels = [...new Set(outcome.channels)];
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
