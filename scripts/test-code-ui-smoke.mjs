import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

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
      const response = await fetch(`${baseUrl}/health`);
      const json = await response.json();
      if (json?.status === 'ok') {
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

async function startFakeProvider(workspaceRoot) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'code-ui-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const parsed = await readJsonBody(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const latestUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');

      if (latestUser.includes('[Code Workspace Context]') && latestUser.includes('answerValue')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'code-ui-harness-model',
          content: 'I found `answerValue` in `src/example.ts` in the current coding workspace.',
        })));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatCompletionResponse({
        model: 'code-ui-harness-model',
        content: 'UI smoke harness response.',
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

function setupWorkspace(workspaceRoot) {
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'example.ts'), [
    'export function getAnswer() {',
    '  const answerValue = 41;',
    '  return answerValue;',
    '}',
    '',
  ].join('\n'));

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
  git(['config', 'user.email', 'code-ui-harness@example.com']);
  git(['config', 'user.name', 'Code UI Harness']);
  git(['add', '.']);
  git(['commit', '-m', 'Initial UI harness commit']);
}

async function run() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const webPort = await getFreePort();
  const authToken = `code-ui-harness-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-code-ui-'));
  const workspaceRoot = path.join(tmpDir, 'workspace');
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');

  setupWorkspace(workspaceRoot);
  const provider = await startFakeProvider(workspaceRoot);

  const config = `
llm:
  local:
    provider: ollama
    baseUrl: ${provider.baseUrl}
    model: code-ui-harness-model
defaultProvider: local
channels:
  cli:
    enabled: false
  web:
    enabled: true
    host: 127.0.0.1
    port: ${webPort}
    authToken: "${authToken}"
assistant:
  identity:
    mode: single_user
    primaryUserId: harness
  setup:
    completed: true
  tools:
    enabled: true
    policyMode: autonomous
    allowedPaths:
      - ${workspaceRoot}
    allowedCommands:
      - git
      - pwd
      - echo
runtime:
  agentIsolation:
    enabled: false
guardian:
  enabled: true
`;
  fs.writeFileSync(configPath, config);

  let appProcess;
  let browser;
  try {
    appProcess = spawn('npx', ['tsx', 'src/index.ts', configPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appProcess.stdout.pipe(fs.createWriteStream(logPath));
    appProcess.stderr.pipe(fs.createWriteStream(`${logPath}.err`));

    await waitForHealth(baseUrl);

    browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.goto(`${baseUrl}/#/code`, { waitUntil: 'networkidle' });
    await page.fill('#auth-token-input', authToken);
    await page.click('#auth-submit');
    await page.waitForSelector('.code-page');

    assert.equal(await page.locator('#chat-panel').isHidden(), true, 'Global chat panel should be hidden on the code route');

    await page.click('[data-code-new-session]');
    await page.fill('[data-code-session-form] input[name="title"]', 'Workspace A');
    await page.fill('[data-code-session-form] input[name="workspaceRoot"]', workspaceRoot);
    await page.click('[data-code-session-form] button[type="submit"]');

    await page.waitForFunction((expected) => {
      return Array.from(document.querySelectorAll('.code-path')).some((node) => node.textContent.includes(expected));
    }, workspaceRoot);
    await page.locator('[data-code-tree-toggle]').filter({ hasText: 'src' }).click();
    await page.locator('[data-code-tree-file]').filter({ hasText: 'example.ts' }).click();
    await page.waitForSelector('text=example.ts');
    assert.match(await page.locator('.code-editor__content').textContent(), /answerValue = 41/);

    await page.fill('[data-code-terminal-form] input[name="command"]', 'pwd');
    await page.click('[data-code-terminal-form] button[type="submit"]');
    await page.waitForFunction(() => {
      const output = document.querySelector('.code-terminal__output');
      return output && output.textContent.includes('$ pwd');
    });
    assert.match(await page.locator('.code-terminal__output').textContent(), /\$ pwd/);

    await page.click('a[data-page="dashboard"]');
    await page.waitForSelector('.code-page', { state: 'detached' });
    assert.equal(await page.locator('#chat-panel').isVisible(), true, 'Global chat panel should reappear off the code route');

    await page.click('a[data-page="code"]');
    await page.waitForSelector('.code-page');
    assert.equal(await page.locator('#chat-panel').isHidden(), true, 'Global chat panel should hide again on return to code');
    assert.match(await page.locator('.code-editor__content').textContent(), /answerValue = 41/);
    assert.match(await page.locator('.code-terminal__output').textContent(), /\$ pwd/);

    console.log('PASS code UI smoke');
  } finally {
    if (browser) {
      await browser.close();
    }
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

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL code UI smoke');
    console.error(err);
    process.exit(1);
  });
