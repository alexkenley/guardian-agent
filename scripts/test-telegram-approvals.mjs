import assert from 'node:assert/strict';
import { TelegramChannel } from '../src/channels/telegram.ts';

function createFakeCtx() {
  const replies = [];
  return {
    replies,
    ctx: {
      chat: { id: 1001 },
      from: { id: 2002 },
      async reply(text, extra) {
        replies.push({ text, extra });
        return {};
      },
      async replyWithChatAction() {
        return {};
      },
    },
  };
}

async function run() {
  const decisions = [];
  const dispatches = [];
  const channel = new TelegramChannel({
    botToken: '123:abc',
    async onToolsApprovalDecision({ approvalId, decision }) {
      decisions.push({ approvalId, decision });
      return {
        success: true,
        message: approvalId === 'approval-path-1'
          ? "Tool 'update_tool_policy' completed."
          : "Tool 'fs_write' completed.",
      };
    },
    async onDispatch(agentId, message) {
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

  await channel.replyWithApprovalSupport(ctx, {
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

  await channel.handlePendingApprovalInput(ctx, 'approved', '1001:2002', '2002');
  await channel.handlePendingApprovalInput(ctx, 'yes approved', '1001:2002', '2002');

  const output = replies.map((reply) => reply.text).join('\n');

  assert.deepEqual(decisions, [
    { approvalId: 'approval-path-1', decision: 'approved' },
    { approvalId: 'approval-write-1', decision: 'approved' },
  ]);
  assert.equal(dispatches.length, 2);
  assert.match(dispatches[0].content, /\[User approved the pending tool action\(s\)\. Result: update_tool_policy: Approved and executed\]/);
  assert.match(dispatches[0].content, /Please continue with the current request only\. Do not resume older unrelated pending tasks\./);
  assert.match(dispatches[1].content, /\[User approved the pending tool action\(s\)\. Result: fs_write: Approved and executed\]/);
  assert.match(dispatches[1].content, /Please continue with the current request only\. Do not resume older unrelated pending tasks\./);
  assert.match(output, /Waiting for approval to add S:\\Development to allowed paths\./);
  assert.match(output, /Waiting for approval to write S:\\Development\\test26\.txt\./);
  assert.match(output, /Done — created `S:\\Development\\test26\.txt` with the specified contents\./);
  assert.ok(!output.includes("Tool 'fs_write' completed."));
  assert.ok(!output.includes("Tool 'update_tool_policy' completed."));
  assert.ok(!output.includes('I need your approval before proceeding.'));
  assert.ok(!output.toLowerCase().includes('tool is unavailable'));

  console.log('PASS telegram approval flow');
}

run().catch((err) => {
  console.error('FAIL telegram approval flow');
  console.error(err);
  process.exit(1);
});
