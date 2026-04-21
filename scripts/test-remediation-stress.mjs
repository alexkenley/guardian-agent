import assert from 'node:assert';
import { randomUUID } from 'node:crypto';

// Minimal mock environment to test the business logic of our fixes
// We could run the full harness, but unit-style validation of the logic is faster and more deterministic for these edge cases.

import { ToolExecutor } from '../src/tools/executor.js';
import { registerBuiltinFilesystemTools } from '../src/tools/builtin/filesystem-tools.ts';

async function runTests() {
  console.log('Running Stress Test Remediation Verification...');

  const executor = new ToolExecutor({
    workspaceRoot: process.cwd(),
    enabled: true,
    policyMode: 'autonomous', // Test if our hard invariants work even in autonomous mode
    allowedPaths: [process.cwd()],
    allowedCommands: ['rm -rf'],
    onPreExecute: async () => ({ allowed: true }), // Mock Guardian Agent LLM allowing everything
  });

  // 1. Verify Critical Path Protection (.git)
  console.log('Test 1: fs_delete .git (Critical Path)');
  const deleteGit = await executor.runTool({
    toolName: 'fs_delete',
    args: { path: '.git', recursive: true },
    origin: 'assistant',
    userId: 'test-user',
    requestId: randomUUID(),
  });
  assert.strictEqual(deleteGit.success, false);
  assert.match(deleteGit.message || '', /blocked: path '.git' is a critical repository metadata directory/);
  console.log('  PASS: .git deletion blocked.');

  // 2. Verify High-Volume Action Gating
  console.log('Test 2: High-volume fs_delete (Recursive)');
  // Even if not a critical path, recursive delete should hit approval in autonomous mode now
  const deleteLarge = await executor.runTool({
    toolName: 'fs_delete',
    args: { path: 'some_folder', recursive: true },
    origin: 'assistant',
    userId: 'test-user',
    requestId: randomUUID(),
  });
  assert.strictEqual(deleteLarge.status, 'pending_approval');
  console.log('  PASS: Recursive delete forced to approval.');

  // 3. Verify Result Truncation (Search)
  console.log('Test 3: Result Truncation (Increased Limits)');
  // We'll mock a search result with many matches and check if it's truncated
  // This requires importing formatToolResultForLLM from chat-agent-helpers
  const { formatToolResultForLLM } = await import('../src/chat-agent-helpers.ts');
  
  const largeSearchResult = {
    path: '.',
    matches: Array.from({ length: 40 }, (_, i) => ({
      path: `file_${i}.ts`,
      line: i + 1,
      content: `match ${i}`,
    })),
  };

  const formatted = formatToolResultForLLM('fs_search', largeSearchResult);
  assert.ok(!formatted.includes('items omitted'), 'Search results should not be truncated at 10 items anymore');
  assert.ok(formatted.includes('file_39.ts'), 'Should contain the 40th match');
  console.log('  PASS: Truncation limits increased.');

  console.log('\nAll stress test remediations VERIFIED.');
}

runTests().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
