import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

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

function createChatCompletionResponse({ model, content = '', finishReason = 'stop', toolCalls }) {
  const message = { role: 'assistant', content };
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

async function startFakeProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'memory-surface-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readJsonBody(req);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const lastUser = [...messages].reverse().find((message) => message?.role === 'user')?.content ?? '';
      if (/remember that the slash operator prefers wiki surfacing/i.test(String(lastUser))) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createChatCompletionResponse({
          model: 'memory-surface-model',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'tool-call-memory-save',
            name: 'memory_save',
            arguments: JSON.stringify({
              content: 'Slash Operator prefers a unified memory wiki surface.',
              category: 'Preferences',
              summary: 'Operator wants all durable memory visible through one memory wiki.',
            }),
          }],
        })));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatCompletionResponse({
        model: 'memory-surface-model',
        content: 'ok',
      })));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

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

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate port');
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForHealth(baseUrl, token, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for Guardian health endpoint');
}

async function requestJson(baseUrl, token, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function createHarnessConfig({ providerBaseUrl, port, token, tempRoot }) {
  return `defaultProvider: local
llm:
  local:
    provider: ollama
    model: memory-surface-model
    baseUrl: ${providerBaseUrl}
channels:
  web:
    enabled: true
    port: ${port}
    host: 127.0.0.1
    auth:
      mode: bearer_required
      token: ${token}
assistant:
  memory:
    enabled: true
    retentionDays: 30
    knowledgeBase:
      enabled: true
      basePath: ${JSON.stringify(path.join(tempRoot, 'memory'))}
      readOnly: false
      maxContextChars: 4000
      maxFileChars: 20000
      maxEntryChars: 2000
      maxEntriesPerScope: 500
      autoFlush: true
guardian:
  enabled: true
runtime:
  logLevel: error
agents:
  - id: default
    name: Default
    systemPrompt: You are Guardian.
`;
}

async function main() {
  const fakeProvider = await startFakeProvider();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-memory-surface-'));
  const configPath = path.join(tempRoot, 'config.yaml');
  const port = await getFreePort();
  const token = 'memory-surface-token';
  fs.writeFileSync(configPath, createHarnessConfig({ providerBaseUrl: fakeProvider.baseUrl, port, token, tempRoot }), 'utf8');

  const env = {
    ...process.env,
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    XDG_CONFIG_HOME: path.join(tempRoot, '.config'),
    XDG_STATE_HOME: path.join(tempRoot, '.state'),
    XDG_DATA_HOME: path.join(tempRoot, '.data'),
  };

  const guardian = spawn('npx', ['tsx', 'src/index.ts', configPath], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  guardian.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl, token);

    const saved = await requestJson(baseUrl, token, 'POST', '/api/tools/run', {
      toolName: 'memory_save',
      agentId: 'default',
      userId: 'web-user',
      origin: 'web',
      args: {
        content: 'Slash Operator prefers a unified memory wiki surface.',
        category: 'Preferences',
        summary: 'Operator wants all durable memory visible through one memory wiki.',
      },
    });
    assert.equal(saved.success, true, `Expected memory_save to succeed: ${JSON.stringify(saved)}`);

    const created = await requestJson(baseUrl, token, 'POST', '/api/memory/curate', {
      action: 'create',
      scope: 'global',
      title: 'Operator wiki standing note',
      content: 'Prefer the unified memory wiki over raw filesystem inspection.',
      summary: 'Standing note for the operator-facing memory wiki.',
      tags: ['preferences', 'wiki'],
      reason: 'Capture the uplift operator preference.',
      actor: 'web-user',
    });
    assert.equal(created.success, true, `Expected memory curate create to succeed: ${JSON.stringify(created)}`);

    const memory = await requestJson(baseUrl, token, 'GET', '/api/memory?includeInactive=true&includeCodeSessions=true&limit=50');
    assert.equal(memory.global.scope, 'global');
    assert.equal(memory.principalAgentId, 'default');
    assert.ok(Array.isArray(memory.global.entries));
    assert.ok(memory.global.entries.some((entry) => String(entry.content).includes('Slash Operator prefers a unified memory wiki surface.')));
    assert.ok(memory.global.entries.some((entry) => entry.displayTitle === 'Operator wiki standing note'));
    assert.ok(Array.isArray(memory.global.wikiPages));
    assert.ok(memory.global.wikiPages.some((page) => page.title === 'Operator wiki standing note' && page.editable === true));
    assert.ok(Array.isArray(memory.global.lintFindings));
    assert.ok(memory.maintenance && typeof memory.maintenance.scopeCount === 'number');
    assert.ok(Array.isArray(memory.recentAudit));
    assert.ok(memory.recentAudit.some((event) => event.type === 'memory_wiki.created'));
    assert.ok(Array.isArray(memory.codeSessions));

    const createdPage = memory.global.wikiPages.find((page) => page.title === 'Operator wiki standing note');
    assert.ok(createdPage?.entryId, 'Expected created page entry id to be returned from memory view');

    const updated = await requestJson(baseUrl, token, 'POST', '/api/memory/curate', {
      action: 'update',
      scope: 'global',
      entryId: createdPage.entryId,
      title: 'Operator wiki standing note',
      content: 'Prefer the unified memory wiki and keep lint findings visible.',
      summary: 'Updated standing note for the operator-facing memory wiki.',
      tags: ['preferences', 'wiki', 'lint'],
      reason: 'Capture the lint/hygiene expectation.',
      actor: 'web-user',
    });
    assert.equal(updated.success, true, `Expected memory curate update to succeed: ${JSON.stringify(updated)}`);

    const afterUpdate = await requestJson(baseUrl, token, 'GET', '/api/memory?includeInactive=true&includeCodeSessions=true&limit=50');
    const updatedPage = afterUpdate.global.wikiPages.find((page) => page.entryId === createdPage.entryId);
    assert.equal(updatedPage?.body, 'Prefer the unified memory wiki and keep lint findings visible.');
    assert.ok(afterUpdate.recentAudit.some((event) => event.type === 'memory_wiki.updated'));

    const archived = await requestJson(baseUrl, token, 'POST', '/api/memory/curate', {
      action: 'archive',
      scope: 'global',
      entryId: createdPage.entryId,
      reason: 'Archive test path',
      actor: 'web-user',
    });
    assert.equal(archived.success, true, `Expected memory curate archive to succeed: ${JSON.stringify(archived)}`);

    const afterArchive = await requestJson(baseUrl, token, 'GET', '/api/memory?includeInactive=true&includeCodeSessions=true&limit=50');
    assert.ok(afterArchive.global.entries.some((entry) => entry.id === createdPage.entryId && entry.status === 'archived'));
    assert.ok(afterArchive.recentAudit.some((event) => event.type === 'memory_wiki.archived'));

    console.log('Memory surface harness passed.');
  } finally {
    guardian.kill('SIGTERM');
    await once(guardian, 'exit').catch(() => {});
    await fakeProvider.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (stderrChunks.length > 0) {
      const stderr = stderrChunks.join('');
      if (stderr.trim()) {
        process.stderr.write(stderr);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
