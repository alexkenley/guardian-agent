import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import { DEFAULT_HARNESS_OLLAMA_MODEL, resolveHarnessOllamaModel } from './ollama-harness-defaults.mjs';

const FAKE_MODEL_NAME = 'second-brain-chat-crud-harness-model';
const DAY_MS = 24 * 60 * 60 * 1000;

function printHelp() {
  console.log([
    'Second Brain chat CRUD harness',
    '',
    'Usage:',
    '  node scripts/test-second-brain-chat-crud.mjs [options]',
    '',
    'Options:',
    '  --use-ollama   Use a real reachable Ollama endpoint instead of the fake provider.',
    '  --keep-tmp     Preserve the temporary harness directory under the system temp folder.',
    '  --help         Show this help text.',
    '',
    'Environment:',
    '  HARNESS_USE_REAL_OLLAMA=1',
    '  HARNESS_KEEP_TMP=1',
    `  HARNESS_OLLAMA_BASE_URL, HARNESS_OLLAMA_MODEL (default ${DEFAULT_HARNESS_OLLAMA_MODEL}), HARNESS_WSL_HOST_IP`,
    '  HARNESS_OLLAMA_BIN, HARNESS_AUTOSTART_LOCAL_OLLAMA,',
    '  HARNESS_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD',
  ].join('\n'));
}

function parseHarnessOptions() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    printHelp();
    process.exit(0);
  }
  return {
    useRealOllama: args.has('--use-ollama') || process.env.HARNESS_USE_REAL_OLLAMA === '1',
    keepTmp: args.has('--keep-tmp') || process.env.HARNESS_KEEP_TMP === '1',
    ollamaBaseUrl: process.env.HARNESS_OLLAMA_BASE_URL?.trim() || '',
    ollamaModel: process.env.HARNESS_OLLAMA_MODEL?.trim() || '',
    wslHostIp: process.env.HARNESS_WSL_HOST_IP?.trim() || '',
    ollamaBin: process.env.HARNESS_OLLAMA_BIN?.trim() || '',
    autostartLocalOllama: process.env.HARNESS_AUTOSTART_LOCAL_OLLAMA !== '0',
    bypassLocalModelComplexityGuard: process.env.HARNESS_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD !== '0',
  };
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

function createToolCallPayload(name, args, suffix = name) {
  return createChatCompletionResponse({
    model: FAKE_MODEL_NAME,
    finishReason: 'tool_calls',
    toolCalls: [{
      id: `second-brain-chat-${suffix}-${Date.now()}`,
      name,
      arguments: JSON.stringify(args),
    }],
  });
}

function createTextPayload(content) {
  return createChatCompletionResponse({
    model: FAKE_MODEL_NAME,
    content,
  });
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

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate free port');
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
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
  throw new Error('GuardianAgent did not become healthy within 90 seconds.');
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function requestJson(baseUrl, token, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function getPrivilegedTicket(baseUrl, token, action) {
  const response = await requestJson(baseUrl, token, 'POST', '/api/auth/ticket', { action });
  assert.equal(typeof response?.ticket, 'string', `Expected privileged ticket for ${action}: ${JSON.stringify(response)}`);
  return response.ticket;
}

async function requestJsonNoAuth(url, timeoutMs = 2_500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
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
    // Ignore missing or unreadable resolv.conf.
  }

  return candidates;
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
  const result = await requestJsonNoAuth(`${candidate}/api/tags`);
  return Array.isArray(result?.models) ? result.models : [];
}

async function maybeStartLocalOllama(options, candidate) {
  if (!options.autostartLocalOllama || !isLoopbackOllamaUrl(candidate)) {
    return null;
  }

  const homeDir = os.homedir();
  const binCandidates = [
    options.ollamaBin,
    path.join(homeDir, '.local', 'bin', 'ollama'),
    'ollama',
  ].filter(Boolean);

  let ollamaBin = '';
  for (const candidateBin of binCandidates) {
    try {
      const processHandle = spawn(candidateBin, ['--version'], { stdio: 'ignore' });
      const exitCode = await new Promise((resolve) => {
        processHandle.on('exit', resolve);
        processHandle.on('error', () => resolve(-1));
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

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-second-brain-chat-ollama-'));
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
      } else if (processHandle.pid) {
        process.kill(-processHandle.pid, 'SIGTERM');
      }
    }
    logStream.end();
  };

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

  await shutdown();
  throw new Error(`Failed to autostart local Ollama at ${candidate}. See ${logPath}`);
}

function extractLatestUser(messages) {
  return String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '');
}

function extractScenarioLookupKey(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? content.trim();
}

function parseToolResultMessage(content) {
  const raw = String(content ?? '');
  const nameMatch = raw.match(/<tool_result name="([^"]+)"/);
  const openTagEnd = raw.indexOf('>');
  const closeTagStart = raw.lastIndexOf('</tool_result>');
  if (!nameMatch || openTagEnd === -1 || closeTagStart === -1) {
    return null;
  }
  const payloadText = raw
    .slice(openTagEnd + 1, closeTagStart)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('[WARNING:'))
    .join('\n');
  let payload = null;
  if (payloadText) {
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = payloadText;
    }
  }
  return {
    name: nameMatch[1],
    payload,
  };
}

