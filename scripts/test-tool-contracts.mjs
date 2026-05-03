import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function toYamlPath(value) {
  return value.replace(/\\/g, '/').replace(/"/g, '\\"');
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate a free port.');
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function startFakeProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'tool-contract-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'tool-contract-harness-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Tool contract harness provider response.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start fake provider.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function requestJson(baseUrl, token, method, pathname, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`${method} ${pathname} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await requestJson(baseUrl, 'unused', 'GET', '/health', undefined, 2_000);
      if (result?.status === 'ok') return;
    } catch {
      // Retry until the web channel is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('GuardianAgent did not become healthy within 40 seconds.');
}

function expectSuccess(result, name) {
  assert.equal(result?.success, true, `${name} should succeed: ${JSON.stringify(result).slice(0, 500)}`);
  assert.ok(result?.jobId, `${name} should include jobId`);
  console.log(`PASS ${name}`);
  return result;
}

function expectFailure(result, name, pattern) {
  assert.equal(result?.success, false, `${name} should fail closed`);
  const message = `${result?.error ?? ''} ${result?.message ?? ''}`;
  if (pattern) {
    assert.match(message, pattern, `${name} failure should match ${pattern}: ${message}`);
  }
  assert.ok(result?.jobId, `${name} should include jobId`);
  console.log(`PASS ${name}`);
  return result;
}

async function approvePendingTool(baseUrl, token, result, scope) {
  assert.ok(result?.approvalId, `${scope.caseName} should include approvalId when pending`);
  const decision = await requestJson(baseUrl, token, 'POST', '/api/tools/approvals/decision', {
    approvalId: result.approvalId,
    decision: 'approved',
    userId: scope.userId,
    channel: 'web',
    surfaceId: scope.surfaceId,
    reason: 'deterministic tool-contract harness approval',
  });
  assert.equal(decision?.success, true, `${scope.caseName} approval decision should be accepted: ${JSON.stringify(decision).slice(0, 500)}`);
  assert.equal(decision?.approved, true, `${scope.caseName} approval decision should be approved`);
  return decision.result ?? {
    success: decision.executionSucceeded === true,
    status: decision.job?.status,
    jobId: decision.job?.id ?? result.jobId,
    message: decision.message,
    error: decision.executionSucceeded === false ? decision.message : undefined,
    output: decision.job?.result,
  };
}

async function runHarness() {
  const port = await getFreePort();
  const token = `tool-contract-harness-${Date.now()}`;
  const runId = `tool-contract-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-tool-contracts-'));
  const scratchRoot = path.join(tempRoot, 'scratch');
  const configPath = path.join(tempRoot, 'config.yaml');
  const logPath = path.join(tempRoot, 'guardian.log');
  const provider = await startFakeProvider();
  fs.mkdirSync(scratchRoot, { recursive: true });

  const config = `
llm:
  local:
    provider: ollama
    baseUrl: ${provider.baseUrl}
    model: tool-contract-harness-model
defaultProvider: local
channels:
  cli:
    enabled: false
  web:
    enabled: true
    host: 127.0.0.1
    port: ${port}
    authToken: "${token}"
assistant:
  identity:
    mode: single_user
    primaryUserId: harness
  setup:
    completed: true
  tools:
    enabled: true
    policyMode: autonomous
    toolPolicies:
      fs_mkdir: auto
      fs_write: auto
      fs_copy: auto
      fs_move: auto
      fs_delete: auto
      doc_create: auto
      shell_safe: auto
    allowedPaths:
      - "${toYamlPath(scratchRoot)}"
      - "${toYamlPath(projectRoot)}"
    allowedCommands:
      - echo
      - node
    allowedDomains:
      - example.com
    sandbox:
      degradedFallback:
        allowNetworkTools: true
runtime:
  agentIsolation:
    enabled: false
guardian:
  enabled: true
`;
  fs.writeFileSync(configPath, config, 'utf8');

  let appProcess;
  let logStream;
  try {
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    appProcess.stdout.pipe(logStream);
    appProcess.stderr.pipe(logStream);

    await waitForHealth(baseUrl);

    let callCounter = 0;
    const runTool = async (toolName, args = {}, options = {}) => {
      callCounter += 1;
      const surfaceId = `${runId}-${callCounter}-${toolName}`;
      const userId = `harness-${runId}`;
      const caseName = options.caseName ?? toolName;
      const initial = await requestJson(baseUrl, token, 'POST', '/api/tools/run', {
        toolName,
        args,
        origin: 'web',
        channel: 'web',
        userId,
        surfaceId,
        metadata: {
          harness: {
            name: 'test-tool-contracts',
            runId,
            caseName,
          },
        },
      });
      if (initial?.status === 'pending_approval' && initial?.approvalId) {
        return approvePendingTool(baseUrl, token, initial, { userId, surfaceId, caseName });
      }
      return initial;
    };

    const state = await requestJson(baseUrl, token, 'GET', '/api/tools?limit=5');
    const definitions = Array.isArray(state.tools) ? state.tools : [];
    for (const toolName of ['fs_list', 'fs_write', 'fs_read', 'fs_search', 'fs_copy', 'fs_move', 'fs_delete', 'shell_safe', 'sys_info']) {
      assert.ok(definitions.some((definition) => definition.name === toolName), `${toolName} should be registered`);
    }
    console.log('PASS tool registry includes deterministic contract targets');

    const preflight = await requestJson(baseUrl, token, 'POST', '/api/tools/preflight', {
      requests: [
        { name: 'fs_write', args: { path: path.join(scratchRoot, 'alpha.txt'), content: 'alpha' } },
        { name: 'shell_safe', args: { command: 'echo contract-shell' } },
      ],
    });
    assert.ok(Array.isArray(preflight?.results), 'preflight should return results');
    assert.ok(preflight.results.every((result) => result.found === true), 'preflight should find requested tools');
    console.log('PASS tool preflight finds requested tools');

    const nestedDir = path.join(scratchRoot, 'nested');
    const alphaPath = path.join(nestedDir, 'alpha.txt');
    const betaPath = path.join(nestedDir, 'beta.txt');
    const gammaPath = path.join(nestedDir, 'gamma.txt');
    const reportPath = path.join(nestedDir, 'report.md');

    expectSuccess(await runTool('fs_mkdir', { path: nestedDir }), 'fs_mkdir creates scratch directory');
    expectSuccess(await runTool('fs_write', { path: alphaPath, content: 'alpha contract content\nneedle-line\n' }), 'fs_write writes text file');

    const readAlpha = expectSuccess(await runTool('fs_read', { path: alphaPath, maxBytes: 4000 }), 'fs_read reads written file');
    assert.match(String(readAlpha.output?.content ?? ''), /needle-line/, 'fs_read output should contain written content');

    const listNested = expectSuccess(await runTool('fs_list', { path: nestedDir }), 'fs_list lists scratch directory');
    assert.ok(String(listNested.output?.entries ?? '').includes('alpha.txt'), 'fs_list should include alpha.txt');

    const searchContent = expectSuccess(await runTool('fs_search', {
      path: scratchRoot,
      query: 'needle-line',
      mode: 'content',
      maxResults: 5,
    }), 'fs_search finds content match');
    assert.ok((searchContent.output?.matches ?? []).some((match) => match.relativePath?.endsWith('alpha.txt')), 'fs_search should match alpha.txt');

    expectSuccess(await runTool('fs_copy', { source: alphaPath, destination: betaPath }), 'fs_copy copies file');
    expectSuccess(await runTool('fs_move', { source: betaPath, destination: gammaPath }), 'fs_move renames file');
    expectSuccess(await runTool('doc_create', {
      path: reportPath,
      title: 'Contract Report',
      content: 'Generated by deterministic tool-contract harness.',
      template: 'markdown',
    }), 'doc_create creates markdown document');
    expectSuccess(await runTool('fs_delete', { path: gammaPath }), 'fs_delete removes copied file');

    const deniedOutsidePath = await runTool('fs_read', { path: path.join(tempRoot, 'outside.txt') }, { caseName: 'fs_read outside allowed path' });
    expectFailure(deniedOutsidePath, 'fs_read outside allowed path fails closed', /not allowed|outside|denied|Path/i);

    const criticalGitPath = path.join(scratchRoot, '.git');
    fs.mkdirSync(criticalGitPath, { recursive: true });
    fs.writeFileSync(path.join(criticalGitPath, 'config'), 'not a real repo', 'utf8');
    expectFailure(
      await runTool('fs_delete', { path: criticalGitPath, recursive: true }, { caseName: 'fs_delete critical path' }),
      'fs_delete critical .git path fails closed',
      /critical|protected|\.git|blocked/i,
    );

    const shellEcho = expectSuccess(await runTool('shell_safe', { command: 'echo contract-shell' }), 'shell_safe executes allowlisted echo');
    assert.match(`${shellEcho.output?.stdout ?? ''}${shellEcho.output?.output ?? ''}`, /contract-shell/, 'shell_safe output should contain echo text');

    expectFailure(
      await runTool('shell_safe', { command: 'whoami' }, { caseName: 'shell_safe deny unlisted command' }),
      'shell_safe rejects unlisted command',
      /not allowlisted|not allowed|blocked|denied/i,
    );

    const sysInfo = expectSuccess(await runTool('sys_info'), 'sys_info returns host metadata');
    assert.ok(sysInfo.output?.platform, 'sys_info should include platform');

    const interfaces = expectSuccess(await runTool('net_interfaces'), 'net_interfaces returns interface list');
    assert.ok(Array.isArray(interfaces.output?.interfaces), 'net_interfaces should include interfaces array');

    const portCheck = expectSuccess(await runTool('net_port_check', { host: '127.0.0.1', ports: [port] }), 'net_port_check checks harness web port');
    assert.ok((portCheck.output?.results ?? []).some((result) => result.port === port), 'net_port_check should include harness port result');

    expectFailure(
      await runTool('web_fetch', { url: `${baseUrl}/health` }, { caseName: 'web_fetch private address SSRF block' }),
      'web_fetch blocks private/internal address',
      /private|internal|SSRF|blocked/i,
    );

    const jobs = await requestJson(baseUrl, token, 'GET', '/api/tools?limit=100');
    const jobNames = new Set((jobs.jobs ?? []).map((job) => job.toolName));
    for (const expectedTool of ['fs_mkdir', 'fs_write', 'fs_read', 'fs_search', 'fs_copy', 'fs_move', 'fs_delete', 'shell_safe', 'sys_info', 'net_interfaces', 'net_port_check', 'web_fetch']) {
      assert.ok(jobNames.has(expectedTool), `job history should include ${expectedTool}`);
    }
    console.log('PASS job history records deterministic tool executions');

    console.log('PASS deterministic tool-contract harness');
  } finally {
    if (appProcess && !appProcess.killed) {
      appProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    logStream?.end();
    await provider.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

runHarness().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`FAIL test-tool-contracts: ${message}`);
  process.exitCode = 1;
});
