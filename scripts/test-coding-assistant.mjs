import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function requestJson(baseUrl, token, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate free port');
  }
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return address.port;
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const health = await requestJson(baseUrl, 'unused', 'GET', '/health');
      if (health?.status === 'ok') {
        return;
      }
    } catch {
      // Retry until ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('GuardianAgent did not become healthy within 30 seconds.');
}

function createChatCompletionResponse({ model, content = '', finishReason = 'stop', toolCalls }) {
  const message = {
    role: 'assistant',
    content,
  };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }));
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

async function startFakeProvider(workspaceRoot, scenarioLog) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'coding-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const parsed = await readJsonBody(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.map((tool) => String(tool?.function?.name ?? '')).filter(Boolean)
        : [];
      const toolMessages = messages.filter((message) => message.role === 'tool');
      const latestUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');

      scenarioLog.push({
        latestUser,
        tools,
        toolMessages: toolMessages.map((message) => String(message.content ?? '')),
      });

      if (latestUser.includes('[Code Workspace Context]') && latestUser.includes('answerValue')) {
        if (toolMessages.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createChatCompletionResponse({
            model: 'coding-harness-model',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'code-find-tools',
              name: 'find_tools',
              arguments: JSON.stringify({
                query: 'coding code edit create git diff test build lint symbol',
                maxResults: 10,
              }),
            }],
          })));
          return;
        }

        if (toolMessages.length === 1) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createChatCompletionResponse({
            model: 'coding-harness-model',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'code-symbol-search',
              name: 'code_symbol_search',
              arguments: JSON.stringify({
                path: workspaceRoot,
                query: 'answerValue',
                mode: 'auto',
                maxResults: 5,
              }),
            }],
          })));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'coding-harness-model',
          content: 'I found `answerValue` in `src/example.ts` inside the active coding workspace.',
        })));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatCompletionResponse({
        model: 'coding-harness-model',
        content: 'Coding harness default response.',
      })));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start fake provider');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function setupGitWorkspace(workspaceRoot) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf-8' });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  };

  git(['init']);
  git(['config', 'user.email', 'coding-harness@example.com']);
  git(['config', 'user.name', 'Coding Harness']);
  git(['add', '.']);
  git(['commit', '-m', 'Initial harness commit']);
}

async function runHarness() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const harnessPort = await getFreePort();
  const harnessToken = `coding-harness-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${harnessPort}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-coding-harness-'));
  const workspaceRoot = path.join(tmpDir, 'workspace');
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');
  const scenarioLog = [];

  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'example.ts'), [
    'export function getAnswer() {',
    '  const answerValue = 41;',
    '  return answerValue;',
    '}',
    '',
  ].join('\n'));
  setupGitWorkspace(workspaceRoot);

  const provider = await startFakeProvider(workspaceRoot, scenarioLog);
  const config = `
llm:
  local:
    provider: ollama
    baseUrl: ${provider.baseUrl}
    model: coding-harness-model
defaultProvider: local
channels:
  cli:
    enabled: false
  web:
    enabled: true
    host: 127.0.0.1
    port: ${harnessPort}
    authToken: "${harnessToken}"
assistant:
  identity:
    mode: single_user
    primaryUserId: harness
  setup:
    completed: true
  tools:
    enabled: true
    policyMode: approve_by_policy
    allowedPaths:
      - ${workspaceRoot}
    allowedCommands:
      - git
      - pwd
      - echo
    agentPolicyUpdates:
      allowedPaths: true
      allowedCommands: false
      allowedDomains: false
runtime:
  agentIsolation:
    enabled: false
guardian:
  enabled: true