function parseToolResults(toolMessages) {
  return toolMessages
    .map((message) => parseToolResultMessage(String(message.content ?? '')))
    .filter(Boolean);
}

function hasToolResult(toolResults, toolName) {
  return toolResults.some((entry) => entry.name === toolName);
}

function getToolOutput(toolResults, toolName) {
  const entry = [...toolResults].reverse().find((result) => result.name === toolName);
  return entry?.payload?.output;
}

function findByTitle(records, title) {
  return Array.isArray(records)
    ? records.find((record) => String(record?.title ?? '') === title) ?? null
    : null;
}

function findByName(records, name) {
  return Array.isArray(records)
    ? records.find((record) => String(record?.name ?? '') === name) ?? null
    : null;
}

function findRoutineTemplate(records, templateId) {
  return Array.isArray(records)
    ? records.find((record) => String(record?.templateId ?? '') === templateId) ?? null
    : null;
}

function buildRouteDecision({ operation, personalItemType, summary, calendarTarget }) {
  return {
    route: 'personal_assistant_task',
    confidence: 'high',
    operation,
    summary,
    turnRelation: 'new_request',
    resolution: 'ready',
    missingFields: [],
    ...(personalItemType ? { personalItemType } : {}),
    ...(calendarTarget ? { calendarTarget } : {}),
  };
}

function buildCreateScenario({ decision, findQuery, mutationTool, mutationArgs, finalContent }) {
  return {
    decision,
    fakeRequiredJobs: ['find_tools', mutationTool],
    realRequiredJobs: [mutationTool],
    run({ toolResults }) {
      if (!hasToolResult(toolResults, 'find_tools')) {
        return createToolCallPayload('find_tools', {
          query: findQuery,
          maxResults: 10,
        }, 'find-tools');
      }
      if (!hasToolResult(toolResults, mutationTool)) {
        return createToolCallPayload(mutationTool, mutationArgs, mutationTool);
      }
      return createTextPayload(finalContent);
    },
  };
}

function buildLookupMutationScenario({
  decision,
  findQuery,
  lookupTool,
  lookupArgs,
  mutationTool,
  selectRecord,
  buildMutationArgs,
  finalContent,
}) {
  return {
    decision,
    fakeRequiredJobs: ['find_tools', lookupTool, mutationTool],
    realRequiredJobs: [mutationTool],
    run({ toolResults }) {
      if (!hasToolResult(toolResults, 'find_tools')) {
        return createToolCallPayload('find_tools', {
          query: findQuery,
          maxResults: 10,
        }, 'find-tools');
      }
      if (!hasToolResult(toolResults, lookupTool)) {
        return createToolCallPayload(lookupTool, lookupArgs, lookupTool);
      }
      const lookupOutput = getToolOutput(toolResults, lookupTool);
      const record = selectRecord(lookupOutput);
      assert.ok(record, `Expected ${lookupTool} to return a matching record for the chat CRUD harness.`);
      if (!hasToolResult(toolResults, mutationTool)) {
        return createToolCallPayload(mutationTool, buildMutationArgs(record), mutationTool);
      }
      return createTextPayload(finalContent);
    },
  };
}

