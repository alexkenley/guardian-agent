import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createOllamaHarnessChatResponse } from './ollama-harness-provider.mjs';

const HARNESS_USER_ID = 'harness';
const HARNESS_CHANNEL = 'web';
const HARNESS_SURFACE_ID = 'web-guardian-chat';

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

function buildRouteIntentDecision(latestUser) {
  if (latestUser.includes('[User approved the pending tool action(s).')) {
    return {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'continue',
      summary: 'Continue the approved file-creation request.',
      turnRelation: 'follow_up',
      resolution: 'ready',
      missingFields: [],
    };
  }
  if (latestUser.includes('create an empty file called web-empty.txt')) {
    return {
      route: 'general_assistant',
      confidence: 'high',
      operation: 'execute',
      summary: 'Create the requested empty file.',
      turnRelation: 'new_request',
      resolution: 'ready',
      missingFields: [],
    };
  }
  return {
    route: 'general_assistant',
    confidence: 'low',
    operation: 'unknown',
    summary: 'Unhandled harness request.',
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
  };
}

function readAssistantToolCalls(message) {
  if (Array.isArray(message?.toolCalls)) {
    return message.toolCalls;
  }
  if (Array.isArray(message?.tool_calls)) {
    return message.tool_calls.map((toolCall) => ({
      id: toolCall?.id,
      name: toolCall?.function?.name,
      arguments: toolCall?.function?.arguments,
    }));
  }
  return [];
}

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasResolvedToolResult(messages, toolName) {
  return messages.some((message, index) => {
    if (message?.role !== 'tool') return false;
    const content = String(message?.content ?? '');
    if (content.includes(`<tool_result name="${toolName}"`)
      && (content.includes('"success":true') || content.includes('"status":"succeeded"'))) {
      return true;
    }
    const parsed = tryParseJson(content);
    if (!(parsed?.success === true || parsed?.status === 'succeeded')) {
      return false;
    }
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previous = messages[previousIndex];
      if (previous?.role !== 'assistant') continue;
      if (readAssistantToolCalls(previous).some((toolCall) => String(toolCall?.name ?? '').trim() === toolName)) {
        return true;
      }
    }
    return false;
  });
}

async function startFakeProvider(testDir, scenarioLog) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isOllamaNativeChat = req.method === 'POST' && url.pathname === '/api/chat';
    const isOpenAiCompatChat = req.method === 'POST' && url.pathname === '/v1/chat/completions';

    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'web-harness-model', size: 1 }] }));
      return;
    }

    if (isOllamaNativeChat || isOpenAiCompatChat) {
      const parsed = await readJsonBody(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean)
        : [];
      const latestUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
      scenarioLog.push({
        latestUser,
        tools,
        resolvedUpdateToolPolicy: hasResolvedToolResult(messages, 'update_tool_policy'),
        resolvedFsWrite: hasResolvedToolResult(messages, 'fs_write'),
        recentMessages: messages.slice(-4).map((message) => ({
          role: message?.role,
          toolCallId: message?.toolCallId ?? message?.tool_call_id ?? null,
          toolCalls: readAssistantToolCalls(message).map((toolCall) => ({
            id: String(toolCall?.id ?? ''),
            name: String(toolCall?.name ?? ''),
          })),
          content: String(message?.content ?? '').slice(0, 240),
        })),
      });
      const sendResponse = ({ model, content = '', finishReason = 'stop', toolCalls }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          isOllamaNativeChat
            ? createOllamaHarnessChatResponse({
                model,
                content,
                doneReason: finishReason,
                toolCalls,
              })
            : createChatCompletionResponse({
                model,
                content,
                finishReason,
                toolCalls,
              }),
        ));
      };
      const decision = buildRouteIntentDecision(latestUser);

      if (tools.includes('route_intent')) {
        sendResponse({
          model: 'web-harness-model',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'web-route-intent-1',
              name: 'route_intent',
              arguments: JSON.stringify(decision),
            },
          ],
        });
        return;
      }

      if (latestUser.includes('Classify this request.')) {
        sendResponse({
          model: 'web-harness-model',
          content: JSON.stringify(decision),
        });
        return;
      }

      if (hasResolvedToolResult(messages, 'fs_write')) {
        sendResponse({
          model: 'web-harness-model',
          content: `Done - created ${path.join(testDir, 'web-empty.txt')} as an empty file.`,
        });
        return;
      }

      if (hasResolvedToolResult(messages, 'update_tool_policy')) {
        sendResponse({
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
        });
        return;
      }

      if (latestUser.includes('create an empty file called web-empty.txt')) {
        sendResponse({
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
        });
        return;
      }

      if (latestUser.includes('update_tool_policy') && /approved and executed/i.test(latestUser)) {
        sendResponse({
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
        });
        return;
      }

      if (latestUser.includes('fs_write') && /approved and executed/i.test(latestUser)) {
        sendResponse({
          model: 'web-harness-model',
          content: `Done - created ${path.join(testDir, 'web-empty.txt')} as an empty file.`,
        });
        return;
      }

      sendResponse({
        model: 'web-harness-model',
        content: 'Unexpected harness prompt.',
      });
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

