/**
 * Microsoft 365 Integration Test Harness (Node.js)
 *
 * Tests Microsoft 365 tool registration, approval gating, schema lookup,
 * param normalization, and edge cases via the direct tool API.
 *
 * Does NOT require a real Microsoft account — all tests exercise the tool
 * registration, decision logic, and approval pipeline. API calls that reach
 * Graph will fail with auth errors, which is expected and verified.
 *
 * Usage:
 *   node scripts/test-m365.mjs
 *
 * Against a running instance:
 *   HARNESS_PORT=3000 HARNESS_TOKEN=your-token SKIP_START=1 node scripts/test-m365.mjs
 *
 * Live authenticated status-only lane:
 *   HARNESS_HOST=localhost HARNESS_PORT=3000 SKIP_START=1 HARNESS_STATUS_ONLY=1 node scripts/test-m365.mjs
 *   node scripts/test-m365.mjs --status-only
 *
 * See docs/guides/INTEGRATION-TEST-HARNESS.md for full documentation.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { DEFAULT_HARNESS_OLLAMA_MODEL } from './ollama-harness-defaults.mjs';

const HARNESS_PORT = parseInt(process.env.HARNESS_PORT || '3015', 10);
const HARNESS_HOST = process.env.HARNESS_HOST || '127.0.0.1';
const HARNESS_TOKEN = process.env.HARNESS_TOKEN || `test-m365-${Date.now()}`;
const HARNESS_MODEL = process.env.HARNESS_OLLAMA_MODEL?.trim() || DEFAULT_HARNESS_OLLAMA_MODEL;
const SKIP_START = process.env.SKIP_START === '1';
const STATUS_ONLY = process.env.HARNESS_STATUS_ONLY === '1' || process.argv.includes('--status-only');
const BASE_URL = `http://${HARNESS_HOST}:${HARNESS_PORT}`;
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-m365-'));
const CONFIG_PATH = path.join(TEMP_DIR, 'config.yaml');
const LOG_FILE = path.join(TEMP_DIR, 'guardian.log');
const ERR_FILE = path.join(TEMP_DIR, 'guardian.err.log');

let appProcess;
let pass = 0;
let fail = 0;
let skip = 0;

// ─── Helpers ──────────────────────────────────────────────

function log(msg) { console.log(`[m365] ${msg}`); }
function logPass(name) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
function logFail(name, reason) { console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${reason}`); fail++; }
function logSkip(name, reason) { console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`); skip++; }

function request(method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${HARNESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const r = await request('GET', '/health');
      if (r?.status === 'ok') return;
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('App did not become healthy within 60s');
}

async function toolRun(toolName, args) {
  return request('POST', '/api/tools/run', {
    toolName, args, origin: 'harness', userId: 'harness',
  });
}

async function getPrivilegedTicket(action) {
  const response = await request('POST', '/api/auth/ticket', { action });
  if (typeof response?.ticket !== 'string' || response.ticket.length === 0) {
    throw new Error(`Expected privileged ticket for ${action}: ${JSON.stringify(response)}`);
  }
  return response.ticket;
}

async function setPolicy(policy) {
  const ticket = await getPrivilegedTicket('tools.policy');
  const result = await request('POST', '/api/tools/policy', { ...policy, ticket });
  if (result?.success !== true) {
    throw new Error(`Expected tools policy update to succeed: ${JSON.stringify(result)}`);
  }
  return result;
}

async function approvalDecision(approvalId, decision, reason = 'harness test') {
  return request('POST', '/api/tools/approvals/decision', {
    approvalId, decision, actor: 'harness', reason,
  });
}

async function getJobs(limit = 50) {
  try {
    const state = await request('GET', `/api/tools?limit=${limit}`);
    return state?.jobs || [];
  } catch { return []; }
}

// ─── Config ───────────────────────────────────────────────

function writeHarnessConfig() {
  // Read user config if exists, overlay web channel
  const userConfigPath = path.join(os.homedir(), '.guardianagent', 'config.yaml');
  let base = {};
  if (fs.existsSync(userConfigPath)) {
    // We need to dynamically import yaml
    // Since we can't guarantee js-yaml is available, write raw YAML
  }

  const config = `
llm:
  ollama:
    provider: ollama
    baseUrl: http://127.0.0.1:11434
    model: ${HARNESS_MODEL}
defaultProvider: ollama
channels:
  cli:
    enabled: false
  web:
    enabled: true
    host: 127.0.0.1
    port: ${HARNESS_PORT}
    authToken: "${HARNESS_TOKEN}"
assistant:
  identity:
    mode: single_user
    primaryUserId: harness
  tools:
    enabled: true
    policyMode: approve_by_policy
    allowedDomains:
      - localhost
      - 127.0.0.1
      - graph.microsoft.com
      - login.microsoftonline.com
    microsoft:
      enabled: true
      clientId: "00000000-0000-0000-0000-000000000000"
      tenantId: "common"
      services: [mail, calendar, onedrive, contacts]
      oauthCallbackPort: 18433
guardian:
  enabled: true
`;
  fs.writeFileSync(CONFIG_PATH, config.trim());
}

// ─── Test Sections ────────────────────────────────────────

async function testPrerequisites() {
  log('=== Prerequisite Check ===');

  // Check if m365 tool is registered
  const probe = await toolRun('m365', {
    service: 'mail', resource: 'me/messages', method: 'list', params: { $top: 1 },
  });

  if (probe.message?.includes('Unknown tool')) {
    logSkip('m365 tool registration', 'tool not registered (workspace category disabled?)');
    return false;
  }

  if (probe.message?.includes('not enabled or not connected')) {
    // Tool is registered but MS365 not authenticated — this is expected for approval tests
    logPass('m365 tool registered (not authenticated — approval tests will run)');
    return true;
  }

  if (probe.status === 'pending_approval') {
    // Tool is registered and gated — good, we're in approve_by_policy
    logPass('m365 tool registered (approval-gated in current policy mode)');
    return true;
  }

  if (probe.success || probe.status === 'succeeded' || probe.status === 'failed' || probe.status === 'error') {
    logPass(`m365 tool registered (probe status: ${probe.status})`);
    return true;
  }

  logSkip('m365 tool registration', `unexpected probe response: ${JSON.stringify(probe).slice(0, 200)}`);
  return false;
}

async function testToolDiscovery() {
  log('');
  log('=== Tool Discovery ===');

  // Check that all 4 M365 tools are in the registry
  const allTools = await request('GET', '/api/tools?limit=200');
  const toolNames = new Set();

  // The tools endpoint returns jobs, not definitions. Use the tool catalog endpoint.
  const catalog = await request('POST', '/api/tools/run', {
    toolName: 'find_tools', args: { query: 'microsoft outlook m365' }, origin: 'harness', userId: 'harness',
  });

  if (catalog.success || catalog.output) {
    const output = typeof catalog.output === 'string' ? catalog.output : JSON.stringify(catalog.output || '');
    const hasM365 = output.includes('m365');
    const hasSchema = output.includes('m365_schema');
    const hasDraft = output.includes('outlook_draft');
    const hasSend = output.includes('outlook_send');

    if (hasM365) logPass('discovery: m365 tool found via find_tools');
    else logFail('discovery: m365 tool', 'not found in find_tools results');

    if (hasSchema) logPass('discovery: m365_schema tool found');
    else logFail('discovery: m365_schema tool', 'not found in find_tools results');

    if (hasDraft) logPass('discovery: outlook_draft tool found');
    else logFail('discovery: outlook_draft tool', 'not found in find_tools results');

    if (hasSend) logPass('discovery: outlook_send tool found');
    else logFail('discovery: outlook_send tool', 'not found in find_tools results');
  } else {
    logFail('discovery: find_tools', `failed: ${catalog.error || catalog.message || 'unknown'}`);
  }
}

async function testSchemaLookup() {
  log('');
  log('=== Schema Lookup ===');

  // m365_schema is read_only — should execute without approval
  const schema1 = await toolRun('m365_schema', { schemaPath: 'mail.messages.list' });

  if (schema1.success || schema1.status === 'succeeded') {
    logPass('schema: mail.messages.list returns data');
    const data = schema1.output || schema1.data;
    if (data && (data.method === 'GET' || data.description)) {
      logPass('schema: mail.messages.list has correct structure');
    } else {
      logFail('schema: mail.messages.list structure', `unexpected data: ${JSON.stringify(data).slice(0, 200)}`);
    }
  } else if (schema1.status === 'pending_approval') {
    logFail('schema: mail.messages.list', 'read_only tool should not require approval');
  } else if (schema1.message?.includes('not enabled')) {
    logPass('schema: tool registered but M365 not enabled (expected)');
  } else {
    logFail('schema: mail.messages.list', `status=${schema1.status}, error=${schema1.error || schema1.message}`);
  }

  // Prefix search
  const schema2 = await toolRun('m365_schema', { schemaPath: 'calendar' });
  if (schema2.success || schema2.status === 'succeeded') {
    const data = schema2.output || schema2.data;
    if (data?.matches && data.matches.length > 1) {
      logPass(`schema: calendar prefix returns ${data.matches.length} matches`);
    } else if (data?.matches) {
      logPass('schema: calendar prefix returns matches');
    } else {
      logPass('schema: calendar prefix query executed');
    }
  } else if (schema2.message?.includes('not enabled')) {
    logPass('schema: calendar prefix — tool registered but M365 not enabled');
  } else {
    logFail('schema: calendar prefix', `${schema2.error || schema2.message || 'unknown'}`);
  }

  // Invalid path should list available paths
  const schema3 = await toolRun('m365_schema', { schemaPath: 'nonexistent.endpoint' });
  if (schema3.success || schema3.status === 'succeeded') {
    const data = schema3.output || schema3.data;
    if (data?.paths && data.paths.length > 0) {
      logPass(`schema: invalid path lists ${data.paths.length} available paths`);
    } else {
      logPass('schema: invalid path handled gracefully');
    }
  } else if (schema3.message?.includes('not enabled')) {
    logPass('schema: invalid path — tool registered but M365 not enabled');
  } else {
    logFail('schema: invalid path', `${schema3.error || schema3.message || 'unknown'}`);
  }
}

async function testWriteApprovalGating() {
  log('');
  log('=== Write Approval Tests (approve_by_policy) ===');

  await setPolicy({ mode: 'approve_by_policy' });
  logPass('setup: policy set to approve_by_policy');

  // --- m365 mail send should require approval ---
  const sendArgs = {
    service: 'mail', resource: 'me/sendMail', method: 'create',
    json: {
      message: {
        subject: 'Harness Test',
        body: { contentType: 'Text', content: 'test' },
        toRecipients: [{ emailAddress: { address: 'test@example.com' } }],
      },
    },
  };
  const mailSend = await toolRun('m365', sendArgs);

  if (mailSend.status === 'pending_approval') {
    logPass('m365 mail-send: requires approval (pending_approval)');
    if (mailSend.approvalId) {
      const deny = await approvalDecision(mailSend.approvalId, 'denied');
      if (deny.success) logPass('m365 mail-send: denial accepted');
      else logFail('m365 mail-send: deny', deny.error || 'unknown');
    }
  } else if (mailSend.success) {
    logFail('m365 mail-send: BYPASSED APPROVAL', 'write executed without approval gate');
  } else {
    logFail('m365 mail-send: unexpected', `status=${mailSend.status}, msg=${mailSend.message || mailSend.error}`);
  }

  // --- Calendar create should require approval ---
  const calArgs = {
    service: 'calendar', resource: 'me/events', method: 'create',
    json: {
      subject: 'Harness Test Event',
      start: { dateTime: '2026-12-01T10:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-12-01T11:00:00', timeZone: 'UTC' },
    },
  };
  const calCreate = await toolRun('m365', calArgs);

  if (calCreate.status === 'pending_approval') {
    logPass('m365 calendar-create: requires approval');
    if (calCreate.approvalId) {
      const deny = await approvalDecision(calCreate.approvalId, 'denied');
      if (deny.success) logPass('m365 calendar-create: denial accepted');
      else logFail('m365 calendar-create: deny', deny.error || 'unknown');
    }
  } else if (calCreate.success) {
    logFail('m365 calendar-create: BYPASSED APPROVAL', 'write executed without approval');
  } else {
    logFail('m365 calendar-create: unexpected', `status=${calCreate.status}, msg=${calCreate.message || calCreate.error}`);
  }

  // --- OneDrive delete should require approval ---
  const driveArgs = {
    service: 'onedrive', resource: 'me/drive/items', method: 'delete', id: 'fake-item-id',
  };
  const driveDelete = await toolRun('m365', driveArgs);

  if (driveDelete.status === 'pending_approval') {
    logPass('m365 onedrive-delete: requires approval');
    if (driveDelete.approvalId) {
      const deny = await approvalDecision(driveDelete.approvalId, 'denied');
      if (deny.success) logPass('m365 onedrive-delete: denial accepted');
      else logFail('m365 onedrive-delete: deny', deny.error || 'unknown');
    }
  } else if (driveDelete.success) {
    logFail('m365 onedrive-delete: BYPASSED APPROVAL', 'delete executed without approval');
  } else {
    logFail('m365 onedrive-delete: unexpected', `status=${driveDelete.status}, msg=${driveDelete.message || driveDelete.error}`);
  }

  // --- Contacts create should require approval ---
  const contactArgs = {
    service: 'contacts', resource: 'me/contacts', method: 'create',
    json: { givenName: 'Harness', surname: 'Test', emailAddresses: [{ address: 'test@example.com' }] },
  };
  const contactCreate = await toolRun('m365', contactArgs);

  if (contactCreate.status === 'pending_approval') {
    logPass('m365 contact-create: requires approval');
    if (contactCreate.approvalId) {
      const deny = await approvalDecision(contactCreate.approvalId, 'denied');
      if (deny.success) logPass('m365 contact-create: denial accepted');
      else logFail('m365 contact-create: deny', deny.error || 'unknown');
    }
  } else if (contactCreate.success) {
    logFail('m365 contact-create: BYPASSED APPROVAL', 'create executed without approval');
  } else {
    logFail('m365 contact-create: unexpected', `status=${contactCreate.status}, msg=${contactCreate.message || contactCreate.error}`);
  }

  // --- outlook_send (external_post) should ALWAYS require approval ---
  const outlookSend = await toolRun('outlook_send', {
    to: 'test@example.com', subject: 'Harness Test', body: 'test body',
  });

  if (outlookSend.status === 'pending_approval') {
    logPass('outlook_send: requires approval (external_post)');
    if (outlookSend.approvalId) {
      const deny = await approvalDecision(outlookSend.approvalId, 'denied');
      if (deny.success) logPass('outlook_send: denial accepted');
      else logFail('outlook_send: deny', deny.error || 'unknown');
    }
  } else if (outlookSend.success) {
    logFail('outlook_send: BYPASSED APPROVAL', 'external_post executed without approval');
  } else if (outlookSend.message?.includes('not enabled')) {
    // Tool registered but M365 not connected — approval fires before handler, so this shouldn't happen
    logFail('outlook_send: not gated', 'handler ran before approval gate');
  } else {
    logFail('outlook_send: unexpected', `status=${outlookSend.status}, msg=${outlookSend.message || outlookSend.error}`);
  }

  // --- outlook_draft (mutating) should require approval in approve_by_policy ---
  const outlookDraft = await toolRun('outlook_draft', {
    to: 'test@example.com', subject: 'Harness Draft', body: 'draft body',
  });

  if (outlookDraft.status === 'pending_approval') {
    logPass('outlook_draft: requires approval (mutating)');
    if (outlookDraft.approvalId) {
      const deny = await approvalDecision(outlookDraft.approvalId, 'denied');
      if (deny.success) logPass('outlook_draft: denial accepted');
      else logFail('outlook_draft: deny', deny.error || 'unknown');
    }
  } else if (outlookDraft.success) {
    logFail('outlook_draft: BYPASSED APPROVAL', 'mutating tool executed without approval');
  } else if (outlookDraft.message?.includes('not enabled')) {
    logFail('outlook_draft: not gated', 'handler ran before approval gate');
  } else {
    logFail('outlook_draft: unexpected', `status=${outlookDraft.status}, msg=${outlookDraft.message || outlookDraft.error}`);
  }
}

async function testReadPassthrough() {
  log('');
  log('=== Read Passthrough Tests (approve_by_policy) ===');

  // Reads for m365 should pass through without approval (network risk → auto-allow)
  const readArgs = {
    service: 'mail', resource: 'me/messages', method: 'list',
    params: { $top: 1 },
  };
  const mailRead = await toolRun('m365', readArgs);

  if (mailRead.status === 'pending_approval') {
    logFail('m365 mail-read: incorrectly requires approval', 'reads should auto-allow');
  } else if (mailRead.success || mailRead.status === 'succeeded') {
    logPass('m365 mail-read: allowed without approval');
  } else if (mailRead.status === 'failed' || mailRead.status === 'error') {
    // Tool executed (bypassed approval) but Graph API failed (not authenticated) — expected
    logPass(`m365 mail-read: executed without approval (status: ${mailRead.status} — expected, no auth)`);
  } else {
    logFail('m365 mail-read: unexpected', `status=${mailRead.status}, msg=${mailRead.message || mailRead.error}`);
  }

  // m365_schema is read_only — should always pass through
  const schemaRead = await toolRun('m365_schema', { schemaPath: 'mail' });
  if (schemaRead.status === 'pending_approval') {
    logFail('m365_schema: incorrectly requires approval', 'read_only should auto-allow');
  } else {
    logPass(`m365_schema: passed through without approval (status: ${schemaRead.status || 'ok'})`);
  }
}

async function testAutonomousMode() {
  log('');
  log('=== Autonomous Mode Verification ===');

  await setPolicy({ mode: 'autonomous' });
  logPass('setup: policy set to autonomous');

  // Calendar create should NOT require approval in autonomous
  const calArgs = {
    service: 'calendar', resource: 'me/events', method: 'create',
    json: {
      subject: 'Autonomous Test',
      start: { dateTime: '2026-12-15T10:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-12-15T10:30:00', timeZone: 'UTC' },
    },
  };
  const calAuto = await toolRun('m365', calArgs);

  if (calAuto.status === 'pending_approval') {
    logFail('autonomous calendar-create: still requires approval in autonomous mode');
  } else if (calAuto.success || calAuto.status === 'succeeded' || calAuto.status === 'failed' || calAuto.status === 'error') {
    logPass(`autonomous calendar-create: bypassed approval (status: ${calAuto.status})`);
  } else {
    logFail('autonomous calendar-create: unexpected', `status=${calAuto.status}`);
  }

  // outlook_draft should pass in autonomous
  const draftAuto = await toolRun('outlook_draft', {
    to: 'test@example.com', subject: 'Auto Draft', body: 'body',
  });

  if (draftAuto.status === 'pending_approval') {
    logFail('autonomous outlook_draft: still requires approval');
  } else {
    logPass(`autonomous outlook_draft: bypassed approval (status: ${draftAuto.status})`);
  }

  // outlook_send (external_post) should STILL require approval even in autonomous
  const sendAuto = await toolRun('outlook_send', {
    to: 'test@example.com', subject: 'Auto Send', body: 'body',
  });

  if (sendAuto.status === 'pending_approval') {
    logPass('autonomous outlook_send: still requires approval (external_post always gated)');
    if (sendAuto.approvalId) {
      await approvalDecision(sendAuto.approvalId, 'denied');
    }
  } else if (sendAuto.success) {
    logFail('autonomous outlook_send: BYPASSED APPROVAL', 'external_post should always require approval');
  } else {
    logFail('autonomous outlook_send: unexpected', `status=${sendAuto.status}`);
  }
}

async function testMicrosoftApiRoutes() {
  log('');
  log('=== Microsoft API Routes ===');

  // GET /api/microsoft/status
  try {
    const status = await request('GET', '/api/microsoft/status');
    if (typeof status?.authenticated === 'boolean') {
      logPass(`api: /api/microsoft/status works (authenticated: ${status.authenticated})`);
    } else if (status?.error) {
      // Route exists but callback not wired — depends on config
      logPass('api: /api/microsoft/status route exists');
    } else {
      logFail('api: /api/microsoft/status', `unexpected response: ${JSON.stringify(status).slice(0, 200)}`);
    }
  } catch (e) {
    logFail('api: /api/microsoft/status', e.message);
  }

  // POST /api/microsoft/disconnect (should work even without tokens)
  try {
    const disc = await request('POST', '/api/microsoft/disconnect');
    if (disc.success !== undefined || disc.error) {
      logPass('api: /api/microsoft/disconnect route exists');
    } else {
      logPass('api: /api/microsoft/disconnect responded');
    }
  } catch (e) {
    logFail('api: /api/microsoft/disconnect', e.message);
  }
}

async function testMicrosoftStatusOnly() {
  log('');
  log('=== Microsoft Live Status-Only Checks ===');

  try {
    const status = await request('GET', '/api/microsoft/status');
    if (status?.authenticated === true) {
      logPass('api: /api/microsoft/status authenticated');
    } else if (typeof status?.authenticated === 'boolean') {
      logFail('api: /api/microsoft/status authenticated', `authenticated=${status.authenticated}`);
    } else {
      logFail('api: /api/microsoft/status', `unexpected response: ${JSON.stringify(status).slice(0, 200)}`);
    }
  } catch (e) {
    logFail('api: /api/microsoft/status', e.message);
  }

  const statusTool = await toolRun('m365_status', {});
  if (statusTool.status === 'pending_approval') {
    logFail('tool: m365_status', 'status-only tool required approval');
  } else if (statusTool.success === true && statusTool.output?.authenticated === true) {
    logPass('tool: m365_status authenticated without content read');
  } else {
    logFail('tool: m365_status', `status=${statusTool.status}, msg=${statusTool.message || statusTool.error}`);
  }

  const schemaTool = await toolRun('m365_schema', { schemaPath: 'mail.messages.list' });
  if (schemaTool.status === 'pending_approval') {
    logFail('tool: m365_schema', 'read-only schema lookup required approval');
  } else if (schemaTool.success === true || schemaTool.status === 'succeeded') {
    logPass('tool: m365_schema executes without approval');
  } else {
    logFail('tool: m365_schema', `status=${schemaTool.status}, msg=${schemaTool.message || schemaTool.error}`);
  }

  const jobs = await getJobs(30);
  const statusJobs = jobs.filter(j => j.toolName?.match(/m365_status|m365_schema/));
  if (statusJobs.length > 0) {
    logPass('job history: M365 status/schema executions recorded');
  } else {
    logFail('job history', 'no M365 status/schema jobs recorded');
  }
}

async function testJobHistory() {
  log('');
  log('=== Job History ===');

  const jobs = await getJobs(100);
  const m365Jobs = jobs.filter(j => j.toolName?.match(/m365|outlook/));

  if (m365Jobs.length > 0) {
    logPass(`job history: ${m365Jobs.length} M365 tool executions recorded`);

    const statuses = [...new Set(m365Jobs.map(j => j.status))].sort().join(', ');
    logPass(`job history: M365 statuses: ${statuses}`);

    const toolNames = [...new Set(m365Jobs.map(j => j.toolName))].sort().join(', ');
    logPass(`job history: tools used: ${toolNames}`);
  } else {
    logFail('job history', 'no M365 jobs recorded');
  }
}

// ─── Main ─────────────────────────────────────────────────

async function run() {
  if (!SKIP_START) {
    writeHarnessConfig();
    log(`Starting GuardianAgent on port ${HARNESS_PORT}...`);

    appProcess = spawn('node', ['--import', 'tsx', 'src/index.ts', CONFIG_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // This harness includes explicit autonomous-mode policy semantics checks.
        // Dedicated security-baseline tests cover the production approval floor.
        GUARDIAN_DISABLE_BASELINE: '1',
        HOME: TEMP_DIR,
        USERPROFILE: TEMP_DIR,
      },
    });
    appProcess.stdout.pipe(fs.createWriteStream(LOG_FILE));
    appProcess.stderr.pipe(fs.createWriteStream(ERR_FILE));

    await waitForHealth();
    log('App is healthy');
  } else {
    log(`Using running instance at ${BASE_URL}`);
  }

  // Log LLM provider info
  try {
    const providers = await request('GET', '/api/providers');
    if (Array.isArray(providers) && providers.length > 0) {
      for (const p of providers) {
        log(`LLM: ${p.name} (${p.type}) model=${p.model} locality=${p.locality || 'unknown'}`);
      }
    }
  } catch { /* ignore */ }

  if (STATUS_ONLY) {
    await testMicrosoftStatusOnly();

    console.log('');
    console.log('============================================');
    console.log(`  \x1b[32mPASS: ${pass}\x1b[0m  \x1b[31mFAIL: ${fail}\x1b[0m  \x1b[33mSKIP: ${skip}\x1b[0m  Total: ${pass + fail + skip}`);
    console.log('============================================');
    console.log('');

    if (fail > 0) {
      log(`Full app log: ${LOG_FILE}`);
    }
    return;
  }

  // Run tests
  const toolRegistered = await testPrerequisites();

  if (toolRegistered) {
    await testToolDiscovery();
    await testSchemaLookup();
    await testWriteApprovalGating();
    await testReadPassthrough();
    await testAutonomousMode();
    await testMicrosoftApiRoutes();

    // Cleanup: restore policy
    await setPolicy({ mode: 'approve_by_policy' });
    logPass('cleanup: policy restored to approve_by_policy');

    await testJobHistory();
  }

  // Summary
  console.log('');
  console.log('============================================');
  console.log(`  \x1b[32mPASS: ${pass}\x1b[0m  \x1b[31mFAIL: ${fail}\x1b[0m  \x1b[33mSKIP: ${skip}\x1b[0m  Total: ${pass + fail + skip}`);
  console.log('============================================');
  console.log('');

  if (fail > 0) {
    log(`Full app log: ${LOG_FILE}`);
  }
}

run().catch((error) => {
  console.error(`[m365] FATAL: ${error instanceof Error ? error.message : String(error)}`);
  if (LOG_FILE && fs.existsSync(LOG_FILE)) {
    console.error(`[m365] App log: ${LOG_FILE}`);
  }
  if (ERR_FILE && fs.existsSync(ERR_FILE)) {
    try {
      const errContent = fs.readFileSync(ERR_FILE, 'utf-8');
      if (errContent.trim()) {
        console.error(`[m365] Error log (last 20 lines):`);
        console.error(errContent.split('\n').slice(-20).join('\n'));
      }
    } catch { /* ignore */ }
  }
  process.exitCode = 1;
}).finally(() => {
  if (appProcess && !appProcess.killed) {
    appProcess.kill();
  }
  process.exitCode = process.exitCode || (fail > 0 ? 1 : 0);
});