async function startFakeProvider(steps, scenarioLog) {
  const stepByPrompt = new Map(steps.map((step) => [step.prompt, step]));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: FAKE_MODEL_NAME, size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        const parsed = await readJsonBody(req);
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const tools = Array.isArray(parsed.tools)
          ? parsed.tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean)
          : [];
        const latestUser = extractLatestUser(messages);
        const lookupKey = extractScenarioLookupKey(latestUser);
        const toolMessages = messages.filter((message) => message.role === 'tool');
        const toolResults = parseToolResults(toolMessages);
        const step = stepByPrompt.get(lookupKey) ?? null;

        scenarioLog.push({
          latestUser,
          lookupKey,
          tools,
          toolNamesSeen: toolResults.map((entry) => entry.name),
        });

        if (tools.includes('route_intent')) {
          const decision = step?.scenario?.decision ?? {
            route: 'general_assistant',
            confidence: 'medium',
            operation: 'inspect',
            summary: 'General assistant request.',
            turnRelation: 'new_request',
            resolution: 'ready',
            missingFields: [],
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createToolCallPayload('route_intent', decision, 'route-intent')));
          return;
        }

        if (step?.scenario) {
          const payload = step.scenario.run({ toolResults, tools });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(createTextPayload('Second Brain chat CRUD harness provider response.')));
        return;
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        return;
      }
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
    model: FAKE_MODEL_NAME,
    mode: 'fake',
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function resolveHarnessProvider(options, steps, scenarioLog) {
  if (!options.useRealOllama) {
    return startFakeProvider(steps, scenarioLog);
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

function formatPromptDateTime(timestamp) {
  const value = new Date(timestamp);
  const pad = (part) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function buildFixtures(tmpDir) {
  const suffix = Date.now();
  const linkPath = path.join(tmpDir, `second-brain-chat-reference-${suffix}.md`);
  fs.writeFileSync(linkPath, '# Harness Reference\n\nSecond Brain chat CRUD harness file.\n');

  const taskDueAt = Date.now() + (2 * DAY_MS);
  const eventStart = Date.now() + DAY_MS + (2 * 60 * 60 * 1000);
  const eventEnd = eventStart + (60 * 60 * 1000);

  return {
    note: {
      createTitle: `Harness Chat Note ${suffix}`,
      createContent: 'Created by the Second Brain chat CRUD harness.',
      updatedTitle: `Harness Chat Note ${suffix} Updated`,
      updatedContent: 'Updated by the Second Brain chat CRUD harness.',
    },
    task: {
      createTitle: `Harness Chat Task ${suffix}`,
      createDetails: 'Initial chat-created task details.',
      updatedTitle: `Harness Chat Task ${suffix} Updated`,
      updatedDetails: 'Updated task details from the chat CRUD harness.',
      dueAt: taskDueAt,
      duePrompt: formatPromptDateTime(taskDueAt),
    },
    calendar: {
      createTitle: `Harness Chat Event ${suffix}`,
      createDescription: 'Initial local calendar event from the chat CRUD harness.',
      createLocation: 'Desk',
      updatedTitle: `Harness Chat Event ${suffix} Updated`,
      updatedDescription: 'Updated local calendar event from the chat CRUD harness.',
      updatedLocation: 'Meeting room',
      startsAt: eventStart,
      endsAt: eventEnd,
      rangeStart: eventStart - DAY_MS,
      rangeEnd: eventEnd + DAY_MS,
      startPrompt: formatPromptDateTime(eventStart),
      endPrompt: formatPromptDateTime(eventEnd),
    },
    person: {
      createName: `Harness Contact ${suffix}`,
      updatedName: `Harness Contact ${suffix} Updated`,
      email: `harness.contact.${suffix}@example.com`,
      title: 'Operator',
      company: 'Guardian Harness',
      createNotes: 'Initial relationship notes from the chat harness.',
      updatedNotes: 'Updated relationship notes from the chat harness.',
    },
    library: {
      createTitle: `Harness Library Item ${suffix}`,
      updatedTitle: `Harness Library Item ${suffix} Updated`,
      createSummary: 'Initial file reference saved through the chat harness.',
      updatedSummary: 'Updated file reference saved through the chat harness.',
      linkPath,
      normalizedUrl: pathToFileURL(linkPath).toString(),
    },
    brief: {
      updatedTitle: `Harness Morning Brief ${suffix}`,
      appendedLine: 'Edited by the Second Brain chat CRUD harness.',
    },
    routine: {
      templateId: 'pre-meeting-brief',
      createName: `Harness Pre-Meeting Brief ${suffix}`,
      updatedName: `Harness Pre-Meeting Brief ${suffix} Updated`,
    },
  };
}

function buildSteps(fixtures) {
  return [
    {
      id: 'note-create',
      prompt: `Use Second Brain to create a note titled "${fixtures.note.createTitle}" with content "${fixtures.note.createContent}" and tags harness, chat-crud.`,
      scenario: buildCreateScenario({
        decision: buildRouteDecision({
          operation: 'save',
          personalItemType: 'note',
          summary: 'Save a Second Brain note.',
        }),
        findQuery: 'second brain notes note create update delete',
        mutationTool: 'second_brain_note_upsert',
        mutationArgs: {
          title: fixtures.note.createTitle,
          content: fixtures.note.createContent,
          tags: ['harness', 'chat-crud'],
        },
        finalContent: `Created the note "${fixtures.note.createTitle}" in Second Brain.`,
      }),
      async verify({ baseUrl, token, records }) {
        const note = await waitFor(async () => findByTitle(await listNotes(baseUrl, token), fixtures.note.createTitle), 12_000, 'Expected created note from chat flow.');
        assert.equal(note.content, fixtures.note.createContent);
        assert.deepEqual(note.tags, ['harness', 'chat-crud']);
        records.noteId = note.id;
      },
    },
    {
      id: 'note-update',
      prompt: `Use Second Brain to update the note titled "${fixtures.note.createTitle}" so the title becomes "${fixtures.note.updatedTitle}" and the content becomes "${fixtures.note.updatedContent}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'note',
          summary: 'Update a Second Brain note.',
        }),
        findQuery: 'second brain notes note update edit by title',
        lookupTool: 'second_brain_note_list',
        lookupArgs: { includeArchived: true, limit: 50 },
        mutationTool: 'second_brain_note_upsert',
        selectRecord: (records) => findByTitle(records, fixtures.note.createTitle),
        buildMutationArgs: (record) => ({
          id: record.id,
          title: fixtures.note.updatedTitle,
          content: fixtures.note.updatedContent,
          tags: record.tags,
          pinned: record.pinned,
          archived: false,
        }),
        finalContent: `Updated the note to "${fixtures.note.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const note = await waitFor(async () => findByTitle(await listNotes(baseUrl, token), fixtures.note.updatedTitle), 12_000, 'Expected updated note from chat flow.');
        assert.equal(note.id, records.noteId);
        assert.equal(note.content, fixtures.note.updatedContent);
      },
    },
    {
      id: 'note-delete',
      prompt: `Use Second Brain to delete the note titled "${fixtures.note.updatedTitle}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'note',
          summary: 'Delete a Second Brain note.',
        }),
        findQuery: 'second brain notes note delete by title',
        lookupTool: 'second_brain_note_list',
        lookupArgs: { includeArchived: true, limit: 50 },
        mutationTool: 'second_brain_note_delete',
        selectRecord: (records) => findByTitle(records, fixtures.note.updatedTitle),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the note "${fixtures.note.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listNotes(baseUrl, token)).some((note) => note.id === records.noteId), 12_000, 'Expected note deletion from chat flow.');
      },
    },
    {
      id: 'task-create',
      prompt: `Create a Second Brain task titled "${fixtures.task.createTitle}" with details "${fixtures.task.createDetails}", high priority, and due at ${fixtures.task.duePrompt}.`,
      scenario: buildCreateScenario({
        decision: buildRouteDecision({
          operation: 'create',
          personalItemType: 'task',
          summary: 'Create a Second Brain task.',
        }),
        findQuery: 'second brain tasks task create update delete',
        mutationTool: 'second_brain_task_upsert',
        mutationArgs: {
          title: fixtures.task.createTitle,
          details: fixtures.task.createDetails,
          priority: 'high',
          dueAt: fixtures.task.dueAt,
        },
        finalContent: `Created the task "${fixtures.task.createTitle}" in Second Brain.`,
      }),
      async verify({ baseUrl, token, records }) {
        const task = await waitFor(async () => findByTitle(await listTasks(baseUrl, token), fixtures.task.createTitle), 12_000, 'Expected created task from chat flow.');
        assert.equal(task.details, fixtures.task.createDetails);
        assert.equal(task.priority, 'high');
        assert.ok(task.dueAt != null, `Expected dueAt on created task: ${JSON.stringify(task)}`);
        records.taskId = task.id;
      },
    },
    {
      id: 'task-update',
      prompt: `Update the Second Brain task titled "${fixtures.task.createTitle}" so the title becomes "${fixtures.task.updatedTitle}", the details become "${fixtures.task.updatedDetails}", and mark it in progress.`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'task',
          summary: 'Update a Second Brain task.',
        }),
        findQuery: 'second brain tasks task update edit by title',
        lookupTool: 'second_brain_task_list',
        lookupArgs: { limit: 50 },
        mutationTool: 'second_brain_task_upsert',
        selectRecord: (records) => findByTitle(records, fixtures.task.createTitle),
        buildMutationArgs: (record) => ({
          id: record.id,
          title: fixtures.task.updatedTitle,
          details: fixtures.task.updatedDetails,
          status: 'in_progress',
          priority: record.priority ?? 'high',
          dueAt: record.dueAt ?? fixtures.task.dueAt,
        }),
        finalContent: `Updated the task to "${fixtures.task.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const task = await waitFor(async () => findByTitle(await listTasks(baseUrl, token), fixtures.task.updatedTitle), 12_000, 'Expected updated task from chat flow.');
        assert.equal(task.id, records.taskId);
        assert.equal(task.details, fixtures.task.updatedDetails);
        assert.equal(task.status, 'in_progress');
      },
    },
    {
      id: 'task-delete',
      prompt: `Delete the Second Brain task titled "${fixtures.task.updatedTitle}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'task',
          summary: 'Delete a Second Brain task.',
        }),
        findQuery: 'second brain tasks task delete by title',
        lookupTool: 'second_brain_task_list',
        lookupArgs: { limit: 50 },
        mutationTool: 'second_brain_task_delete',
        selectRecord: (records) => findByTitle(records, fixtures.task.updatedTitle),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the task "${fixtures.task.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listTasks(baseUrl, token)).some((task) => task.id === records.taskId), 12_000, 'Expected task deletion from chat flow.');
      },
    },
    {
      id: 'calendar-create',
      prompt: `Using the local Guardian calendar in Second Brain, not Google or Microsoft, create an event titled "${fixtures.calendar.createTitle}" on ${fixtures.calendar.startPrompt} through ${fixtures.calendar.endPrompt} at "${fixtures.calendar.createLocation}" with description "${fixtures.calendar.createDescription}".`,
      scenario: buildCreateScenario({
        decision: buildRouteDecision({
          operation: 'create',
          personalItemType: 'calendar',
          calendarTarget: 'local',
          summary: 'Create a local Second Brain calendar event.',
        }),
        findQuery: 'second brain local calendar event create update delete',
        mutationTool: 'second_brain_calendar_upsert',
        mutationArgs: {
          title: fixtures.calendar.createTitle,
          description: fixtures.calendar.createDescription,
          startsAt: fixtures.calendar.startsAt,
          endsAt: fixtures.calendar.endsAt,
          location: fixtures.calendar.createLocation,
        },
        finalContent: `Created the local event "${fixtures.calendar.createTitle}" in Second Brain.`,
      }),
      async verify({ baseUrl, token, records }) {
        const event = await waitFor(async () => findByTitle(await listCalendar(baseUrl, token, fixtures.calendar), fixtures.calendar.createTitle), 12_000, 'Expected created local calendar event from chat flow.');
        assert.equal(event.location, fixtures.calendar.createLocation);
        assert.equal(event.description, fixtures.calendar.createDescription);
        records.calendarId = event.id;
      },
    },
    {
      id: 'calendar-update',
      prompt: `Using the local Guardian calendar in Second Brain, update the event titled "${fixtures.calendar.createTitle}" so the title becomes "${fixtures.calendar.updatedTitle}", the location becomes "${fixtures.calendar.updatedLocation}", and the description becomes "${fixtures.calendar.updatedDescription}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'calendar',
          calendarTarget: 'local',
          summary: 'Update a local Second Brain calendar event.',
        }),
        findQuery: 'second brain local calendar event update by title',
        lookupTool: 'second_brain_calendar_list',
        lookupArgs: {
          fromTime: fixtures.calendar.rangeStart,
          toTime: fixtures.calendar.rangeEnd,
          limit: 50,
          includePast: true,
        },
        mutationTool: 'second_brain_calendar_upsert',
        selectRecord: (records) => findByTitle(records, fixtures.calendar.createTitle),
        buildMutationArgs: (record) => ({
          id: record.id,
          title: fixtures.calendar.updatedTitle,
          description: fixtures.calendar.updatedDescription,
          startsAt: record.startsAt,
          endsAt: record.endsAt ?? fixtures.calendar.endsAt,
          location: fixtures.calendar.updatedLocation,
        }),
        finalContent: `Updated the local event to "${fixtures.calendar.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const event = await waitFor(async () => findByTitle(await listCalendar(baseUrl, token, fixtures.calendar), fixtures.calendar.updatedTitle), 12_000, 'Expected updated local calendar event from chat flow.');
        assert.equal(event.id, records.calendarId);
        assert.equal(event.location, fixtures.calendar.updatedLocation);
        assert.equal(event.description, fixtures.calendar.updatedDescription);
      },
    },
    {
      id: 'calendar-delete',
      prompt: `Using the local Guardian calendar in Second Brain, delete the event titled "${fixtures.calendar.updatedTitle}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'calendar',
          calendarTarget: 'local',
          summary: 'Delete a local Second Brain calendar event.',
        }),
        findQuery: 'second brain local calendar event delete by title',
        lookupTool: 'second_brain_calendar_list',
        lookupArgs: {
          fromTime: fixtures.calendar.rangeStart,
          toTime: fixtures.calendar.rangeEnd,
          limit: 50,
          includePast: true,
        },
        mutationTool: 'second_brain_calendar_delete',
        selectRecord: (records) => findByTitle(records, fixtures.calendar.updatedTitle),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the local event "${fixtures.calendar.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listCalendar(baseUrl, token, fixtures.calendar)).some((event) => event.id === records.calendarId), 12_000, 'Expected local calendar deletion from chat flow.');
      },
    },
    {
      id: 'person-create',
      prompt: `Create a Second Brain contact named "${fixtures.person.createName}" with email "${fixtures.person.email}", title "${fixtures.person.title}", company "${fixtures.person.company}", relationship work, and notes "${fixtures.person.createNotes}".`,
      scenario: buildCreateScenario({
        decision: buildRouteDecision({
          operation: 'create',
          personalItemType: 'person',
          summary: 'Create a person record in Second Brain.',
        }),
        findQuery: 'second brain people contacts create update delete',
        mutationTool: 'second_brain_person_upsert',
        mutationArgs: {
          name: fixtures.person.createName,
          email: fixtures.person.email,
          title: fixtures.person.title,
          company: fixtures.person.company,
          relationship: 'work',
          notes: fixtures.person.createNotes,
        },
        finalContent: `Created the contact "${fixtures.person.createName}" in Second Brain.`,
      }),
      async verify({ baseUrl, token, records }) {
        const person = await waitFor(async () => findByName(await listPeople(baseUrl, token), fixtures.person.createName), 12_000, 'Expected created contact from chat flow.');
        assert.equal(person.email, fixtures.person.email);
        assert.equal(person.notes, fixtures.person.createNotes);
        records.personId = person.id;
      },
    },
    {
      id: 'person-update',
      prompt: `Update the Second Brain contact named "${fixtures.person.createName}" so the name becomes "${fixtures.person.updatedName}" and the notes become "${fixtures.person.updatedNotes}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'person',
          summary: 'Update a person record in Second Brain.',
        }),
        findQuery: 'second brain contacts people update delete by name',
        lookupTool: 'second_brain_people_list',
        lookupArgs: { limit: 50 },
        mutationTool: 'second_brain_person_upsert',
        selectRecord: (records) => findByName(records, fixtures.person.createName),
        buildMutationArgs: (record) => ({
          id: record.id,
          name: fixtures.person.updatedName,
          email: record.email,
          title: record.title,
          company: record.company,
          relationship: record.relationship ?? 'work',
          notes: fixtures.person.updatedNotes,
          ...(record.lastContactAt == null ? {} : { lastContactAt: record.lastContactAt }),
        }),
        finalContent: `Updated the contact to "${fixtures.person.updatedName}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const person = await waitFor(async () => findByName(await listPeople(baseUrl, token), fixtures.person.updatedName), 12_000, 'Expected updated contact from chat flow.');
        assert.equal(person.id, records.personId);
        assert.equal(person.notes, fixtures.person.updatedNotes);
      },
    },
    {
      id: 'person-delete',
      prompt: `Delete the Second Brain contact named "${fixtures.person.updatedName}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'person',
          summary: 'Delete a person record from Second Brain.',
        }),
        findQuery: 'second brain contacts people delete by name',
        lookupTool: 'second_brain_people_list',
        lookupArgs: { limit: 50 },
        mutationTool: 'second_brain_person_delete',
        selectRecord: (records) => findByName(records, fixtures.person.updatedName),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the contact "${fixtures.person.updatedName}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listPeople(baseUrl, token)).some((person) => person.id === records.personId), 12_000, 'Expected contact deletion from chat flow.');
      },
    },
    {
      id: 'library-create',
      prompt: `Save a Second Brain library item titled "${fixtures.library.createTitle}" pointing to "${fixtures.library.linkPath}" as a file reference with summary "${fixtures.library.createSummary}".`,
      scenario: buildCreateScenario({
        decision: buildRouteDecision({
          operation: 'save',
          personalItemType: 'library',
          summary: 'Save a Second Brain library item.',
        }),
        findQuery: 'second brain library saved references create update delete',
        mutationTool: 'second_brain_library_upsert',
        mutationArgs: {
          title: fixtures.library.createTitle,
          url: fixtures.library.linkPath,
          kind: 'file',
          summary: fixtures.library.createSummary,
          tags: ['harness', 'chat-crud'],
        },
        finalContent: `Saved the library item "${fixtures.library.createTitle}" in Second Brain.`,
      }),
      async verify({ baseUrl, token, records }) {
        const link = await waitFor(async () => findByTitle(await listLinks(baseUrl, token), fixtures.library.createTitle), 12_000, 'Expected created library item from chat flow.');
        assert.equal(link.url, fixtures.library.normalizedUrl);
        assert.equal(link.summary, fixtures.library.createSummary);
        records.linkId = link.id;
      },
    },
    {
      id: 'library-update',
      prompt: `Update the Second Brain library item titled "${fixtures.library.createTitle}" so the title becomes "${fixtures.library.updatedTitle}" and the summary becomes "${fixtures.library.updatedSummary}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'library',
          summary: 'Update a Second Brain library item.',
        }),
        findQuery: 'second brain library saved references update by title',
        lookupTool: 'second_brain_library_list',
        lookupArgs: { limit: 50 },
        mutationTool: 'second_brain_library_upsert',
        selectRecord: (records) => findByTitle(records, fixtures.library.createTitle),
        buildMutationArgs: (record) => ({
          id: record.id,
          title: fixtures.library.updatedTitle,
          url: record.url,
          summary: fixtures.library.updatedSummary,
          tags: record.tags,
          kind: record.kind,
        }),
        finalContent: `Updated the library item to "${fixtures.library.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const link = await waitFor(async () => findByTitle(await listLinks(baseUrl, token), fixtures.library.updatedTitle), 12_000, 'Expected updated library item from chat flow.');
        assert.equal(link.id, records.linkId);
        assert.equal(link.summary, fixtures.library.updatedSummary);
        assert.equal(link.url, fixtures.library.normalizedUrl);
      },
    },
    {
      id: 'library-delete',
      prompt: `Delete the Second Brain library item titled "${fixtures.library.updatedTitle}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'library',
          summary: 'Delete a Second Brain library item.',
        }),
        findQuery: 'second brain library saved references delete by title',
        lookupTool: 'second_brain_library_list',
        lookupArgs: { limit: 50 },
        mutationTool: 'second_brain_library_delete',
        selectRecord: (records) => findByTitle(records, fixtures.library.updatedTitle),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the library item "${fixtures.library.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listLinks(baseUrl, token)).some((link) => link.id === records.linkId), 12_000, 'Expected library deletion from chat flow.');
      },
    },
    {
      id: 'brief-create',
      prompt: 'Generate a morning brief in Second Brain.',
      scenario: buildCreateScenario({
        decision: buildRouteDecision({
          operation: 'create',
          personalItemType: 'brief',
          summary: 'Generate a morning brief in Second Brain.',
        }),
        findQuery: 'second brain brief morning pre meeting follow up create update delete',
        mutationTool: 'second_brain_generate_brief',
        mutationArgs: { kind: 'morning' },
        finalContent: 'Generated a morning brief in Second Brain.',
      }),
      async verify({ baseUrl, token, records }) {
        const brief = await waitFor(async () => {
          const briefs = await listBriefs(baseUrl, token);
          return Array.isArray(briefs) ? briefs.find((entry) => entry.kind === 'morning') ?? null : null;
        }, 12_000, 'Expected generated morning brief from chat flow.');
        assert.ok(String(brief.content ?? '').trim().length > 0, `Expected non-empty morning brief content: ${JSON.stringify(brief)}`);
        records.briefId = brief.id;
      },
    },
    {
      id: 'brief-update',
      prompt: `Update the latest morning brief in Second Brain so the title becomes "${fixtures.brief.updatedTitle}" and append "${fixtures.brief.appendedLine}" to the content.`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'brief',
          summary: 'Update the latest morning brief in Second Brain.',
        }),
        findQuery: 'second brain morning brief update delete',
        lookupTool: 'second_brain_brief_list',
        lookupArgs: { kind: 'morning', limit: 20 },
        mutationTool: 'second_brain_brief_update',
        selectRecord: (records) => Array.isArray(records) ? records.find((record) => record.kind === 'morning') ?? records[0] ?? null : null,
        buildMutationArgs: (record) => ({
          id: record.id,
          title: fixtures.brief.updatedTitle,
          content: `${record.content}\n\n${fixtures.brief.appendedLine}`,
        }),
        finalContent: `Updated the morning brief to "${fixtures.brief.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const brief = await waitFor(async () => {
          const briefs = await listBriefs(baseUrl, token);
          return Array.isArray(briefs)
            ? briefs.find((entry) => entry.id === records.briefId && entry.title === fixtures.brief.updatedTitle) ?? null
            : null;
        }, 12_000, 'Expected updated morning brief from chat flow.');
        assert.match(String(brief.content ?? ''), new RegExp(fixtures.brief.appendedLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      },
    },
    {
      id: 'brief-delete',
      prompt: `Delete the morning brief titled "${fixtures.brief.updatedTitle}" from Second Brain.`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'brief',
          summary: 'Delete a stored morning brief from Second Brain.',
        }),
        findQuery: 'second brain morning brief delete by title',
        lookupTool: 'second_brain_brief_list',
        lookupArgs: { kind: 'morning', limit: 20 },
        mutationTool: 'second_brain_brief_delete',
        selectRecord: (records) => findByTitle(records, fixtures.brief.updatedTitle),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the morning brief "${fixtures.brief.updatedTitle}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listBriefs(baseUrl, token)).some((brief) => brief.id === records.briefId), 12_000, 'Expected morning brief deletion from chat flow.');
      },
    },
    {
      id: 'routine-create',
      prompt: `Create the Pre-Meeting Brief routine in Second Brain and name it "${fixtures.routine.createName}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'create',
          personalItemType: 'routine',
          summary: 'Create the Pre-Meeting Brief routine in Second Brain.',
        }),
        findQuery: 'second brain routines routine catalog create update delete',
        lookupTool: 'second_brain_routine_catalog',
        lookupArgs: {},
        mutationTool: 'second_brain_routine_create',
        selectRecord: (records) => findRoutineTemplate(records, fixtures.routine.templateId),
        buildMutationArgs: (record) => ({
          templateId: record.templateId,
          name: fixtures.routine.createName,
          enabled: true,
        }),
        finalContent: `Created the routine "${fixtures.routine.createName}" in Second Brain.`,
      }),
      async verify({ baseUrl, token, records }) {
        const routine = await waitFor(async () => {
          const routines = await listRoutines(baseUrl, token);
          return Array.isArray(routines)
            ? routines.find((entry) => entry.id === fixtures.routine.templateId) ?? null
            : null;
        }, 12_000, 'Expected created routine from chat flow.');
        assert.equal(routine.name, fixtures.routine.createName);
        records.routineId = routine.id;
      },
    },
    {
      id: 'routine-update',
      prompt: `Update the Second Brain routine named "${fixtures.routine.createName}" so it is renamed to "${fixtures.routine.updatedName}" and disabled.`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'update',
          personalItemType: 'routine',
          summary: 'Update a Second Brain routine.',
        }),
        findQuery: 'second brain routines routine update delete by name',
        lookupTool: 'second_brain_routine_list',
        lookupArgs: {},
        mutationTool: 'second_brain_routine_update',
        selectRecord: (records) => findByName(records, fixtures.routine.createName),
        buildMutationArgs: (record) => ({
          id: record.id,
          name: fixtures.routine.updatedName,
          enabled: false,
        }),
        finalContent: `Updated the routine to "${fixtures.routine.updatedName}".`,
      }),
      async verify({ baseUrl, token, records }) {
        const routine = await waitFor(async () => {
          const routines = await listRoutines(baseUrl, token);
          return Array.isArray(routines)
            ? routines.find((entry) => entry.id === records.routineId) ?? null
            : null;
        }, 12_000, 'Expected updated routine from chat flow.');
        assert.equal(routine.name, fixtures.routine.updatedName);
        assert.equal(routine.enabled, false);
      },
    },
    {
      id: 'routine-delete',
      prompt: `Delete the Second Brain routine named "${fixtures.routine.updatedName}".`,
      scenario: buildLookupMutationScenario({
        decision: buildRouteDecision({
          operation: 'delete',
          personalItemType: 'routine',
          summary: 'Delete a configured Second Brain routine.',
        }),
        findQuery: 'second brain routines routine delete by name',
        lookupTool: 'second_brain_routine_list',
        lookupArgs: {},
        mutationTool: 'second_brain_routine_delete',
        selectRecord: (records) => findByName(records, fixtures.routine.updatedName),
        buildMutationArgs: (record) => ({ id: record.id }),
        finalContent: `Deleted the routine "${fixtures.routine.updatedName}".`,
      }),
      async verify({ baseUrl, token, records }) {
        await waitFor(async () => !(await listRoutines(baseUrl, token)).some((routine) => routine.id === records.routineId), 12_000, 'Expected routine deletion from chat flow.');
      },
    },
  ];
}

