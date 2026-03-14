import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolExecutor } from './executor.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox/index.js';
import { AgentMemoryStore } from '../runtime/agent-memory-store.js';
import { ConversationService } from '../runtime/conversation.js';
import { SHARED_TIER_AGENT_STATE_ID } from '../runtime/agent-state-context.js';

const testDirs: string[] = [];
const testServers: Server[] = [];

function createExecutorRoot(): string {
  const root = join(tmpdir(), `guardianagent-tools-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  return root;
}

function createWorkspaceExecutorRoot(): string {
  const root = join(process.cwd(), `.guardianagent-tools-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  testDirs.push(root);
  return root;
}

function toWindowsPath(pathValue: string): string {
  const mnt = pathValue.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mnt) {
    const drive = mnt[1].toUpperCase();
    const rest = mnt[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }
  return pathValue.replace(/\//g, '\\');
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(async () => {
  await Promise.all(testServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

describe('ToolExecutor', () => {
  it('lists builtin tools', () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const names = executor.listToolDefinitions().map((tool) => tool.name);
    expect(names).toContain('fs_read');
    expect(names).toContain('fs_search');
    expect(names).toContain('fs_write');
    expect(names).toContain('fs_mkdir');
    expect(names).toContain('shell_safe');
    expect(names).toContain('chrome_job');
    expect(names).toContain('campaign_create');
    expect(names).toContain('campaign_run');
    expect(names).toContain('gmail_send');
  });

  it('keeps update_tool_policy always loaded when policy updates are enabled', () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      agentPolicyUpdates: {
        allowedPaths: true,
        allowedCommands: false,
        allowedDomains: true,
      },
    });

    const alwaysLoaded = executor.listAlwaysLoadedDefinitions().map((tool) => tool.name);
    expect(alwaysLoaded).toContain('update_tool_policy');
  });

  it('includes configured cloud profiles and tool discovery guidance in tool context', () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost', 'api.vercel.com', 'host.social.example'],
      agentPolicyUpdates: {
        allowedPaths: true,
        allowedCommands: false,
        allowedDomains: true,
      },
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'social',
          name: 'Social WHM',
          type: 'whm',
          host: 'https://host.social.example/',
          username: 'root',
          apiToken: 'secret',
          defaultCpanelUser: 'socialuser',
        }],
        vercelProfiles: [{
          id: 'web-prod',
          name: 'Web Production',
          apiToken: 'vercel-secret',
        }],
      },
    });

    const context = executor.getToolContext();
    expect(context).toContain('Enabled tool categories:');
    expect(context).toContain('Policy updates via chat: enabled via update_tool_policy (add_path, remove_path, add_domain, remove_domain)');
    expect(context).toContain('Additional tools may be hidden by deferred loading. Use find_tools to discover tools that are not currently visible.');
    expect(context).toContain('Cloud tools: enabled');
    expect(context).toContain('Cloud tool families available via find_tools: cpanel_*, whm_*, vercel_*, cf_*, aws_*, gcp_*, azure_*');
    expect(context).toContain('Use configured cloud profile ids exactly as listed below when calling cloud tools.');
    expect(context).toContain('- social: provider=whm');
    expect(context).toContain('endpoint=https://host.social.example:2087');
    expect(context).toContain('credential=ready');
    expect(context).toContain('hostAllowlisted=yes');
    expect(context).toContain('suggestedReadOnlyTest=whm_status');
    expect(context).toContain('defaultCpanelUser=socialuser');
    expect(context).toContain('- web-prod: provider=vercel');
    expect(context).toContain('suggestedReadOnlyTest=vercel_status');
  });

  it('returns cPanel account summaries through a configured profile', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/execute/StatsBar/get_stats')) {
        res.end(JSON.stringify({
          result: {
            status: 1,
            data: { disk_used_percent: 42 },
          },
        }));
        return;
      }
      if (req.url?.includes('/execute/DomainInfo/list_domains')) {
        res.end(JSON.stringify({
          result: {
            status: 1,
            data: { main_domain: 'example.com', addon_domains: ['shop.example.com'] },
          },
        }));
        return;
      }
      if (req.url?.includes('/execute/ResourceUsage/get_usages')) {
        res.end(JSON.stringify({
          result: {
            status: 1,
            data: [{ description: 'CPU', state: 'ok' }],
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'primary',
          name: 'Primary cPanel',
          type: 'cpanel',
          host: '127.0.0.1',
          port: address.port,
          username: 'alice',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const result = await executor.runTool({
      toolName: 'cpanel_account',
      args: { profile: 'primary' },
      origin: 'cli',
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      profile: 'primary',
      account: 'alice',
      stats: { disk_used_percent: 42 },
      domains: { main_domain: 'example.com', addon_domains: ['shop.example.com'] },
    });
  });

  it('lists WHM accounts through a configured profile', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/json-api/listaccts')) {
        res.end(JSON.stringify({
          metadata: { result: 1 },
          data: {
            acct: [
              { user: 'alice', domain: 'example.com', owner: 'root' },
              { user: 'bob', domain: 'example.net', owner: 'root' },
            ],
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'whm-main',
          name: 'WHM Main',
          type: 'whm',
          host: '127.0.0.1',
          port: address.port,
          username: 'root',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const result = await executor.runTool({
      toolName: 'whm_accounts',
      args: { profile: 'whm-main', action: 'list', search: 'bob' },
      origin: 'cli',
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      profile: 'whm-main',
      action: 'list',
      total: 2,
      returned: 1,
      accounts: [{ user: 'bob', domain: 'example.net', owner: 'root' }],
    });
  });

  it('normalizes WHM profile hosts entered as full URLs before execution', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/json-api/gethostname')) {
        res.end(JSON.stringify({
          metadata: { result: 1 },
          data: { hostname: 'whm.social.local' },
        }));
        return;
      }
      if (req.url?.includes('/json-api/version')) {
        res.end(JSON.stringify({
          metadata: { result: 1 },
          data: { version: '124.0.1' },
        }));
        return;
      }
      if (req.url?.includes('/json-api/systemloadavg')) {
        res.end(JSON.stringify({
          metadata: { result: 1 },
          data: [0.12, 0.08, 0.04],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'social',
          name: 'Social WHM',
          type: 'whm',
          host: `http://127.0.0.1:${address.port}/`,
          username: 'root',
          apiToken: 'secret',
        }],
      },
    });

    const result = await executor.runTool({
      toolName: 'whm_status',
      args: { profile: 'social', includeServices: false },
      origin: 'cli',
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      profile: 'social',
      host: '127.0.0.1',
      hostname: { hostname: 'whm.social.local' },
      version: { version: '124.0.1' },
    });
  });

  it('requires approval for WHM account creation and executes after approval', async () => {
    const requests: Array<{ method: string; url: string | undefined }> = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method ?? 'GET', url: req.url });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/json-api/createacct')) {
        res.end(JSON.stringify({
          metadata: { result: 1 },
          data: {
            acct: [{ user: 'alice', domain: 'example.com' }],
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'whm-main',
          name: 'WHM Main',
          type: 'whm',
          host: '127.0.0.1',
          port: address.port,
          username: 'root',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const pending = await executor.runTool({
      toolName: 'whm_accounts',
      args: {
        profile: 'whm-main',
        action: 'create',
        username: 'alice',
        domain: 'example.com',
        password: 'StrongPass!23',
      },
      origin: 'cli',
    });

    expect(pending.success).toBe(false);
    expect(pending.status).toBe('pending_approval');
    expect(pending.approvalId).toBeDefined();

    const approved = await executor.decideApproval(pending.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'create',
      username: 'alice',
      domain: 'example.com',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST' });
    expect(requests[0]?.url).toContain('/json-api/createacct');
  });

  it('lists cPanel domains without approval and gates mutations', async () => {
    const requests: Array<{ method: string; url: string | undefined }> = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method ?? 'GET', url: req.url });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/execute/DomainInfo/list_domains')) {
        res.end(JSON.stringify({
          result: {
            status: 1,
            data: { main_domain: 'example.com', sub_domains: ['dev.example.com'] },
          },
        }));
        return;
      }
      if (req.url?.includes('/execute/SubDomain/addsubdomain')) {
        res.end(JSON.stringify({
          result: {
            status: 1,
            data: { statusmsg: 'created' },
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'primary',
          name: 'Primary cPanel',
          type: 'cpanel',
          host: '127.0.0.1',
          port: address.port,
          username: 'alice',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const list = await executor.runTool({
      toolName: 'cpanel_domains',
      args: { profile: 'primary', action: 'list' },
      origin: 'cli',
    });

    expect(list.success).toBe(true);
    expect(list.output).toMatchObject({
      action: 'list',
      data: { main_domain: 'example.com', sub_domains: ['dev.example.com'] },
    });

    const addPending = await executor.runTool({
      toolName: 'cpanel_domains',
      args: {
        profile: 'primary',
        action: 'add_subdomain',
        domain: 'blog',
        rootDomain: 'example.com',
      },
      origin: 'cli',
    });

    expect(addPending.success).toBe(false);
    expect(addPending.status).toBe('pending_approval');

    const approved = await executor.decideApproval(addPending.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'add_subdomain',
      domain: 'blog',
      rootDomain: 'example.com',
    });

    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(requests[1]).toMatchObject({ method: 'POST' });
  });

  it('parses cPanel DNS zones without approval and gates mass edits', async () => {
    const requests: Array<{ method: string; url: string | undefined }> = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method ?? 'GET', url: req.url });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/execute/DNS/parse_zone')) {
        res.end(JSON.stringify({
          result: { status: 1, data: { zone: 'example.com', records: [{ name: 'www', type: 'A' }] } },
        }));
        return;
      }
      if (req.url?.includes('/execute/DNS/mass_edit_zone')) {
        res.end(JSON.stringify({
          result: { status: 1, data: { updated: true } },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'cp',
          name: 'CP',
          type: 'cpanel',
          host: '127.0.0.1',
          port: address.port,
          username: 'alice',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const read = await executor.runTool({
      toolName: 'cpanel_dns',
      args: { profile: 'cp', action: 'parse_zone', zone: 'example.com' },
      origin: 'cli',
    });
    expect(read.success).toBe(true);
    expect(read.output).toMatchObject({ action: 'parse_zone', zone: 'example.com' });

    const edit = await executor.runTool({
      toolName: 'cpanel_dns',
      args: { profile: 'cp', action: 'mass_edit_zone', zone: 'example.com', add: [{ name: 'blog', type: 'A', address: '1.2.3.4' }] },
      origin: 'cli',
    });
    expect(edit.success).toBe(false);
    expect(edit.status).toBe('pending_approval');
    const approved = await executor.decideApproval(edit.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(requests[1]).toMatchObject({ method: 'POST' });
  });

  it('lists cPanel backups and approval-gates backup creation', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/execute/Backup/list_backups')) {
        res.end(JSON.stringify({
          result: { status: 1, data: [{ file: 'backup-1.tar.gz' }] },
        }));
        return;
      }
      if (req.url?.includes('/execute/Backup/fullbackup_to_homedir')) {
        res.end(JSON.stringify({
          result: { status: 1, data: { queued: true } },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'cp',
          name: 'CP',
          type: 'cpanel',
          host: '127.0.0.1',
          port: address.port,
          username: 'alice',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const list = await executor.runTool({
      toolName: 'cpanel_backups',
      args: { profile: 'cp', action: 'list' },
      origin: 'cli',
    });
    expect(list.success).toBe(true);
    expect(list.output).toMatchObject({ action: 'list', data: [{ file: 'backup-1.tar.gz' }] });

    const create = await executor.runTool({
      toolName: 'cpanel_backups',
      args: { profile: 'cp', action: 'create', homedir: 'include' },
      origin: 'cli',
    });
    expect(create.success).toBe(false);
    expect(create.status).toBe('pending_approval');
  });

  it('lists cPanel SSL certs and redacts private key material from install output', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/execute/SSL/list_certs')) {
        res.end(JSON.stringify({
          result: { status: 1, data: [{ domain: 'example.com', not_after: '2026-12-31' }] },
        }));
        return;
      }
      if (req.url?.includes('/execute/SSL/install_ssl')) {
        res.end(JSON.stringify({
          result: { status: 1, data: { domain: 'example.com', key: 'PRIVATE-KEY' } },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'cp',
          name: 'CP',
          type: 'cpanel',
          host: '127.0.0.1',
          port: address.port,
          username: 'alice',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    const list = await executor.runTool({
      toolName: 'cpanel_ssl',
      args: { profile: 'cp', action: 'list_certs' },
      origin: 'cli',
    });
    expect(list.success).toBe(true);

    const install = await executor.runTool({
      toolName: 'cpanel_ssl',
      args: {
        profile: 'cp',
        action: 'install_ssl',
        domain: 'example.com',
        certificate: 'CERT',
        privateKey: 'KEY',
      },
      origin: 'cli',
    });
    expect(install.success).toBe(false);
    expect(install.status).toBe('pending_approval');
    const approved = await executor.decideApproval(install.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'install_ssl',
      domain: 'example.com',
      data: { domain: 'example.com', key: '[REDACTED]' },
    });
  });

  it('supports WHM DNS, SSL, backup, and service phase-one actions', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/json-api/listzones')) {
        res.end(JSON.stringify({ metadata: { result: 1 }, data: { zones: ['example.com'] } }));
        return;
      }
      if (req.url?.includes('/json-api/get_autossl_providers')) {
        res.end(JSON.stringify({ metadata: { result: 1 }, data: { providers: ['letsencrypt'] } }));
        return;
      }
      if (req.url?.includes('/json-api/backup_config_get')) {
        res.end(JSON.stringify({ metadata: { result: 1 }, data: { enabled: true } }));
        return;
      }
      if (req.url?.includes('/json-api/servicestatus')) {
        res.end(JSON.stringify({ metadata: { result: 1 }, data: { service: [{ name: 'httpd', running: 1 }] } }));
        return;
      }
      if (req.url?.includes('/json-api/restartservice')) {
        res.end(JSON.stringify({ metadata: { result: 1 }, data: { restarted: 'httpd' } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cpanelProfiles: [{
          id: 'whm',
          name: 'WHM',
          type: 'whm',
          host: '127.0.0.1',
          port: address.port,
          username: 'root',
          apiToken: 'secret',
          ssl: false,
        }],
      },
    });

    expect((await executor.runTool({ toolName: 'whm_dns', args: { profile: 'whm', action: 'list' }, origin: 'cli' })).success).toBe(true);
    expect((await executor.runTool({ toolName: 'whm_ssl', args: { profile: 'whm', action: 'list_providers' }, origin: 'cli' })).success).toBe(true);
    expect((await executor.runTool({ toolName: 'whm_backup', args: { profile: 'whm', action: 'config_get' }, origin: 'cli' })).success).toBe(true);
    expect((await executor.runTool({ toolName: 'whm_services', args: { profile: 'whm', action: 'status' }, origin: 'cli' })).success).toBe(true);

    const restart = await executor.runTool({
      toolName: 'whm_services',
      args: { profile: 'whm', action: 'restart', service: 'httpd' },
      origin: 'cli',
    });
    expect(restart.success).toBe(false);
    expect(restart.status).toBe('pending_approval');
    await executor.decideApproval(restart.approvalId!, 'approved', 'tester');
    expect(requests.some((url) => url.includes('/json-api/restartservice'))).toBe(true);
  });

  it('executes Vercel read-only tools and redacts env values', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v10/projects?')) {
        res.end(JSON.stringify({
          projects: [{ id: 'prj_1', name: 'web-app' }],
        }));
        return;
      }
      if (req.url?.startsWith('/v6/deployments?')) {
        res.end(JSON.stringify({
          deployments: [{ uid: 'dpl_1', name: 'web-app', target: 'production' }],
        }));
        return;
      }
      if (req.url === '/v10/projects/web-app/env?decrypt=true&teamId=team_123') {
        res.end(JSON.stringify({
          envs: [{ id: 'env_1', key: 'API_KEY', value: 'secret-value', target: ['production'] }],
        }));
        return;
      }
      if (req.url?.startsWith('/v1/projects/prj_1/deployments/dpl_1/runtime-logs?')) {
        res.end(JSON.stringify({
          entries: [{ message: 'hello', level: 'info' }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        vercelProfiles: [{
          id: 'vercel-main',
          name: 'Vercel Main',
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          apiToken: 'secret',
          teamId: 'team_123',
        }],
      },
    });

    const status = await executor.runTool({
      toolName: 'vercel_status',
      args: { profile: 'vercel-main' },
      origin: 'cli',
    });
    expect(status.success).toBe(true);
    expect(status.output).toMatchObject({
      profile: 'vercel-main',
      projectCount: 1,
      deploymentCount: 1,
    });

    const envs = await executor.runTool({
      toolName: 'vercel_env',
      args: { profile: 'vercel-main', action: 'list', project: 'web-app', decrypt: true },
      origin: 'cli',
    });
    expect(envs.success).toBe(true);
    expect(envs.output).toMatchObject({
      action: 'list',
      project: 'web-app',
      data: {
        envs: [{ id: 'env_1', key: 'API_KEY', value: '[REDACTED]', target: ['production'] }],
      },
    });

    const logs = await executor.runTool({
      toolName: 'vercel_logs',
      args: { profile: 'vercel-main', action: 'runtime', project: 'prj_1', deploymentId: 'dpl_1' },
      origin: 'cli',
    });
    expect(logs.success).toBe(true);
    expect(logs.output).toMatchObject({
      action: 'runtime',
      project: 'prj_1',
      deploymentId: 'dpl_1',
      data: { entries: [{ message: 'hello', level: 'info' }] },
    });
  });

  it('requires approval for Vercel env mutations and redacts stored values', async () => {
    const requests: Array<{ method: string; url: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', url: req.url, body: raw });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v10/projects/web-app/env?upsert=true&teamId=team_123') {
          res.end(JSON.stringify({
            created: { id: 'env_1', key: 'API_KEY', value: 'secret-value', target: ['production'] },
          }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      });
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        vercelProfiles: [{
          id: 'vercel-main',
          name: 'Vercel Main',
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          apiToken: 'secret',
          teamId: 'team_123',
        }],
      },
    });

    const pending = await executor.runTool({
      toolName: 'vercel_env',
      args: {
        profile: 'vercel-main',
        action: 'create',
        project: 'web-app',
        key: 'API_KEY',
        value: 'secret-value',
        targets: ['production'],
        upsert: 'true',
      },
      origin: 'cli',
    });
    expect(pending.success).toBe(false);
    expect(pending.status).toBe('pending_approval');

    const approved = await executor.decideApproval(pending.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'create',
      project: 'web-app',
      data: {
        created: { id: 'env_1', key: 'API_KEY', value: '[REDACTED]', target: ['production'] },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST' });
    expect(requests[0]?.url).toBe('/v10/projects/web-app/env?upsert=true&teamId=team_123');
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      key: 'API_KEY',
      value: 'secret-value',
      type: 'encrypted',
      target: ['production'],
    });
  });

  it('requires approval for Vercel domain updates', async () => {
    const requests: Array<{ method: string; url: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', url: req.url, body: raw });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v9/projects/web-app/domains/example.com?teamId=team_123') {
          res.end(JSON.stringify({ name: 'example.com', redirect: 'https://www.example.com' }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      });
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        vercelProfiles: [{
          id: 'vercel-main',
          name: 'Vercel Main',
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          apiToken: 'secret',
          teamId: 'team_123',
        }],
      },
    });

    const pending = await executor.runTool({
      toolName: 'vercel_domains',
      args: {
        profile: 'vercel-main',
        action: 'update',
        project: 'web-app',
        domain: 'example.com',
        redirect: 'https://www.example.com',
      },
      origin: 'cli',
    });
    expect(pending.success).toBe(false);
    expect(pending.status).toBe('pending_approval');

    const approved = await executor.decideApproval(pending.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'update',
      project: 'web-app',
      domain: 'example.com',
      data: { name: 'example.com', redirect: 'https://www.example.com' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'PATCH', url: '/v9/projects/web-app/domains/example.com?teamId=team_123' });
    expect(JSON.parse(requests[0]!.body)).toEqual({ redirect: 'https://www.example.com' });
  });

  it('executes Cloudflare read-only tools', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/user/tokens/verify') {
        res.end(JSON.stringify({ success: true, result: { status: 'active' } }));
        return;
      }
      if (req.url === '/accounts/acc_123') {
        res.end(JSON.stringify({ success: true, result: { id: 'acc_123', name: 'Main Account' } }));
        return;
      }
      if (req.url === '/zones?per_page=20') {
        res.end(JSON.stringify({ success: true, result: [{ id: 'zone_1', name: 'example.com' }] }));
        return;
      }
      if (req.url === '/zones/zone_1/dns_records') {
        res.end(JSON.stringify({ success: true, result: [{ id: 'record_1', type: 'A', name: 'app.example.com' }] }));
        return;
      }
      if (req.url === '/zones/zone_1/settings/ssl') {
        res.end(JSON.stringify({ success: true, result: { id: 'ssl', value: 'full' } }));
        return;
      }
      if (req.url === '/zones/zone_1/settings/min_tls_version') {
        res.end(JSON.stringify({ success: true, result: { id: 'min_tls_version', value: '1.2' } }));
        return;
      }
      if (req.url === '/zones/zone_1/settings/tls_1_3') {
        res.end(JSON.stringify({ success: true, result: { id: 'tls_1_3', value: 'on' } }));
        return;
      }
      if (req.url === '/zones/zone_1/settings/always_use_https') {
        res.end(JSON.stringify({ success: true, result: { id: 'always_use_https', value: 'off' } }));
        return;
      }
      if (req.url === '/zones/zone_1/settings/automatic_https_rewrites') {
        res.end(JSON.stringify({ success: true, result: { id: 'automatic_https_rewrites', value: 'on' } }));
        return;
      }
      if (req.url === '/zones/zone_1/settings/opportunistic_encryption') {
        res.end(JSON.stringify({ success: true, result: { id: 'opportunistic_encryption', value: 'on' } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }], result: null }));
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cloudflareProfiles: [{
          id: 'cf-main',
          name: 'Cloudflare Main',
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          apiToken: 'secret',
          accountId: 'acc_123',
          defaultZoneId: 'zone_1',
        }],
      },
    });

    const status = await executor.runTool({
      toolName: 'cf_status',
      args: { profile: 'cf-main' },
      origin: 'cli',
    });
    expect(status.success).toBe(true);
    expect(status.output).toMatchObject({
      profile: 'cf-main',
      token: { status: 'active' },
      account: { id: 'acc_123', name: 'Main Account' },
      zones: [{ id: 'zone_1', name: 'example.com' }],
    });

    const dns = await executor.runTool({
      toolName: 'cf_dns',
      args: { profile: 'cf-main', action: 'list' },
      origin: 'cli',
    });
    expect(dns.success).toBe(true);
    expect(dns.output).toMatchObject({
      action: 'list',
      zoneId: 'zone_1',
      data: [{ id: 'record_1', type: 'A', name: 'app.example.com' }],
    });

    const ssl = await executor.runTool({
      toolName: 'cf_ssl',
      args: { profile: 'cf-main', action: 'list_settings' },
      origin: 'cli',
    });
    expect(ssl.success).toBe(true);
    expect(ssl.output).toMatchObject({
      action: 'list_settings',
      zoneId: 'zone_1',
    });
  });

  it('requires approval for Cloudflare DNS mutations', async () => {
    const requests: Array<{ method: string; url: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      if (req.url === '/zones?name=example.com&per_page=1') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, result: [{ id: 'zone_1', name: 'example.com' }] }));
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', url: req.url, body: raw });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/zones/zone_1/dns_records') {
          res.end(JSON.stringify({
            success: true,
            result: { id: 'record_1', type: 'A', name: 'app.example.com', content: '1.2.3.4' },
          }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }], result: null }));
      });
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cloudflareProfiles: [{
          id: 'cf-main',
          name: 'Cloudflare Main',
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          apiToken: 'secret',
        }],
      },
    });

    const pending = await executor.runTool({
      toolName: 'cf_dns',
      args: {
        profile: 'cf-main',
        action: 'create',
        zone: 'example.com',
        type: 'A',
        name: 'app.example.com',
        content: '1.2.3.4',
      },
      origin: 'cli',
    });
    expect(pending.success).toBe(false);
    expect(pending.status).toBe('pending_approval');

    const approved = await executor.decideApproval(pending.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'create',
      zoneId: 'zone_1',
      data: { id: 'record_1', type: 'A', name: 'app.example.com', content: '1.2.3.4' },
    });
    expect(requests.some((entry) => entry.url === '/zones/zone_1/dns_records' && entry.method === 'POST')).toBe(true);
  });

  it('requires approval for Cloudflare cache purges', async () => {
    const requests: Array<{ method: string; url: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      if (req.url === '/zones?name=example.com&per_page=1') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ success: true, result: [{ id: 'zone_1', name: 'example.com' }] }));
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        requests.push({ method: req.method ?? 'GET', url: req.url, body: raw });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/zones/zone_1/purge_cache') {
          res.end(JSON.stringify({ success: true, result: { id: 'purge_1' } }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }], result: null }));
      });
    });
    testServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: createExecutorRoot(),
      policyMode: 'approve_by_policy',
      allowedDomains: ['127.0.0.1'],
      cloudConfig: {
        enabled: true,
        cloudflareProfiles: [{
          id: 'cf-main',
          name: 'Cloudflare Main',
          apiBaseUrl: `http://127.0.0.1:${address.port}`,
          apiToken: 'secret',
        }],
      },
    });

    const pending = await executor.runTool({
      toolName: 'cf_cache',
      args: { profile: 'cf-main', action: 'purge_tags', zone: 'example.com', tags: ['release-123'] },
      origin: 'cli',
    });
    expect(pending.success).toBe(false);
    expect(pending.status).toBe('pending_approval');

    const approved = await executor.decideApproval(pending.approvalId!, 'approved', 'tester');
    expect(approved.success).toBe(true);
    expect(approved.result?.output).toMatchObject({
      action: 'purge_tags',
      zoneId: 'zone_1',
      data: { id: 'purge_1' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/zones/zone_1/purge_cache' });
    expect(JSON.parse(requests[0]!.body)).toEqual({ tags: ['release-123'] });
  });

  it('executes AWS read-only tools through an AWS profile', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['amazonaws.com'],
      cloudConfig: {
        enabled: true,
        awsProfiles: [{
          id: 'aws-main',
          name: 'AWS Main',
          region: 'us-east-1',
        }],
      },
    });

    const fakeClient = {
      config: { id: 'aws-main', name: 'AWS Main', region: 'us-east-1' },
      getCallerIdentity: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/tester' }),
      listAccountAliases: async () => ({ AccountAliases: ['main'] }),
      listS3Buckets: async () => ({ Buckets: [{ Name: 'bucket-a' }] }),
      getS3ObjectText: async () => ({ metadata: { contentType: 'text/plain' }, bodyText: 'hello world' }),
    };
    (executor as unknown as { createAwsClient: () => typeof fakeClient }).createAwsClient = () => fakeClient;
    (executor as unknown as { describeAwsEndpoint: () => string }).describeAwsEndpoint = () => 'https://sts.us-east-1.amazonaws.com';

    const status = await executor.runTool({
      toolName: 'aws_status',
      args: { profile: 'aws-main' },
      origin: 'cli',
    });
    expect(status.success).toBe(true);
    expect(status.output).toMatchObject({
      profile: 'aws-main',
      region: 'us-east-1',
      identity: { Account: '123456789012' },
      aliases: { AccountAliases: ['main'] },
    });

    const s3Object = await executor.runTool({
      toolName: 'aws_s3_buckets',
      args: { profile: 'aws-main', action: 'get_object', bucket: 'bucket-a', key: 'notes.txt' },
      origin: 'cli',
    });
    expect(s3Object.success).toBe(true);
    expect(s3Object.output).toMatchObject({
      action: 'get_object',
      bucket: 'bucket-a',
      key: 'notes.txt',
      data: { metadata: { contentType: 'text/plain' }, bodyText: 'hello world' },
    });
  });

  it('requires approval for AWS EC2 and Route53 mutations', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['amazonaws.com'],
      cloudConfig: {
        enabled: true,
        awsProfiles: [{
          id: 'aws-main',
          name: 'AWS Main',
          region: 'us-east-1',
        }],
      },
    });

    const calls: Array<{ method: string; payload: unknown }> = [];
    const fakeClient = {
      config: { id: 'aws-main', name: 'AWS Main', region: 'us-east-1' },
      startEc2Instances: async (instanceIds: string[]) => {
        calls.push({ method: 'startEc2Instances', payload: instanceIds });
        return { StartingInstances: instanceIds.map((id) => ({ InstanceId: id })) };
      },
      changeRoute53Records: async (hostedZoneId: string, changes: unknown) => {
        calls.push({ method: 'changeRoute53Records', payload: { hostedZoneId, changes } });
        return { ChangeInfo: { Id: 'change-1', Status: 'PENDING' } };
      },
    };
    (executor as unknown as { createAwsClient: () => typeof fakeClient }).createAwsClient = () => fakeClient;
    (executor as unknown as { describeAwsEndpoint: () => string }).describeAwsEndpoint = () => 'https://ec2.us-east-1.amazonaws.com';

    const ec2Pending = await executor.runTool({
      toolName: 'aws_ec2_instances',
      args: { profile: 'aws-main', action: 'start', instanceIds: ['i-123'] },
      origin: 'cli',
    });
    expect(ec2Pending.success).toBe(false);
    expect(ec2Pending.status).toBe('pending_approval');
    const ec2Approved = await executor.decideApproval(ec2Pending.approvalId!, 'approved', 'tester');
    expect(ec2Approved.success).toBe(true);
    expect(ec2Approved.result?.output).toMatchObject({
      action: 'start',
      instanceIds: ['i-123'],
    });

    const route53Pending = await executor.runTool({
      toolName: 'aws_route53',
      args: {
        profile: 'aws-main',
        action: 'change_records',
        hostedZoneId: 'Z123',
        changeAction: 'UPSERT',
        type: 'A',
        name: 'app.example.com',
        records: ['1.2.3.4'],
      },
      origin: 'cli',
    });
    expect(route53Pending.success).toBe(false);
    expect(route53Pending.status).toBe('pending_approval');
    const route53Approved = await executor.decideApproval(route53Pending.approvalId!, 'approved', 'tester');
    expect(route53Approved.success).toBe(true);
    expect(route53Approved.result?.output).toMatchObject({
      action: 'change_records',
      hostedZoneId: 'Z123',
    });

    expect(calls).toEqual([
      { method: 'startEc2Instances', payload: ['i-123'] },
      {
        method: 'changeRoute53Records',
        payload: {
          hostedZoneId: 'Z123',
          changes: [{
            Action: 'UPSERT',
            ResourceRecordSet: {
              Name: 'app.example.com',
              Type: 'A',
              TTL: 300,
              ResourceRecords: [{ Value: '1.2.3.4' }],
            },
          }],
        },
      },
    ]);
  });

  it('requires approval for AWS S3 bucket lifecycle mutations', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['amazonaws.com'],
      cloudConfig: {
        enabled: true,
        awsProfiles: [{
          id: 'aws-main',
          name: 'AWS Main',
          region: 'us-east-1',
        }],
      },
    });

    const calls: Array<{ method: string; payload: unknown }> = [];
    const fakeClient = {
      config: { id: 'aws-main', name: 'AWS Main', region: 'us-east-1' },
      createS3Bucket: async (bucket: string) => {
        calls.push({ method: 'createS3Bucket', payload: bucket });
        return { Location: '/app-bucket' };
      },
      deleteS3Bucket: async (bucket: string) => {
        calls.push({ method: 'deleteS3Bucket', payload: bucket });
        return {};
      },
    };
    (executor as unknown as { createAwsClient: () => typeof fakeClient }).createAwsClient = () => fakeClient;
    (executor as unknown as { describeAwsEndpoint: () => string }).describeAwsEndpoint = () => 'https://s3.us-east-1.amazonaws.com';

    const createPending = await executor.runTool({
      toolName: 'aws_s3_buckets',
      args: { profile: 'aws-main', action: 'create_bucket', bucket: 'app-bucket' },
      origin: 'cli',
    });
    expect(createPending.success).toBe(false);
    expect(createPending.status).toBe('pending_approval');
    const createApproved = await executor.decideApproval(createPending.approvalId!, 'approved', 'tester');
    expect(createApproved.success).toBe(true);
    expect(createApproved.result?.output).toMatchObject({
      action: 'create_bucket',
      bucket: 'app-bucket',
      data: { Location: '/app-bucket' },
    });

    const deletePending = await executor.runTool({
      toolName: 'aws_s3_buckets',
      args: { profile: 'aws-main', action: 'delete_bucket', bucket: 'app-bucket' },
      origin: 'cli',
    });
    expect(deletePending.success).toBe(false);
    expect(deletePending.status).toBe('pending_approval');
    const deleteApproved = await executor.decideApproval(deletePending.approvalId!, 'approved', 'tester');
    expect(deleteApproved.success).toBe(true);
    expect(deleteApproved.result?.output).toMatchObject({
      action: 'delete_bucket',
      bucket: 'app-bucket',
    });

    expect(calls).toEqual([
      { method: 'createS3Bucket', payload: 'app-bucket' },
      { method: 'deleteS3Bucket', payload: 'app-bucket' },
    ]);
  });

  it('executes GCP read-only tools through a GCP profile', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['googleapis.com'],
      cloudConfig: {
        enabled: true,
        gcpProfiles: [{
          id: 'gcp-main',
          name: 'GCP Main',
          projectId: 'guardian-prod',
          location: 'australia-southeast1',
          accessToken: 'gcp-secret',
        }],
      },
    });

    const fakeClient = {
      config: { id: 'gcp-main', name: 'GCP Main', projectId: 'guardian-prod', location: 'australia-southeast1' },
      getProject: async () => ({ projectId: 'guardian-prod', lifecycleState: 'ACTIVE' }),
      listEnabledServices: async () => ({ services: [{ name: 'compute.googleapis.com' }] }),
      listStorageBuckets: async () => ({ items: [{ name: 'bucket-a' }] }),
      getStorageObjectText: async () => ({ metadata: { contentType: 'text/plain' }, bodyText: 'hello gcp' }),
    };
    (executor as unknown as { createGcpClient: () => typeof fakeClient }).createGcpClient = () => fakeClient;
    (executor as unknown as { describeGcpEndpoint: () => string }).describeGcpEndpoint = () => 'https://cloudresourcemanager.googleapis.com';

    const status = await executor.runTool({
      toolName: 'gcp_status',
      args: { profile: 'gcp-main' },
      origin: 'cli',
    });
    expect(status.success).toBe(true);
    expect(status.output).toMatchObject({
      profile: 'gcp-main',
      projectId: 'guardian-prod',
      project: { projectId: 'guardian-prod' },
      services: { services: [{ name: 'compute.googleapis.com' }] },
    });

    const object = await executor.runTool({
      toolName: 'gcp_storage',
      args: { profile: 'gcp-main', action: 'get_object', bucket: 'bucket-a', object: 'notes.txt' },
      origin: 'cli',
    });
    expect(object.success).toBe(true);
    expect(object.output).toMatchObject({
      action: 'get_object',
      bucket: 'bucket-a',
      object: 'notes.txt',
      data: { metadata: { contentType: 'text/plain' }, bodyText: 'hello gcp' },
    });
  });

  it('requires approval for GCP compute and DNS mutations', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['googleapis.com'],
      cloudConfig: {
        enabled: true,
        gcpProfiles: [{
          id: 'gcp-main',
          name: 'GCP Main',
          projectId: 'guardian-prod',
          location: 'australia-southeast1',
          accessToken: 'gcp-secret',
        }],
      },
    });

    const calls: Array<{ method: string; payload: unknown }> = [];
    const fakeClient = {
      config: { id: 'gcp-main', name: 'GCP Main', projectId: 'guardian-prod', location: 'australia-southeast1' },
      startComputeInstance: async (zone: string, instance: string) => {
        calls.push({ method: 'startComputeInstance', payload: { zone, instance } });
        return { name: 'op-start-1', targetLink: instance };
      },
      changeDnsRecordSets: async (managedZone: string, body: unknown) => {
        calls.push({ method: 'changeDnsRecordSets', payload: { managedZone, body } });
        return { id: 'change-1', status: 'pending' };
      },
    };
    (executor as unknown as { createGcpClient: () => typeof fakeClient }).createGcpClient = () => fakeClient;
    (executor as unknown as { describeGcpEndpoint: () => string }).describeGcpEndpoint = () => 'https://compute.googleapis.com';

    const computePending = await executor.runTool({
      toolName: 'gcp_compute',
      args: { profile: 'gcp-main', action: 'start', zone: 'australia-southeast1-b', instance: 'web-1' },
      origin: 'cli',
    });
    expect(computePending.success).toBe(false);
    expect(computePending.status).toBe('pending_approval');
    const computeApproved = await executor.decideApproval(computePending.approvalId!, 'approved', 'tester');
    expect(computeApproved.success).toBe(true);
    expect(computeApproved.result?.output).toMatchObject({
      action: 'start',
      zone: 'australia-southeast1-b',
      instance: 'web-1',
    });

    const dnsPending = await executor.runTool({
      toolName: 'gcp_dns',
      args: {
        profile: 'gcp-main',
        action: 'change_records',
        managedZone: 'primary-zone',
        additions: [{
          name: 'app.example.com.',
          type: 'A',
          ttl: 300,
          rrdatas: ['1.2.3.4'],
        }],
      },
      origin: 'cli',
    });
    expect(dnsPending.success).toBe(false);
    expect(dnsPending.status).toBe('pending_approval');
    const dnsApproved = await executor.decideApproval(dnsPending.approvalId!, 'approved', 'tester');
    expect(dnsApproved.success).toBe(true);
    expect(dnsApproved.result?.output).toMatchObject({
      action: 'change_records',
      managedZone: 'primary-zone',
    });

    expect(calls).toEqual([
      {
        method: 'startComputeInstance',
        payload: { zone: 'australia-southeast1-b', instance: 'web-1' },
      },
      {
        method: 'changeDnsRecordSets',
        payload: {
          managedZone: 'primary-zone',
          body: {
            additions: [{
              name: 'app.example.com.',
              type: 'A',
              ttl: 300,
              rrdatas: ['1.2.3.4'],
            }],
            deletions: undefined,
          },
        },
      },
    ]);
  });

  it('requires approval for GCP Cloud Run and Storage lifecycle mutations', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['googleapis.com'],
      cloudConfig: {
        enabled: true,
        gcpProfiles: [{
          id: 'gcp-main',
          name: 'GCP Main',
          projectId: 'guardian-prod',
          location: 'australia-southeast1',
          accessToken: 'gcp-secret',
        }],
      },
    });

    const calls: Array<{ method: string; payload: unknown }> = [];
    const fakeClient = {
      config: { id: 'gcp-main', name: 'GCP Main', projectId: 'guardian-prod', location: 'australia-southeast1' },
      deleteCloudRunService: async (location: string, service: string) => {
        calls.push({ method: 'deleteCloudRunService', payload: { location, service } });
        return { name: 'operations/delete-service-1' };
      },
      createStorageBucket: async (bucket: string, location?: string, storageClass?: string) => {
        calls.push({ method: 'createStorageBucket', payload: { bucket, location, storageClass } });
        return { name: bucket, location };
      },
    };
    (executor as unknown as { createGcpClient: () => typeof fakeClient }).createGcpClient = () => fakeClient;
    (executor as unknown as { describeGcpEndpoint: () => string }).describeGcpEndpoint = () => 'https://run.googleapis.com';

    const runPending = await executor.runTool({
      toolName: 'gcp_cloud_run',
      args: { profile: 'gcp-main', action: 'delete_service', service: 'web-app' },
      origin: 'cli',
    });
    expect(runPending.success).toBe(false);
    expect(runPending.status).toBe('pending_approval');
    const runApproved = await executor.decideApproval(runPending.approvalId!, 'approved', 'tester');
    expect(runApproved.success).toBe(true);
    expect(runApproved.result?.output).toMatchObject({
      action: 'delete_service',
      location: 'australia-southeast1',
      service: 'web-app',
    });

    const bucketPending = await executor.runTool({
      toolName: 'gcp_storage',
      args: {
        profile: 'gcp-main',
        action: 'create_bucket',
        bucket: 'app-bucket',
        location: 'AUSTRALIA-SOUTHEAST1',
        storageClass: 'STANDARD',
      },
      origin: 'cli',
    });
    expect(bucketPending.success).toBe(false);
    expect(bucketPending.status).toBe('pending_approval');
    const bucketApproved = await executor.decideApproval(bucketPending.approvalId!, 'approved', 'tester');
    expect(bucketApproved.success).toBe(true);
    expect(bucketApproved.result?.output).toMatchObject({
      action: 'create_bucket',
      bucket: 'app-bucket',
      data: { name: 'app-bucket', location: 'AUSTRALIA-SOUTHEAST1' },
    });

    expect(calls).toEqual([
      { method: 'deleteCloudRunService', payload: { location: 'australia-southeast1', service: 'web-app' } },
      { method: 'createStorageBucket', payload: { bucket: 'app-bucket', location: 'AUSTRALIA-SOUTHEAST1', storageClass: 'STANDARD' } },
    ]);
  });

  it('executes Azure read-only tools through an Azure profile', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['management.azure.com', 'blob.core.windows.net', 'login.microsoftonline.com'],
      cloudConfig: {
        enabled: true,
        azureProfiles: [{
          id: 'azure-main',
          name: 'Azure Main',
          subscriptionId: 'sub-123',
          accessToken: 'azure-secret',
          defaultResourceGroup: 'rg-main',
        }],
      },
    });

    const fakeClient = {
      config: { id: 'azure-main', name: 'Azure Main', subscriptionId: 'sub-123', defaultResourceGroup: 'rg-main' },
      getSubscription: async () => ({ subscriptionId: 'sub-123', displayName: 'Primary' }),
      listResourceGroups: async () => ({ value: [{ name: 'rg-main' }] }),
      listActivityLogs: async () => ({ value: [{ operationName: { value: 'Microsoft.Compute/virtualMachines/start/action' } }] }),
    };
    (executor as unknown as { createAzureClient: () => typeof fakeClient }).createAzureClient = () => fakeClient;
    (executor as unknown as { describeAzureEndpoint: () => string }).describeAzureEndpoint = () => 'https://management.azure.com';

    const status = await executor.runTool({
      toolName: 'azure_status',
      args: { profile: 'azure-main' },
      origin: 'cli',
    });
    expect(status.success).toBe(true);
    expect(status.output).toMatchObject({
      profile: 'azure-main',
      subscriptionId: 'sub-123',
      subscription: { subscriptionId: 'sub-123' },
      resourceGroups: { value: [{ name: 'rg-main' }] },
    });

    const monitor = await executor.runTool({
      toolName: 'azure_monitor',
      args: { profile: 'azure-main', action: 'activity_logs' },
      origin: 'cli',
    });
    expect(monitor.success).toBe(true);
    expect(monitor.output).toMatchObject({
      action: 'activity_logs',
      data: { value: [{ operationName: { value: 'Microsoft.Compute/virtualMachines/start/action' } }] },
    });
  });

  it('requires approval for Azure VM and DNS mutations', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['management.azure.com', 'blob.core.windows.net', 'login.microsoftonline.com'],
      cloudConfig: {
        enabled: true,
        azureProfiles: [{
          id: 'azure-main',
          name: 'Azure Main',
          subscriptionId: 'sub-123',
          accessToken: 'azure-secret',
          defaultResourceGroup: 'rg-main',
        }],
      },
    });

    const calls: Array<{ method: string; payload: unknown }> = [];
    const fakeClient = {
      config: { id: 'azure-main', name: 'Azure Main', subscriptionId: 'sub-123', defaultResourceGroup: 'rg-main' },
      startVm: async (resourceGroup: string, vmName: string) => {
        calls.push({ method: 'startVm', payload: { resourceGroup, vmName } });
        return { name: 'vm-op-1' };
      },
      upsertDnsRecordSet: async (resourceGroup: string, zoneName: string, recordType: string, relativeRecordSetName: string, recordSet: unknown) => {
        calls.push({ method: 'upsertDnsRecordSet', payload: { resourceGroup, zoneName, recordType, relativeRecordSetName, recordSet } });
        return { id: 'dns-op-1' };
      },
    };
    (executor as unknown as { createAzureClient: () => typeof fakeClient }).createAzureClient = () => fakeClient;
    (executor as unknown as { describeAzureEndpoint: () => string }).describeAzureEndpoint = () => 'https://management.azure.com';

    const vmPending = await executor.runTool({
      toolName: 'azure_vms',
      args: { profile: 'azure-main', action: 'start', vmName: 'web-1' },
      origin: 'cli',
    });
    expect(vmPending.success).toBe(false);
    expect(vmPending.status).toBe('pending_approval');
    const vmApproved = await executor.decideApproval(vmPending.approvalId!, 'approved', 'tester');
    expect(vmApproved.success).toBe(true);
    expect(vmApproved.result?.output).toMatchObject({
      action: 'start',
      resourceGroup: 'rg-main',
      vmName: 'web-1',
    });

    const dnsPending = await executor.runTool({
      toolName: 'azure_dns',
      args: {
        profile: 'azure-main',
        action: 'upsert_record_set',
        zoneName: 'example.com',
        recordType: 'A',
        relativeRecordSetName: 'app',
        recordSet: {
          properties: {
            TTL: 300,
            ARecords: [{ ipv4Address: '1.2.3.4' }],
          },
        },
      },
      origin: 'cli',
    });
    expect(dnsPending.success).toBe(false);
    expect(dnsPending.status).toBe('pending_approval');
    const dnsApproved = await executor.decideApproval(dnsPending.approvalId!, 'approved', 'tester');
    expect(dnsApproved.success).toBe(true);
    expect(dnsApproved.result?.output).toMatchObject({
      action: 'upsert_record_set',
      resourceGroup: 'rg-main',
      zoneName: 'example.com',
    });

    expect(calls).toEqual([
      {
        method: 'startVm',
        payload: { resourceGroup: 'rg-main', vmName: 'web-1' },
      },
      {
        method: 'upsertDnsRecordSet',
        payload: {
          resourceGroup: 'rg-main',
          zoneName: 'example.com',
          recordType: 'A',
          relativeRecordSetName: 'app',
          recordSet: {
            properties: {
              TTL: 300,
              ARecords: [{ ipv4Address: '1.2.3.4' }],
            },
          },
        },
      },
    ]);
  });

  it('requires approval for Azure App Service and Storage lifecycle mutations', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedDomains: ['management.azure.com', 'blob.core.windows.net', 'login.microsoftonline.com'],
      cloudConfig: {
        enabled: true,
        azureProfiles: [{
          id: 'azure-main',
          name: 'Azure Main',
          subscriptionId: 'sub-123',
          accessToken: 'azure-secret',
          defaultResourceGroup: 'rg-main',
        }],
      },
    });

    const calls: Array<{ method: string; payload: unknown }> = [];
    const fakeClient = {
      config: { id: 'azure-main', name: 'Azure Main', subscriptionId: 'sub-123', defaultResourceGroup: 'rg-main' },
      deleteWebApp: async (resourceGroup: string, name: string) => {
        calls.push({ method: 'deleteWebApp', payload: { resourceGroup, name } });
        return { id: 'delete-webapp-op' };
      },
      createBlobContainer: async (accountName: string, container: string) => {
        calls.push({ method: 'createBlobContainer', payload: { accountName, container } });
        return {};
      },
    };
    (executor as unknown as { createAzureClient: () => typeof fakeClient }).createAzureClient = () => fakeClient;
    (executor as unknown as { describeAzureEndpoint: () => string }).describeAzureEndpoint = () => 'https://management.azure.com';

    const appPending = await executor.runTool({
      toolName: 'azure_app_service',
      args: { profile: 'azure-main', action: 'delete', name: 'web-app' },
      origin: 'cli',
    });
    expect(appPending.success).toBe(false);
    expect(appPending.status).toBe('pending_approval');
    const appApproved = await executor.decideApproval(appPending.approvalId!, 'approved', 'tester');
    expect(appApproved.success).toBe(true);
    expect(appApproved.result?.output).toMatchObject({
      action: 'delete',
      resourceGroup: 'rg-main',
      name: 'web-app',
    });

    const storagePending = await executor.runTool({
      toolName: 'azure_storage',
      args: { profile: 'azure-main', action: 'create_container', accountName: 'storageacct', container: 'assets' },
      origin: 'cli',
    });
    expect(storagePending.success).toBe(false);
    expect(storagePending.status).toBe('pending_approval');
    const storageApproved = await executor.decideApproval(storagePending.approvalId!, 'approved', 'tester');
    expect(storageApproved.success).toBe(true);
    expect(storageApproved.result?.output).toMatchObject({
      action: 'create_container',
      accountName: 'storageacct',
      container: 'assets',
    });

    expect(calls).toEqual([
      { method: 'deleteWebApp', payload: { resourceGroup: 'rg-main', name: 'web-app' } },
      { method: 'createBlobContainer', payload: { accountName: 'storageacct', container: 'assets' } },
    ]);
  });

  it('rejects fs_write content containing secrets before writing', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const result = await executor.runTool({
      toolName: 'fs_write',
      args: {
        path: 'secret.txt',
        content: 'AWS key: AKIAIOSFODNN7EXAMPLE',
      },
      origin: 'cli',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Write content contains secrets');
  });

  it('fails fs_write before approval when the path is outside allowed roots', async () => {
    const root = createExecutorRoot();
    const outside = join(tmpdir(), `guardianagent-outside-${randomUUID()}`, 'blocked.txt');
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const result = await executor.runTool({
      toolName: 'fs_write',
      args: {
        path: outside,
        content: 'hello',
      },
      origin: 'telegram',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.approvalId).toBeUndefined();
    expect(result.message).toContain('outside allowed paths');
  });

  it('rejects shell_safe commands with shell control operators', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const result = await executor.runTool({
      toolName: 'shell_safe',
      args: { command: 'echo hello && pwd' },
      origin: 'cli',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('shell control operators');
  });

  it('enforces Google Workspace service-specific capabilities for managed MCP tools', async () => {
    const root = createExecutorRoot();
    const checked: Array<{ type: string; params: Record<string, unknown> }> = [];
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      onCheckAction: ({ type, params }) => {
        checked.push({ type, params });
      },
      mcpManager: {
        getAllToolDefinitions: () => ([
          {
            name: 'mcp-gws-calendar_create_event',
            description: 'Create a calendar event in Google Calendar',
            risk: 'network',
            parameters: { type: 'object', properties: {} },
          },
        ]),
        callTool: async () => ({ success: true, output: { ok: true } }),
      } as unknown as import('./mcp-client.js').MCPClientManager,
    });

    const result = await executor.runTool({
      toolName: 'mcp-gws-calendar_create_event',
      args: {},
      origin: 'cli',
    });

    expect(result.status).not.toBe('failed');
    expect(checked).toMatchObject([
      {
        type: 'write_calendar',
        params: {
          toolName: 'calendar_create_event',
        },
      },
    ]);
  });

  it('hot-applies Google Workspace service availability without rebuilding the executor', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const beforeEnable = await executor.runTool({
      toolName: 'gws',
      args: { service: 'gmail', resource: 'users messages', method: 'list' },
      origin: 'cli',
    });
    expect(beforeEnable.success).toBe(false);
    expect(beforeEnable.message).toContain('Google Workspace is not enabled');

    executor.setGwsService({
      execute: async () => ({ success: true, data: { messages: [] } }),
      schema: async () => ({ success: true, data: {} }),
      authStatus: async () => ({ success: true, data: {} }),
      isServiceEnabled: () => true,
      getEnabledServices: () => ['gmail'],
    } as unknown as import('../runtime/gws-service.js').GWSService);

    const afterEnable = await executor.runTool({
      toolName: 'gws',
      args: { service: 'gmail', resource: 'users messages', method: 'list' },
      origin: 'cli',
    });
    expect(afterEnable.success).toBe(true);
    expect(afterEnable.output).toEqual({ messages: [] });

    executor.setGwsService(undefined);

    const afterDisable = await executor.runTool({
      toolName: 'gws',
      args: { service: 'gmail', resource: 'users messages', method: 'list' },
      origin: 'cli',
    });
    expect(afterDisable.success).toBe(false);
    expect(afterDisable.message).toContain('Google Workspace is not enabled');
  });

  it('requires approval for Gmail draft creation via gws in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { id: 'draft-1' } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'gmail',
        resource: 'users drafts',
        method: 'create',
        params: { userId: 'me' },
        json: { message: { raw: 'Zm9v' } },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();
  });

  it('allows Gmail reads via gws without approval in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { messages: [] } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'gmail',
        resource: 'users messages',
        method: 'list',
        params: { userId: 'me', maxResults: 5 },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(true);
    expect(run.status).toBe('succeeded');
    expect(run.output).toEqual({ messages: [] });
  });

  it('requires approval for Calendar create via gws in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { id: 'event-1' } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'calendar',
        resource: 'events',
        method: 'create',
        params: { calendarId: 'primary' },
        json: { summary: 'Test Event' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();
  });

  it('allows Calendar reads via gws without approval in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { items: [] } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'calendar',
        resource: 'events',
        method: 'list',
        params: { calendarId: 'primary' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(true);
    expect(run.status).toBe('succeeded');
  });

  it('requires approval for Drive create via gws in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { id: 'file-1' } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'drive',
        resource: 'files',
        method: 'create',
        json: { name: 'test.txt' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();
  });

  it('allows Drive reads via gws without approval in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { files: [] } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'drive',
        resource: 'files',
        method: 'list',
        params: { pageSize: 10 },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(true);
    expect(run.status).toBe('succeeded');
  });

  it('requires approval for Docs update via gws in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { documentId: 'doc-1' } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'docs',
        resource: 'documents',
        method: 'update',
        json: { title: 'Updated Doc' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();
  });

  it('requires approval for Sheets delete via gws in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: {} }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'sheets',
        resource: 'spreadsheets',
        method: 'delete',
        params: { spreadsheetId: 'sheet-1' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();
  });

  it('allows Calendar create via gws in autonomous mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: { id: 'event-2' } }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'calendar',
        resource: 'events',
        method: 'create',
        params: { calendarId: 'primary' },
        json: { summary: 'Autonomous Event' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(true);
    expect(run.status).toBe('succeeded');
  });

  it('requires approval for unknown GWS service writes in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      gwsService: {
        execute: async () => ({ success: true, data: {} }),
        schema: async () => ({ success: true, data: {} }),
        authStatus: async () => ({ success: true, data: {} }),
        isServiceEnabled: () => true,
        getEnabledServices: () => ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'tasks'],
      } as unknown as import('../runtime/gws-service.js').GWSService,
    });

    const run = await executor.runTool({
      toolName: 'gws',
      args: {
        service: 'tasks',
        resource: 'tasklists',
        method: 'create',
        json: { title: 'New List' },
      },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();
  });

  it('requires approval for mutating tools in approve_by_policy mode', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_write',
      args: { path: 'note.txt', content: 'hello' },
      origin: 'cli',
    });
    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();

    const decided = await executor.decideApproval(run.approvalId!, 'approved', 'tester');
    expect(decided.success).toBe(true);

    const text = await readFile(join(root, 'note.txt'), 'utf-8');
    expect(text).toBe('hello');
  });

  it('creates directories with fs_mkdir after approval', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_mkdir',
      args: { path: 'apps/Testapp', recursive: true },
      origin: 'cli',
    });
    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();

    const decided = await executor.decideApproval(run.approvalId!, 'approved', 'tester');
    expect(decided.success).toBe(true);

    const listing = await executor.runTool({
      toolName: 'fs_list',
      args: { path: 'apps' },
      origin: 'cli',
    });
    expect(listing.success).toBe(true);
    const entries = Array.isArray((listing.output as { entries?: unknown })?.entries)
      ? (listing.output as { entries: Array<{ name?: string; type?: string }> }).entries
      : [];
    expect(entries.some((entry) => entry.name === 'Testapp' && entry.type === 'dir')).toBe(true);
  });

  it('creates empty files with fs_write after approval', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_write',
      args: { path: 'empty.txt', content: '' },
      origin: 'cli',
    });
    expect(run.success).toBe(false);
    expect(run.status).toBe('pending_approval');
    expect(run.approvalId).toBeDefined();

    const decided = await executor.decideApproval(run.approvalId!, 'approved', 'tester');
    expect(decided.success).toBe(true);

    const latestJob = executor.listJobs(1)[0];
    expect(latestJob?.argsRedacted).toEqual({ path: 'empty.txt', content: '' });

    const text = await readFile(join(root, 'empty.txt'), 'utf-8');
    expect(text).toBe('');
  });

  it('rejects invalid tool args before creating approval requests', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_write',
      args: { path: 'note.txt' },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('failed');
    expect(run.approvalId).toBeUndefined();
    expect(run.message).toContain("must have required property 'content'");
  });

  it('rejects non-allowlisted shell_safe commands before creating approval requests', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'shell_safe',
      args: { command: 'whoami /groups' },
      origin: 'cli',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('failed');
    expect(run.approvalId).toBeUndefined();
    expect(run.message).toContain("Command is not allowlisted: 'whoami /groups'.");
    expect(executor.listApprovals(10, 'pending')).toHaveLength(0);
  });

  it('stores redacted argument previews and deterministic hashes for approvals', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_write',
      args: {
        path: 'note.txt',
        content: 'hello',
        access_token: 'super-secret-token',
      },
      origin: 'web',
    });
    expect(run.status).toBe('pending_approval');

    const jobs = executor.listJobs(1);
    expect(jobs[0].argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(jobs[0].argsPreview).toContain('[REDACTED]');
    expect(jobs[0].argsPreview).not.toContain('super-secret-token');

    const approvals = executor.listApprovals(1);
    expect(approvals[0].argsHash).toBe(jobs[0].argsHash);
    expect(String(approvals[0].args.access_token)).toBe('[REDACTED]');
  });

  it('lists pending approval IDs scoped to user/channel with optional unscoped fallback', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const scoped = await executor.runTool({
      toolName: 'fs_write',
      args: { path: 'scoped.txt', content: 'scoped' },
      origin: 'assistant',
      userId: 'alice',
      channel: 'web',
    });
    const otherScoped = await executor.runTool({
      toolName: 'fs_write',
      args: { path: 'other.txt', content: 'other' },
      origin: 'assistant',
      userId: 'bob',
      channel: 'web',
    });
    const unscoped = await executor.runTool({
      toolName: 'fs_write',
      args: { path: 'unscoped.txt', content: 'unscoped' },
      origin: 'web',
    });

    expect(scoped.approvalId).toBeDefined();
    expect(otherScoped.approvalId).toBeDefined();
    expect(unscoped.approvalId).toBeDefined();

    const aliceOnly = executor.listPendingApprovalIdsForUser('alice', 'web');
    expect(aliceOnly).toEqual([scoped.approvalId!]);

    const aliceWithUnscoped = executor.listPendingApprovalIdsForUser('alice', 'web', { includeUnscoped: true });
    expect(aliceWithUnscoped).toContain(scoped.approvalId!);
    expect(aliceWithUnscoped).toContain(unscoped.approvalId!);
    expect(aliceWithUnscoped).not.toContain(otherScoped.approvalId!);
  });

  it('executes read-only tools without approval', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_list',
      args: { path: '.' },
      origin: 'web',
    });

    expect(run.success).toBe(true);
    expect(run.status).toBe('succeeded');
    expect(run.output).toBeTruthy();
  });

  it('searches files recursively by name and content', async () => {
    const root = createExecutorRoot();
    mkdirSync(join(root, 'nested', 'docs'), { recursive: true });
    await writeFile(join(root, 'nested', 'docs', 'five-notes.txt'), 'Code GRC checklist', 'utf-8');
    await writeFile(join(root, 'nested', 'docs', 'random.txt'), 'nothing relevant', 'utf-8');

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const byName = await executor.runTool({
      toolName: 'fs_search',
      args: { path: '.', query: 'five', mode: 'name' },
      origin: 'web',
    });
    expect(byName.success).toBe(true);
    const byNameOutput = byName.output as { matches: Array<{ relativePath: string; matchType: string }> };
    expect(byNameOutput.matches.some((m) => m.relativePath.endsWith('five-notes.txt') && m.matchType === 'name')).toBe(true);

    const byContent = await executor.runTool({
      toolName: 'fs_search',
      args: { path: '.', query: 'Code GRC', mode: 'content' },
      origin: 'web',
    });
    expect(byContent.success).toBe(true);
    const byContentOutput = byContent.output as { matches: Array<{ relativePath: string; matchType: string; snippet?: string }> };
    const contentMatch = byContentOutput.matches.find((m) => m.relativePath.endsWith('five-notes.txt') && m.matchType === 'content');
    expect(contentMatch).toBeDefined();
    expect(contentMatch?.snippet).toContain('Code GRC');
  });

  it('accepts Windows-style separators in file paths', async () => {
    const root = createExecutorRoot();
    mkdirSync(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'note.txt'), 'hello backslash path', 'utf-8');

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_read',
      args: { path: 'docs\\note.txt' },
      origin: 'web',
    });

    expect(run.success).toBe(true);
    const output = run.output as { content: string };
    expect(output.content).toContain('backslash path');
  });

  it('accepts Windows drive-letter absolute paths in WSL-style runtimes', async () => {
    if (!process.cwd().startsWith('/mnt/')) return;

    const root = createWorkspaceExecutorRoot();
    mkdirSync(join(root, 'docs'), { recursive: true });
    const filePath = join(root, 'docs', 'win-abs.txt');
    await writeFile(filePath, 'absolute windows path', 'utf-8');

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_read',
      args: { path: toWindowsPath(filePath) },
      origin: 'web',
    });

    expect(run.success).toBe(true);
    const output = run.output as { content: string };
    expect(output.content).toContain('absolute windows path');
  });

  it('honors explicit deny policy overrides', async () => {
    const root = createExecutorRoot();
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'approve_by_policy',
      toolPolicies: { fs_read: 'deny' },
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
    });

    const run = await executor.runTool({
      toolName: 'fs_read',
      args: { path: 'missing.txt' },
      origin: 'web',
    });

    expect(run.success).toBe(false);
    expect(run.status).toBe('denied');
  });

  it('discovers contacts from browser page and stores them', async () => {
    const root = createExecutorRoot();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      '<html><body>Sales: alice@example.com and bob@example.com</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )) as typeof fetch;

    try {
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: ['echo'],
        allowedDomains: ['example.com'],
      });

      const run = await executor.runTool({
        toolName: 'contacts_discover_browser',
        args: { url: 'https://example.com/team' },
        origin: 'web',
      });
      expect(run.success).toBe(true);

      const listed = await executor.runTool({
        toolName: 'contacts_list',
        args: {},
        origin: 'web',
      });
      expect(listed.success).toBe(true);
      const output = listed.output as { count: number };
      expect(output.count).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs campaign send behind approval checkpoint', async () => {
    const root = createExecutorRoot();
    const csvPath = join(root, 'contacts.csv');
    await writeFile(csvPath, 'email,name,company,tags\njane@example.com,Jane,Acme,lead', 'utf-8');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ id: 'gmail-msg-1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    try {
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: ['echo'],
        allowedDomains: ['gmail.googleapis.com'],
      });

      const imported = await executor.runTool({
        toolName: 'contacts_import_csv',
        args: { path: 'contacts.csv' },
        origin: 'cli',
      });
      expect(imported.success).toBe(true);

      const listContacts = await executor.runTool({
        toolName: 'contacts_list',
        args: {},
        origin: 'cli',
      });
      const contactOutput = listContacts.output as { contacts: Array<{ id: string }> };
      const contactId = contactOutput.contacts[0]?.id;
      expect(contactId).toBeDefined();

      const created = await executor.runTool({
        toolName: 'campaign_create',
        args: {
          name: 'Launch',
          subjectTemplate: 'Hello {name}',
          bodyTemplate: 'Welcome {name} at {company}',
          contactIds: [contactId],
        },
        origin: 'cli',
      });
      expect(created.success).toBe(true);
      const campaign = created.output as { id: string };

      const run = await executor.runTool({
        toolName: 'campaign_run',
        args: {
          campaignId: campaign.id,
          accessToken: 'token',
        },
        origin: 'cli',
      });

      expect(run.success).toBe(false);
      expect(run.status).toBe('pending_approval');
      expect(run.approvalId).toBeDefined();

      const approved = await executor.decideApproval(run.approvalId!, 'approved', 'tester');
      expect(approved.success).toBe(true);
      expect(approved.result?.success).toBe(true);
      expect(approved.result?.status).toBe('succeeded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('shares memory recall across tier-routed local and external agents', async () => {
    const root = createExecutorRoot();
    const memoryStore = new AgentMemoryStore({
      enabled: true,
      basePath: join(root, 'memory'),
      maxContextChars: 4000,
      maxFileChars: 20000,
    });
    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      agentMemoryStore: memoryStore,
      resolveStateAgentId: (agentId) => agentId === 'local' || agentId === 'external'
        ? SHARED_TIER_AGENT_STATE_ID
        : agentId,
    });

    const saved = await executor.runTool({
      toolName: 'memory_save',
      args: { content: 'Remember the user prefers concise status updates.' },
      origin: 'web',
      agentId: 'local',
    });
    expect(saved.success).toBe(true);
    expect(memoryStore.load(SHARED_TIER_AGENT_STATE_ID)).toContain('concise status updates');

    const recalled = await executor.runTool({
      toolName: 'memory_recall',
      args: {},
      origin: 'web',
      agentId: 'external',
    });
    expect(recalled.success).toBe(true);
    const output = recalled.output as { content: string };
    expect(output.content).toContain('concise status updates');
  });

  it('searches shared conversation history across tier-routed local and external agents', async () => {
    const root = createExecutorRoot();
    const conversations = new ConversationService({
      enabled: false,
      sqlitePath: join(root, 'conversation.sqlite'),
      maxTurns: 10,
      maxMessageChars: 2000,
      maxContextChars: 10000,
      retentionDays: 30,
    });
    conversations.recordTurn(
      { agentId: SHARED_TIER_AGENT_STATE_ID, userId: 'u1', channel: 'web' },
      'Investigate the ARP conflict on 172.23.21.43',
      'I will inspect duplicate IP claims and DHCP overlap.',
    );

    const executor = new ToolExecutor({
      enabled: true,
      workspaceRoot: root,
      policyMode: 'autonomous',
      allowedPaths: [root],
      allowedCommands: ['echo'],
      allowedDomains: ['localhost'],
      conversationService: conversations,
      resolveStateAgentId: (agentId) => agentId === 'local' || agentId === 'external'
        ? SHARED_TIER_AGENT_STATE_ID
        : agentId,
    });

    const searched = await executor.runTool({
      toolName: 'memory_search',
      args: { query: 'ARP conflict' },
      origin: 'web',
      agentId: 'external',
      userId: 'u1',
      channel: 'web',
    });
    expect(searched.success).toBe(true);
    const output = searched.output as { resultCount: number; results: Array<{ content: string }> };
    expect(output.resultCount).toBeGreaterThan(0);
    expect(output.results.some((row) => row.content.includes('ARP conflict'))).toBe(true);
    conversations.close();
  });

  describe('web_search', () => {
    it('is registered as a builtin tool', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: ['echo'],
        allowedDomains: ['localhost'],
      });
      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).toContain('web_search');
    });

    it('returns error for empty query', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
      });
      const run = await executor.runTool({
        toolName: 'web_search',
        args: { query: '  ' },
        origin: 'web',
      });
      expect(run.success).toBe(false);
    });

    it('blocks search provider hosts not in allowedDomains', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
      });
      const run = await executor.runTool({
        toolName: 'web_search',
        args: { query: 'test provider allowlist', provider: 'duckduckgo' },
        origin: 'web',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('allowedDomains');
    });

    it('parses DuckDuckGo HTML results', async () => {
      const root = createExecutorRoot();
      const originalFetch = globalThis.fetch;
      const ddgHtml = `
        <html><body>
          <div class="result results_links results_links_deep web-result">
            <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">Example <strong>Page</strong></a>
            <a class="result__snippet">A great <em>snippet</em> about the topic.</a>
          </div>
          <div class="result results_links results_links_deep web-result">
            <a class="result__a" href="https://example.com/page2">Second Result</a>
            <a class="result__snippet">Another snippet here.</a>
          </div>
        </body></html>
      `;
      globalThis.fetch = (async () => new Response(ddgHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
      try {
        const executor = new ToolExecutor({
          enabled: true,
          workspaceRoot: root,
          policyMode: 'autonomous',
          allowedPaths: [root],
          allowedCommands: [],
          allowedDomains: ['html.duckduckgo.com'],
        });
        const run = await executor.runTool({
          toolName: 'web_search',
          args: { query: 'restaurants in Brisbane', maxResults: 5 },
          origin: 'web',
        });
        expect(run.success).toBe(true);
        const output = run.output as { provider: string; results: Array<{ title: string; url: string; snippet: string }>; cached: boolean; _untrusted: string };
        expect(output.provider).toBe('duckduckgo');
        expect(output.results.length).toBeGreaterThanOrEqual(1);
        expect(output.results[0].title).toBe('Example Page');
        expect(output.results[0].url).toBe('https://example.com/page1');
        expect(output.results[0].snippet).toBe('A great snippet about the topic.');
        expect(output.cached).toBe(false);
        expect(output._untrusted).toContain('untrusted');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns cached results on second identical call', async () => {
      const root = createExecutorRoot();
      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      const ddgHtml = `
        <html><body>
          <div class="result results_links">
            <a class="result__a" href="https://example.com/cached">Cached Result</a>
            <a class="result__snippet">Cached snippet.</a>
          </div>
        </body></html>
      `;
      globalThis.fetch = (async () => {
        fetchCount++;
        return new Response(ddgHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }) as typeof fetch;
      try {
        const executor = new ToolExecutor({
          enabled: true,
          workspaceRoot: root,
          policyMode: 'autonomous',
          allowedPaths: [root],
          allowedCommands: [],
          allowedDomains: ['html.duckduckgo.com'],
        });
        const run1 = await executor.runTool({
          toolName: 'web_search',
          args: { query: 'cache test', maxResults: 5 },
          origin: 'web',
        });
        expect(run1.success).toBe(true);
        const out1 = run1.output as { cached: boolean };
        expect(out1.cached).toBe(false);

        const run2 = await executor.runTool({
          toolName: 'web_search',
          args: { query: 'cache test', maxResults: 5 },
          origin: 'web',
        });
        expect(run2.success).toBe(true);
        const out2 = run2.output as { cached: boolean };
        expect(out2.cached).toBe(true);
        // fetch should only be called once (second call hits cache)
        expect(fetchCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('uses Brave provider when configured', async () => {
      const root = createExecutorRoot();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof _url === 'string' ? _url : _url.toString();
        const parsedUrl = new URL(urlStr);
        if (parsedUrl.hostname === 'api.search.brave.com') {
          expect(init?.headers).toBeDefined();
          const headers = init!.headers as Record<string, string>;
          expect(headers['X-Subscription-Token']).toBe('test-brave-key');
          return new Response(JSON.stringify({
            web: {
              results: [
                { title: 'Brave Result', url: 'https://brave.example.com', description: 'A brave snippet.' },
              ],
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch;
      try {
        const executor = new ToolExecutor({
          enabled: true,
          workspaceRoot: root,
          policyMode: 'autonomous',
          allowedPaths: [root],
          allowedCommands: [],
          allowedDomains: ['api.search.brave.com'],
          webSearch: { braveApiKey: 'test-brave-key' },
        });
        const run = await executor.runTool({
          toolName: 'web_search',
          args: { query: 'brave test', provider: 'brave' },
          origin: 'web',
        });
        expect(run.success).toBe(true);
        const output = run.output as { provider: string; results: Array<{ title: string }> };
        expect(output.provider).toBe('brave');
        expect(output.results[0].title).toBe('Brave Result');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('web_fetch', () => {
    it('is registered as a builtin tool', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
      });
      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).toContain('web_fetch');
    });

    it('blocks SSRF attempts to private IPs', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
      });
      for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.1.1', 'localhost']) {
        const run = await executor.runTool({
          toolName: 'web_fetch',
          args: { url: `http://${ip}:8080/secret` },
          origin: 'web',
        });
        expect(run.success).toBe(false);
        expect(String(run.error ?? run.message)).toContain('SSRF');
      }
    });

    it('rejects non-HTTP protocols', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
      });
      const run = await executor.runTool({
        toolName: 'web_fetch',
        args: { url: 'ftp://example.com/file' },
        origin: 'web',
      });
      expect(run.success).toBe(false);
      expect(String(run.error ?? run.message)).toContain('HTTP');
    });

    it('fetches and extracts HTML content with untrusted marker', async () => {
      const root = createExecutorRoot();
      const originalFetch = globalThis.fetch;
      const html = `
        <html>
          <head><title>Test Page</title></head>
          <body>
            <nav>Navigation stuff</nav>
            <main><p>This is the main content of the page.</p></main>
            <footer>Footer info</footer>
          </body>
        </html>
      `;
      globalThis.fetch = (async () => new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })) as typeof fetch;
      try {
        const executor = new ToolExecutor({
          enabled: true,
          workspaceRoot: root,
          policyMode: 'autonomous',
          allowedPaths: [root],
          allowedCommands: [],
          allowedDomains: [],
        });
        const run = await executor.runTool({
          toolName: 'web_fetch',
          args: { url: 'https://example.com/article' },
          origin: 'web',
        });
        expect(run.success).toBe(true);
        const output = run.output as { content: string; host: string };
        expect(output.content).toContain('[EXTERNAL CONTENT from example.com');
        expect(output.content).toContain('main content of the page');
        expect(output.content).toContain('Test Page');
        // nav/footer should be stripped from <main> extraction
        expect(output.host).toBe('example.com');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('truncates long content at maxChars', async () => {
      const root = createExecutorRoot();
      const originalFetch = globalThis.fetch;
      const longText = 'A'.repeat(5000);
      globalThis.fetch = (async () => new Response(longText, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })) as typeof fetch;
      try {
        const executor = new ToolExecutor({
          enabled: true,
          workspaceRoot: root,
          policyMode: 'autonomous',
          allowedPaths: [root],
          allowedCommands: [],
          allowedDomains: [],
        });
        const run = await executor.runTool({
          toolName: 'web_fetch',
          args: { url: 'https://example.com/long', maxChars: 500 },
          origin: 'web',
        });
        expect(run.success).toBe(true);
        const output = run.output as { content: string; truncated: boolean };
        expect(output.truncated).toBe(true);
        expect(output.content).toContain('[truncated]');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns pretty JSON for JSON responses', async () => {
      const root = createExecutorRoot();
      const originalFetch = globalThis.fetch;
      const jsonData = { restaurants: [{ name: 'Test Cafe', rating: 4.5 }] };
      globalThis.fetch = (async () => new Response(JSON.stringify(jsonData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      try {
        const executor = new ToolExecutor({
          enabled: true,
          workspaceRoot: root,
          policyMode: 'autonomous',
          allowedPaths: [root],
          allowedCommands: [],
          allowedDomains: [],
        });
        const run = await executor.runTool({
          toolName: 'web_fetch',
          args: { url: 'https://api.example.com/data' },
          origin: 'web',
        });
        expect(run.success).toBe(true);
        const output = run.output as { content: string };
        expect(output.content).toContain('"restaurants"');
        expect(output.content).toContain('Test Cafe');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Browser tools (MCP-based)', () => {
    it('does not register legacy browser tools (browser tools are now MCP-provided)', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'approve_by_policy',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
        browserConfig: { enabled: true },
      });
      const names = executor.listToolDefinitions().map((t) => t.name);
      // Legacy agent-browser tools should not exist — browser automation is now via MCP servers
      expect(names).not.toContain('browser_open');
      expect(names).not.toContain('browser_action');
      expect(names).not.toContain('browser_snapshot');
      expect(names).not.toContain('browser_close');
      expect(names).not.toContain('browser_task');
    });

    it('dispose does not throw without browser sessions', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: ['example.com'],
        browserConfig: { enabled: true },
      });
      // Should not throw — no browser session manager to clean up
      await executor.dispose();
    });
  });

  describe('tool categories', () => {
    it('disabledCategories filters tools from list', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        disabledCategories: ['network', 'system'],
      });
      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).not.toContain('net_ping');
      expect(names).not.toContain('sys_info');
      expect(names).toContain('fs_read');
      expect(names).toContain('shell_safe');
    });

    it('disabled category tool returns denied on runTool', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        disabledCategories: ['filesystem'],
      });
      const result = await executor.runTool({
        toolName: 'fs_read',
        args: { path: 'test.txt' },
        origin: 'cli',
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe('denied');
      expect(result.message).toContain('disabled category');
    });

    it('all builtin tools have category field set', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        browserConfig: { enabled: true },
      });
      const tools = executor.listToolDefinitions();
      for (const tool of tools) {
        expect(tool.category, `Tool '${tool.name}' should have a category`).toBeTruthy();
      }
    });

    it('getCategoryInfo returns all categories with correct counts', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
      });
      const info = executor.getCategoryInfo();
      expect(info.length).toBe(15);
      const names = info.map((c) => c.category);
      expect(names).toContain('filesystem');
      expect(names).toContain('shell');
      expect(names).toContain('web');
      expect(names).toContain('browser');
      expect(names).toContain('contacts');
      expect(names).toContain('email');
      expect(names).toContain('intel');
      expect(names).toContain('forum');
      expect(names).toContain('network');
      expect(names).toContain('cloud');
      expect(names).toContain('system');
      expect(names).toContain('memory');
      expect(names).toContain('search');
      expect(names).toContain('automation');
      expect(names).toContain('workspace');
      const fs = info.find((c) => c.category === 'filesystem')!;
      expect(fs.toolCount).toBe(6);
      expect(fs.enabled).toBe(true);
    });

    it('setCategoryEnabled toggles work', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
      });
      expect(executor.getDisabledCategories()).toEqual([]);
      executor.setCategoryEnabled('network', false);
      expect(executor.getDisabledCategories()).toContain('network');
      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).not.toContain('net_ping');

      executor.setCategoryEnabled('network', true);
      expect(executor.getDisabledCategories()).not.toContain('network');
      const namesAfter = executor.listToolDefinitions().map((t) => t.name);
      expect(namesAfter).toContain('net_ping');
    });

    it('strict sandbox mode blocks risky subprocess-backed tools without a strong backend', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: ['echo'],
        allowedDomains: ['localhost'],
        sandboxConfig: {
          ...DEFAULT_SANDBOX_CONFIG,
          enforcementMode: 'strict',
        },
        sandboxHealth: {
          enabled: true,
          platform: 'win32',
          availability: 'unavailable',
          backend: 'env',
          enforcementMode: 'strict',
          reasons: ['No native Windows sandbox helper is available.'],
        },
      });

      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).toContain('find_tools');
      expect(names).not.toContain('shell_safe');
      expect(names).not.toContain('net_ping');
      expect(names).not.toContain('doc_search');

      const shell = executor.getCategoryInfo().find((entry) => entry.category === 'shell');
      expect(shell?.enabled).toBe(false);
      expect(shell?.disabledReason).toContain('strict sandbox mode');
      expect(executor.getRuntimeNotices()[0]?.message).toContain('assistant.tools.sandbox.enforcementMode: permissive');

      const result = await executor.runTool({
        toolName: 'shell_safe',
        args: { command: 'echo hello' },
        origin: 'cli',
      });
      expect(result.success).toBe(false);
      expect(result.status).toBe('denied');
      expect(result.message).toContain('strict sandbox mode');
    });

    it('warns when permissive mode is explicitly enabled without strong sandboxing', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        sandboxConfig: {
          ...DEFAULT_SANDBOX_CONFIG,
          enforcementMode: 'permissive',
        },
        sandboxHealth: {
          enabled: true,
          platform: 'win32',
          availability: 'unavailable',
          backend: 'env',
          enforcementMode: 'permissive',
          reasons: ['No native Windows sandbox helper is available.'],
        },
      });

      const notice = executor.getRuntimeNotices()[0];
      expect(notice?.level).toBe('warn');
      expect(notice?.message).toContain('Permissive sandbox mode is explicitly enabled');
      expect(notice?.message).toContain('bubblewrap');
      expect(notice?.message).toContain('guardian-sandbox-win.exe');
    });
  });

  describe('document search tools', () => {
    it('doc_search tools appear in search category', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
      });
      const info = executor.getCategoryInfo();
      const search = info.find((c) => c.category === 'search');
      expect(search).toBeDefined();
      expect(search!.toolCount).toBe(3);
    });

    it('doc_search returns error when service not injected', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
      });
      const result = await executor.runTool({
        toolName: 'doc_search',
        args: { query: 'test' },
        origin: 'cli',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not configured');
    });
  });
});
