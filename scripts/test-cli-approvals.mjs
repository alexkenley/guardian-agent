import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CLIChannel } from '../src/channels/cli.ts';

function readOutput(stream) {
  return stream.read()?.toString() ?? '';
}

async function wait(ms = 50) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function send(input, text) {
  input.write(`${text}\n`);
  await wait();
}

async function runStandardApprovalFlow() {
  const input = new PassThrough();
  const output = new PassThrough();
  const decisions = [];
  const dispatches = [];

  const cli = new CLIChannel({
    input,
    output,
    defaultAgent: 'agent-1',
    dashboard: {
      onAgents: () => [{ id: 'agent-1', name: 'TestAgent', state: 'running', capabilities: [] }],
      onDispatch: async (agentId, msg) => {
        dispatches.push({ agentId, ...msg });
        if (msg.content.trim().toLowerCase() === 'y') {
          throw new Error('CLI approval prompt answer leaked into onDispatch');
        }
        if (dispatches.length === 1) {
          return {
            content: 'Action: fs_write — {"path":"S:/Development/test50.txt","content":"This is test50.txt","append":false}\nApproval ID: approval-write-1\nReply "yes" to approve or "no" to deny (expires in 30 minutes).\nOptional: /approve or /deny',
            metadata: {
              pendingApprovals: [
                {
                  id: 'approval-write-1',
                  toolName: 'fs_write',
                  argsPreview: '{"path":"S:/Development/test50.txt","content":"This is test50.txt","append":false}',
                },
              ],
            },
          };
        }
        if (dispatches.length === 2) {
          return {
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
          };
        }
        return {
          content: 'Done – `test50.txt` has been created in `S:\\Development`.',
        };
      },
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        return {
          success: true,
          message: approvalId === 'approval-path-1'
            ? "Tool 'update_tool_policy' completed."
            : "Tool 'fs_write' completed.",
        };
      },
    },
  });

  await cli.start(async () => ({ content: 'ok' }));
  await send(input, '/chat agent-1');
  readOutput(output);

  await send(input, 'Create a new test file called test50.txt in the s Drive Development Directory.');
  await send(input, 'y');
  await send(input, 'y');
  await wait(100);

  const text = readOutput(output);
  await cli.stop();

  assert.deepEqual(decisions, [
    { approvalId: 'approval-write-1', decision: 'approved' },
    { approvalId: 'approval-path-1', decision: 'approved' },
  ]);
  assert.match(text, /Waiting for approval to write S:\/Development\/test50\.txt\./);
  assert.match(text, /Waiting for approval to add S:\\Development to allowed paths\./);
  assert.match(text, /Done – `test50\.txt` has been created in `S:\\Development`\./);
  assert.ok(!text.includes('Approval ID:'));
  assert.ok(!text.includes('Reply "yes" to approve'));
  assert.ok(!text.includes("Tool 'fs_write' completed."));
  assert.ok(!text.includes("Tool 'update_tool_policy' completed."));
  assert.ok(!dispatches.some((dispatch) => dispatch.content.trim().toLowerCase() === 'y'));
}

async function runStaleApprovalRefreshFlow() {
  const input = new PassThrough();
  const output = new PassThrough();
  const decisions = [];

  const cli = new CLIChannel({
    input,
    output,
    defaultAgent: 'agent-1',
    dashboard: {
      onAgents: () => [{ id: 'agent-1', name: 'TestAgent', state: 'running', capabilities: [] }],
      onDispatch: async () => ({
        content: 'Done – `Test60.txt` has been created in `S:\\Development`.',
      }),
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        if (approvalId === 'stale-write-1') {
          return { success: false, message: "Approval 'stale-write-1' not found." };
        }
        return { success: true, message: "Tool 'fs_write' completed." };
      },
      onToolsPendingApprovals: () => [
        {
          id: 'fresh-write-1',
          toolName: 'fs_write',
          argsPreview: '{"path":"S:/Development/Test60.txt","content":"This is Test60.txt","append":false}',
        },
      ],
    },
  });

  await cli.start(async () => ({
    content: 'Waiting for approval to write S:/Development/Test60.txt.',
    metadata: {
      pendingApprovals: [
        {
          id: 'stale-write-1',
          toolName: 'fs_write',
          argsPreview: '{"path":"S:/Development/Test60.txt","content":"This is Test60.txt","append":false}',
        },
      ],
    },
  }));
  readOutput(output);

  await send(input, 'Create a test file called Test60 in the S Drive development directory.');
  await send(input, 'y');
  await send(input, 'y');
  await wait(100);

  const text = readOutput(output);
  await cli.stop();

  assert.deepEqual(decisions, [
    { approvalId: 'stale-write-1', decision: 'approved' },
    { approvalId: 'fresh-write-1', decision: 'approved' },
  ]);
  assert.match(text, /Waiting for approval to write S:\/Development\/Test60\.txt\./);
  assert.match(text, /Done – `Test60\.txt` has been created in `S:\\Development`\./);
  assert.ok(!text.includes("Approval 'stale-write-1' not found."));
}