async function sendMessage(baseUrl, token, content) {
  return requestJson(baseUrl, token, 'POST', '/api/message', {
    agentId: 'default',
    userId: 'second-brain-chat-harness',
    channel: 'web',
    content,
  });
}

async function listNotes(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/second-brain/notes?limit=200&includeArchived=true');
  return Array.isArray(result) ? result : [];
}

async function listTasks(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/second-brain/tasks?limit=200');
  return Array.isArray(result) ? result : [];
}

async function listCalendar(baseUrl, token, fixture) {
  const qs = new URLSearchParams({
    fromTime: String(fixture.rangeStart),
    toTime: String(fixture.rangeEnd),
    includePast: 'true',
    limit: '50',
  });
  const result = await requestJson(baseUrl, token, 'GET', `/api/second-brain/calendar?${qs.toString()}`);
  return Array.isArray(result) ? result : [];
}

async function listPeople(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/second-brain/people?limit=200');
  return Array.isArray(result) ? result : [];
}

async function listLinks(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/second-brain/links?limit=200');
  return Array.isArray(result) ? result : [];
}

async function listBriefs(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/second-brain/briefs?limit=100');
  return Array.isArray(result) ? result : [];
}

async function listRoutines(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/second-brain/routines');
  return Array.isArray(result) ? result : [];
}

