import { describe, expect, it, vi } from 'vitest';
import { createSecondBrainRoutineNotifier } from './routine-notifier.js';

describe('createSecondBrainRoutineNotifier', () => {
  it('delivers routine outcomes to the requested channels', async () => {
    const cliChannel = { send: vi.fn(async () => undefined) };
    const telegramChannel = {
      send: vi.fn(async () => undefined),
      getKnownChatIds: vi.fn(() => []),
    };
    const webChannel = { send: vi.fn(async () => undefined) };
    const notifier = createSecondBrainRoutineNotifier({
      configRef: {
        current: {
          assistant: {
            identity: { primaryUserId: 'owner' },
          },
          channels: {
            telegram: {
              allowedChatIds: [111, 222],
            },
          },
        } as any,
      },
      getCliChannel: () => cliChannel as any,
      getTelegramChannel: () => telegramChannel as any,
      getWebChannel: () => webChannel as any,
    });

    await notifier({
      routineId: 'morning-brief',
      channels: ['telegram', 'web', 'cli', 'web'],
      kind: 'brief',
      title: 'Morning Brief for April 8, 2026',
      summary: 'Your morning brief is ready.',
      importance: 'useful',
      followUpActions: ['open_brief', 'regenerate'],
      text: 'Your morning brief is ready.',
    });

    expect(telegramChannel.send).toHaveBeenCalledTimes(2);
    expect(telegramChannel.send).toHaveBeenNthCalledWith(1, '111', [
      'Morning Brief for April 8, 2026',
      'Your morning brief is ready.',
      'Next: Open Briefs to review it. Regenerate it from Briefs if the context changes.',
    ].join('\n\n'));
    expect(telegramChannel.send).toHaveBeenNthCalledWith(2, '222', [
      'Morning Brief for April 8, 2026',
      'Your morning brief is ready.',
      'Next: Open Briefs to review it. Regenerate it from Briefs if the context changes.',
    ].join('\n\n'));
    expect(webChannel.send).toHaveBeenCalledWith('owner', [
      'Morning Brief for April 8, 2026',
      'Your morning brief is ready.',
      'Next: Open Briefs to review it. Regenerate it from Briefs if the context changes.',
    ].join('\n\n'));
    expect(cliChannel.send).toHaveBeenCalledWith('owner', [
      'Morning Brief for April 8, 2026',
      'Your morning brief is ready.',
      'Next: Open Briefs to review it. Regenerate it from Briefs if the context changes.',
    ].join('\n\n'));
  });

  it('falls back to web when telegram is requested but unavailable', async () => {
    const cliChannel = { send: vi.fn(async () => undefined) };
    const webChannel = { send: vi.fn(async () => undefined) };
    const notifier = createSecondBrainRoutineNotifier({
      configRef: {
        current: {
          assistant: {
            identity: { primaryUserId: 'owner' },
          },
          channels: {
            telegram: {
              allowedChatIds: [],
            },
          },
        } as any,
      },
      getCliChannel: () => cliChannel as any,
      getTelegramChannel: () => null,
      getWebChannel: () => webChannel as any,
    });

    await notifier({
      routineId: 'topic-watch:harbor-launch',
      channels: ['telegram'],
      kind: 'brief',
      title: 'Topic Watch: Harbor launch',
      summary: 'Your topic watch found new matching context.',
      importance: 'useful',
      followUpActions: ['open_brief'],
      text: 'Your topic watch found new matching context.',
    });

    expect(webChannel.send).toHaveBeenCalledWith('owner', [
      'Topic Watch: Harbor launch',
      'Your topic watch found new matching context.',
      'Next: Open Briefs to review it.',
    ].join('\n\n'));
    expect(cliChannel.send).not.toHaveBeenCalled();
  });

  it('delivers telegram-only routine outcomes to known chats when no allowlist exists', async () => {
    const telegramChannel = {
      send: vi.fn(async () => undefined),
      getKnownChatIds: vi.fn(() => [444]),
    };
    const notifier = createSecondBrainRoutineNotifier({
      configRef: {
        current: {
          assistant: {
            identity: { primaryUserId: 'owner' },
          },
          channels: {
            telegram: {
              allowedChatIds: [],
            },
          },
        } as any,
      },
      getCliChannel: () => null,
      getTelegramChannel: () => telegramChannel as any,
      getWebChannel: () => null,
    });

    await notifier({
      routineId: 'morning-brief',
      channels: ['telegram'],
      kind: 'brief',
      title: 'Morning Brief',
      summary: 'Your morning brief is ready.',
      importance: 'useful',
      followUpActions: ['open_brief'],
      text: 'Your morning brief is ready.',
    });

    expect(telegramChannel.send).toHaveBeenCalledWith('444', [
      'Morning Brief',
      'Your morning brief is ready.',
      'Next: Open Briefs to review it.',
    ].join('\n\n'));
  });
});
