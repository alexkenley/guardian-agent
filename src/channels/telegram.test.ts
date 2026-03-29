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

describe('Telegram approval flow', () => {
  function createFakeCtx() {
    const replies: Array<{ text: string; extra?: unknown }> = [];
    return {
      replies,
      ctx: {
        chat: { id: 1001 },
        from: { id: 2002 },
        reply: vi.fn(async (text: string, extra?: unknown) => {
          replies.push({ text, extra });
          return {} as unknown;
        }),
        replyWithChatAction: vi.fn(async () => ({} as unknown)),
      },
    };
  }

  function createFakeCallbackCtx(data = 'approve:approval-1', text = '⚠️ fs_write — {"path":"S:\\\\Development\\\\test.txt"}') {
    const edits: string[] = [];
    const replies: Array<{ text: string; extra?: unknown }> = [];
    return {
      edits,
      replies,
      ctx: {
        chat: { id: 1001 },
        from: { id: 2002 },
        callbackQuery: {
          data,
          message: { text },
        },
        answerCallbackQuery: vi.fn(async () => ({} as unknown)),
        editMessageText: vi.fn(async (nextText: string) => {
          edits.push(nextText);
          return {} as unknown;
        }),
        reply: vi.fn(async (text: string, extra?: unknown) => {
          replies.push({ text, extra });
          return {} as unknown;
        }),
      },
    };
  }

  it('auto-continues plain-text approvals through add-path then write-file without generic completion chatter', async () => {
    const decisions: Array<{ approvalId: string; decision: string }> = [];
    const dispatches: Array<{ agentId: string; content: string; userId?: string; channel?: string }> = [];
    const channel = new TelegramChannel({
      botToken: '123:abc',
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        return {
          success: true,
          message: approvalId === 'approval-path-1'
            ? "Tool 'update_tool_policy' completed."
            : "Tool 'fs_write' completed.",
        };
      },
      onDispatch: async (agentId, message) => {
        dispatches.push({ agentId, ...message });
        if (dispatches.length === 1) {
          return {
            content: 'Waiting for approval to write S:\\Development\\test26.txt.',
            metadata: {
              pendingApprovals: [
                {
                  id: 'approval-write-1',
                  toolName: 'fs_write',
                  argsPreview: '{"path":"S:\\\\Development\\\\test26.txt","content":"This is a test file.","append":false}',
                },
              ],
            },
          };
        }
        return {
          content: 'Done — created `S:\\Development\\test26.txt` with the specified contents.',
        };
      },
    });
    const { ctx, replies } = createFakeCtx();

    await (channel as unknown as {
      replyWithApprovalSupport: (ctx: unknown, response: { content: string; metadata?: Record<string, unknown> }, agentId?: string) => Promise<void>;
      handlePendingApprovalInput: (ctx: unknown, text: string, approvalKey: string, userId: string) => Promise<void>;
    }).replyWithApprovalSupport(ctx, {
      content: 'Waiting for approval to add S:\\Development to allowed paths.',
      metadata: {
        pendingApprovals: [
          {
            id: 'approval-path-1',
            toolName: 'update_tool_policy',
            argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
          },
        ],
      },
    }, 'default');

    await (channel as unknown as {
      handlePendingApprovalInput: (ctx: unknown, text: string, approvalKey: string, userId: string) => Promise<void>;
    }).handlePendingApprovalInput(ctx, 'approved', '1001:2002', '2002');

    await (channel as unknown as {
      handlePendingApprovalInput: (ctx: unknown, text: string, approvalKey: string, userId: string) => Promise<void>;
    }).handlePendingApprovalInput(ctx, 'yes approved', '1001:2002', '2002');

    expect(decisions).toEqual([
      { approvalId: 'approval-path-1', decision: 'approved' },
      { approvalId: 'approval-write-1', decision: 'approved' },
    ]);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]?.content).toContain('[User approved the pending tool action(s). Result: update_tool_policy: Approved and executed]');
    expect(dispatches[0]?.content).toContain('Please continue with the current request only. Do not resume older unrelated pending tasks.');
    expect(dispatches[1]?.content).toContain('[User approved the pending tool action(s). Result: fs_write: Approved and executed]');
    expect(dispatches[1]?.content).toContain('Please continue with the current request only. Do not resume older unrelated pending tasks.');

    const output = replies.map((reply) => reply.text).join('\n');
    expect(output).toContain('Waiting for approval to add S:\\Development to allowed paths.');
    expect(output).toContain('Waiting for approval to write S:\\Development\\test26.txt.');
    expect(output).toContain('Done — created `S:\\Development\\test26.txt` with the specified contents.');
    expect(output).not.toContain("Tool 'fs_write' completed.");
    expect(output).not.toContain("Tool 'update_tool_policy' completed.");
    expect(output).not.toContain('I need your approval before proceeding.');
    expect(output).not.toContain('tool is unavailable');
  });

  it('replaces model approval preamble with structured Telegram approval copy', async () => {
    const channel = new TelegramChannel({
      botToken: '123:abc',
      onToolsApprovalDecision: async () => ({ success: true, message: 'Approved and executed' }),
    });
    const { ctx, replies } = createFakeCtx();

    await (channel as unknown as {
      replyWithApprovalSupport: (ctx: unknown, response: { content: string; metadata?: Record<string, unknown> }, agentId?: string) => Promise<void>;
    }).replyWithApprovalSupport(ctx, {
      content: "Let's add `S:\\Development` to the allowed paths, then I'll create the file **test32.txt** there. Please approve this action.",
      metadata: {
        pendingApprovals: [
          {
            id: 'approval-path-1',
            toolName: 'update_tool_policy',
            argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
          },
        ],
      },
    }, 'default');

    expect(replies[0]?.text).toBe('Waiting for approval to add S:\\Development to allowed paths.');
    expect(replies.map((reply) => reply.text).join('\n')).not.toContain('Please approve this action.');
  });

  it('acknowledges inline approval buttons immediately before slow continuation finishes', async () => {
    let resolveApproval!: (value: { success: boolean; message: string }) => void;
    const approvalGate = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveApproval = resolve;
    });
    const channel = new TelegramChannel({
      botToken: '123:abc',
      onToolsApprovalDecision: async () => approvalGate,
      onDispatch: async () => ({
        content: 'Done — wrote the requested file.',
      }),
    });
    const { ctx, edits } = createFakeCallbackCtx('approve:approval-write-1');
    (
      channel as unknown as {
        pendingApprovalsByChat: Map<string, { approvals: Array<{ id: string; toolName: string; argsPreview: string }>; agentId: string }>;
      }
    ).pendingApprovalsByChat.set('1001:2002', {
      approvals: [
        {
          id: 'approval-write-1',
          toolName: 'fs_write',
          argsPreview: '{"path":"S:\\\\Development\\\\test.txt","content":"ok"}',
        },
      ],
      agentId: 'default',
    });

    const pending = (channel as unknown as {
      handleInlineApprovalCallback: (ctx: unknown) => Promise<void>;
    }).handleInlineApprovalCallback(ctx);
    await Promise.resolve();
    await Promise.resolve();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '⏳ Approval received. Continuing...' });
    expect(edits[0]).toContain('⏳ Approval received. Continuing...');

    resolveApproval({ success: true, message: "Tool 'fs_write' completed." });
    await pending;

    expect(edits.at(-1)).toContain('✅ fs_write: Approved and executed');
    expect(ctx.reply).toHaveBeenCalledWith('Done — wrote the requested file.');
  });

  it('uses continued approval responses directly instead of dispatching a second continuation', async () => {
    const onDispatch = vi.fn();
    const channel = new TelegramChannel({
      botToken: '123:abc',
      onToolsApprovalDecision: async () => ({
        success: true,
        message: "Tool 'coding_backend_run' completed.",
        continuedResponse: {
          content: 'OpenAI Codex CLI completed.\n\nHello! I am working.',
        },
      }),
      onDispatch,
    });
    const { ctx, edits, replies } = createFakeCallbackCtx('approve:approval-codex-1');
    (
      channel as unknown as {
        pendingApprovalsByChat: Map<string, { approvals: Array<{ id: string; toolName: string; argsPreview: string }>; agentId: string }>;
      }
    ).pendingApprovalsByChat.set('1001:2002', {
      approvals: [
        {
          id: 'approval-codex-1',
          toolName: 'coding_backend_run',
          argsPreview: '{"backend":"codex"}',
        },
      ],
      agentId: 'default',
    });

    await (channel as unknown as {
      handleInlineApprovalCallback: (ctx: unknown) => Promise<void>;
    }).handleInlineApprovalCallback(ctx);

    expect(edits.at(-1)).toContain('✅ coding_backend_run: Approved and executed');
    expect(replies.map((reply) => reply.text).join('\n')).toContain('OpenAI Codex CLI completed.');
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('prefixes source labels on normal Telegram replies', async () => {
    const channel = new TelegramChannel({ botToken: '123:abc' });
    const { ctx, replies } = createFakeCtx();

    await (channel as unknown as {
      replyWithApprovalSupport: (ctx: unknown, response: { content: string; metadata?: Record<string, unknown> }, agentId?: string) => Promise<void>;
    }).replyWithApprovalSupport(ctx, {
      content: 'Workflow created successfully.',
      metadata: {
        responseSource: {
          locality: 'external',
          usedFallback: true,
        },
      },
    }, 'default');

    expect(replies[0]?.text).toBe('[external · fallback] Workflow created successfully.');
  });
});