async function listToolJobs(baseUrl, token) {
  const result = await requestJson(baseUrl, token, 'GET', '/api/tools?limit=300');
  return Array.isArray(result?.jobs) ? result.jobs : [];
}

function assertNoPendingApprovals(response, stepId) {
  const pending = response?.metadata?.pendingApprovals;
  assert.ok(!Array.isArray(pending) || pending.length === 0, `Expected no pending approvals for ${stepId}: ${JSON.stringify(response)}`);
}

async function waitForNewJobs(baseUrl, token, previousJobIds, stepId) {
  return waitFor(async () => {
    const jobs = await listToolJobs(baseUrl, token);
    const newJobs = jobs.filter((job) => job?.id && !previousJobIds.has(job.id));
    return newJobs.length > 0 ? newJobs : null;
  }, 12_000, `Expected tool jobs for ${stepId}.`);
}

function assertFakeScenarioRouting(logEntries, prompt, stepId) {
  const matching = logEntries.filter((entry) => entry.lookupKey === prompt);
  assert.ok(matching.some((entry) => entry.tools.includes('route_intent')), `Expected route_intent call for ${stepId}.`);
}

function assertRequiredJobs(jobs, requiredToolNames, stepId, mode) {
  for (const toolName of requiredToolNames) {
    assert.ok(
      jobs.some((job) => job.toolName === toolName),
      `Expected ${toolName} job for ${stepId} in ${mode} mode. Jobs: ${JSON.stringify(jobs)}`,
    );
  }
}

