import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';

import { getGuardianBaseDir } from '../util/env.js';
import { createLogger } from '../util/logging.js';
import type {
  GitHubAuthStartResult,
  GitHubConfig,
  GitHubIssueCreateInput,
  GitHubIssueCreateResult,
  GitHubServiceLike,
  GitHubStatusResult,
} from './types.js';

const log = createLogger('github-auth');

const SECRETS_FILE = join(getGuardianBaseDir(), 'secrets.enc.json');
const SECRETS_KEY_LABEL = 'github-tokens';
const ALGORITHM = 'aes-256-gcm';
const AUTH_TIMEOUT_MS = 120_000;
const DEFAULT_SCOPES = ['repo', 'read:user'];
const GITHUB_API_VERSION = '2022-11-28';

interface GitHubTokens {
  access_token: string;
  token_type?: string;
  scope?: string;
  obtained_at: number;
}

interface PendingAuth {
  state: string;
  server: Server;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export class GitHubOAuthService implements GitHubServiceLike {
  private readonly config: GitHubConfig;
  private tokens?: GitHubTokens;
  private pending?: PendingAuth;

  constructor(config?: GitHubConfig) {
    this.config = {
      enabled: true,
      mode: 'oauth',
      oauthCallbackPort: 18434,
      scopes: DEFAULT_SCOPES,
      allowIssueCreation: true,
      ...(config ?? {}),
    };
  }

  async startAuth(): Promise<GitHubAuthStartResult> {
    if (this.pending) {
      this.cancelPendingAuth('Starting a new GitHub connection flow.');
    }
    const clientId = this.clientId;
    const clientSecret = this.clientSecret;
    if (!clientId || !clientSecret) {
      return {
        success: false,
        authUrl: '',
        state: '',
        message: 'Enter the GitHub OAuth Client ID and Client Secret before connecting.',
      };
    }

    const state = randomBytes(16).toString('hex');
    const redirectUri = this.redirectUri;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: this.scopes.join(' '),
      state,
      allow_signup: 'true',
    });

    await this.startCallbackServer(state);

