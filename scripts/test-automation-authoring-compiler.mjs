import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

import { DEFAULT_HARNESS_OLLAMA_MODEL, resolveHarnessOllamaModel } from './ollama-harness-defaults.mjs';

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

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function startFakeProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'automation-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const parsed = await readJsonBody(req);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const toolNames = Array.isArray(parsed?.tools)
        ? parsed.tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean)
        : [];
      const latestUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
      const conversationTranscript = messages.map((message) => String(message?.content ?? '')).join('\n');

      if (toolNames.includes('route_intent')) {
        const wantsAutomationAuthoring = /\b(create|build|set up|setup|make|configure|schedule)\b[\s\S]{0,160}\b(automation|workflow|playbook|scheduled task|assistant task)\b/i.test(latestUser);
        const wantsAutomationRename = /\brename\b[\s\S]{0,160}\bautomation\b/i.test(latestUser)
          || /\brename\b/i.test(latestUser);
        const wantsAutomationUpdate = /\b(edit|update|change)\b[\s\S]{0,160}\bautomation\b/i.test(latestUser)
          || /\bmake it scheduled\b/i.test(latestUser);
        const isAutomationNameClarification = /field:\s*automation_name/i.test(conversationTranscript)
          && /^[A-Za-z0-9][A-Za-z0-9\s-]{2,}\.?$/.test(latestUser.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'automation-harness-model',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'automation-harness-route',
            name: 'route_intent',
            arguments: JSON.stringify(isAutomationNameClarification
              ? {
                  route: 'automation_control',
                  confidence: 'high',
                  operation: 'update',
                  summary: 'Select the automation to update.',
                  turnRelation: 'clarification_answer',
                  resolution: 'ready',
                  automationName: latestUser.trim().replace(/\.$/, ''),
                  missingFields: [],
                }
              : wantsAutomationRename
                ? {
                    route: 'automation_control',
                    confidence: 'high',
                    operation: 'update',
                    summary: 'Rename an existing automation.',
                    turnRelation: /\bthat automation\b/i.test(latestUser) ? 'follow_up' : 'new_request',
                    resolution: 'ready',
                    newAutomationName: latestUser.match(/\bto\s+(.+?)(?:[.?!]\s*)?$/i)?.[1]?.trim(),
                    missingFields: [],
                  }
                : wantsAutomationUpdate
                  ? {
                      route: 'automation_control',
                      confidence: 'high',
                      operation: 'update',
                      summary: 'Update an existing automation.',
                      turnRelation: /\bthat automation\b/i.test(latestUser) ? 'follow_up' : 'new_request',
                      resolution: 'ready',
                      missingFields: [],
                    }
                  : wantsAutomationAuthoring
                    ? {
                  route: 'automation_authoring',
                  confidence: 'high',
                  operation: 'create',
                  summary: 'Create a new automation definition.',
                  turnRelation: 'new_request',
                  resolution: 'ready',
                  missingFields: [],
                }
                    : {
                        route: 'general_assistant',
                        confidence: 'medium',
                        operation: 'inspect',
                        summary: 'General assistant question.',
                        turnRelation: 'new_request',
                        resolution: 'ready',
                        missingFields: [],
                      }),
          }],
        })));
        return;
      }

      if (toolNames.includes('resolve_automation_name')) {
        const normalizedTranscript = conversationTranscript.toLowerCase();
        let automationName = '';
        if (/now edit that automation/i.test(latestUser) && normalizedTranscript.includes('whm social check disk quota')) {
          automationName = 'WHM Social Check Disk Quota';
        } else if (/rename that automation to/i.test(latestUser) && normalizedTranscript.includes('it should check account')) {
          automationName = 'It Should Check Account';
        } else if (normalizedTranscript.includes('whm social check disk quota')) {
          automationName = 'WHM Social Check Disk Quota';
        } else if (normalizedTranscript.includes('it should check account')) {
          automationName = 'It Should Check Account';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'automation-harness-model',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'automation-harness-name-repair',
            name: 'resolve_automation_name',
            arguments: JSON.stringify({
              automationName,
            }),
          }],
        })));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatCompletionResponse({
        model: 'automation-harness-model',
        content: 'Harness provider response.',
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
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function parseHarnessOptions() {
  const args = new Set(process.argv.slice(2));
  return {
    useRealOllama: args.has('--use-ollama') || process.env.HARNESS_USE_REAL_OLLAMA === '1',
    agentIsolation: args.has('--brokered') || process.env.HARNESS_AGENT_ISOLATION === '1',
    ollamaBaseUrl: process.env.HARNESS_OLLAMA_BASE_URL?.trim() || '',
    ollamaModel: process.env.HARNESS_OLLAMA_MODEL?.trim() || '',
    wslHostIp: process.env.HARNESS_WSL_HOST_IP?.trim() || '',
    ollamaBin: process.env.HARNESS_OLLAMA_BIN?.trim() || '',
    autostartLocalOllama: process.env.HARNESS_AUTOSTART_LOCAL_OLLAMA !== '0',
    bypassLocalModelComplexityGuard: process.env.HARNESS_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD !== '0',
  };
}

function collectOllamaBaseUrlCandidates(options) {
  const candidates = [];
  const push = (value) => {
    const trimmed = value?.trim();
    if (!trimmed || candidates.includes(trimmed)) return;
    candidates.push(trimmed.replace(/\/$/, ''));
  };

  push(options.ollamaBaseUrl);
  push('http://127.0.0.1:11434');
  push('http://localhost:11434');
  push(options.wslHostIp ? `http://${options.wslHostIp}:11434` : '');

  try {
    const resolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    const match = resolv.match(/^nameserver\s+([0-9.]+)\s*$/m);
    if (match?.[1]) {
      push(`http://${match[1]}:11434`);
    }
  } catch {
    // ignore
  }

  return candidates;
}

async function requestJsonNoAuth(url, method, body, timeoutMs = 2_500) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      timeout: timeoutMs,
      headers: {
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
    req.on('timeout', () => req.destroy(new Error(`Timed out connecting to ${url}`)));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function isLoopbackOllamaUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

async function canReachOllama(candidate) {
  const result = await requestJsonNoAuth(`${candidate}/api/tags`, 'GET', undefined);
  const models = Array.isArray(result?.models) ? result.models : [];
  return models;
}

async function maybeStartLocalOllama(options, candidate) {
  if (!options.autostartLocalOllama || !isLoopbackOllamaUrl(candidate)) {
    return null;
  }

  const configuredBin = options.ollamaBin || '';
  const homeDir = os.homedir();
  const binCandidates = [
    configuredBin,
    path.join(homeDir, '.local', 'bin', 'ollama'),
    'ollama',
  ].filter(Boolean);

  let ollamaBin = '';
  for (const candidateBin of binCandidates) {
    try {
      const result = spawn(candidateBin, ['--version'], {
        stdio: 'ignore',
      });
      const exitCode = await new Promise((resolve) => {
        result.on('exit', resolve);
        result.on('error', () => resolve(-1));
      });
      if (exitCode === 0) {
        ollamaBin = candidateBin;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }

  if (!ollamaBin) {
    return null;
  }

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-ollama-'));
  const logPath = path.join(logDir, 'ollama.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const processHandle = spawn(ollamaBin, ['serve'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
  processHandle.stdout.pipe(logStream);
  processHandle.stderr.pipe(logStream);

  const shutdown = async () => {
    if (!processHandle.killed) {
      if (process.platform === 'win32') {
        processHandle.kill('SIGTERM');
      } else {
        process.kill(-processHandle.pid, 'SIGTERM');
      }
    }
    logStream.end();
  };

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await canReachOllama(candidate);
        return { close: shutdown, logPath };
      } catch {
        if (processHandle.exitCode !== null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } catch {
    await shutdown();
    throw new Error(`Failed to autostart local Ollama at ${candidate}. See ${logPath}`);
  }

  await shutdown();
  throw new Error(`Failed to autostart local Ollama at ${candidate}. See ${logPath}`);
}

async function resolveHarnessProvider(options) {
  if (!options.useRealOllama) {
    const fake = await startFakeProvider();
    return {
      baseUrl: fake.baseUrl,
      model: 'automation-harness-model',
      mode: 'fake',
      async close() {
        await fake.close();
      },
    };
  }

  const candidates = collectOllamaBaseUrlCandidates(options);
  const errors = [];
  let localOllama = null;
  for (const candidate of candidates) {
    try {
      let models;
      try {
        models = await canReachOllama(candidate);
      } catch (error) {
        if (!localOllama) {
          localOllama = await maybeStartLocalOllama(options, candidate);
          if (localOllama) {
            models = await canReachOllama(candidate);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      const resolvedModel = resolveHarnessOllamaModel(options.ollamaModel, models);
      if (!resolvedModel) {
        throw new Error(
          `No models available at ${candidate}. Pull ${DEFAULT_HARNESS_OLLAMA_MODEL} or set HARNESS_OLLAMA_MODEL first.`,
        );
      }
      return {
        baseUrl: candidate,
        model: resolvedModel,
        mode: 'real_ollama',
        async close() {
          if (localOllama) {
            await localOllama.close();
          }
        },
      };
    } catch (error) {
      errors.push(`${candidate} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    [
      'Real Ollama mode was requested, but no reachable Ollama endpoint was found.',
      'Set HARNESS_OLLAMA_BASE_URL to a reachable endpoint or install Ollama locally in WSL so the harness can autostart it on 127.0.0.1:11434.',
      'If you intend to reach Windows-hosted Ollama from WSL, expose it on the Windows host IP and allow it through the firewall.',
      `Tried: ${errors.join(' | ')}`,
    ].join(' '),
  );
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate port');
  }
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function requestJson(baseUrl, token, method, pathname, body) {
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const result = await requestJson(baseUrl, 'unused', 'GET', '/health');
      if (result?.status === 'ok') return;
    } catch {
      // Retry until ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('GuardianAgent did not become healthy within 30 seconds.');
}

async function waitForAssertion(assertFn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertFn();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error('Timed out waiting for assertion.');
}

async function runTool(baseUrl, token, toolName, args = {}) {
  return requestJson(baseUrl, token, 'POST', '/api/tools/run', {
    toolName,
    agentId: 'default',
    args,
  });
}

async function listAutomations(baseUrl, token) {
  const result = await runTool(baseUrl, token, 'automation_list');
  assert.equal(result.success, true, `Expected automation_list to succeed: ${JSON.stringify(result)}`);
  return result.output?.automations ?? [];
}

async function listAutomationHistory(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/automations/history');
  assert.ok(Array.isArray(result), `Expected automation history array: ${JSON.stringify(result)}`);
  return result;
}

async function runAutomationWithApproval(baseUrl, token, automationId) {
  const result = await runTool(baseUrl, token, 'automation_run', { automationId });
  if (result?.status === 'pending_approval' && result.approvalId) {
    const decision = await approve(baseUrl, token, result.approvalId);
    assert.equal(decision.success, true, `Expected automation_run approval to succeed: ${JSON.stringify(decision)}`);
    return { approved: true, decision };
  }
  assert.equal(result.success, true, `Expected automation_run to succeed: ${JSON.stringify(result)}`);
  return { approved: false, result };
}

async function sendMessage(baseUrl, token, content) {
  return requestJson(baseUrl, token, 'POST', '/api/message', {
    agentId: 'default',
    userId: 'harness',
    channel: 'web',
    content,
  });
}

function getPendingApprovalSummaries(response) {
  const metadata = response?.metadata;
  if (Array.isArray(metadata?.pendingApprovals)) {
    return metadata.pendingApprovals;
  }
  const pendingActionApprovals = metadata?.pendingAction?.blocker?.approvalSummaries;
  return Array.isArray(pendingActionApprovals) ? pendingActionApprovals : [];
}

async function approve(baseUrl, token, approvalId) {
  return requestJson(baseUrl, token, 'POST', '/api/tools/approvals/decision', {
    approvalId,
    decision: 'approved',
  });
}

async function runHarness() {
  const options = parseHarnessOptions();
  const port = await getFreePort();
  const token = `automation-authoring-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-automation-authoring-'));
  const harnessHome = path.join(tmpDir, 'home');
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const fakeBrowserMcpPath = path.join(scriptDir, 'fake-browser-mcp.mjs');
  const provider = await resolveHarnessProvider(options);
  fs.mkdirSync(harnessHome, { recursive: true });

  const config = `
llm:
  local:
    provider: ollama
    baseUrl: ${provider.baseUrl}
    model: ${provider.model}
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
  skills:
    enabled: false
  tools:
    enabled: true
    policyMode: approve_by_policy
    toolPolicies:
      fs_write: auto
      automation_run: auto
    allowedPaths:
      - ${JSON.stringify(harnessHome)}
    allowedDomains:
      - example.com
      - github.com
      - httpbin.org
      - html.duckduckgo.com
    mcp:
      enabled: true
      servers:
        - id: playwright
          name: Fake Playwright Browser
          command: ${JSON.stringify(process.execPath)}
          args:
            - ${JSON.stringify(fakeBrowserMcpPath)}
            - "playwright"
          timeoutMs: 30000
          startupApproved: true
    browser:
      enabled: true
      playwrightEnabled: true
runtime:
  agentIsolation:
    enabled: ${options.agentIsolation ? 'true' : 'false'}
guardian:
  enabled: true
  rateLimit:
    maxPerMinute: 120
    maxPerHour: 1000
    burstAllowed: 20
    maxPerMinutePerUser: 120
    maxPerHourPerUser: 1000
    maxGlobalPerMinute: 500
    maxGlobalPerHour: 5000
`;

  fs.writeFileSync(configPath, config);
  const companiesPath = path.join(harnessHome, 'companies.csv');
  const outputCsvPath = path.join(harnessHome, 'lead-research-output.csv');
  const summaryPath = path.join(harnessHome, 'lead-research-summary.md');
  fs.writeFileSync(companiesPath, 'Company Name\nAcme SaaS\nGlobex Cloud\n');

  let appProcess;
  let logStream;
  try {
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: harnessHome,
        USERPROFILE: harnessHome,
        NO_COLOR: '1',
        ...(options.useRealOllama && options.bypassLocalModelComplexityGuard
          ? { GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: '1' }
          : {}),
      },
    });
    logStream = fs.createWriteStream(logPath, { flags: 'a' });
    appProcess.stdout.pipe(logStream);
    appProcess.stderr.pipe(logStream);

    await waitForHealth(baseUrl);

    const browserCapabilities = await runTool(baseUrl, token, 'browser_capabilities');
    assert.equal(browserCapabilities.success, true, `Expected browser_capabilities to succeed: ${JSON.stringify(browserCapabilities)}`);
    assert.equal(browserCapabilities.output?.available, true);
    assert.equal(browserCapabilities.output?.preferredReadBackend, 'playwright');
    assert.equal(browserCapabilities.output?.preferredInteractionBackend, 'playwright');

    const leadPrompt = `Build a weekday lead research workflow that reads ${JSON.stringify(companiesPath)}, researches each company’s website and public presence, scores fit from 1-5 using a simple B2B SaaS ICP, writes results to ${JSON.stringify(outputCsvPath)}, and creates ${JSON.stringify(summaryPath)}. Use built-in tools only. Do not create any shell script, Python script, or code file.`;
    const first = await sendMessage(baseUrl, token, leadPrompt);
    const firstPending = getPendingApprovalSummaries(first);
    assert.ok(firstPending.length > 0, `Expected pending approval metadata from automation compiler: ${JSON.stringify(first)}`);
    assert.equal(firstPending[0].toolName, 'automation_save');
    assert.match(first.content, /native Guardian scheduled assistant task/i);

    const approveCreate = await approve(baseUrl, token, firstPending[0].id);
    assert.equal(approveCreate.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const leadAutomation = entries.find((entry) => entry.name === 'Weekday Lead Research');
      assert.ok(leadAutomation, `Expected Weekday Lead Research automation, got ${JSON.stringify(entries)}`);
      assert.equal(leadAutomation.kind, 'assistant_task');
      assert.equal(leadAutomation.task?.type, 'agent');
      assert.equal(leadAutomation.task?.cron, '0 9 * * 1-5');
      assert.match(String(leadAutomation.description || ''), /weekday lead research workflow/i);
      assert.doesNotMatch(String(leadAutomation.description || ''), /you are executing a scheduled guardian automation/i);
      return leadAutomation;
    });

    const second = await sendMessage(baseUrl, token, leadPrompt);
    const secondPending = getPendingApprovalSummaries(second);
    assert.ok(secondPending.length > 0, `Expected update approval metadata on second automation request: ${JSON.stringify(second)}`);
    assert.equal(secondPending[0].toolName, 'automation_save');

    const approveUpdate = await approve(baseUrl, token, secondPending[0].id);
    assert.equal(approveUpdate.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const leadAutomations = entries.filter((entry) => entry.name === 'Weekday Lead Research');
      assert.equal(leadAutomations.length, 1, `Expected deduped lead-research automation, got ${JSON.stringify(entries)}`);
    });

    const remediationPrompt = 'Create a daily 7:30 AM automation that checks my high-priority inbox, summarizes anything actionable, drafts replies, and asks for approval before sending anything.';
    const remediation = await sendMessage(baseUrl, token, remediationPrompt);
    const remediationPending = getPendingApprovalSummaries(remediation);
    if (remediationPending.length > 0) {
      if (remediationPending[0].toolName === 'update_tool_policy') {
        assert.equal(remediation.metadata.resumeAutomationAfterApprovals, true);

        const approveRemediation = await approve(baseUrl, token, remediationPending[0].id);
        assert.equal(approveRemediation.success, true);
        assert.ok(approveRemediation.continuedResponse, `Expected continued automation response after remediation approval: ${JSON.stringify(approveRemediation)}`);
        const remediationCreatePending = getPendingApprovalSummaries(approveRemediation.continuedResponse);
        assert.ok(remediationCreatePending.length > 0);
        assert.equal(remediationCreatePending[0].toolName, 'automation_save');

        const approveRemediationCreate = await approve(
          baseUrl,
          token,
          remediationCreatePending[0].id,
        );
        assert.equal(approveRemediationCreate.success, true);
      } else {
        assert.equal(remediationPending[0].toolName, 'automation_save');
        const approveRemediationCreate = await approve(
          baseUrl,
          token,
          remediationPending[0].id,
        );
        assert.equal(approveRemediationCreate.success, true);
      }

      await waitForAssertion(async () => {
        const entries = await listAutomations(baseUrl, token);
        const remediationAutomation = entries.find((entry) => entry.task?.cron === '30 7 * * *' && String(entry.name || '').includes('Inbox'));
        assert.ok(remediationAutomation, `Expected remediation-created automation, got ${JSON.stringify(entries)}`);
      });
    } else {
      assert.match(String(remediation?.content || ''), /couldn't create/i);
      assert.match(String(remediation?.content || ''), /gmail_draft/i);
      assert.match(String(remediation?.content || ''), /auto-approve/i);
    }

    const missingParentPrompt = 'Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to D:\\\\Repor    ts\\\\lead-summary.md, and uses built-in Guardian tools only.';
    const missingParentResponse = await sendMessage(baseUrl, token, missingParentPrompt);
    const missingParentPending = getPendingApprovalSummaries(missingParentResponse);
    if (missingParentPending.length > 0) {
      assert.equal(missingParentPending[0].toolName, 'update_tool_policy');

      const approveMissingParentRemediation = await approve(
        baseUrl,
        token,
        missingParentPending[0].id,
      );
      assert.equal(approveMissingParentRemediation.success, true);
      assert.ok(
        approveMissingParentRemediation.continuedResponse,
        `Expected continued automation response after missing-parent remediation: ${JSON.stringify(approveMissingParentRemediation)}`,
      );
      const missingParentCreatePending = getPendingApprovalSummaries(approveMissingParentRemediation.continuedResponse);
      assert.equal(
        missingParentCreatePending[0].toolName,
        'automation_save',
      );

      const approveMissingParentCreate = await approve(
        baseUrl,
        token,
        missingParentCreatePending[0].id,
      );
      assert.equal(approveMissingParentCreate.success, true);

      await waitForAssertion(async () => {
        const entries = await listAutomations(baseUrl, token);
        const missingParentAutomation = entries.find((entry) => entry.task?.cron === '0 8 * * *' && entry.name === 'Daily Lead Summary');
        assert.ok(missingParentAutomation, `Expected missing-parent automation, got ${JSON.stringify(entries)}`);
        assert.match(String(missingParentAutomation.description || ''), /d:\\reports\\lead-summary\.md/i);
      });
    } else {
      assert.match(String(missingParentResponse?.content || ''), /couldn't create/i);
      assert.match(String(missingParentResponse?.content || ''), /allowed paths/i);
      assert.match(String(missingParentResponse?.content || ''), /d:\\reports\\lead-summary\.md/i);
    }

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const workflowPrompt = 'Create a Guardian workflow that runs net_ping and then web_fetch every 15 minutes in sequential mode.';
    const workflowResponse = await sendMessage(baseUrl, token, workflowPrompt);
    const workflowPending = getPendingApprovalSummaries(workflowResponse);
    assert.ok(workflowPending.length > 0, `Expected workflow approval metadata: ${JSON.stringify(workflowResponse)}`);
    assert.equal(workflowPending[0].toolName, 'automation_save');

    const approveWorkflow = await approve(baseUrl, token, workflowPending[0].id);
    assert.equal(approveWorkflow.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const compiled = entries.find((entry) => entry.id === 'net-ping-web-fetch-workflow');
      assert.ok(compiled, `Expected compiled workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.kind, 'workflow');
      assert.equal(compiled.task?.cron, '*/15 * * * *');
      assert.equal(Array.isArray(compiled.workflow?.steps), true);
      assert.equal(compiled.workflow.steps.length, 2);
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const instructionWorkflowPrompt = 'Create a sequential Guardian workflow that first reads ./         companies.csv, then runs a fixed summarization step, then          writes ./lead-research-summary.md.';
    const instructionWorkflowResponse = await sendMessage(baseUrl, token, instructionWorkflowPrompt);
    const instructionWorkflowPending = getPendingApprovalSummaries(instructionWorkflowResponse);
    assert.ok(
      instructionWorkflowPending.length > 0,
      `Expected instruction-workflow approval metadata: ${JSON.stringify(instructionWorkflowResponse)}`,
    );
    assert.equal(instructionWorkflowPending[0].toolName, 'automation_save');

    const approveInstructionWorkflow = await approve(
      baseUrl,
      token,
      instructionWorkflowPending[0].id,
    );
    assert.equal(approveInstructionWorkflow.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const compiled = entries.find((entry) => entry.id === 'lead-research-summary-workflow');
      assert.ok(compiled, `Expected instruction-compiled workflow, got ${JSON.stringify(entries)}`);
      assert.equal(Array.isArray(compiled.workflow?.steps), true);
      assert.equal(compiled.workflow.steps.length, 3);
      assert.equal(compiled.workflow.steps[0]?.toolName, 'fs_read');
      assert.equal(compiled.workflow.steps[1]?.type, 'instruction');
      assert.equal(compiled.workflow.steps[2]?.toolName, 'fs_write');
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const browserReadPrompt = 'Create an automation called Browser Read Smoke. When I run it, it should open https://example.com, read the page, list the links, and keep the results in the automation run output only. Do not schedule it yet.';
    const browserReadResponse = await sendMessage(baseUrl, token, browserReadPrompt);
    const browserReadPending = getPendingApprovalSummaries(browserReadResponse);
    assert.ok(
      browserReadPending.length > 0,
      `Expected browser-read approval metadata: ${JSON.stringify(browserReadResponse)}`,
    );
    assert.equal(browserReadPending[0].toolName, 'automation_save');

    const approveBrowserRead = await approve(baseUrl, token, browserReadPending[0].id);
    assert.equal(approveBrowserRead.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const compiled = entries.find((entry) => entry.id === 'browser-read-smoke');
      assert.ok(compiled, `Expected Browser Read Smoke workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.enabled, true);
      assert.equal(Array.isArray(compiled.workflow?.steps), true);
      assert.equal(compiled.workflow.steps.length, 3);
      assert.equal(compiled.workflow.steps[0]?.toolName, 'browser_navigate');
      assert.equal(compiled.workflow.steps[1]?.toolName, 'browser_read');
      assert.equal(compiled.workflow.steps[2]?.toolName, 'browser_links');
    });

    await runAutomationWithApproval(baseUrl, token, 'browser-read-smoke');
    await waitForAssertion(async () => {
      const history = await listAutomationHistory(baseUrl, token);
      const entry = history.find((item) => item.name === 'Browser Read Smoke');
      assert.ok(entry, `Expected Browser Read Smoke history entry, got ${JSON.stringify(history)}`);
      assert.equal(entry.status, 'succeeded');
      assert.equal(entry.source, 'automation');
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const browserExtractPrompt = 'Create an automation called Browser Extract Smoke. When I run it, it should open https://github.com, extract structured metadata and a semantic outline, and show me the result. Do not schedule it.';
    const browserExtractResponse = await sendMessage(baseUrl, token, browserExtractPrompt);
    const browserExtractPending = getPendingApprovalSummaries(browserExtractResponse);
    assert.ok(
      browserExtractPending.length > 0,
      `Expected browser-extract approval metadata: ${JSON.stringify(browserExtractResponse)}`,
    );
    assert.equal(browserExtractPending[0].toolName, 'automation_save');

    const approveBrowserExtract = await approve(baseUrl, token, browserExtractPending[0].id);
    assert.equal(approveBrowserExtract.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const compiled = entries.find((entry) => entry.id === 'browser-extract-smoke');
      assert.ok(compiled, `Expected Browser Extract Smoke workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.enabled, true);
      assert.equal(Array.isArray(compiled.workflow?.steps), true);
      assert.equal(compiled.workflow.steps.length, 2);
      assert.equal(compiled.workflow.steps[0]?.toolName, 'browser_navigate');
      assert.equal(compiled.workflow.steps[1]?.toolName, 'browser_extract');
    });

    await runAutomationWithApproval(baseUrl, token, 'browser-extract-smoke');
    await waitForAssertion(async () => {
      const history = await listAutomationHistory(baseUrl, token);
      const entry = history.find((item) => item.name === 'Browser Extract Smoke');
      assert.ok(entry, `Expected Browser Extract Smoke history entry, got ${JSON.stringify(history)}`);
      assert.equal(entry.status, 'succeeded');
      assert.equal(entry.source, 'automation');
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const formPrompt = 'Create an automation called HTTPBin Form Smoke Test. When I run it, it should open https://httpbin.org/forms/post, list the inputs, and type "automation smoke test" into the first text field. Do not schedule it.';
    const formResponse = await sendMessage(baseUrl, token, formPrompt);
    const formPending = getPendingApprovalSummaries(formResponse);
    assert.ok(
      formPending.length > 0,
      `Expected browser-form approval metadata: ${JSON.stringify(formResponse)}`,
    );
    assert.equal(formPending[0].toolName, 'automation_save');

    const approveForm = await approve(baseUrl, token, formPending[0].id);
    assert.equal(approveForm.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const compiled = entries.find((entry) => entry.id === 'httpbin-form-smoke-test');
      assert.ok(compiled, `Expected HTTPBin Form Smoke Test workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.enabled, true);
      assert.equal(Array.isArray(compiled.workflow?.steps), true);
      assert.equal(compiled.workflow.steps.length, 4);
      assert.equal(compiled.workflow.steps[0]?.toolName, 'browser_navigate');
      assert.equal(compiled.workflow.steps[1]?.toolName, 'browser_state');
      assert.equal(compiled.workflow.steps[2]?.type, 'instruction');
      assert.equal(compiled.workflow.steps[3]?.toolName, 'browser_act');
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const manualWhmPrompt = 'Create a manual assistant automation called It Should Check Account. It should check the account in WHM for the social profile, inspect disk usage, and report if any account is within 100 MB of its quota. Do not schedule it yet.';
    const manualWhmCreate = await sendMessage(baseUrl, token, manualWhmPrompt);
    const manualWhmPending = getPendingApprovalSummaries(manualWhmCreate);
    assert.ok(manualWhmPending.length > 0, `Expected pending approval for manual WHM automation: ${JSON.stringify(manualWhmCreate)}`);
    assert.equal(manualWhmPending[0].toolName, 'automation_save');

    const approveManualWhm = await approve(baseUrl, token, manualWhmPending[0].id);
    assert.equal(approveManualWhm.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const whmAutomation = entries.find((entry) => entry.name === 'It Should Check Account');
      assert.ok(whmAutomation, `Expected initial WHM automation, got ${JSON.stringify(entries)}`);
      assert.equal(whmAutomation.task?.cron ?? '', '');
      return whmAutomation;
    });

    const renameWhm = await sendMessage(baseUrl, token, 'Rename that automation to WHM Social Check Disk Quota.');
    const renameWhmPending = getPendingApprovalSummaries(renameWhm);
    assert.ok(renameWhmPending.length > 0, `Expected pending approval for WHM rename: ${JSON.stringify(renameWhm)}`);
    assert.equal(renameWhmPending[0].toolName, 'automation_save');

    const approveRenameWhm = await approve(baseUrl, token, renameWhmPending[0].id);
    assert.equal(approveRenameWhm.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const renamedWhmAutomation = entries.find((entry) => entry.name === 'WHM Social Check Disk Quota');
      assert.ok(renamedWhmAutomation, `Expected renamed WHM automation, got ${JSON.stringify(entries)}`);
      return renamedWhmAutomation;
    });

    const scheduleWhm = await sendMessage(baseUrl, token, 'Now edit that automation, make it scheduled and run daily at 9:00 AM.');
    const scheduleWhmPending = getPendingApprovalSummaries(scheduleWhm);
    assert.ok(scheduleWhmPending.length > 0, `Expected pending approval for WHM schedule update: ${JSON.stringify(scheduleWhm)}`);
    assert.equal(scheduleWhmPending[0].toolName, 'automation_save');

    const approveScheduleWhm = await approve(baseUrl, token, scheduleWhmPending[0].id);
    assert.equal(approveScheduleWhm.success, true);

    await waitForAssertion(async () => {
      const entries = await listAutomations(baseUrl, token);
      const scheduledWhmAutomation = entries.find((entry) => entry.name === 'WHM Social Check Disk Quota');
      assert.ok(scheduledWhmAutomation, `Expected scheduled WHM automation, got ${JSON.stringify(entries)}`);
      assert.equal(scheduledWhmAutomation.task?.cron, '0 9 * * *');
      return scheduledWhmAutomation;
    });

    console.log(`PASS automation compiler harness (${provider.mode}${options.agentIsolation ? ', brokered' : ''})`);
  } finally {
    if (logStream) logStream.end();
    if (appProcess && !appProcess.killed) {
      if (process.platform === 'win32') {
        appProcess.kill('SIGTERM');
      } else {
        process.kill(-appProcess.pid, 'SIGTERM');
      }
    }
    await provider.close();
  }
}

runHarness().catch((error) => {
  console.error('FAIL automation compiler harness');
  console.error(error);
  process.exitCode = 1;
});
