import http from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const appPort = 3033;
const llmPort = 11481;
const cloudPort = 11482;
const cloudHost = '127.0.0.1.nip.io';
const authToken = `cloud-harness-${Date.now()}`;
const baseUrl = `http://127.0.0.1:${appPort}`;
const dummyApiKeyEnv = 'GUARDIAN_CLOUD_HARNESS_API_KEY';
const dummyApiKey = 'cloud-harness-key';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth(timeoutMs) {
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

async function request(pathname, init = {}, options = {}) {
  const { auth = true, parseJson = true } = options;
  const headers = {
    ...(parseJson ? { 'Content-Type': 'application/json' } : {}),
    ...(auth ? { Authorization: `Bearer ${authToken}` } : {}),
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

function xmlResponse(body) {
  return [
    ['content-type', 'text/xml; charset=utf-8'],
    body,
  ];
}

function jsonResponse(body) {
  return [
    ['content-type', 'application/json'],
    JSON.stringify(body),
  ];
}

async function readRequestBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw;
}

async function createMockCloudServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${cloudPort}`);
    const body = await readRequestBody(req);

    let response;

    if (url.pathname === '/json-api/gethostname') {
      response = jsonResponse({ metadata: { result: 1 }, data: { hostname: 'whm.social.local' } });
    } else if (url.pathname === '/json-api/version') {
      response = jsonResponse({ metadata: { result: 1 }, data: { version: '124.0.1' } });
    } else if (url.pathname === '/json-api/systemloadavg') {
      response = jsonResponse({ metadata: { result: 1 }, data: { one: 0.11, five: 0.22, fifteen: 0.33 } });
    } else if (url.pathname === '/json-api/servicestatus') {
      response = jsonResponse({
        metadata: { result: 1 },
        data: {
          service: [
            { name: 'httpd', running: 1 },
            { name: 'mysql', running: 1 },
          ],
        },
      });
    } else if (url.pathname === '/execute/StatsBar/get_stats') {
      response = jsonResponse({ result: { status: 1, data: { disk_used_percent: 42, bandwidth_used_percent: 18 } } });
    } else if (url.pathname === '/execute/DomainInfo/list_domains') {
      response = jsonResponse({
        result: {
          status: 1,
          data: {
            main_domain: 'example.com',
            addon_domains: ['shop.example.com'],
            sub_domains: ['blog.example.com'],
          },
        },
      });
    } else if (url.pathname === '/execute/ResourceUsage/get_usages') {
      response = jsonResponse({
        result: {
          status: 1,
          data: [{ description: 'CPU', state: 'ok' }, { description: 'Memory', state: 'ok' }],
        },
      });
    } else if (url.pathname === '/v10/projects') {
      response = jsonResponse({ projects: [{ id: 'prj_1', name: 'web-app' }] });
    } else if (url.pathname === '/v6/deployments') {
      response = jsonResponse({ deployments: [{ uid: 'dpl_1', name: 'web-app', target: 'production' }] });
    } else if (url.pathname === '/user/tokens/verify') {
      response = jsonResponse({ success: true, result: { status: 'active' } });
    } else if (url.pathname === '/accounts/acc_123') {
      response = jsonResponse({ success: true, result: { id: 'acc_123', name: 'Main Account' } });
    } else if (url.pathname === '/zones') {
      response = jsonResponse({ success: true, result: [{ id: 'zone_1', name: 'example.com' }] });
    } else if (url.pathname === '/v1/projects/guardian-prod') {
      response = jsonResponse({ projectId: 'guardian-prod', lifecycleState: 'ACTIVE' });
    } else if (url.pathname === '/v1/projects/guardian-prod/services') {
      response = jsonResponse({ services: [{ name: 'compute.googleapis.com', state: 'ENABLED' }] });
    } else if (url.pathname === '/subscriptions/sub-123') {
      response = jsonResponse({ subscriptionId: 'sub-123', displayName: 'Primary Subscription' });
    } else if (url.pathname === '/subscriptions/sub-123/resourcegroups') {
      response = jsonResponse({ value: [{ name: 'rg-main' }, { name: 'rg-ops' }] });
    } else if (body.includes('Action=GetCallerIdentity')) {
      response = xmlResponse([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">',
        '<GetCallerIdentityResult>',
        '<Arn>arn:aws:iam::123456789012:user/tester</Arn>',
        '<UserId>AIDACKCEVSQ6C2EXAMPLE</UserId>',
        '<Account>123456789012</Account>',
        '</GetCallerIdentityResult>',
        '<ResponseMetadata><RequestId>req-sts-1</RequestId></ResponseMetadata>',
        '</GetCallerIdentityResponse>',
      ].join(''));
    } else if (body.includes('Action=ListAccountAliases')) {
      response = xmlResponse([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ListAccountAliasesResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">',
        '<ListAccountAliasesResult>',
        '<AccountAliases><member>main</member></AccountAliases>',
        '<IsTruncated>false</IsTruncated>',
        '</ListAccountAliasesResult>',
        '<ResponseMetadata><RequestId>req-iam-1</RequestId></ResponseMetadata>',
        '</ListAccountAliasesResponse>',
      ].join(''));
    }

    if (!response) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.pathname, body }));
      return;
    }

    const [header, payload] = response;
    res.writeHead(200, { [header[0]]: header[1] });
    res.end(payload);
  });

  await new Promise((resolve, reject) => {
    server.listen(cloudPort, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return server;
}

async function createMockLlmServer(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${llmPort}`);

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-tools-model', object: 'model' }] }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await readRequestBody(req);
      const parsed = raw ? JSON.parse(raw) : {};
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const systemPrompt = messages.find((message) => message.role === 'system')?.content;
      if (typeof systemPrompt === 'string') {
        state.systemPrompts.push(systemPrompt);
      }

      const originalUser = messages.find((message) => message.role === 'user')?.content ?? '';
      const toolMessages = messages.filter((message) => message.role === 'tool');

      let choice;
      if (String(originalUser).includes('social WHM')) {
        if (toolMessages.length === 0) {
          choice = {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tc-find-whm',
                type: 'function',
                function: {
                  name: 'find_tools',
                  arguments: JSON.stringify({ query: 'whm cloud hosting', maxResults: 10 }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          };
        } else if (toolMessages.length === 1) {
          choice = {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'tc-whm-status',
                type: 'function',
                function: {
                  name: 'whm_status',
                  arguments: JSON.stringify({ profile: 'social', includeServices: true }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          };
        } else {
          choice = {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Tested the social WHM profile with whm_status. In this simulated harness, the profile is configured, the endpoint is reachable, and core WHM services are reported healthy.',
            },
            finish_reason: 'stop',
          };
        }
      } else {
        choice = {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Harness response.',
          },
          finish_reason: 'stop',
        };
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-tools-model',
        choices: [choice],
        usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(llmPort, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return server;
}

function buildHarnessConfig(configPath) {
  writeFileSync(
    configPath,
    [
      'llm:',
      '  mock_openai:',
      '    provider: openai',
      `    baseUrl: "http://127.0.0.1:${llmPort}/v1"`,
      '    model: mock-tools-model',
      '    credentialRef: llm.mock_openai',
      '    maxTokens: 1024',
      'defaultProvider: mock_openai',
      'channels:',
      '  cli:',
      '    enabled: false',
      '  web:',
      '    enabled: true',
      `    port: ${appPort}`,
      `    authToken: "${authToken}"`,
      'assistant:',
      '  identity:',
      '    mode: single_user',
      '    primaryUserId: cloud-harness',
      '  credentials:',
      '    refs:',
      '      llm.mock_openai:',
      '        source: env',
      `        env: ${dummyApiKeyEnv}`,
      '  memory:',
      '    enabled: false',
      '    maxTurns: 4',
      '    maxMessageChars: 4000',
      '    maxContextChars: 8000',
      '    retentionDays: 1',
      '  analytics:',
      '    enabled: false',
      '    retentionDays: 1',
      '  tools:',
      '    enabled: true',
      '    policyMode: autonomous',
      '    allowedPaths: ["."]',
      '    allowedCommands: ["echo"]',
      `    allowedDomains: ["127.0.0.1", "localhost", "${cloudHost}"]`,
      '    cloud:',
      '      enabled: true',
      '      cpanelProfiles:',
      '        - id: social',
      '          name: Social WHM',
      '          type: whm',
      `          host: ${cloudHost}`,
      `          port: ${cloudPort}`,
      '          username: root',
      '          apiToken: whm-secret',
      '          ssl: false',
      '          defaultCpanelUser: socialuser',
      '        - id: site-cpanel',
      '          name: Site cPanel',
      '          type: cpanel',
      `          host: ${cloudHost}`,
      `          port: ${cloudPort}`,
      '          username: alice',
      '          apiToken: cpanel-secret',
      '          ssl: false',
      '      vercelProfiles:',
      '        - id: vercel-main',
      '          name: Vercel Main',
      `          apiBaseUrl: "http://${cloudHost}:${cloudPort}"`,
      '          apiToken: vercel-secret',
      '          teamId: team_123',
      '      cloudflareProfiles:',
      '        - id: cf-main',
      '          name: Cloudflare Main',
      `          apiBaseUrl: "http://${cloudHost}:${cloudPort}"`,
      '          apiToken: cf-secret',
      '          accountId: acc_123',
      '          defaultZoneId: zone_1',
      '      awsProfiles:',
      '        - id: aws-main',
      '          name: AWS Main',
      '          region: us-east-1',
      '          accessKeyId: AKIAIOSFODNN7EXAMPLE',
      '          secretAccessKey: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '          endpoints:',
      `            sts: "http://${cloudHost}:${cloudPort}"`,
      `            iam: "http://${cloudHost}:${cloudPort}"`,
      '      gcpProfiles:',
      '        - id: gcp-main',
      '          name: GCP Main',
      '          projectId: guardian-prod',
      '          accessToken: gcp-secret',
      '          endpoints:',
      `            cloudResourceManager: "http://${cloudHost}:${cloudPort}"`,
      `            serviceUsage: "http://${cloudHost}:${cloudPort}"`,
      '      azureProfiles:',
      '        - id: azure-main',
      '          name: Azure Main',
      '          subscriptionId: sub-123',
      '          accessToken: azure-secret',
      '          defaultResourceGroup: rg-main',
      '          endpoints:',
      `            management: "http://${cloudHost}:${cloudPort}"`,
      'guardian:',
      '  enabled: true',
      '  ssrf:',
      '    enabled: true',
      '    allowPrivateNetworks: true',
      '    allowlist: ["127.0.0.1", "localhost"]',
      'runtime:',
      '  agentIsolation:',
      '    enabled: false',
      '    mode: in-process',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main() {
  const tempRoot = path.join(os.tmpdir(), `ga-cloud-harness-${Date.now()}`);
  const configPath = path.join(tempRoot, 'config.yaml');
  const stdoutLogPath = path.join(tempRoot, 'app.stdout.log');
  const stderrLogPath = path.join(tempRoot, 'app.stderr.log');

  mkdirSync(tempRoot, { recursive: true });
  buildHarnessConfig(configPath);

  const llmState = { systemPrompts: [] };
  const llmServer = await createMockLlmServer(llmState);
  const cloudServer = await createMockCloudServer();

  const app = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      [dummyApiKeyEnv]: dummyApiKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.pipe(createWriteStream(stdoutLogPath, { flags: 'a' }));
  app.stderr.pipe(createWriteStream(stderrLogPath, { flags: 'a' }));

  const results = [];

  try {
    await waitForHealth(30_000);

    await runTest(results, 'config redaction exposes cloud profiles without leaking secrets', async () => {
      const response = await request('/api/config');
      assert(response.status === 200, `Expected 200 from /api/config, got ${response.status}`);
      const config = response.body;
      const cloud = config?.assistant?.tools?.cloud;
      assert(cloud?.enabled === true, 'Expected assistant.tools.cloud.enabled to be true');
      assert(cloud?.profileCounts?.total === 7, `Expected 7 configured cloud profiles, got ${cloud?.profileCounts?.total}`);
      assert(Array.isArray(cloud?.cpanelProfiles), 'Expected cpanelProfiles array');
      assert(cloud.cpanelProfiles.some((profile) => profile.id === 'social' && profile.type === 'whm'), 'Expected social WHM profile in redacted config');
      const serialized = JSON.stringify(config);
      for (const secret of ['whm-secret', 'cpanel-secret', 'vercel-secret', 'cf-secret', 'gcp-secret', 'azure-secret', dummyApiKey]) {
        assert(!serialized.includes(secret), `Config response leaked secret value '${secret}'`);
      }
    });

    await runTest(results, 'tools API exposes cloud category and runtime summary', async () => {
      const response = await request('/api/tools');
      assert(response.status === 200, `Expected 200 from /api/tools, got ${response.status}`);
      const cloudCategory = Array.isArray(response.body?.categories)
        ? response.body.categories.find((entry) => entry.category === 'cloud')
        : undefined;
      assert(cloudCategory?.enabled === true, 'Expected cloud category to be enabled');
      assert(Array.isArray(response.body?.tools), 'Expected tools array from /api/tools');
    });

    await runTest(results, 'find_tools discovers deferred cloud tool families', async () => {
      const queries = [
        ['whm hosting', 'whm_status'],
        ['cpanel hosting', 'cpanel_account'],
        ['vercel deployment', 'vercel_status'],
        ['cloudflare dns', 'cf_status'],
        ['aws account identity', 'aws_status'],
        ['gcp project services', 'gcp_status'],
        ['azure subscription resource groups', 'azure_status'],
      ];

      for (const [query, expected] of queries) {
        const response = await request('/api/tools/run', {
          method: 'POST',
          body: JSON.stringify({
            toolName: 'find_tools',
            args: { query, maxResults: 10 },
            userId: 'cloud-harness',
            origin: 'web',
          }),
        });
        assert(response.status === 200, `Expected 200 from find_tools for '${query}', got ${response.status}`);
        assert(response.body?.success === true, `Expected find_tools to succeed for '${query}', got ${response.body?.message ?? response.body?.error ?? JSON.stringify(response.body)}`);
        const names = Array.isArray(response.body?.output?.tools)
          ? response.body.output.tools.map((tool) => String(tool.name))
          : [];
        assert(names.includes(expected), `Expected find_tools query '${query}' to include ${expected}`);
      }
    });

    await runTest(results, 'assistant planner path uses social WHM profile from context', async () => {
      const response = await request('/api/message', {
        method: 'POST',
        body: JSON.stringify({
          content: 'Can you test connection to my social WHM?',
          userId: 'cloud-harness',
          channel: 'web',
        }),
      });
      assert(response.status === 200, `Expected 200 from /api/message, got ${response.status}`);
      assert(typeof response.body?.content === 'string', 'Expected chat response content');
      const content = response.body.content;
      assert(content.includes('social WHM'), 'Expected final response to reference social WHM');
      assert(content.toLowerCase().includes('configured'), 'Expected final response to mention configuration status');
      assert(!/server address|share the host|what(?:'s| is) the server/i.test(content), 'Response asked for host details instead of using configured profile');
      assert(llmState.systemPrompts.length > 0, 'Expected mock LLM to capture at least one system prompt');
      const prompt = llmState.systemPrompts[0];
      assert(prompt.includes('- social: provider=whm'), 'Expected social WHM profile in system prompt tool context');
      assert(prompt.includes('Use configured cloud profile ids exactly as listed below'), 'Expected explicit cloud profile instruction in system prompt');
    });

    const toolRuns = [
      ['whm_status', { profile: 'social' }, (output) => output?.profile === 'social' && output?.hostname?.hostname === 'whm.social.local'],
      ['cpanel_account', { profile: 'site-cpanel' }, (output) => output?.profile === 'site-cpanel' && output?.stats?.disk_used_percent === 42],
      ['vercel_status', { profile: 'vercel-main' }, (output) => output?.profile === 'vercel-main' && output?.projectCount === 1 && output?.deploymentCount === 1],
      ['cf_status', { profile: 'cf-main' }, (output) => output?.profile === 'cf-main' && output?.token?.status === 'active'],
      ['aws_status', { profile: 'aws-main' }, (output) => output?.profile === 'aws-main' && output?.identity?.Account === '123456789012'],
      ['gcp_status', { profile: 'gcp-main' }, (output) => output?.profile === 'gcp-main' && output?.project?.projectId === 'guardian-prod'],
      ['azure_status', { profile: 'azure-main' }, (output) => output?.profile === 'azure-main' && output?.subscription?.subscriptionId === 'sub-123'],
    ];

    for (const [toolName, args, validate] of toolRuns) {
      await runTest(results, `${toolName} executes against simulated profile`, async () => {
        const response = await request('/api/tools/run', {
          method: 'POST',
          body: JSON.stringify({
            toolName,
            args,
            userId: 'cloud-harness',
            origin: 'web',
            channel: 'web',
          }),
        });
        assert(response.status === 200, `Expected 200 from ${toolName}, got ${response.status}`);
        assert(response.body?.success === true, `Expected ${toolName} to succeed, got ${response.body?.message ?? response.body?.error}`);
        assert(validate(response.body?.output), `Unexpected output shape from ${toolName}: ${JSON.stringify(response.body?.output)}`);
      });
    }
  } finally {
    app.kill('SIGKILL');
    llmServer.close();
    cloudServer.close();

    if (results.some((result) => !result.ok)) {
      if (existsSync(stdoutLogPath)) {
        const stdoutLog = readFileSync(stdoutLogPath, 'utf8').trim();
        if (stdoutLog) {
          console.error('\nstdout log:\n' + stdoutLog);
        }
      }
      if (existsSync(stderrLogPath)) {
        const stderrLog = readFileSync(stderrLogPath, 'utf8').trim();
        if (stderrLog) {
          console.error('\nstderr log:\n' + stderrLog);
        }
      }
    }

    rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\nCloud harness summary: ${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    for (const failure of failed) {
      console.error(`- ${failure.name}: ${failure.message}`);
    }
    process.exit(1);
  }
}

await main();
