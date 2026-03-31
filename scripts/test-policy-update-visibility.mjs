import http from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distEntry = path.join(projectRoot, 'dist', 'index.js');
const workerEntry = path.join(projectRoot, 'dist', 'worker', 'worker-entry.js');
const blockedHost = 'vmres13.web-servers.com.au';
const domainPrompt = 'Add vmres13.web-servers.com.au to allowed domains and then run the read-only whm_status check against the social profile.';
const pathPrompt = 'Can you create a file called Test100 in S Drive Development?';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPendingApprovalSummaries(responseBody) {
  const metadata = responseBody?.metadata;
  if (Array.isArray(metadata?.pendingApprovals)) {
    return metadata.pendingApprovals;
  }
  const pendingActionApprovals = metadata?.pendingAction?.blocker?.approvalSummaries;
  return Array.isArray(pendingActionApprovals) ? pendingActionApprovals : [];
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      if (body?.status === 'ok') {
        return;
      }
    } catch {
      // Keep polling.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function request(baseUrl, token, pathname, init = {}, options = {}) {
  const { auth = true, parseJson = true } = options;
  const headers = {
    ...(parseJson ? { 'Content-Type': 'application/json' } : {}),
    ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body = text;
  if (parseJson) {
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function runTest(results, name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function createMockLlmServer(port, scenarioLog) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3.2', object: 'model' }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : {};
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools
          .map((tool) => String(tool?.function?.name ?? ''))
          .filter(Boolean)
        : [];
      const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

      scenarioLog.requests.push({
        prompt: String(latestUser),
        tools: [...tools],
      });

      if (String(latestUser).includes(blockedHost)) {
        if (tools.includes('update_tool_policy')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(toolCallResponse('update_tool_policy', {
            action: 'add_domain',
            value: blockedHost,
          })));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(textResponse(
          'The update_tool_policy tool is not available in this environment, so you need to edit config manually.',
        )));
        return;
      }

      if (String(latestUser).includes('Test100') || String(latestUser).includes('S Drive Development')) {
        if (tools.includes('update_tool_policy')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(toolCallResponse('update_tool_policy', {
            action: 'add_path',
            value: 'S:\\Development',
          })));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(textResponse(
          'The update_tool_policy tool is not available in this environment, so you need to edit config manually.',
        )));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(textResponse('Harness response.')));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return server;
}

function textResponse(content) {
  return {
    id: 'mock-chat',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'llama3.2',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

function toolCallResponse(toolName, args) {
  return {
    id: 'mock-chat',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'llama3.2',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `call-${toolName}`,
              type: 'function',
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

function writeConfig(configPath, options) {
  const {
    appPort,
    llmPort,
    authToken,
    workspaceDir,
    mode,
  } = options;

  const lines = [
    'llm:',
    '  ollama:',
    '    provider: ollama',
    `    baseUrl: "http://127.0.0.1:${llmPort}"`,
    '    model: llama3.2',
    'defaultProvider: ollama',
    'channels:',
    '  cli:',
    '    enabled: false',
    '  web:',
    '    enabled: true',
    `    port: ${appPort}`,
    `    authToken: "${authToken}"`,
    'assistant:',
    '  setup:',
    '    completed: true',
    '  identity:',
    '    mode: single_user',
    '    primaryUserId: owner',
    '  tools:',
    '    enabled: true',
    '    policyMode: approve_by_policy',
    `    allowedPaths: ["${workspaceDir.replace(/\\/g, '/')}"]`,
    '    allowedCommands: ["echo"]',
    '    allowedDomains: ["localhost"]',
    '    cloud:',
    '      enabled: true',
    '      cpanelProfiles:',
    '        - id: social',
    '          name: social',
    '          type: whm',
    `          host: "https://${blockedHost}/"`,
    '          port: 2087',
    '          ssl: true',
    '          allowSelfSigned: false',
    '          username: social',
    '          apiToken: whm-secret',
    '    agentPolicyUpdates:',
    '      allowedPaths: true',
    '      allowedCommands: false',
    '      allowedDomains: true',
    '    sandbox:',
    '      enabled: true',
    '      enforcementMode: strict',
    'runtime:',
    '  agentIsolation:',
    mode === 'brokered' ? '    enabled: true' : '    enabled: false',
    `    mode: ${mode}`,
    `    workerEntryPoint: "${workerEntry.replace(/\\/g, '/')}"`,
    '',
  ];

  writeFileSync(configPath, lines.join('\n'), 'utf8');
}

async function runScenario(mode) {
  const tempRoot = path.join(os.tmpdir(), `ga-policy-update-${mode}-${Date.now()}`);
  const workspaceDir = path.join(tempRoot, 'workspace');
  const appPort = mode === 'brokered' ? 3042 : 3041;
  const llmPort = mode === 'brokered' ? 11492 : 11491;
  const authToken = `policy-update-${mode}-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const configPath = path.join(tempRoot, 'config.yaml');
  const stdoutLogPath = path.join(tempRoot, 'app.stdout.log');
  const stderrLogPath = path.join(tempRoot, 'app.stderr.log');
  const scenarioLog = { requests: [] };

  mkdirSync(workspaceDir, { recursive: true });
  writeConfig(configPath, { appPort, llmPort, authToken, workspaceDir, mode });

  const llmServer = await createMockLlmServer(llmPort, scenarioLog);
  const app = spawn(process.execPath, [distEntry, configPath], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      XDG_CONFIG_HOME: tempRoot,
      XDG_DATA_HOME: tempRoot,
      XDG_CACHE_HOME: tempRoot,
      PATH: path.join(tempRoot, 'no-bwrap-path'),
    },
  });
  app.stdout.pipe(createWriteStream(stdoutLogPath, { flags: 'a' }));
  app.stderr.pipe(createWriteStream(stderrLogPath, { flags: 'a' }));

  const results = [];

  try {
    await waitForHealth(baseUrl, 30_000);

    await runTest(results, `${mode}: strict degraded sandbox exposes update_tool_policy in tools API`, async () => {
      const response = await request(baseUrl, authToken, '/api/tools');
      assert(response.status === 200, `Expected 200 from /api/tools, got ${response.status}`);
      assert(response.body?.sandbox?.enforcementMode === 'strict', 'Expected strict sandbox enforcement mode');
      assert(
        response.body?.sandbox?.availability === 'degraded' || response.body?.sandbox?.availability === 'unavailable',
        `Expected degraded or unavailable sandbox, got ${response.body?.sandbox?.availability}`,
      );
      const toolNames = Array.isArray(response.body?.tools)
        ? response.body.tools.map((tool) => String(tool.name))
        : [];
      assert(toolNames.includes('find_tools'), 'Expected find_tools in tool catalog');
      assert(toolNames.includes('update_tool_policy'), 'Expected update_tool_policy in tool catalog');
      assert(!toolNames.includes('shell_safe'), 'Expected shell_safe to be hidden in strict degraded sandbox');
      assert(!toolNames.includes('net_ping'), 'Expected net_ping to be hidden in strict degraded sandbox');
    });

    await runTest(results, `${mode}: domain allowlist prompt triggers update_tool_policy approval`, async () => {
      const response = await request(baseUrl, authToken, '/api/message', {
        method: 'POST',
        body: JSON.stringify({
          content: domainPrompt,
          userId: `policy-${mode}`,
          channel: 'web',
        }),
      });
      assert(response.status === 200, `Expected 200 from /api/message, got ${response.status}`);
      const pending = getPendingApprovalSummaries(response.body)[0];
      assert(pending?.toolName === 'update_tool_policy', `Expected update_tool_policy pending approval, got ${pending?.toolName ?? 'none'}`);

      const decision = await request(baseUrl, authToken, '/api/tools/approvals/decision', {
        method: 'POST',
        body: JSON.stringify({
          approvalId: pending.id,
          decision: 'approved',
          actor: 'harness',
        }),
      });
      assert(decision.status === 200, `Expected 200 from approval decision, got ${decision.status}`);
      assert(decision.body?.success === true, 'Expected domain approval decision to succeed');

      const toolsState = await request(baseUrl, authToken, '/api/tools');
      const allowedDomains = Array.isArray(toolsState.body?.policy?.sandbox?.allowedDomains)
        ? toolsState.body.policy.sandbox.allowedDomains
        : [];
      assert(allowedDomains.includes(blockedHost), `Expected ${blockedHost} in allowedDomains`);
    });

    await runTest(results, `${mode}: path allowlist prompt triggers update_tool_policy approval`, async () => {
      const response = await request(baseUrl, authToken, '/api/message', {
        method: 'POST',
        body: JSON.stringify({
          content: pathPrompt,
          userId: `policy-${mode}`,
          channel: 'web',
        }),
      });
      assert(response.status === 200, `Expected 200 from /api/message, got ${response.status}`);
      const pending = getPendingApprovalSummaries(response.body)[0];
      assert(pending?.toolName === 'update_tool_policy', `Expected update_tool_policy pending approval, got ${pending?.toolName ?? 'none'}`);

      const decision = await request(baseUrl, authToken, '/api/tools/approvals/decision', {
        method: 'POST',
        body: JSON.stringify({
          approvalId: pending.id,
          decision: 'approved',
          actor: 'harness',
        }),
      });
      assert(decision.status === 200, `Expected 200 from approval decision, got ${decision.status}`);
      assert(decision.body?.success === true, 'Expected path approval decision to succeed');

      const toolsState = await request(baseUrl, authToken, '/api/tools');
      const allowedPaths = Array.isArray(toolsState.body?.policy?.sandbox?.allowedPaths)
        ? toolsState.body.policy.sandbox.allowedPaths
        : [];
      assert(allowedPaths.includes('S:\\Development'), 'Expected S:\\Development in allowedPaths');
    });
  } finally {
    llmServer.close();
    app.kill('SIGTERM');
    await new Promise((resolve) => app.once('exit', () => resolve(undefined)));
    const failed = results.some((result) => !result.ok);
    if (failed) {
      const stdout = existsSync(stdoutLogPath) ? readFileSync(stdoutLogPath, 'utf8') : '';
      const stderr = existsSync(stderrLogPath) ? readFileSync(stderrLogPath, 'utf8') : '';
      console.log(`\n--- ${mode} stdout ---\n${stdout}`);
      console.log(`\n--- ${mode} stderr ---\n${stderr}`);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }

  return results;
}

async function main() {
  assert(existsSync(distEntry), 'Missing dist/index.js. Run `npm run build` first.');
  assert(existsSync(workerEntry), 'Missing dist/worker/worker-entry.js. Run `npm run build` first.');

  const allResults = [];
  for (const mode of ['in-process', 'brokered']) {
    console.log(`\n[policy-update] Running ${mode} scenario...`);
    const results = await runScenario(mode);
    allResults.push(...results);
  }

  const passed = allResults.filter((result) => result.ok).length;
  const total = allResults.length;
  const failed = allResults.filter((result) => !result.ok);

  console.log(`\nPolicy update visibility harness summary: ${passed}/${total} passed`);
  if (failed.length > 0) {
    for (const result of failed) {
      console.error(`FAIL ${result.name}: ${result.message}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Policy update visibility harness failed.');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
