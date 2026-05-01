import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Minimal mock environment to test the business logic of our fixes
// We could run the full harness, but unit-style validation of the logic is faster and more deterministic for these edge cases.

if (process.env.GUARDIAN_REMEDIATION_STRESS_TSX !== '1') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: { ...process.env, GUARDIAN_REMEDIATION_STRESS_TSX: '1' },
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

async function runTests() {
  console.log('Running Stress Test Remediation Verification...');

  const { ToolExecutor } = await import('../src/tools/executor.ts');

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
    success: true,
    status: 'succeeded',
    output: {
      root: process.cwd(),
      query: 'match',
      mode: 'content',
      matches: Array.from({ length: 40 }, (_, i) => ({
        relativePath: `file_${i}.ts`,
        matchType: 'content',
        snippet: `match ${i}`,
      })),
    },
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