`;
  fs.writeFileSync(configPath, config);

  let appProcess;
  try {
    appProcess = spawn('npx', ['tsx', 'src/index.ts', configPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = fs.createWriteStream(logPath);
    const stderr = fs.createWriteStream(`${logPath}.err`);
    appProcess.stdout.pipe(stdout);
    appProcess.stderr.pipe(stderr);

    await waitForHealth(baseUrl);

    const agents = await requestJson(baseUrl, harnessToken, 'GET', '/api/agents');
    assert.ok(Array.isArray(agents) && agents.length > 0, `Expected /api/agents to return agents: ${JSON.stringify(agents)}`);

    const toolState = await requestJson(baseUrl, harnessToken, 'GET', '/api/tools?limit=20');
    const toolNames = Array.isArray(toolState?.tools) ? toolState.tools.map((tool) => tool.name) : [];
    assert.ok(toolNames.includes('code_edit'), 'Expected code_edit in tool catalog');
    assert.ok(toolNames.includes('code_symbol_search'), 'Expected code_symbol_search in tool catalog');

    const codeEditPending = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/run', {
      toolName: 'code_edit',
      args: {
        path: path.join(workspaceRoot, 'src', 'example.ts'),
        oldString: 'const answerValue = 41;',
        newString: 'const answerValue = 42;',
      },
      origin: 'web',
      userId: 'web-code-harness',
      channel: 'web',
    });
    assert.equal(codeEditPending.status, 'pending_approval');
    assert.ok(codeEditPending.approvalId, `Expected approvalId from code_edit: ${JSON.stringify(codeEditPending)}`);

    const pendingApprovals = await requestJson(
      baseUrl,
      harnessToken,
      'GET',
      '/api/tools/approvals/pending?userId=web-code-harness&channel=web&limit=10',
    );
    assert.ok(Array.isArray(pendingApprovals) && pendingApprovals.length > 0, 'Expected pending approvals for code session');
    assert.equal(pendingApprovals[0].toolName, 'code_edit');
    assert.equal(pendingApprovals[0].id, codeEditPending.approvalId);

    const codeEditDecision = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/approvals/decision', {
      approvalId: codeEditPending.approvalId,
      decision: 'approved',
      actor: 'web-code-harness',
    });
    assert.equal(codeEditDecision.success, true);
    assert.match(fs.readFileSync(path.join(workspaceRoot, 'src', 'example.ts'), 'utf-8'), /answerValue = 42/);

    const autonomousPolicy = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/policy', {
      mode: 'autonomous',
      sandbox: {
        allowedPaths: [workspaceRoot],
        allowedCommands: ['git', 'pwd', 'echo'],
      },
    });
    assert.equal(autonomousPolicy.success, true);

    const codeCreate = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/run', {
      toolName: 'code_create',
      args: {
        path: path.join(workspaceRoot, 'src', 'generated.ts'),
        content: 'export const generatedValue = 7;\n',
      },
      origin: 'web',
      userId: 'web-code-harness',
      channel: 'web',
    });
    assert.equal(codeCreate.success, true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'src', 'generated.ts')), true);

    const codeSearch = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/run', {
      toolName: 'code_symbol_search',
      args: {
        path: workspaceRoot,
        query: 'answerValue',
        mode: 'auto',
        maxResults: 5,
      },
      origin: 'web',
      userId: 'web-code-harness',
      channel: 'web',
    });
    assert.equal(codeSearch.success, true);
    assert.ok(Array.isArray(codeSearch.output?.matches) && codeSearch.output.matches.some((match) => match.relativePath === 'src/example.ts'));

    const codeDiff = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/run', {
      toolName: 'code_git_diff',
      args: {
        cwd: workspaceRoot,
        path: 'src/example.ts',
      },
      origin: 'web',
      userId: 'web-code-harness',
      channel: 'web',
    });
    assert.equal(codeDiff.success, true);
    assert.match(String(codeDiff.output?.stdout ?? ''), /answerValue = 42/);

    const messageResponse = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: [
        '[Code Workspace Context]',
        `workspaceRoot: ${workspaceRoot}`,
        `selectedFile: ${path.join(workspaceRoot, 'src', 'example.ts')}`,
        'activeTerminal: Agent',
        'Use coding tools when appropriate. If coding tools are not visible, call find_tools with query "coding code edit create git diff test build lint symbol".',
        `When running shell commands, use cwd="${workspaceRoot}".`,
        '',
        'Search the workspace for answerValue and tell me where it is defined.',
      ].join('\n'),
      userId: 'web-code-harness',
      channel: 'web',
    });
    assert.match(String(messageResponse.content ?? ''), /answerValue/);
    assert.match(String(messageResponse.content ?? ''), /src\/example\.ts/);

    const toolsStateAfter = await requestJson(baseUrl, harnessToken, 'GET', '/api/tools?limit=20');
    const recentJobs = Array.isArray(toolsStateAfter?.jobs) ? toolsStateAfter.jobs : [];
    assert.ok(recentJobs.some((job) => job.toolName === 'find_tools'), 'Expected find_tools job from coding message flow');
    assert.ok(recentJobs.some((job) => job.toolName === 'code_symbol_search'), 'Expected code_symbol_search job from coding message flow');

    const toolListsSeen = scenarioLog.map((entry) => entry.tools);
    assert.ok(toolListsSeen.some((tools) => tools.includes('find_tools')), 'Expected find_tools in model tool lists');

    console.log('PASS coding assistant harness');
  } finally {
    if (appProcess && !appProcess.killed) {
      appProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!appProcess.killed) {
        appProcess.kill('SIGKILL');
      }
    }
    await provider.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runHarness()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL coding assistant harness');
    console.error(err);
    process.exit(1);
  });
