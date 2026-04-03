import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import yaml from 'js-yaml';

import { DEFAULT_HARNESS_OLLAMA_MODEL, resolveHarnessOllamaModel } from './ollama-harness-defaults.mjs';
import { SkillRegistry } from '../src/skills/registry.ts';
import { SkillResolver } from '../src/skills/resolver.ts';

let pass = 0;
let fail = 0;
let skip = 0;

function log(message) {
  console.log(`[skills-routing] ${message}`);
}

function passCase(name, detail = '') {
  pass += 1;
  console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

function failCase(name, detail) {
  fail += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${detail}`);
}

function skipCase(name, detail = '') {
  skip += 1;
  console.log(`  \x1b[33mSKIP\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

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
      res.end(JSON.stringify({ models: [{ name: 'skills-routing-harness-model', size: 1 }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      await readJsonBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(createChatCompletionResponse({
        model: 'skills-routing-harness-model',
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

async function requestJsonNoAuth(url, method, body, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      method,
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
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

  const homeDir = os.homedir();
  const binCandidates = [
    options.ollamaBin,
    path.join(homeDir, '.local', 'bin', 'ollama'),
    'ollama',
  ].filter(Boolean);

  let ollamaBin = '';
  for (const candidateBin of binCandidates) {
    const result = spawn(candidateBin, ['--version'], { stdio: 'ignore' });
    const exitCode = await new Promise((resolve) => {
      result.on('exit', resolve);
      result.on('error', () => resolve(-1));
    });
    if (exitCode === 0) {
      ollamaBin = candidateBin;
      break;
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

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await canReachOllama(candidate);
      return { close: shutdown, logPath };
    } catch {
      if (processHandle.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await shutdown();
  throw new Error(`Failed to autostart local Ollama at ${candidate}. See ${logPath}`);
}

async function resolveHarnessProvider(options) {
  if (!options.useRealOllama) {
    const fake = await startFakeProvider();
    return {
      baseUrl: fake.baseUrl,
      model: 'skills-routing-harness-model',
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
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('GuardianAgent did not become healthy within 30 seconds.');
}

function writeStubGws(stubPath) {
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'if [[ "$#" -ge 2 && "$1" == "auth" && "$2" == "status" ]]; then',
    `  echo '{"auth_method":"stub"}'`,
    '  exit 0',
    'fi',
    '',
    'if [[ "$#" -ge 4 && "$1" == "gmail" && "$2" == "users" && "$3" == "messages" && "$4" == "list" ]]; then',
    `  echo '{"messages":[{"id":"stub-msg-1"},{"id":"stub-msg-2"}],"resultSizeEstimate":2}'`,
    '  exit 0',
    'fi',
    '',
    'if [[ "$#" -ge 4 && "$1" == "gmail" && "$2" == "users" && "$3" == "messages" && "$4" == "get" ]]; then',
    '  id="stub-msg-1"',
    '  for ((i=1; i<=$#; i++)); do',
    '    if [[ "${!i}" == "--id" ]]; then',
    '      next=$((i+1))',
    '      id="${!next}"',
    '      break',
    '    fi',
    '  done',
    '  if [[ "$id" == "stub-msg-1" ]]; then',
    `    echo '{"snippet":"Quarterly report is ready.","payload":{"headers":[{"name":"From","value":"Alex <alex@example.com>"},{"name":"Subject","value":"Quarterly report"},{"name":"Date","value":"Mon, 17 Mar 2026 09:00:00 +1000"}]}}'`,
    '  else',
    `    echo '{"snippet":"Deployment completed successfully.","payload":{"headers":[{"name":"From","value":"CI Bot <ci@example.com>"},{"name":"Subject","value":"Deployment status"},{"name":"Date","value":"Mon, 17 Mar 2026 09:30:00 +1000"}]}}'`,
    '  fi',
    '  exit 0',
    'fi',
    '',
    'if [[ "$#" -ge 4 && "$1" == "gmail" && "$2" == "users" && "$3" == "messages" && "$4" == "send" ]]; then',
    `  echo '{"id":"stub-sent-1","labelIds":["SENT"]}'`,
    '  exit 0',
    'fi',
    '',
    `echo '{"error":{"message":"Unhandled gws stub call"}}'`,
    'exit 1',
    '',
  ].join('\n');

  fs.writeFileSync(stubPath, script, { mode: 0o755 });
}

async function runResolverMatrix() {
  log('=== Resolver Matrix ===');
  const registry = new SkillRegistry();
  await registry.loadFromRoots(['./skills']);

  const reviewedSkillIds = ['blogwatcher', 'weather', 'multi-search-engine', 'notion', 'obsidian', 'himalaya'];
  for (const id of reviewedSkillIds) {
    if (!registry.enable(id)) {
      failCase(`resolver setup: ${id}`, 'skill not found');
    }
  }

  const resolver = new SkillResolver(registry, { maxActivePerRequest: 4 });
  const cases = [
    {
      name: 'generic email resolves both workspace providers',
      content: 'Check my email.',
      enabledManagedProviders: new Set(['gws', 'm365']),
      availableCapabilities: new Set(['network_access']),
      includes: ['google-workspace', 'microsoft-365'],
      excludes: ['himalaya'],
    },
    {
      name: 'explicit Himalaya isolates local mailbox workflow',
      content: 'Use Himalaya to check my local IMAP mailbox.',
      enabledManagedProviders: new Set(['email']),
      availableCapabilities: new Set(['network_access', 'shell_access']),
      includes: ['himalaya'],
      excludes: ['google-workspace', 'microsoft-365'],
    },
    {
      name: 'generic docs search prefers knowledge search',
      content: 'Search the docs wiki for the deployment guide.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['filesystem_read']),
      includes: ['knowledge-search'],
      excludes: ['notion', 'obsidian'],
    },
    {
      name: 'explicit Notion prompt isolates Notion',
      content: 'Update this Notion page in my workspace.',
      enabledManagedProviders: new Set(['notion']),
      availableCapabilities: new Set(['network_access']),
      includes: ['notion'],
      excludes: ['knowledge-search', 'obsidian'],
    },
    {
      name: 'explicit Obsidian prompt isolates Obsidian',
      content: 'Rename this note in my Obsidian vault.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['filesystem_write', 'shell_access']),
      includes: ['obsidian'],
      excludes: ['knowledge-search', 'notion'],
    },
    {
      name: 'generic web lookup prefers web research over engine specialization',
      content: 'Look up the latest Kubernetes release notes online.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['network_access']),
      includes: ['web-research'],
      excludes: ['multi-search-engine', 'weather', 'blogwatcher'],
    },
    {
      name: 'generic repo analysis does not pull in reviewed GitHub skill',
      content: 'Analyze this repo and explain how the code is structured.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['filesystem_read', 'shell_access', 'network_access']),
      includes: ['coding-workspace'],
      excludes: ['github'],
    },
    {
      name: 'explicit GitHub request activates reviewed GitHub skill',
      content: 'Use GitHub to inspect the workflow run for this pull request.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['shell_access', 'network_access']),
      includes: ['github'],
      excludes: [],
    },
    {
      name: 'review findings language activates code review',
      content: 'Review this patch for regressions and missing tests before merge.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['read_files']),
      includes: ['code-review'],
      excludes: [],
    },
    {
      name: 'research-before-edit language activates deep research',
      content: 'Compare the old and new code paths and trace the behavior before implementing a fix.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['read_files']),
      includes: ['deep-research'],
      excludes: [],
    },
    {
      name: 'engine-specific search activates multi-search-engine',
      content: 'Use privacy search with DuckDuckGo bangs for this German query.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['network_access']),
      includes: ['multi-search-engine'],
      excludes: ['weather', 'blogwatcher'],
    },
    {
      name: 'weather prompt activates weather skill only when capabilities exist',
      content: 'What is the weather forecast in Brisbane?',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['network_access', 'shell_access']),
      includes: ['weather'],
      excludes: ['blogwatcher', 'multi-search-engine'],
    },
    {
      name: 'RSS monitoring prompt activates blogwatcher',
      content: 'Monitor this RSS feed for new posts.',
      enabledManagedProviders: new Set(),
      availableCapabilities: new Set(['network_access', 'shell_access']),
      includes: ['blogwatcher'],
      excludes: ['weather'],
    },
  ];

  for (const testCase of cases) {
    const resolved = resolver.resolve({
      agentId: 'default',
      channel: 'web',
      requestType: 'chat',
      content: testCase.content,
      enabledManagedProviders: testCase.enabledManagedProviders,
      availableCapabilities: testCase.availableCapabilities,
    });
    const ids = resolved.map((skill) => skill.id);
    const missing = testCase.includes.filter((id) => !ids.includes(id));
    const unexpected = testCase.excludes.filter((id) => ids.includes(id));
    if (missing.length === 0 && unexpected.length === 0) {
      passCase(testCase.name, ids.join(', '));
    } else {
      failCase(testCase.name, `resolved=${ids.join(', ') || '(none)'} missing=${missing.join(', ') || '(none)'} unexpected=${unexpected.join(', ') || '(none)'}`);
    }
  }
}

async function runHttpMatrix(provider, options) {
  log('');
  log(`=== HTTP Planner Matrix (${provider.mode}) ===`);

  const port = await getFreePort();
  const token = `skills-routing-${Date.now()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-skills-routing-'));
  const configPath = path.join(tempDir, 'config.yaml');
  const logFile = path.join(tempDir, 'guardian.log');
  const errFile = path.join(tempDir, 'guardian.err.log');
  let appProcess;

  const config = {
    llm: {
      harness: {
        provider: 'ollama',
        baseUrl: provider.baseUrl,
        model: provider.model,
      },
    },
    defaultProvider: 'harness',
    channels: {
      cli: { enabled: false },
      web: {
        enabled: true,
        host: '127.0.0.1',
        port,
        authToken: token,
        defaultAgent: 'default',
      },
    },
    assistant: {
      identity: {
        mode: 'single_user',
        primaryUserId: 'harness',
      },
      skills: {
        enabled: true,
        roots: [path.join(process.cwd(), 'skills').replace(/\\/g, '/')],
        autoSelect: true,
        maxActivePerRequest: 3,
        disabledSkills: [],
      },
      tools: {
        enabled: true,
        policyMode: 'approve_by_policy',
        allowedDomains: [
          '127.0.0.1',
          'localhost',
          'graph.microsoft.com',
          'login.microsoftonline.com',
        ],
        google: {
          enabled: true,
          services: ['gmail'],
          credentialsPath: path.join(tempDir, 'google-credentials.json').replace(/\\/g, '/'),
          oauthCallbackPort: 18432,
        },
        microsoft: {
          enabled: true,
          clientId: '00000000-0000-0000-0000-000000000000',
          tenantId: 'common',
          services: ['mail', 'calendar', 'onedrive', 'contacts'],
          oauthCallbackPort: 18433,
        },
      },
    },
    guardian: {
      enabled: true,
    },
    runtime: {
      agentIsolation: {
        enabled: false,
        mode: 'brokered',
      },
    },
  };

  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: -1, noRefs: true }));

  try {
    appProcess = spawn('node', ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempDir,
        USERPROFILE: tempDir,
        XDG_CONFIG_HOME: tempDir,
        XDG_DATA_HOME: tempDir,
        ...(options.useRealOllama && options.bypassLocalModelComplexityGuard
          ? { GUARDIAN_BYPASS_LOCAL_MODEL_COMPLEXITY_GUARD: '1' }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appProcess.stdout.pipe(fs.createWriteStream(logFile));
    appProcess.stderr.pipe(fs.createWriteStream(errFile));

    await waitForHealth(baseUrl);

    const readJobs = async () => {
      const state = await requestJson(baseUrl, token, 'GET', '/api/tools?limit=100');
      return Array.isArray(state?.jobs) ? state.jobs : [];
    };

    const sendMessage = async (content) => requestJson(baseUrl, token, 'POST', '/api/message', {
      content,
      userId: 'harness',
      agentId: 'default',
      channel: 'web',
    });

    const skillsState = await requestJson(baseUrl, token, 'GET', '/api/skills');
    const managedProviders = Array.isArray(skillsState?.managedProviders)
      ? skillsState.managedProviders
      : [];
    log(`Managed providers in harness app: ${JSON.stringify(managedProviders)}`);
    const toolsState = await requestJson(baseUrl, token, 'GET', '/api/tools?limit=5');
    log(`Tools enabled in harness app: ${JSON.stringify(toolsState?.enabled)}`);

    const newToolNames = (beforeJobs, afterJobs) => {
      const beforeIds = new Set(beforeJobs.map((job) => job.id));
      return afterJobs
        .filter((job) => !beforeIds.has(job.id))
        .map((job) => job.toolName)
        .filter(Boolean);
    };

    const ambiguousReadBefore = await readJobs();
    const ambiguousReadResponse = await sendMessage('Check my email.');
    const ambiguousReadAfter = await readJobs();
    const ambiguousReadTools = newToolNames(ambiguousReadBefore, ambiguousReadAfter);
    if (
      typeof ambiguousReadResponse?.content === 'string'
      && ambiguousReadResponse.content.includes('Which one do you want me to use?')
      && ambiguousReadTools.length === 0
    ) {
      passCase('planner: generic inbox asks for provider clarification');
    } else {
      failCase('planner: generic inbox asks for provider clarification', `content=${JSON.stringify(ambiguousReadResponse?.content)} tools=${ambiguousReadTools.join(', ') || '(none)'} activeSkills=${JSON.stringify(ambiguousReadResponse?.metadata?.activeSkills ?? [])}`);
    }

    const ambiguousSendBefore = await readJobs();
    const ambiguousSendResponse = await sendMessage('Send an email to alex@example.com with subject Test and body Hello.');
    const ambiguousSendAfter = await readJobs();
    const ambiguousSendTools = newToolNames(ambiguousSendBefore, ambiguousSendAfter);
    if (
      typeof ambiguousSendResponse?.content === 'string'
      && ambiguousSendResponse.content.includes('Which one do you want me to use?')
      && ambiguousSendTools.length === 0
    ) {
      passCase('planner: generic compose asks for provider clarification');
    } else {
      failCase('planner: generic compose asks for provider clarification', `content=${JSON.stringify(ambiguousSendResponse?.content)} tools=${ambiguousSendTools.join(', ') || '(none)'} activeSkills=${JSON.stringify(ambiguousSendResponse?.metadata?.activeSkills ?? [])}`);
    }

    const gmailBefore = await readJobs();
    const gmailResponse = await sendMessage('Check my Gmail inbox.');
    const gmailAfter = await readJobs();
    const gmailTools = newToolNames(gmailBefore, gmailAfter);
    if (
      typeof gmailResponse?.content === 'string'
      && /gmail/i.test(gmailResponse.content)
      && gmailTools.includes('gws')
    ) {
      passCase('planner: explicit Gmail prompt routes to gws', gmailTools.join(', '));
    } else {
      failCase('planner: explicit Gmail prompt routes to gws', `content=${JSON.stringify(gmailResponse?.content)} tools=${gmailTools.join(', ') || '(none)'} activeSkills=${JSON.stringify(gmailResponse?.metadata?.activeSkills ?? [])}`);
    }

    if (provider.mode === 'real_ollama') {
      const outlookBefore = await readJobs();
      const outlookResponse = await sendMessage('Use Microsoft 365 to check my Outlook inbox.');
      const outlookAfter = await readJobs();
      const outlookTools = newToolNames(outlookBefore, outlookAfter);
      if (
        typeof outlookResponse?.content === 'string'
        && !outlookResponse.content.includes('Which one do you want me to use?')
        && outlookTools.includes('m365')
      ) {
        passCase('planner: explicit Outlook prompt routes to m365', outlookTools.join(', '));
      } else {
        failCase('planner: explicit Outlook prompt routes to m365', `content=${JSON.stringify(outlookResponse?.content)} tools=${outlookTools.join(', ') || '(none)'} activeSkills=${JSON.stringify(outlookResponse?.metadata?.activeSkills ?? [])}`);
      }
    } else {
      skipCase('planner: explicit Outlook prompt routes to m365', 'requires real LLM tool selection');
    }
  } finally {
    if (appProcess && !appProcess.killed) {
      appProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function main() {
  await runResolverMatrix();
  const options = parseHarnessOptions();
  const provider = await resolveHarnessProvider(options);
  log(`Using provider mode: ${provider.mode} (${provider.baseUrl}, model=${provider.model})`);
  try {
    await runHttpMatrix(provider, options);
  } finally {
    await provider.close();
  }

  log('');
  log(`Summary: ${pass} passed, ${fail} failed, ${skip} skipped.`);
  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  failCase('harness', error instanceof Error ? error.message : String(error));
  log(`Summary: ${pass} passed, ${fail} failed, ${skip} skipped.`);
  process.exitCode = 1;
});
