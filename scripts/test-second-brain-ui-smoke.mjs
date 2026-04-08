import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

import { chromium } from 'playwright';
import { DEFAULT_HARNESS_OLLAMA_MODEL } from './ollama-harness-defaults.mjs';
import {
  createOllamaHarnessChatResponse,
  getHarnessProviderConfig,
  readHarnessOllamaEnvOptions,
  resolveRealOllamaProvider,
} from './ollama-harness-provider.mjs';

function printHelp() {
  console.log([
    'Second Brain UI smoke harness',
    '',
    'Usage:',
    '  node scripts/test-second-brain-ui-smoke.mjs [options]',
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
    '  HARNESS_OLLAMA_API_KEY or OLLAMA_API_KEY for Ollama Cloud,',
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
  const ollamaEnv = readHarnessOllamaEnvOptions();
  return {
    useRealOllama: args.has('--use-ollama') || process.env.HARNESS_USE_REAL_OLLAMA === '1',
    keepTmp: args.has('--keep-tmp') || process.env.HARNESS_KEEP_TMP === '1',
    ...ollamaEnv,
  };
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
  for (let index = 0; index < 60; index += 1) {
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
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function createChatCompletionResponse({ model, content = '' }) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: 'stop',
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
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const isOllamaNativeChat = req.method === 'POST' && url.pathname === '/api/chat';

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'second-brain-ui-harness-model', size: 1 }] }));
      return;
    }

    if (isOllamaNativeChat || (req.method === 'POST' && url.pathname === '/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(
        isOllamaNativeChat
          ? createOllamaHarnessChatResponse({
              model: 'second-brain-ui-harness-model',
              content: 'Second Brain UI harness provider response.',
            })
          : createChatCompletionResponse({
              model: 'second-brain-ui-harness-model',
              content: 'Second Brain UI harness provider response.',
            }),
      ));
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
    model: 'second-brain-ui-harness-model',
    providerType: 'ollama',
    mode: 'fake',
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function resolveHarnessProvider(options) {
  if (!options.useRealOllama) {
    return startFakeProvider();
  }
  return resolveRealOllamaProvider(options, { logPrefix: 'guardian-second-brain-ollama-' });
}

