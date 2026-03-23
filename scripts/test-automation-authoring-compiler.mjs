import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

function createChatCompletionResponse({ model, content = '' }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
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
      await readJsonBody(req);
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
      const resolvedModel = options.ollamaModel || models[0]?.name;
      if (!resolvedModel) {
        throw new Error(`No models available at ${candidate}. Set HARNESS_OLLAMA_MODEL or pull a model first.`);
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

async function sendMessage(baseUrl, token, content) {
  return requestJson(baseUrl, token, 'POST', '/api/message', {
    agentId: 'default',
    userId: 'harness',
    channel: 'web',
    content,
  });
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
      workflow_run: auto
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
    assert.ok(first?.metadata?.pendingApprovals?.length > 0, `Expected pending approval metadata from automation compiler: ${JSON.stringify(first)}`);
    assert.equal(first.metadata.pendingApprovals[0].toolName, 'task_create');
    assert.match(first.content, /native Guardian scheduled assistant task/i);

    const approveCreate = await approve(baseUrl, token, first.metadata.pendingApprovals[0].id);
    assert.equal(approveCreate.success, true);

    await waitForAssertion(async () => {
      const tasks = await runTool(baseUrl, token, 'task_list');
      assert.equal(tasks.success, true);
      const entries = tasks.output?.tasks ?? [];
      const leadTask = entries.find((task) => task.name === 'Weekday Lead Research');
      assert.ok(leadTask, `Expected Weekday Lead Research task, got ${JSON.stringify(entries)}`);
      assert.equal(leadTask.type, 'agent');
      assert.equal(leadTask.cron, '0 9 * * 1-5');
      assert.match(String(leadTask.description || ''), /weekday lead research workflow/i);
      assert.doesNotMatch(String(leadTask.description || ''), /you are executing a scheduled guardian automation/i);
      return leadTask;
    });

    const second = await sendMessage(baseUrl, token, leadPrompt);
    assert.ok(second?.metadata?.pendingApprovals?.length > 0, `Expected update approval metadata on second automation request: ${JSON.stringify(second)}`);
    assert.equal(second.metadata.pendingApprovals[0].toolName, 'task_update');

    const approveUpdate = await approve(baseUrl, token, second.metadata.pendingApprovals[0].id);
    assert.equal(approveUpdate.success, true);

    await waitForAssertion(async () => {
      const tasks = await runTool(baseUrl, token, 'task_list');
      const entries = tasks.output?.tasks ?? [];
      const leadTasks = entries.filter((task) => task.name === 'Weekday Lead Research');
      assert.equal(leadTasks.length, 1, `Expected deduped lead-research task, got ${JSON.stringify(entries)}`);
    });

    const remediationPrompt = 'Create a daily 7:30 AM automation that checks my high-priority inbox, summarizes anything actionable, drafts replies, and asks for approval before sending anything.';
    const remediation = await sendMessage(baseUrl, token, remediationPrompt);
    if (Array.isArray(remediation?.metadata?.pendingApprovals) && remediation.metadata.pendingApprovals.length > 0) {
      assert.equal(remediation.metadata.pendingApprovals[0].toolName, 'update_tool_policy');
      assert.equal(remediation.metadata.resumeAutomationAfterApprovals, true);

      const approveRemediation = await approve(baseUrl, token, remediation.metadata.pendingApprovals[0].id);
      assert.equal(approveRemediation.success, true);
      assert.ok(approveRemediation.continuedResponse, `Expected continued automation response after remediation approval: ${JSON.stringify(approveRemediation)}`);
      assert.ok(Array.isArray(approveRemediation.continuedResponse.metadata?.pendingApprovals));
      assert.equal(approveRemediation.continuedResponse.metadata.pendingApprovals[0].toolName, 'task_create');

      const approveRemediationCreate = await approve(
        baseUrl,
        token,
        approveRemediation.continuedResponse.metadata.pendingApprovals[0].id,
      );
      assert.equal(approveRemediationCreate.success, true);

      await waitForAssertion(async () => {
        const tasks = await runTool(baseUrl, token, 'task_list');
        const entries = tasks.output?.tasks ?? [];
        const remediationTask = entries.find((task) => task.cron === '30 7 * * *' && String(task.name || '').includes('Inbox'));
        assert.ok(remediationTask, `Expected remediation-created scheduled task, got ${JSON.stringify(entries)}`);
      });
    } else {
      assert.match(String(remediation?.content || ''), /couldn't create/i);
      assert.match(String(remediation?.content || ''), /gmail_draft/i);
      assert.match(String(remediation?.content || ''), /auto-approve/i);
    }

    const missingParentPrompt = 'Create a daily 8:00 AM automation that reads ./companies.csv, writes a summary report to D:\\\\Repor    ts\\\\lead-summary.md, and uses built-in Guardian tools only.';
    const missingParentResponse = await sendMessage(baseUrl, token, missingParentPrompt);
    if (Array.isArray(missingParentResponse?.metadata?.pendingApprovals) && missingParentResponse.metadata.pendingApprovals.length > 0) {
      assert.equal(missingParentResponse.metadata.pendingApprovals[0].toolName, 'update_tool_policy');

      const approveMissingParentRemediation = await approve(
        baseUrl,
        token,
        missingParentResponse.metadata.pendingApprovals[0].id,
      );
      assert.equal(approveMissingParentRemediation.success, true);
      assert.ok(
        approveMissingParentRemediation.continuedResponse,
        `Expected continued automation response after missing-parent remediation: ${JSON.stringify(approveMissingParentRemediation)}`,
      );
      assert.equal(
        approveMissingParentRemediation.continuedResponse.metadata.pendingApprovals[0].toolName,
        'task_create',
      );

      const approveMissingParentCreate = await approve(
        baseUrl,
        token,
        approveMissingParentRemediation.continuedResponse.metadata.pendingApprovals[0].id,
      );
      assert.equal(approveMissingParentCreate.success, true);

      await waitForAssertion(async () => {
        const tasks = await runTool(baseUrl, token, 'task_list');
        const entries = tasks.output?.tasks ?? [];
        const missingParentTask = entries.find((task) => task.cron === '0 8 * * *' && task.name === 'Daily Lead Summary');
        assert.ok(missingParentTask, `Expected missing-parent scheduled task, got ${JSON.stringify(entries)}`);
        assert.match(String(missingParentTask.description || ''), /d:\\reports\\lead-summary\.md/i);
      });
    } else {
      assert.match(String(missingParentResponse?.content || ''), /couldn't create/i);
      assert.match(String(missingParentResponse?.content || ''), /allowed paths/i);
      assert.match(String(missingParentResponse?.content || ''), /d:\\reports\\lead-summary\.md/i);
    }

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const workflowPrompt = 'Create a Guardian workflow that runs net_ping and then web_fetch every 15 minutes in sequential mode.';
    const workflowResponse = await sendMessage(baseUrl, token, workflowPrompt);
    assert.ok(workflowResponse?.metadata?.pendingApprovals?.length > 0, `Expected workflow approval metadata: ${JSON.stringify(workflowResponse)}`);
    assert.equal(workflowResponse.metadata.pendingApprovals[0].toolName, 'workflow_upsert');

    const approveWorkflow = await approve(baseUrl, token, workflowResponse.metadata.pendingApprovals[0].id);
    assert.equal(approveWorkflow.success, true);

    await waitForAssertion(async () => {
      const workflows = await runTool(baseUrl, token, 'workflow_list');
      assert.equal(workflows.success, true);
      const entries = workflows.output?.workflows ?? [];
      const compiled = entries.find((workflow) => workflow.id === 'net-ping-web-fetch-workflow');
      assert.ok(compiled, `Expected compiled workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.schedule, '*/15 * * * *');
      assert.equal(Array.isArray(compiled.steps), true);
      assert.equal(compiled.steps.length, 2);
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const instructionWorkflowPrompt = 'Create a sequential Guardian workflow that first reads ./         companies.csv, then runs a fixed summarization step, then          writes ./lead-research-summary.md.';
    const instructionWorkflowResponse = await sendMessage(baseUrl, token, instructionWorkflowPrompt);
    assert.ok(
      instructionWorkflowResponse?.metadata?.pendingApprovals?.length > 0,
      `Expected instruction-workflow approval metadata: ${JSON.stringify(instructionWorkflowResponse)}`,
    );
    assert.equal(instructionWorkflowResponse.metadata.pendingApprovals[0].toolName, 'workflow_upsert');

    const approveInstructionWorkflow = await approve(
      baseUrl,
      token,
      instructionWorkflowResponse.metadata.pendingApprovals[0].id,
    );
    assert.equal(approveInstructionWorkflow.success, true);

    await waitForAssertion(async () => {
      const workflows = await runTool(baseUrl, token, 'workflow_list');
      assert.equal(workflows.success, true);
      const entries = workflows.output?.workflows ?? [];
      const compiled = entries.find((workflow) => workflow.id === 'lead-research-summary-workflow');
      assert.ok(compiled, `Expected instruction-compiled workflow, got ${JSON.stringify(entries)}`);
      assert.equal(Array.isArray(compiled.steps), true);
      assert.equal(compiled.steps.length, 3);
      assert.equal(compiled.steps[0]?.toolName, 'fs_read');
      assert.equal(compiled.steps[1]?.type, 'instruction');
      assert.equal(compiled.steps[2]?.toolName, 'fs_write');
    });

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const browserReadPrompt = 'Create an automation called Browser Read Smoke. When I run it, it should open https://example.com, read the page, list the links, and keep the results in the automation run output only. Do not schedule it yet.';
    const browserReadResponse = await sendMessage(baseUrl, token, browserReadPrompt);
    assert.ok(
      browserReadResponse?.metadata?.pendingApprovals?.length > 0,
      `Expected browser-read approval metadata: ${JSON.stringify(browserReadResponse)}`,
    );
    assert.equal(browserReadResponse.metadata.pendingApprovals[0].toolName, 'workflow_upsert');

    const approveBrowserRead = await approve(baseUrl, token, browserReadResponse.metadata.pendingApprovals[0].id);
    assert.equal(approveBrowserRead.success, true);

    await waitForAssertion(async () => {
      const workflows = await runTool(baseUrl, token, 'workflow_list');
      const entries = workflows.output?.workflows ?? [];
      const compiled = entries.find((workflow) => workflow.id === 'browser-read-smoke');
      assert.ok(compiled, `Expected Browser Read Smoke workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.enabled, true);
      assert.equal(Array.isArray(compiled.steps), true);
      assert.equal(compiled.steps.length, 3);
      assert.equal(compiled.steps[0]?.toolName, 'browser_navigate');
      assert.equal(compiled.steps[1]?.toolName, 'browser_read');
      assert.equal(compiled.steps[2]?.toolName, 'browser_links');
    });

    const browserReadRun = await runTool(baseUrl, token, 'workflow_run', { workflowId: 'browser-read-smoke' });
    assert.equal(browserReadRun.success, true, `Expected Browser Read Smoke run to succeed: ${JSON.stringify(browserReadRun)}`);
    assert.equal(browserReadRun.output?.success, true, `Expected Browser Read Smoke wrapper output to succeed: ${JSON.stringify(browserReadRun)}`);
    assert.equal(browserReadRun.output?.run?.status, 'succeeded', `Expected Browser Read Smoke run status to be succeeded: ${JSON.stringify(browserReadRun)}`);

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const browserExtractPrompt = 'Create an automation called Browser Extract Smoke. When I run it, it should open https://github.com, extract structured metadata and a semantic outline, and show me the result. Do not schedule it.';
    const browserExtractResponse = await sendMessage(baseUrl, token, browserExtractPrompt);
    assert.ok(
      browserExtractResponse?.metadata?.pendingApprovals?.length > 0,
      `Expected browser-extract approval metadata: ${JSON.stringify(browserExtractResponse)}`,
    );
    assert.equal(browserExtractResponse.metadata.pendingApprovals[0].toolName, 'workflow_upsert');

    const approveBrowserExtract = await approve(baseUrl, token, browserExtractResponse.metadata.pendingApprovals[0].id);
    assert.equal(approveBrowserExtract.success, true);

    await waitForAssertion(async () => {
      const workflows = await runTool(baseUrl, token, 'workflow_list');
      const entries = workflows.output?.workflows ?? [];
      const compiled = entries.find((workflow) => workflow.id === 'browser-extract-smoke');
      assert.ok(compiled, `Expected Browser Extract Smoke workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.enabled, true);
      assert.equal(Array.isArray(compiled.steps), true);
      assert.equal(compiled.steps.length, 2);
      assert.equal(compiled.steps[0]?.toolName, 'browser_navigate');
      assert.equal(compiled.steps[1]?.toolName, 'browser_extract');
    });

    const browserExtractRun = await runTool(baseUrl, token, 'workflow_run', { workflowId: 'browser-extract-smoke' });
    assert.equal(browserExtractRun.success, true, `Expected Browser Extract Smoke run to succeed: ${JSON.stringify(browserExtractRun)}`);
    assert.equal(browserExtractRun.output?.success, true, `Expected Browser Extract Smoke wrapper output to succeed: ${JSON.stringify(browserExtractRun)}`);
    assert.equal(browserExtractRun.output?.run?.status, 'succeeded', `Expected Browser Extract Smoke run status to be succeeded: ${JSON.stringify(browserExtractRun)}`);

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const formPrompt = 'Create an automation called HTTPBin Form Smoke Test. When I run it, it should open https://httpbin.org/forms/post, list the inputs, and type "automation smoke test" into the first text field. Do not schedule it.';
    const formResponse = await sendMessage(baseUrl, token, formPrompt);
    assert.ok(
      formResponse?.metadata?.pendingApprovals?.length > 0,
      `Expected browser-form approval metadata: ${JSON.stringify(formResponse)}`,
    );
    assert.equal(formResponse.metadata.pendingApprovals[0].toolName, 'workflow_upsert');

    const approveForm = await approve(baseUrl, token, formResponse.metadata.pendingApprovals[0].id);
    assert.equal(approveForm.success, true);

    await waitForAssertion(async () => {
      const workflows = await runTool(baseUrl, token, 'workflow_list');
      const entries = workflows.output?.workflows ?? [];
      const compiled = entries.find((workflow) => workflow.id === 'httpbin-form-smoke-test');
      assert.ok(compiled, `Expected HTTPBin Form Smoke Test workflow, got ${JSON.stringify(entries)}`);
      assert.equal(compiled.enabled, true);
      assert.equal(Array.isArray(compiled.steps), true);
      assert.equal(compiled.steps.length, 4);
      assert.equal(compiled.steps[0]?.toolName, 'browser_navigate');
      assert.equal(compiled.steps[1]?.toolName, 'browser_state');
      assert.equal(compiled.steps[2]?.type, 'instruction');
      assert.equal(compiled.steps[3]?.toolName, 'browser_act');
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