async function runHarness() {
  const options = parseHarnessOptions();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const harnessPort = await getFreePort();
  const authToken = `second-brain-chat-harness-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${harnessPort}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-second-brain-chat-'));
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');
  const fixtures = buildFixtures(tmpDir);
  const steps = buildSteps(fixtures);
  const scenarioLog = [];
  const provider = await resolveHarnessProvider(options, steps, scenarioLog);

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
    port: ${harnessPort}
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
runtime:
  agentIsolation:
    enabled: false
guardian:
  enabled: true
`;
  fs.writeFileSync(configPath, config);

  const records = {};
  let appProcess;
  try {
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
        XDG_CACHE_HOME: path.join(tmpDir, '.cache'),
        XDG_DATA_HOME: path.join(tmpDir, '.local', 'share'),
        ...(options.useRealOllama && options.bypassLocalModelComplexityGuard
          ? { GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: '1' }
          : {}),
      },
    });
    appProcess.stdout.pipe(fs.createWriteStream(logPath));
    appProcess.stderr.pipe(fs.createWriteStream(`${logPath}.err`));

    await waitForHealth(baseUrl);

    const toolsPolicyTicket = await getPrivilegedTicket(baseUrl, authToken, 'tools.policy');
    const autonomousPolicy = await requestJson(baseUrl, authToken, 'POST', '/api/tools/policy', {
      mode: 'autonomous',
      ticket: toolsPolicyTicket,
    });
    assert.equal(autonomousPolicy?.success, true, `Expected tools policy update to succeed: ${JSON.stringify(autonomousPolicy)}`);

    for (const step of steps) {
      const toolsBefore = await listToolJobs(baseUrl, authToken);
      const previousJobIds = new Set(toolsBefore.map((job) => job?.id).filter(Boolean));
      const logIndex = scenarioLog.length;
      const response = await sendMessage(baseUrl, authToken, step.prompt);
      assert.ok(String(response?.content ?? '').trim().length > 0, `Expected non-empty assistant response for ${step.id}: ${JSON.stringify(response)}`);
      assertNoPendingApprovals(response, step.id);

      const newJobs = await waitForNewJobs(baseUrl, authToken, previousJobIds, step.id);
      if (provider.mode === 'fake') {
        assertRequiredJobs(newJobs, step.scenario.fakeRequiredJobs, step.id, provider.mode);
        assertFakeScenarioRouting(scenarioLog.slice(logIndex), step.prompt, step.id);
      } else {
        assertRequiredJobs(newJobs, step.scenario.realRequiredJobs, step.id, provider.mode);
      }

      try {
        await step.verify({ baseUrl, token: authToken, records, response, provider });
      } catch (error) {
        throw new Error(
          [
            `Verification failed for ${step.id}.`,
            error instanceof Error ? error.message : String(error),
            `Response: ${JSON.stringify(response)}`,
            `Jobs: ${JSON.stringify(newJobs)}`,
          ].join(' '),
        );
      }
    }

    console.log(`PASS second brain chat CRUD harness (${provider.mode}, ${steps.length} chat scenarios)`);
  } finally {
    if (appProcess && appProcess.exitCode == null) {
      appProcess.kill('SIGTERM');
      await new Promise((resolve) => appProcess.once('exit', resolve)).catch(() => {});
    }
    await provider.close().catch(() => {});
    if (!options.keepTmp) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

runHarness().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