function resolveBrowserExecutable() {
  const candidates = [
    process.env.HARNESS_CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || undefined;
}

async function loginToWeb(page, baseUrl, authToken) {
  await page.goto(`${baseUrl}/#/`, { waitUntil: 'networkidle' });
  await page.fill('#auth-token-input', authToken);
  await page.click('#auth-submit');
  await page.waitForSelector('.sb-tabs');
  await page.waitForSelector('.tab-bar');
}

async function openSecondBrainTab(page, label, readySelector) {
  await page.locator('.tab-bar .tab-btn', { hasText: label }).click();
  if (readySelector) {
    await page.waitForSelector(readySelector);
  }
}

async function acceptNextDialog(page) {
  page.once('dialog', (dialog) => dialog.accept());
}

async function waitForFormRecordId(page, formSelector, expectedId) {
  await page.waitForFunction(
    ({ formSelector: nextSelector, expectedId: nextId }) => {
      const form = document.querySelector(nextSelector);
      if (!(form instanceof HTMLFormElement)) return false;
      const field = form.querySelector('input[name="id"]');
      return field instanceof HTMLInputElement && field.value === nextId;
    },
    { formSelector, expectedId },
  );
}

function formatDateTimeLocalInput(timestamp) {
  const value = new Date(timestamp);
  const pad = (part) => String(part).padStart(2, '0');
  return [
    value.getFullYear(),
    '-',
    pad(value.getMonth() + 1),
    '-',
    pad(value.getDate()),
    'T',
    pad(value.getHours()),
    ':',
    pad(value.getMinutes()),
  ].join('');
}

async function runHarness() {
  const options = parseHarnessOptions();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const harnessPort = await getFreePort();
  const authToken = `second-brain-ui-harness-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${harnessPort}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-second-brain-ui-'));
  const configPath = path.join(tmpDir, 'config.yaml');
  const logPath = path.join(tmpDir, 'guardian.log');
  const linkPath = path.join(tmpDir, 'reference-note.txt');
  fs.writeFileSync(linkPath, 'Harness reference file\n');

  const provider = await resolveHarnessProvider(options);
  const providerConfig = getHarnessProviderConfig(provider);
  const config = `
llm:
  ${providerConfig.profileName}:
    provider: ${providerConfig.llmEntry.provider}
    baseUrl: ${provider.baseUrl}
    model: ${provider.model}
${providerConfig.credentialRef ? `    credentialRef: ${providerConfig.credentialRef}
` : ''}defaultProvider: ${providerConfig.profileName}
channels:
  cli:
    enabled: false
  web:
    enabled: true
    host: 127.0.0.1
    port: ${harnessPort}
    authToken: "${authToken}"
assistant:
${providerConfig.credentialRef ? `  credentials:
    refs:
      ${providerConfig.credentialRef}:
        source: env
        env: ${providerConfig.credentialEnv}
` : ''}  identity:
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

  let appProcess;
  let browser;
  try {
    appProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tmpDir,
        ...(options.useRealOllama && options.bypassLocalModelComplexityGuard
          ? { GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: '1' }
          : {}),
      },
    });
    appProcess.stdout.pipe(fs.createWriteStream(logPath));
    appProcess.stderr.pipe(fs.createWriteStream(`${logPath}.err`));

    await waitForHealth(baseUrl);

    const executablePath = resolveBrowserExecutable();
    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await loginToWeb(page, baseUrl, authToken);

    const noteTitle = `Harness Note ${Date.now()}`;
    const noteUpdatedTitle = `${noteTitle} Updated`;
    await openSecondBrainTab(page, 'Notes', 'form[data-note-form]');
    await page.click('[data-note-new="true"]');
    await page.fill('#note-title', noteTitle);
    await page.fill('#note-tags', 'harness, smoke');
    await page.fill('#note-content', 'Created by the Second Brain UI smoke harness.');
    await page.locator('form[data-note-form] button[type="submit"]').click();
    let note = await waitFor(async () => {
      const notes = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/notes?limit=200');
      return Array.isArray(notes) ? notes.find((entry) => entry.title === noteTitle) : null;
    }, 12_000, 'Expected created note to appear in the Second Brain notes API.');
    await waitForFormRecordId(page, 'form[data-note-form]', note.id);
    await page.fill('#note-title', noteUpdatedTitle);
    await page.fill('#note-content', 'Updated note content from the Second Brain UI smoke harness.');
    await page.locator('form[data-note-form] button[type="submit"]').click();
    note = await waitFor(async () => {
      const notes = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/notes?limit=200');
      return Array.isArray(notes) ? notes.find((entry) => entry.id === note.id && entry.title === noteUpdatedTitle) : null;
    }, 12_000, 'Expected edited note to persist through the notes API.');

    const taskTitle = `Harness Task ${Date.now()}`;
    const taskUpdatedTitle = `${taskTitle} Updated`;
    await openSecondBrainTab(page, 'Tasks', 'form[data-task-form]');
    await page.click('[data-task-new="true"]');
    await page.fill('#task-title', taskTitle);
    await page.fill('#task-details', 'Initial harness task details.');
    await page.selectOption('#task-priority', 'high');
    await page.selectOption('#task-status', 'todo');
    await page.fill('#task-due-at', '2030-01-02T10:00');
    await page.locator('form[data-task-form] button[type="submit"]').click();
    let task = await waitFor(async () => {
      const tasks = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/tasks?limit=200');
      return Array.isArray(tasks) ? tasks.find((entry) => entry.title === taskTitle) : null;
    }, 12_000, 'Expected created task to appear in the tasks API.');
    await waitForFormRecordId(page, 'form[data-task-form]', task.id);
    await page.fill('#task-title', taskUpdatedTitle);
    await page.fill('#task-details', 'Updated harness task details.');
    await page.selectOption('#task-status', 'in_progress');
    await page.locator('form[data-task-form] button[type="submit"]').click();
    task = await waitFor(async () => {
      const tasks = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/tasks?limit=200');
      return Array.isArray(tasks)
        ? tasks.find((entry) => entry.id === task.id && entry.title === taskUpdatedTitle && entry.status === 'in_progress')
        : null;
    }, 12_000, 'Expected edited task to persist through the tasks API.');

    const eventTitle = `Harness Event ${Date.now()}`;
    const eventUpdatedTitle = `${eventTitle} Updated`;
    const eventDay = new Date();
    eventDay.setHours(0, 0, 0, 0);
    const eventStart = new Date(eventDay.getTime());
    eventStart.setHours(9, 0, 0, 0);
    const eventEnd = new Date(eventDay.getTime());
    eventEnd.setHours(10, 0, 0, 0);
    const eventFrom = eventDay.getTime();
    const eventTo = eventDay.getTime() + (24 * 60 * 60 * 1000);
    await openSecondBrainTab(page, 'Calendar', 'form[data-calendar-form]');
    await page.click('[data-calendar-new="true"]');
    await page.fill('#calendar-title', eventTitle);
    await page.fill('#calendar-starts-at', formatDateTimeLocalInput(eventStart.getTime()));
    await page.fill('#calendar-ends-at', formatDateTimeLocalInput(eventEnd.getTime()));
    await page.fill('#calendar-location', 'Desk');
    await page.fill('#calendar-description', 'Initial harness event description.');
    await page.locator('form[data-calendar-form] button[type="submit"]').click();
    let event = await waitFor(async () => {
      const events = await requestJson(baseUrl, authToken, 'GET', `/api/second-brain/calendar?fromTime=${eventFrom}&toTime=${eventTo}&limit=50`);
      return Array.isArray(events) ? events.find((entry) => entry.title === eventTitle) : null;
    }, 12_000, 'Expected created local event to appear in the calendar API.');
    await waitForFormRecordId(page, 'form[data-calendar-form]', event.id);
    await page.fill('#calendar-title', eventUpdatedTitle);
    await page.fill('#calendar-location', 'Meeting room');
    await page.fill('#calendar-description', 'Updated harness event description.');
    await page.locator('form[data-calendar-form] button[type="submit"]').click();
    event = await waitFor(async () => {
      const events = await requestJson(baseUrl, authToken, 'GET', `/api/second-brain/calendar?fromTime=${eventFrom}&toTime=${eventTo}&limit=50`);
      return Array.isArray(events)
        ? events.find((entry) => entry.id === event.id && entry.title === eventUpdatedTitle && entry.location === 'Meeting room')
        : null;
    }, 12_000, 'Expected edited local event to persist through the calendar API.');

    if (options.useRealOllama) {
      const planResponse = await requestJson(baseUrl, authToken, 'POST', '/api/message', {
        content: `Using my Second Brain, give me a concise morning plan that references ${taskUpdatedTitle}, ${noteUpdatedTitle}, and ${eventUpdatedTitle} if you can find them.`,
        userId: 'second-brain-harness-chat',
        channel: 'web',
      });
      const planText = String(planResponse?.content ?? '');
      assert.ok(planText.trim().length > 0, `Expected a non-empty Second Brain planning response from the real Ollama lane: ${JSON.stringify(planResponse)}`);
      assert.ok(
        planText.includes(taskUpdatedTitle) || planText.includes(noteUpdatedTitle) || planText.includes(eventUpdatedTitle),
        `Expected the real Ollama Second Brain planning response to reference harness entities: ${JSON.stringify(planResponse)}`,
      );
    }

    const personName = `Harness Contact ${Date.now()}`;
    await openSecondBrainTab(page, 'Contacts', 'form[data-person-form]');
    await page.click('[data-person-new="true"]');
    await page.fill('#person-name', personName);
    await page.fill('#person-email', 'harness.contact@example.com');
    await page.fill('#person-title', 'Operator');
    await page.fill('#person-company', 'Guardian Harness');
    await page.fill('#person-notes', 'Initial harness contact notes.');
    await page.locator('form[data-person-form] button[type="submit"]').click();
    let person = await waitFor(async () => {
      const people = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/people?limit=200');
      return Array.isArray(people) ? people.find((entry) => entry.name === personName) : null;
    }, 12_000, 'Expected created contact to appear in the contacts API.');
    await waitForFormRecordId(page, 'form[data-person-form]', person.id);
    await page.fill('#person-notes', 'Updated harness contact notes.');
    await page.locator('form[data-person-form] button[type="submit"]').click();
    person = await waitFor(async () => {
      const people = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/people?limit=200');
      return Array.isArray(people)
        ? people.find((entry) => entry.id === person.id && String(entry.notes || '').includes('Updated harness'))
        : null;
    }, 12_000, 'Expected edited contact to persist through the contacts API.');
    await page.click(`[data-person-touch="${person.id}"]`);
    person = await waitFor(async () => {
      const people = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/people?limit=200');
      return Array.isArray(people)
        ? people.find((entry) => entry.id === person.id && Number.isFinite(entry.lastContactAt))
        : null;
    }, 12_000, 'Expected mark-contacted action to update lastContactAt.');

    const linkTitle = `Harness Link ${Date.now()}`;
    await openSecondBrainTab(page, 'Library', 'form[data-link-form]');
    await page.click('[data-link-new="true"]');
    await page.fill('#link-title', linkTitle);
    await page.fill('#link-url', linkPath);
    await page.selectOption('#link-kind', 'file');
    await page.fill('#link-tags', 'harness, file');
    await page.fill('#link-summary', 'Initial harness library summary.');
    await page.locator('form[data-link-form] button[type="submit"]').click();
    let link = await waitFor(async () => {
      const links = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/links?limit=200');
      return Array.isArray(links) ? links.find((entry) => entry.title === linkTitle) : null;
    }, 12_000, 'Expected created library item to appear in the links API.');
    await waitForFormRecordId(page, 'form[data-link-form]', link.id);
    assert.equal(link.url, pathToFileURL(linkPath).toString());
    const openLinkHref = await page.locator('a[rel="noreferrer"]').getAttribute('href');
    assert.equal(openLinkHref, link.url, `Expected library Open link href to match normalized file URL. Got ${openLinkHref} vs ${link.url}`);
    await page.fill('#link-summary', 'Updated harness library summary.');
    await page.locator('form[data-link-form] button[type="submit"]').click();
    link = await waitFor(async () => {
      const links = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/links?limit=200');
      return Array.isArray(links)
        ? links.find((entry) => entry.id === link.id && String(entry.summary || '').includes('Updated harness'))
        : null;
    }, 12_000, 'Expected edited library item to persist through the links API.');

    await openSecondBrainTab(page, 'Briefs', 'button[data-generate-brief="morning"]');
    await page.locator('button[data-generate-brief="morning"]').first().click();
    let brief = await waitFor(async () => {
      const briefs = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/briefs?limit=50');
      return Array.isArray(briefs) ? briefs.find((entry) => entry.kind === 'morning') : null;
    }, 12_000, 'Expected generated morning brief to appear in the briefs API.');
    await waitForFormRecordId(page, 'form[data-brief-form]', brief.id);
    await page.fill('#brief-title', 'Harness Morning Brief Edited');
    await page.fill('#brief-content', `${brief.content}\n\nEdited by the UI smoke harness.`);
    await page.locator('form[data-brief-form] button[type="submit"]').click();
    brief = await waitFor(async () => {
      const briefs = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/briefs?limit=50');
      return Array.isArray(briefs)
        ? briefs.find((entry) => entry.id === brief.id && entry.title === 'Harness Morning Brief Edited' && String(entry.content).includes('Edited by the UI smoke harness.'))
        : null;
    }, 12_000, 'Expected edited brief to persist through the briefs API.');
    await page.locator('button[data-generate-brief="morning"]').last().click();
    brief = await waitFor(async () => {
      const briefs = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/briefs?limit=50');
      return Array.isArray(briefs) ? briefs.find((entry) => entry.id === brief.id) : null;
    }, 12_000, 'Expected regenerated morning brief to remain addressable by its stable id.');
    await acceptNextDialog(page);
    await page.click('[data-brief-delete]');
    await waitFor(async () => {
      const briefs = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/briefs?limit=50');
      return Array.isArray(briefs) ? !briefs.some((entry) => entry.id === brief.id) : false;
    }, 12_000, 'Expected deleted brief to disappear from the briefs API.');

    await openSecondBrainTab(page, 'Routines', '#sb-routine-catalog-table');
    await page.click('[data-second-brain-sync-now="true"]');
    await page.waitForFunction(() => {
      const flash = document.querySelector('[data-sb-flash-shell]');
      return flash instanceof HTMLElement && /Synced calendar and contacts\./.test(flash.textContent || '');
    });
    await page.click('[data-routine-create-toggle="true"]');
    await page.selectOption('#routine-template-id', 'topic-watch');
    await page.fill('#routine-name', 'Harness Topic Watch');
    await page.fill('#routine-topic-query', 'Harness launch');
    await page.locator('form[data-routine-create-form] button[type="submit"]').click();
    let routine = await waitFor(async () => {
      const routines = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/routines');
      return Array.isArray(routines)
        ? routines.find((entry) => entry.templateId === 'topic-watch' && entry.name === 'Harness Topic Watch')
        : null;
    }, 12_000, 'Expected created topic watch routine to appear in the routines API.');
    await waitForFormRecordId(page, 'form[data-routine-form]', routine.id);
    await page.fill('#routine-name', 'Harness Topic Watch Updated');
    await page.fill('#routine-topic-query', 'Harness launch updated');
    await page.locator('form[data-routine-form] button[type="submit"]').click();
    routine = await waitFor(async () => {
      const routines = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/routines');
      return Array.isArray(routines)
        ? routines.find((entry) => (
          entry.id === routine.id
          && entry.name === 'Harness Topic Watch Updated'
          && entry.config?.topicQuery === 'Harness launch updated'
        ))
        : null;
    }, 12_000, 'Expected edited topic watch routine to persist through the routines API.');
    await acceptNextDialog(page);
    await page.click('[data-routine-delete]');
    await waitFor(async () => {
      const routines = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/routines');
      return Array.isArray(routines) ? !routines.some((entry) => entry.id === routine.id) : false;
    }, 12_000, 'Expected deleted routine to disappear from the routines API.');

    await page.click('[data-routine-create-toggle="true"]');
    await page.selectOption('#routine-template-id', 'deadline-watch');
    await page.fill('#routine-name', 'Harness Deadline Watch');
    await page.fill('#routine-due-within-hours', '8');
    await page.locator('input[name="includeOverdue"]').uncheck();
    await page.locator('form[data-routine-create-form] button[type="submit"]').click();
    routine = await waitFor(async () => {
      const routines = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/routines');
      return Array.isArray(routines)
        ? routines.find((entry) => (
          entry.templateId === 'deadline-watch'
          && entry.name === 'Harness Deadline Watch'
          && entry.config?.dueWithinHours === 8
          && entry.config?.includeOverdue === false
        ))
        : null;
    }, 12_000, 'Expected created deadline watch routine to appear in the routines API.');
    await waitForFormRecordId(page, 'form[data-routine-form]', routine.id);
    await page.fill('#routine-name', 'Harness Deadline Watch Updated');
    await page.fill('#routine-due-within-hours', '12');
    await page.locator('input[name="includeOverdue"]').check();
    await page.locator('form[data-routine-form] button[type="submit"]').click();
    routine = await waitFor(async () => {
      const routines = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/routines');
      return Array.isArray(routines)
        ? routines.find((entry) => (
          entry.id === routine.id
          && entry.name === 'Harness Deadline Watch Updated'
          && entry.config?.dueWithinHours === 12
          && entry.config?.includeOverdue === true
        ))
        : null;
    }, 12_000, 'Expected edited deadline watch routine to persist through the routines API.');
    await acceptNextDialog(page);
    await page.click('[data-routine-delete]');
    await waitFor(async () => {
      const routines = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/routines');
      return Array.isArray(routines) ? !routines.some((entry) => entry.id === routine.id) : false;
    }, 12_000, 'Expected deleted deadline watch routine to disappear from the routines API.');

    await openSecondBrainTab(page, 'Library', 'form[data-link-form]');
    await waitForFormRecordId(page, 'form[data-link-form]', link.id);
    await acceptNextDialog(page);
    await page.click('[data-link-delete]');
    await waitFor(async () => {
      const links = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/links?limit=200');
      return Array.isArray(links) ? !links.some((entry) => entry.id === link.id) : false;
    }, 12_000, 'Expected deleted library item to disappear from the links API.');

    await openSecondBrainTab(page, 'Contacts', 'form[data-person-form]');
    await waitForFormRecordId(page, 'form[data-person-form]', person.id);
    await acceptNextDialog(page);
    await page.click('[data-person-delete]');
    await waitFor(async () => {
      const people = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/people?limit=200');
      return Array.isArray(people) ? !people.some((entry) => entry.id === person.id) : false;
    }, 12_000, 'Expected deleted contact to disappear from the contacts API.');

    await openSecondBrainTab(page, 'Calendar', 'form[data-calendar-form]');
    await waitForFormRecordId(page, 'form[data-calendar-form]', event.id);
    await acceptNextDialog(page);
    await page.click('[data-calendar-delete]');
    await waitFor(async () => {
      const events = await requestJson(baseUrl, authToken, 'GET', `/api/second-brain/calendar?fromTime=${eventFrom}&toTime=${eventTo}&limit=50`);
      return Array.isArray(events) ? !events.some((entry) => entry.id === event.id) : false;
    }, 12_000, 'Expected deleted local event to disappear from the calendar API.');

    await openSecondBrainTab(page, 'Tasks', 'form[data-task-form]');
    await waitForFormRecordId(page, 'form[data-task-form]', task.id);
    await acceptNextDialog(page);
    await page.click('[data-task-delete]');
    await waitFor(async () => {
      const tasks = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/tasks?limit=200');
      return Array.isArray(tasks) ? !tasks.some((entry) => entry.id === task.id) : false;
    }, 12_000, 'Expected deleted task to disappear from the tasks API.');

    await openSecondBrainTab(page, 'Notes', 'form[data-note-form]');
    await waitForFormRecordId(page, 'form[data-note-form]', note.id);
    await acceptNextDialog(page);
    await page.click('[data-note-delete]');
    await waitFor(async () => {
      const notes = await requestJson(baseUrl, authToken, 'GET', '/api/second-brain/notes?limit=200');
      return Array.isArray(notes) ? !notes.some((entry) => entry.id === note.id) : false;
    }, 12_000, 'Expected deleted note to disappear from the notes API.');

    console.log(`PASS second brain ui smoke (${provider.mode})`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
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
