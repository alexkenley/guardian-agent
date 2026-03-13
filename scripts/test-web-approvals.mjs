import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

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
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

async function startFakeProvider(testDir, scenarioLog) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'web-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const parsed = await readJsonBody(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.map((tool) => String(tool?.function?.name ?? '')).filter(Boolean)
        : [];
      const latestUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
      scenarioLog.push({ latestUser, tools });

      if (latestUser.includes('create an empty file called web-empty.txt')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'web-harness-model',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'web-tool-call-1',
              name: 'update_tool_policy',
              arguments: JSON.stringify({
                action: 'add_path',
                value: testDir,
              }),
            },
          ],
        })));
        return;
      }

      if (latestUser.includes('Result: ✓ update_tool_policy: Approved and executed')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'web-harness-model',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'web-tool-call-2',
              name: 'fs_write',
              arguments: JSON.stringify({
                path: path.join(testDir, 'web-empty.txt'),
                content: '',
                append: false,
              }),
            },
          ],
        })));
        return;
      }

      if (latestUser.includes('Result: ✓ fs_write: Approved and executed')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'web-harness-model',
          content: `Done - created ${path.join(testDir, 'web-empty.txt')} as an empty file.`,
        })));
        return;
      }

      if (latestUser.includes('What exact tool did you use?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'web-harness-model',
          content: 'It used update_tool_policy and fs_write.',
        })));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatCompletionResponse({
        model: 'web-harness-model',
        content: 'Unexpected harness prompt.',
      })));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
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
    throw new Error('Failed to allocate a free port');
  }
  const { port } = address;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const result = await requestJson(baseUrl, 'unused', 'GET', '/health');
      if (result?.status === 'ok') {
        return;
      }
    } catch {
      // Retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('GuardianAgent did not become healthy within 30 seconds.');
}

async function runWebApprovalHarness() {
  const harnessPort = await getFreePort();
  const harnessToken = `web-approval-harness-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${harnessPort}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-web-approvals-'));
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');
  const testDir = path.join(tmpDir, 'allowed-after-approval');
  const scenarioLog = [];
  const provider = await startFakeProvider(testDir, scenarioLog);

  const config = `
llm:
  local:
    provider: ollama
    baseUrl: ${provider.baseUrl}
    model: web-harness-model
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
      - .
    allowedCommands:
      - node
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
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = fs.createWriteStream(logPath);
    const stderr = fs.createWriteStream(`${logPath}.err`);
    appProcess.stdout.pipe(stdout);
    appProcess.stderr.pipe(stderr);

    await waitForHealth(baseUrl);

    const first = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: 'Please create an empty file called web-empty.txt in the requested external directory.',
      userId: 'harness',
      channel: 'web',
    });
    assert.ok(first?.metadata?.pendingApprovals?.length > 0, `Expected pending approval from initial message: ${JSON.stringify(first)}`);
    assert.equal(first.metadata.pendingApprovals[0].toolName, 'update_tool_policy');
    assert.match(first.content, /Waiting for approval to add .*allowed paths\./i);

    const firstDecision = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/approvals/decision', {
      approvalId: first.metadata.pendingApprovals[0].id,
      decision: 'approved',
      actor: 'web-user',
    });
    assert.equal(firstDecision.success, true);

    const second = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: '[Context: User is currently viewing the chat panel] [User approved the pending tool action(s). Result: ✓ update_tool_policy: Approved and executed] Please continue with the current request only. Do not resume older unrelated pending tasks.',
      userId: 'harness',
      channel: 'web',
    });
    assert.ok(second?.metadata?.pendingApprovals?.length > 0, `Expected pending fs_write approval after path update: ${JSON.stringify(second)}`);
    assert.equal(second.metadata.pendingApprovals[0].toolName, 'fs_write');
    assert.match(second.content, /Waiting for approval to write .*web-empty\.txt\./i);

    const secondDecision = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/approvals/decision', {
      approvalId: second.metadata.pendingApprovals[0].id,
      decision: 'approved',
      actor: 'web-user',
    });
    assert.equal(secondDecision.success, true);

    const third = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: '[Context: User is currently viewing the chat panel] [User approved the pending tool action(s). Result: ✓ fs_write: Approved and executed] Please continue with the current request only. Do not resume older unrelated pending tasks.',
      userId: 'harness',
      channel: 'web',
    });
    assert.ok(typeof third.content === 'string' && third.content.length > 0, `Expected final response text: ${JSON.stringify(third)}`);
    assert.ok(!third.metadata?.pendingApprovals?.length, 'Did not expect more pending approvals after fs_write approval');
    assert.match(third.content, /created .*web-empty\.txt as an empty file/i);

    const emptyFilePath = path.join(testDir, 'web-empty.txt');
    assert.equal(fs.existsSync(emptyFilePath), true, `Expected ${emptyFilePath} to exist`);
    assert.equal(fs.statSync(emptyFilePath).size, 0, 'Expected approved empty file to have zero-byte size');

    const followUp = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: 'What exact tool did you use?',
      userId: 'harness',
      channel: 'web',
    });
    assert.equal(followUp.content, 'It used update_tool_policy and fs_write.');
    assert.ok(!followUp.metadata?.pendingApprovals?.length, 'Did not expect stale pending approvals on follow-up');

    const toolCallsSeen = scenarioLog.map((entry) => entry.tools);
    assert.ok(toolCallsSeen.some((tools) => tools.includes('update_tool_policy')), 'Expected update_tool_policy in tool list');
    assert.ok(scenarioLog.some((entry) => entry.latestUser.includes('What exact tool did you use?')), 'Expected the follow-up prompt to reach the model');

    console.log('PASS web approval flow');
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

runWebApprovalHarness()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL web approvals');
    console.error(err);
    process.exit(1);
  });
