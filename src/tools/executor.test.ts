import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolExecutor } from './executor.js';

const testDirs: string[] = [];

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
    expect(names).toContain('shell_safe');
    expect(names).toContain('chrome_job');
    expect(names).toContain('campaign_create');
    expect(names).toContain('campaign_run');
    expect(names).toContain('gmail_send');
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
            <a class="result__a" href="https://example.com/page1">Example Page</a>
            <a class="result__snippet">A great snippet about the topic.</a>
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
        if (urlStr.includes('api.search.brave.com')) {
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

  describe('Browser tools', () => {
    it('does not register browser tools when browserConfig.enabled is false', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'approve_by_policy',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: [],
        browserConfig: { enabled: false },
      });
      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).not.toContain('browser_open');
      expect(names).not.toContain('browser_action');
      expect(names).not.toContain('browser_snapshot');
      expect(names).not.toContain('browser_close');
      expect(names).not.toContain('browser_task');
    });

    it('registers browser tools when browserConfig.enabled is true', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'approve_by_policy',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: ['example.com'],
        browserConfig: { enabled: true },
      });
      const names = executor.listToolDefinitions().map((t) => t.name);
      expect(names).toContain('browser_open');
      expect(names).toContain('browser_action');
      expect(names).toContain('browser_snapshot');
      expect(names).toContain('browser_close');
      expect(names).toContain('browser_task');
    });

    it('browser_open blocks private URLs (SSRF protection)', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: ['localhost', '127.0.0.1'],
        browserConfig: { enabled: true, allowedDomains: ['localhost'] },
      });
      const run = await executor.runTool({
        toolName: 'browser_open',
        args: { url: 'http://127.0.0.1:8080/admin' },
        origin: 'cli',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('private/internal address');
    });

    it('browser_open blocks domains not in allowedDomains', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: ['example.com'],
        browserConfig: { enabled: true, allowedDomains: ['example.com'] },
      });
      const run = await executor.runTool({
        toolName: 'browser_open',
        args: { url: 'https://evil.com/phish' },
        origin: 'cli',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('not in browser allowedDomains');
    });

    it('browser_task blocks private URLs', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        allowedPaths: [root],
        allowedCommands: [],
        allowedDomains: ['example.com'],
        browserConfig: { enabled: true, allowedDomains: ['example.com'] },
      });
      const run = await executor.runTool({
        toolName: 'browser_task',
        args: { url: 'http://192.168.1.1/config' },
        origin: 'cli',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('private/internal address');
    });

    it('browser_action requires active session', async () => {
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
      const run = await executor.runTool({
        toolName: 'browser_action',
        args: { action: 'click', ref: '@e1' },
        origin: 'cli',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('No active browser session');
    });

    it('browser_action validates ref format to prevent injection', async () => {
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
      const run = await executor.runTool({
        toolName: 'browser_action',
        args: { action: 'click', ref: '@e1; rm -rf /' },
        origin: 'cli',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('Invalid element reference');
    });

    it('browser_action validates action enum', async () => {
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
      const run = await executor.runTool({
        toolName: 'browser_action',
        args: { action: 'execute', ref: '@e1' },
        origin: 'cli',
      });
      expect(run.success).toBe(false);
      expect(run.message).toContain('Invalid browser action');
    });

    it('dispose cleans up browser sessions', async () => {
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
      // Should not throw
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

    it('getCategoryInfo returns all 10 categories with correct counts', () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
      });
      const info = executor.getCategoryInfo();
      expect(info.length).toBe(12);
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
      expect(names).toContain('system');
      expect(names).toContain('memory');
      expect(names).toContain('search');
      const fs = info.find((c) => c.category === 'filesystem')!;
      expect(fs.toolCount).toBe(5);
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
  });

  describe('QMD search tools', () => {
    const mockQMDSearch = {
      search: async (opts: Record<string, unknown>) => ({
        results: [{ score: 0.9, filepath: '/notes/a.md', title: 'A', context: 'snippet', hash: 'h', docid: 'd', collectionName: 'notes' }],
        query: opts.query as string,
        mode: 'query' as const,
        totalResults: 1,
        durationMs: 42,
      }),
      status: async () => ({
        installed: true,
        version: '0.5.0',
        collections: [{ name: 'notes', documentCount: 10 }],
        configuredSources: [{ id: 'notes', name: 'Notes', type: 'directory', path: '/notes', enabled: true }],
      }),
      reindex: async (collection?: string) => ({
        success: true,
        message: collection ? `Reindexed '${collection}'.` : 'Reindexed all.',
      }),
    };

    it('qmd_search returns results when service is injected', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        qmdSearch: mockQMDSearch as never,
      });
      const result = await executor.runTool({
        toolName: 'qmd_search',
        args: { query: 'test query' },
        origin: 'cli',
      });
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      expect((result.output as Record<string, unknown>).totalResults).toBe(1);
    });

    it('qmd_search returns error when service not injected', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
      });
      const result = await executor.runTool({
        toolName: 'qmd_search',
        args: { query: 'test' },
        origin: 'cli',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('not enabled');
    });

    it('qmd_status returns status when service injected', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        qmdSearch: mockQMDSearch as never,
      });
      const result = await executor.runTool({
        toolName: 'qmd_status',
        args: {},
        origin: 'cli',
      });
      expect(result.success).toBe(true);
      expect((result.output as Record<string, unknown>).installed).toBe(true);
    });

    it('qmd_reindex works when service injected', async () => {
      const root = createExecutorRoot();
      const executor = new ToolExecutor({
        enabled: true,
        workspaceRoot: root,
        policyMode: 'autonomous',
        qmdSearch: mockQMDSearch as never,
      });
      const result = await executor.runTool({
        toolName: 'qmd_reindex',
        args: { collection: 'notes' },
        origin: 'cli',
      });
      expect(result.success).toBe(true);
    });

    it('qmd tools appear in search category', () => {
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
  });
});