    return {
      success: true,
      authUrl: `https://github.com/login/oauth/authorize?${params}`,
      state,
      message: 'Opening GitHub login in a new window. Complete the flow there.',
    };
  }

  hasPendingAuth(): boolean {
    return !!this.pending;
  }

  cancelPendingAuth(reason: string = 'GitHub connection flow was cancelled.'): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.stopCallbackServer();
    pending.reject(new Error(reason));
    log.info({ reason }, 'Cancelled pending GitHub auth flow');
  }

  async disconnect(): Promise<void> {
    this.tokens = undefined;
    await this.clearStoredTokens();
    this.cancelPendingAuth('GitHub connection flow was cancelled.');
  }

  async status(owner?: string, repo?: string): Promise<GitHubStatusResult> {
    const repository = this.tryResolveRepository(owner, repo);
    const base = {
      enabled: this.config.enabled !== false,
      mode: 'oauth' as const,
      cliPath: '',
      installed: true,
      authPending: this.hasPendingAuth(),
      clientId: this.clientId,
      repositoryConfigured: !!repository,
      ...(repository ? { defaultRepository: repository.fullName } : {}),
    };

    if (this.config.enabled === false) {
      return {
        ...base,
        authenticated: false,
        repositoryAccessible: false,
        message: 'GitHub integration is disabled.',
      };
    }
    if (!this.clientId || !this.clientSecret) {
      return {
        ...base,
        authenticated: false,
        repositoryAccessible: false,
        message: 'Enter GitHub OAuth app details, then connect GitHub. Repository selection is optional until you use repo actions.',
      };
    }

    const token = await this.getStoredAccessToken();
    if (!token) {
      return {
        ...base,
        authenticated: false,
        repositoryAccessible: false,
        message: 'Please connect your GitHub account.',
      };
    }

    const accountResult = await this.apiFetch('https://api.github.com/user', {
      method: 'GET',
    });
    if (!accountResult.ok) {
      return {
        ...base,
        authenticated: false,
        repositoryAccessible: false,
        message: 'GitHub token was not accepted. Disconnect and reconnect GitHub.',
      };
    }

    if (!repository) {
      return {
        ...base,
        authenticated: true,
        repositoryAccessible: false,
        message: 'GitHub is connected. Add an owner and repository only when you want issue reporting or repo workflow actions.',
      };
    }

    const repoResult = await this.apiFetch(`https://api.github.com/repos/${repository.fullName}`, {
      method: 'GET',
    });
    if (!repoResult.ok) {
      return {
        ...base,
        authenticated: true,
        repositoryAccessible: false,
        message: `GitHub is connected, but ${repository.fullName} is not accessible.`,
      };
    }
    const repoJson = await repoResult.json() as { html_url?: string };
    return {
      ...base,
      authenticated: true,
      repositoryAccessible: true,
      ...(repoJson.html_url ? { repositoryUrl: repoJson.html_url } : {}),
      message: `GitHub is connected and can access ${repository.fullName}.`,
    };
  }

  async createIssue(input: GitHubIssueCreateInput): Promise<GitHubIssueCreateResult> {
    if (this.config.enabled === false) {
      throw new Error('GitHub integration is disabled.');
    }
    if (this.config.allowIssueCreation === false) {
      throw new Error('GitHub issue creation is disabled.');
    }
    const repository = this.resolveRepository(input.owner, input.repo);
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new Error('title is required.');
    if (!body) throw new Error('body is required.');

    const labels = normalizeLabels(input.labels);
    const response = await this.apiFetch(`https://api.github.com/repos/${repository.fullName}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body, labels }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GitHub issue creation failed (${response.status}): ${detail}`);
    }
    const created = await response.json() as { html_url?: string; number?: number };
    if (!created.html_url) {
      throw new Error('GitHub did not return a created issue URL.');
    }
    return {
      owner: repository.owner,
      repo: repository.repo,
      url: created.html_url,
      ...(typeof created.number === 'number' ? { number: created.number } : {}),
      title,
      labels,
    };
  }

  private get clientId(): string {
    return this.config.clientId?.trim() ?? '';
  }

  private get clientSecret(): string {
    return this.config.clientSecret?.trim() ?? '';
  }

  private get callbackPort(): number {
    return this.config.oauthCallbackPort && this.config.oauthCallbackPort > 0
      ? this.config.oauthCallbackPort
      : 18434;
  }

  private get redirectUri(): string {
    return `http://127.0.0.1:${this.callbackPort}/callback`;
  }

  private get scopes(): string[] {
    return Array.isArray(this.config.scopes) && this.config.scopes.length > 0
      ? this.config.scopes
      : DEFAULT_SCOPES;
  }

  private resolveRepository(owner?: string, repo?: string): { owner: string; repo: string; fullName: string } {
    const resolvedOwner = validateRepositoryPart(owner || this.config.defaultOwner || '', 'owner');
    const resolvedRepo = validateRepositoryPart(repo || this.config.defaultRepo || '', 'repo');
    return {
      owner: resolvedOwner,
      repo: resolvedRepo,
      fullName: `${resolvedOwner}/${resolvedRepo}`,
    };
  }

  private tryResolveRepository(owner?: string, repo?: string): { owner: string; repo: string; fullName: string } | null {
    try {
      return this.resolveRepository(owner, repo);
    } catch {
      return null;
    }
  }

  private async getStoredAccessToken(): Promise<string | undefined> {
    if (!this.tokens) {
      await this.loadStoredTokens();
    }
    return this.tokens?.access_token;
  }

  private async apiFetch(url: string, init: RequestInit): Promise<Response> {
    const token = await this.getStoredAccessToken();
    if (!token) {
      throw new Error('Not authenticated. Please connect GitHub.');
    }
    return fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  }

  private async startCallbackServer(state: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.callbackPort}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end('Not found');
          return;
        }

        const receivedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            renderCallbackPage('Authorization failed', error),
          );
          this.pending?.reject(new Error(`GitHub OAuth error: ${error}`));
          this.stopCallbackServer();
          return;
        }

        if (receivedState !== state || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(
            renderCallbackPage('Invalid callback', 'State mismatch or missing code. Return to Guardian and start GitHub connection again.'),
          );
          return;
        }

        try {
          await this.exchangeCode(code);
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            renderCallbackPage('Connected', 'GitHub account linked successfully. You can close this window.'),
          );
          this.pending?.resolve(code);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            renderCallbackPage('Connection failed', `${msg} Please return to Guardian and try again.`),
          );
          this.pending?.reject(err instanceof Error ? err : new Error(msg));
        }

        this.stopCallbackServer();
      });

      server.listen(this.callbackPort, '127.0.0.1', () => {
        this.pending = {
          state,
          server,
          resolve: () => {},
          reject: () => {},
          timeoutHandle: setTimeout(() => {
            this.cancelPendingAuth('GitHub connection flow timed out.');
          }, AUTH_TIMEOUT_MS),
        };
        resolve();
      });

      server.on('error', (err) => {
        reject(new Error(`Failed to start GitHub callback server on port ${this.callbackPort}: ${err.message}`));
      });
    });
  }

  private stopCallbackServer(): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
    pending.server.close();
  }

  private async exchangeCode(code: string): Promise<void> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
    });

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${detail}`);
    }
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.error === 'string') {
      throw new Error(String(data.error_description ?? data.error));
    }
    if (typeof data.access_token !== 'string') {
      throw new Error('GitHub did not return an access token.');
    }
    this.tokens = {
      access_token: data.access_token,
      token_type: typeof data.token_type === 'string' ? data.token_type : 'bearer',
      scope: typeof data.scope === 'string' ? data.scope : this.scopes.join(','),
      obtained_at: Date.now(),
    };
    await this.storeTokens();
  }

  private async loadStoredTokens(): Promise<void> {
    try {
      const data = await readFile(SECRETS_FILE, 'utf-8');
      const secrets = JSON.parse(data) as Record<string, unknown>;
      const encrypted = secrets[SECRETS_KEY_LABEL] as string | undefined;
      if (!encrypted) return;
      this.tokens = JSON.parse(decrypt(encrypted)) as GitHubTokens;
    } catch {
      // No stored tokens.
    }
  }

  private async storeTokens(): Promise<void> {
    if (!this.tokens) return;
    await mkdir(dirname(SECRETS_FILE), { recursive: true });
    let secrets: Record<string, unknown> = {};
    try {
      secrets = JSON.parse(await readFile(SECRETS_FILE, 'utf-8')) as Record<string, unknown>;
    } catch {
      // File does not exist yet.
    }
    secrets[SECRETS_KEY_LABEL] = encrypt(JSON.stringify(this.tokens));
    await writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }

  private async clearStoredTokens(): Promise<void> {
    try {
      const secrets = JSON.parse(await readFile(SECRETS_FILE, 'utf-8')) as Record<string, unknown>;
      delete secrets[SECRETS_KEY_LABEL];
      await writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    } catch {
      // File may not exist.
    }
  }
}

function validateRepositoryPart(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error(`${field} may only contain letters, numbers, dot, underscore, or dash.`);
  }
  return trimmed;
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => label.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((label, index, all) => all.indexOf(label) === index)
    .slice(0, 10);
}

function deriveKey(): Buffer {
  const material = `guardianagent:${hostname()}:${userInfo().username}:github-tokens`;
  return createHash('sha256').update(material).digest();
}

function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(ciphertext: string): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted token format');
  const decipher = createDecipheriv(ALGORITHM, deriveKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return decipher.update(Buffer.from(dataB64, 'base64')) + decipher.final('utf-8');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCallbackPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GitHub ${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #f8fafc; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 2rem; box-sizing: border-box; }
    section { max-width: 34rem; border: 1px solid #334155; background: #111827; padding: 1.5rem; }
    h1 { margin: 0 0 0.75rem; font-size: 1.35rem; }
    p { margin: 0; color: #cbd5e1; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </section>
  </main>
  <script>
    try { window.opener && window.opener.postMessage({ type: 'guardian:github-auth-complete' }, '*'); } catch (_) {}
  </script>
</body>
</html>`;
}