async function runEmptyFileApprovalFlow() {
  const input = new PassThrough();
  const output = new PassThrough();
  const decisions = [];
  const dispatches = [];

  const cli = new CLIChannel({
    input,
    output,
    defaultAgent: 'agent-1',
    dashboard: {
      onAgents: () => [{ id: 'agent-1', name: 'TestAgent', state: 'running', capabilities: [] }],
      onDispatch: async (agentId, msg) => {
        dispatches.push({ agentId, ...msg });
        if (msg.content.trim().toLowerCase() === 'y') {
          throw new Error('CLI approval prompt answer leaked into onDispatch');
        }
        if (dispatches.length === 1) {
          return {
            content: 'Waiting for approval to add S:\\Development to allowed paths.',
            metadata: {
              pendingApprovals: [
                {
                  id: 'approval-path-empty-1',
                  toolName: 'update_tool_policy',
                  argsPreview: '{"action":"add_path","value":"S:\\\\Development"}',
                },
              ],
            },
          };
        }
        if (dispatches.length === 2) {
          return {
            content: 'Waiting for approval to write S:\\Development\\Test100.',
            metadata: {
              pendingApprovals: [
                {
                  id: 'approval-write-empty-1',
                  toolName: 'fs_write',
                  argsPreview: '{"path":"S:\\\\Development\\\\Test100","content":"","append":false}',
                },
              ],
            },
          };
        }
        if (dispatches.length === 3) {
          return {
            content: 'Done – `Test100` has been created as an empty file in `S:\\Development`.',
          };
        }
        return {
          content: 'It used update_tool_policy and fs_write.',
        };
      },
      onToolsApprovalDecision: async ({ approvalId, decision }) => {
        decisions.push({ approvalId, decision });
        return {
          success: true,
          message: approvalId === 'approval-path-empty-1'
            ? "Tool 'update_tool_policy' completed."
            : "Tool 'fs_write' completed.",
        };
      },
    },
  });

  await cli.start(async () => ({ content: 'ok' }));
  await send(input, '/chat agent-1');
  readOutput(output);

  await send(input, 'Add S Drive Development to the allowed directories and then create a file called Test100 there.');
  await send(input, 'y');
  await send(input, 'y');
  await send(input, 'What exact tool did you use?');
  await wait(100);

  const text = readOutput(output);
  await cli.stop();

  assert.deepEqual(decisions, [
    { approvalId: 'approval-path-empty-1', decision: 'approved' },
    { approvalId: 'approval-write-empty-1', decision: 'approved' },
  ]);
  assert.match(text, /Waiting for approval to add S:\\Development to allowed paths\./);
  assert.match(text, /Waiting for approval to write S:\\Development\\Test100\./);
  assert.match(text, /Done – `Test100` has been created as an empty file in `S:\\Development`\./);
  assert.match(text, /It used update_tool_policy and fs_write\./);
  assert.ok(!text.includes("Tool 'fs_write' completed."));
  assert.ok(!text.includes("Tool 'update_tool_policy' completed."));
  assert.ok(!dispatches.some((dispatch) => dispatch.content.trim().toLowerCase() === 'y'));
}

async function run() {
  await runStandardApprovalFlow();
  await runStaleApprovalRefreshFlow();
  await runEmptyFileApprovalFlow();
  console.log('PASS cli approval flow');
}

run().catch((err) => {
  console.error('FAIL cli approval flow');
  console.error(err);
  process.exit(1);
});
