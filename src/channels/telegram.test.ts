import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel, splitTelegramMessage } from './telegram.js';

describe('splitTelegramMessage', () => {
  it('returns a single chunk when under limit', () => {
    const text = 'hello world';
    expect(splitTelegramMessage(text, 4096)).toEqual([text]);
  });

  it('splits long text into chunks under the limit', () => {
    const text = 'a'.repeat(9000);
    const chunks = splitTelegramMessage(text, 4096);
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers newline boundaries when possible', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 80 }, () => line).join('\n');
    const chunks = splitTelegramMessage(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('\n'))).toBe(true);
    expect(chunks[0].startsWith(line)).toBe(true);
  });
});

describe('TelegramChannel.send', () => {
  it('sends long outbound messages in chunks', async () => {
    const channel = new TelegramChannel({ botToken: '123:abc' });
    const sendMessage = vi.spyOn((channel as unknown as { bot: { api: { sendMessage: (chatId: number, text: string) => Promise<unknown> } } }).bot.api, 'sendMessage')
      .mockResolvedValue({} as unknown);

    await channel.send('12345', 'z'.repeat(9000));

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const sentChunks = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(sentChunks.every((chunk) => chunk.length <= 4096)).toBe(true);
  });
});

describe('TelegramChannel help text', () => {
  it('lists approval commands', () => {
    const channel = new TelegramChannel({ botToken: '123:abc' });
    const helpText = (channel as unknown as { buildHelpText: () => string }).buildHelpText();
    expect(helpText).toContain('/approve [approvalId ...]');
    expect(helpText).toContain('/deny [approvalId ...]');
  });
});