function getPendingApprovalSummaries(response) {
  const pendingActionApprovals = response?.metadata?.pendingAction?.blocker?.approvalSummaries;
  if (Array.isArray(pendingActionApprovals)) {
    return pendingActionApprovals;
  }
  return Array.isArray(response?.metadata?.pendingApprovals)
    ? response.metadata.pendingApprovals
    : [];
}

async function readCurrentPendingAction(baseUrl, token, userId = 'harness', channel = 'web', surfaceId = 'web-guardian-chat') {
  const qs = new URLSearchParams({ userId, channel, surfaceId });
  return requestJson(baseUrl, token, 'GET', `/api/chat/pending-action?${qs.toString()}`);
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
  // Fresh temp HOME cold starts can exceed 30s on mounted workspaces even when healthy.
  for (let i = 0; i < 180; i += 1) {
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
  throw new Error('GuardianAgent did not become healthy within 90 seconds.');
}

function normalizeApprovalSummary(result, approval, decision = 'approved') {
  const toolName = approval?.toolName || 'tool';
  if (result?.success === false) {
    const rawMessage = typeof result?.message === 'string' ? result.message.trim() : '';
    return `Failed: ${toolName}: ${rawMessage || 'unknown error'}`;
  }
  return `${toolName}: ${decision === 'approved' ? 'Approved and executed' : 'Denied'}`;
}

async function continueAfterApproval({
  baseUrl,
  token,
  approval,
  decisionResult,
  userId = HARNESS_USER_ID,
  channel = HARNESS_CHANNEL,
  surfaceId = HARNESS_SURFACE_ID,
}) {
  if (decisionResult?.continuedResponse && typeof decisionResult.continuedResponse.content === 'string') {
    return decisionResult.continuedResponse;
  }

  const hasExplicitContinuationDirective = decisionResult?.continuedResponse || decisionResult?.continueConversation !== undefined;
  const needsSyntheticContinuation = decisionResult?.success !== false
    && (
      decisionResult?.continueConversation === true
      || !hasExplicitContinuationDirective
    );
  if (!needsSyntheticContinuation) {
    return null;
  }

  const summary = normalizeApprovalSummary(decisionResult, approval, 'approved');
  return requestJson(baseUrl, token, 'POST', '/api/message', {
    content: `[Context: User is currently viewing the second-brain panel] [User approved the pending tool action(s). Result: ${summary}] Please continue with the current request only. Do not resume older unrelated pending tasks.`,
    userId,
    channel,
    surfaceId,
  });
}

async function runWebApprovalHarness() {
  const preserveArtifacts = process.env.HARNESS_KEEP_TMP === '1';
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
  guardianAgent:
    llmProvider: local
`;

  fs.writeFileSync(configPath, config);

  let appProcess;
  let exitInfo = null;
  let completed = false;
  try {
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        XDG_CONFIG_HOME: tmpDir,
        XDG_DATA_HOME: tmpDir,
        XDG_CACHE_HOME: tmpDir,
      },
    });
    appProcess.once('exit', (code, signal) => {
      exitInfo = { code, signal };
    });
    const stdout = fs.createWriteStream(logPath);
    const stderr = fs.createWriteStream(`${logPath}.err`);
    appProcess.stdout.pipe(stdout);
    appProcess.stderr.pipe(stderr);

    await waitForHealth(baseUrl);

    const first = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: 'Please create an empty file called web-empty.txt in the requested external directory.',
      userId: HARNESS_USER_ID,
      channel: HARNESS_CHANNEL,
      surfaceId: HARNESS_SURFACE_ID,
    });
    const firstPending = getPendingApprovalSummaries(first);
    assert.ok(firstPending.length > 0, `Expected pending approval from initial message: ${JSON.stringify(first)}`);
    assert.equal(first.metadata?.pendingAction?.blocker?.kind, 'approval', `Expected canonical pendingAction metadata on blocked response: ${JSON.stringify(first)}`);
    assert.equal(firstPending[0].toolName, 'update_tool_policy');
    assert.match(first.content, /Waiting for approval to add .*allowed paths\./i);
    const firstCurrent = await readCurrentPendingAction(baseUrl, harnessToken);
    assert.equal(firstCurrent?.pendingAction?.blocker?.kind, 'approval', `Expected current pending action after first blocked response: ${JSON.stringify(firstCurrent)}`);
    assert.equal(firstCurrent.pendingAction.blocker.approvalSummaries?.[0]?.id, firstPending[0].id);

    const firstDecision = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/approvals/decision', {
      approvalId: firstPending[0].id,
      decision: 'approved',
      actor: 'web-user',
      userId: HARNESS_USER_ID,
      channel: HARNESS_CHANNEL,
      surfaceId: HARNESS_SURFACE_ID,
    });
    assert.equal(firstDecision.success, true);

    const second = await continueAfterApproval({
      baseUrl,
      token: harnessToken,
      approval: firstPending[0],
      decisionResult: firstDecision,
    });
    const secondPending = getPendingApprovalSummaries(second);
    assert.ok(secondPending.length > 0, `Expected pending fs_write approval after path update: ${JSON.stringify(second)}`);
    assert.equal(second.metadata?.pendingAction?.blocker?.kind, 'approval', `Expected canonical pendingAction metadata on second blocked response: ${JSON.stringify(second)}`);
    assert.equal(secondPending[0].toolName, 'fs_write');
    assert.match(second.content, /Waiting for approval to write .*web-empty\.txt\./i);
    const secondCurrent = await readCurrentPendingAction(baseUrl, harnessToken);
    assert.equal(secondCurrent?.pendingAction?.blocker?.kind, 'approval', `Expected current pending action after second blocked response: ${JSON.stringify(secondCurrent)}`);
    assert.equal(secondCurrent.pendingAction.blocker.approvalSummaries?.[0]?.id, secondPending[0].id);

    const secondDecision = await requestJson(baseUrl, harnessToken, 'POST', '/api/tools/approvals/decision', {
      approvalId: secondPending[0].id,
      decision: 'approved',
      actor: 'web-user',
      userId: HARNESS_USER_ID,
      channel: HARNESS_CHANNEL,
      surfaceId: HARNESS_SURFACE_ID,
    });
    assert.equal(secondDecision.success, true);

    const third = await continueAfterApproval({
      baseUrl,
      token: harnessToken,
      approval: secondPending[0],
      decisionResult: secondDecision,
    });
    assert.ok(typeof third.content === 'string' && third.content.length > 0, `Expected final response text: ${JSON.stringify(third)}`);
    assert.equal(getPendingApprovalSummaries(third).length, 0, 'Did not expect more pending approvals after fs_write approval');
    assert.match(third.content, /created .*web-empty\.txt as an empty file/i);
    const clearedCurrent = await readCurrentPendingAction(baseUrl, harnessToken);
    assert.equal(clearedCurrent?.pendingAction ?? null, null, `Did not expect a current pending action after completion: ${JSON.stringify(clearedCurrent)}`);

    const emptyFilePath = path.join(testDir, 'web-empty.txt');
    assert.equal(fs.existsSync(emptyFilePath), true, `Expected ${emptyFilePath} to exist`);
    assert.equal(fs.statSync(emptyFilePath).size, 0, 'Expected approved empty file to have zero-byte size');

    const followUp = await requestJson(baseUrl, harnessToken, 'POST', '/api/message', {
      content: 'What exact tool did you use?',
      userId: HARNESS_USER_ID,
      channel: HARNESS_CHANNEL,
      surfaceId: HARNESS_SURFACE_ID,
    });
    assert.match(followUp.content, /1\. update_tool_policy/);
    assert.match(followUp.content, /"action": "add_path"/);
    assert.match(followUp.content, /2\. fs_write/);
    assert.match(followUp.content, /"content": ""/);
    assert.equal(getPendingApprovalSummaries(followUp).length, 0, 'Did not expect stale pending approvals on follow-up');

    const toolCallsSeen = scenarioLog.map((entry) => entry.tools);
    assert.ok(toolCallsSeen.some((tools) => tools.includes('update_tool_policy')), 'Expected update_tool_policy in tool list');

    completed = true;
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
    if (!completed) {
      if (exitInfo) {
        console.error(`[web-approvals] GuardianAgent exited before completion: code=${exitInfo.code ?? 'null'} signal=${exitInfo.signal ?? 'null'}`);
      }
      console.error(`[web-approvals] Scenario log: ${JSON.stringify(scenarioLog, null, 2)}`);
      if (preserveArtifacts) {
        console.error(`[web-approvals] Preserved artifacts at ${tmpDir}`);
      }
    }
    if (completed || !preserveArtifacts) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
