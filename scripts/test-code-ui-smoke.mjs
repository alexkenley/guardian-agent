import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
  const examplePath = path.join(workspaceRoot, 'src', 'example.ts');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'code-ui-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const parsed = await readJsonBody(req);
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const toolMessages = messages.filter((message) => message.role === 'tool');
      const latestUser = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');

      if (latestUser.includes('[Code Approval Continuation]')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'code-ui-harness-model',
          content: 'The approved edit has been applied. Refresh the file view if you want to inspect the updated source.',
        })));
        return;
      }

      if (/make the answer 42/i.test(latestUser)) {
        if (toolMessages.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createChatCompletionResponse({
            model: 'code-ui-harness-model',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'code-ui-find-tools',
              name: 'find_tools',
              arguments: JSON.stringify({
                query: 'coding code edit patch create git diff test build lint symbol',
                maxResults: 10,
              }),
            }],
          })));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'code-ui-harness-model',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'code-ui-edit',
            name: 'code_edit',
            arguments: JSON.stringify({
              path: examplePath,
              oldString: 'const answerValue = 41;',
              newString: 'const answerValue = 42;',
            }),
          }],
        })));
        return;
      }

      if (latestUser.includes('answerValue')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'code-ui-harness-model',
          content: 'I found `answerValue` in `src/example.ts` in the current coding workspace.',
        })));
        return;
      }

      if (/slow repo summary/i.test(latestUser)) {
        await new Promise((resolve) => setTimeout(resolve, 5600));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'code-ui-harness-model',
          content: 'This repo contains a src directory with example.ts and a generated live-generated.ts file.',
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
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), [
    '# UI Harness Workspace',
    '',
    'A small routine planner used by the Code UI smoke test.',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'code-ui-harness-workspace',
    version: '1.0.0',
    description: 'A small routine planner used by the Code UI smoke test.',
    dependencies: {
      react: '^18.0.0',
      vite: '^5.0.0',
    },
  }, null, 2));
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
  const examplePath = path.join(workspaceRoot, 'src', 'example.ts');

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
    policyMode: approve_by_policy
    allowedPaths:
      - ${workspaceRoot}
    allowedCommands:
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
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
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
      return Array.from(document.querySelectorAll('.code-session__meta')).some((node) => (node.textContent || '').includes(expected));
    }, workspaceRoot);

    const poisonedCurrentDirectory = path.join(tmpDir, 'poisoned-workspace');
    await page.evaluate((poisonPath) => {
      const key = 'guardianagent_code_sessions_v2';
      const raw = JSON.parse(localStorage.getItem(key) || '{}');
      if (Array.isArray(raw.sessions) && raw.sessions[0]) {
        raw.sessions[0].currentDirectory = poisonPath;
        raw.sessions[0].selectedFilePath = `${poisonPath}/ghost.ts`;
        localStorage.setItem(key, JSON.stringify(raw));
      }
    }, poisonedCurrentDirectory);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.code-page');
    await page.waitForFunction((expected) => {
      return Array.from(document.querySelectorAll('.code-session__meta')).some((node) => (node.textContent || '').includes(expected));
    }, workspaceRoot);
    const repairedSessionState = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('guardianagent_code_sessions_v2') || '{}');
      const session = Array.isArray(raw.sessions) ? raw.sessions[0] : null;
      return session ? {
        currentDirectory: session.currentDirectory,
        selectedFilePath: session.selectedFilePath,
      } : null;
    });
    assert.equal(repairedSessionState?.currentDirectory, workspaceRoot, 'Code UI should replace stale local currentDirectory with the backend workspace root');
    assert.equal(repairedSessionState?.selectedFilePath, null, 'Code UI should not preserve a stale selected file outside the workspace');

    const chatTab = page.locator('[data-code-assistant-tab="chat"]');
    const activityTab = page.locator('[data-code-assistant-tab="activity"]');
    await Promise.all([
      chatTab.waitFor(),
      activityTab.waitFor(),
    ]);
    assert.equal(await chatTab.getAttribute('aria-selected'), 'true', 'Chat tab should be active by default');
    assert.match(await page.locator('.code-chat__title').textContent(), /Coding Assistant/);

    // Icon rail panel switching — switch to explorer
    await page.locator('[data-code-panel-switch="explorer"]').click();
    await page.waitForSelector('.code-side-panel__nav-btn[data-code-panel-switch="explorer"].is-active');
    // Collapse panel by clicking active icon
    await page.locator('[data-code-panel-switch="explorer"]').click();
    await page.waitForSelector('.code-page__shell.panel-collapsed');
    // Re-open explorer
    await page.locator('[data-code-panel-switch="explorer"]').click();
    await page.waitForFunction(() => !document.querySelector('.code-page__shell.panel-collapsed'));

    await page.locator('[data-code-tree-toggle]').filter({ hasText: 'src' }).click();
    await page.locator('[data-code-tree-file]').filter({ hasText: 'example.ts' }).click();
    await page.waitForSelector('text=example.ts');
    // Wait for Monaco editor to mount and contain expected content
    await page.waitForFunction(() => {
      const monaco = window.monaco;
      if (!monaco) return false;
      const models = monaco.editor.getModels();
      return models.some((m) => m.getValue().includes('answerValue = 41'));
    }, null, { timeout: 15000 });
    const editorContent = await page.evaluate(() => {
      const models = window.monaco?.editor?.getModels() || [];
      const model = models.find((m) => m.getValue().includes('answerValue'));
      return model ? model.getValue() : '';
    });
    assert.match(editorContent, /answerValue = 41/);

    const liveGeneratedPath = path.join(workspaceRoot, 'src', 'live-generated.ts');
    fs.writeFileSync(liveGeneratedPath, 'export const liveGenerated = true;\n');
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('[data-code-tree-file]')).some((node) => (node.textContent || '').includes('live-generated.ts'));
    }, null, { timeout: 12000 });

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('.code-terminal-pane__badge')).some((node) => {
        const text = (node.textContent || '').trim().toLowerCase();
        return text === 'connected' || text === 'connecting';
      });
    });
    await page.waitForSelector('.code-terminal__viewport .xterm');

    const draftInput = page.locator('[data-code-chat-form] textarea[name="message"]');
    await draftInput.click();
    await draftInput.type('Focus should stay in the code chat input.');
    await page.waitForTimeout(6000);
    const draftFocusState = await page.evaluate(() => {
      const active = document.activeElement;
      const draft = document.querySelector('[data-code-chat-form] textarea[name="message"]');
      return {
        activeName: active?.getAttribute?.('name') || '',
        inChat: !!active?.closest?.('[data-code-chat-form]'),
        value: draft?.value || '',
      };
    });
    assert.equal(draftFocusState.inChat, true, 'Code chat input should keep focus during background refresh');
    assert.equal(draftFocusState.activeName, 'message', 'Code chat input should remain the active control');
    assert.match(draftFocusState.value, /Focus should stay in the code chat input/);
    await draftInput.fill('');

    await page.fill('[data-code-chat-form] textarea[name="message"]', 'Search the workspace for answerValue and tell me where it is defined.');
    await page.press('[data-code-chat-form] textarea[name="message"]', 'Enter');
    await page.waitForFunction(() => {
      const pendingUser = document.querySelector('.code-message.is-pending');
      const thinking = document.querySelector('.code-message.is-thinking');
      return !!pendingUser && !!thinking && (pendingUser.textContent || '').includes('Search the workspace');
    });
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('.code-message')).some((node) => (node.textContent || '').includes('answerValue'));
    });
    assert.equal(await page.locator('.code-chat__history').textContent().then((text) => text.includes('[Code Workspace Context]')), false, 'Code chat should not render internal prompt wrapper text');
    assert.equal(await chatTab.getAttribute('aria-selected'), 'true', 'Chat tab should stay active after a normal coding reply');

    await activityTab.click();
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('.code-status-card strong, .approval-card')).length > 0
        || !!document.querySelector('.code-assistant-panel__body');
    });
    await chatTab.click();
    await page.waitForSelector('.code-chat__history');

    await page.fill('[data-code-chat-form] textarea[name="message"]', 'Give me a slow repo summary.');
    await page.click('[data-code-chat-form] button[type="submit"]');
    await page.waitForFunction(() => {
      const pendingUser = document.querySelector('.code-message.is-pending');
      const thinking = document.querySelector('.code-message.is-thinking');
      return !!pendingUser && !!thinking && (pendingUser.textContent || '').includes('slow repo summary');
    });
    await page.waitForFunction(() => {
      const history = Array.from(document.querySelectorAll('.code-message'));
      const summaries = history.filter((node) => (node.textContent || '').includes('slow repo summary'));
      const finalReply = history.some((node) => (node.textContent || '').includes('This repo contains a src directory'));
      const pending = document.querySelector('.code-message.is-pending');
      const thinking = document.querySelector('.code-message.is-thinking');
      return summaries.length === 1 && finalReply && !pending && !thinking;
    }, null, { timeout: 15000 });

    // Code tools within the workspace are auto-approved, so the edit should
    // complete without requiring manual approval.
    await page.fill('[data-code-chat-form] textarea[name="message"]', 'Make the answer 42 in the selected file.');
    await page.click('[data-code-chat-form] button[type="submit"]');
    await page.waitForFunction(() => {
      // Wait for the assistant reply (non-pending, non-thinking)
      const messages = document.querySelectorAll('.code-message');
      const thinking = document.querySelector('.code-message.is-thinking');
      const pending = document.querySelector('.code-message.is-pending');
      return messages.length >= 4 && !thinking && !pending;
    }, null, { timeout: 30000 });
    assert.match(fs.readFileSync(examplePath, 'utf-8'), /answerValue = 42/);

    await chatTab.click();
    await page.waitForSelector('.code-chat__history');

    await page.click('a[data-page="dashboard"]');
    await page.waitForSelector('.code-page', { state: 'detached' });
    assert.equal(await page.locator('#chat-panel').isVisible(), true, 'Global chat panel should reappear off the code route');
    await page.waitForTimeout(6000);
    assert.equal(await page.locator('.code-page').count(), 0, 'Leaving Code should not be overwritten by a delayed Code rerender');
    assert.equal(await page.locator('#chat-panel').isVisible(), true, 'Global chat panel should stay visible after leaving Code');

    await page.click('a[data-page="code"]');
    await page.waitForSelector('.code-page');
    assert.equal(await page.locator('#chat-panel').isHidden(), true, 'Global chat panel should hide again on return to code');
    await page.click('[data-code-refresh-file]');
    // Wait for Monaco to reload with updated content after refresh
    await page.waitForFunction(() => {
      const monaco = window.monaco;
      if (!monaco) return false;
      const models = monaco.editor.getModels();
      return models.some((m) => m.getValue().includes('answerValue = 42'));
    }, null, { timeout: 15000 });
    const refreshedContent = await page.evaluate(() => {
      const models = window.monaco?.editor?.getModels() || [];
      const model = models.find((m) => m.getValue().includes('answerValue'));
      return model ? model.getValue() : '';
    });
    assert.match(refreshedContent, /answerValue = 42/);

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
