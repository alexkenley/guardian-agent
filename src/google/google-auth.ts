/**
 * Google OAuth2 with PKCE for native Google Workspace integration.
 *
 * Handles the full OAuth lifecycle: authorization URL generation, localhost
 * callback, token exchange, encrypted storage, and transparent refresh.
 *
 * Spec: docs/specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md
 */

import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { createLogger } from '../util/logging.js';
import type { GoogleTokens } from './types.js';

const log = createLogger('google-auth');

const SECRETS_FILE = join(homedir(), '.guardianagent', 'secrets.enc.json');
const SECRETS_KEY_LABEL = 'google-tokens';
const ALGORITHM = 'aes-256-gcm';
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes for user to complete consent

export interface GoogleAuthConfig {
  /** Path to the client_secret.json downloaded from Google Cloud Console. */
  credentialsPath: string;
  /** Port for the localhost OAuth callback server. */
  callbackPort: number;
  /** Scopes to request. */
  scopes: string[];
}

interface ClientCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

interface PendingAuth {
  codeVerifier: string;
  state: string;
  server: Server;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
}

export class GoogleAuth {
  private readonly credentialsPath: string;
  private readonly callbackPort: number;
  private readonly scopes: string[];
  private tokens?: GoogleTokens;
  private clientCredentials?: ClientCredentials;
  private pending?: PendingAuth;

  constructor(config: GoogleAuthConfig) {
    this.credentialsPath = config.credentialsPath;
    this.callbackPort = config.callbackPort;
    this.scopes = config.scopes;
  }

  /**
   * Start the OAuth flow.
   * Returns the authorization URL that should be opened in the user's browser.
   */
  async startAuth(): Promise<{ authUrl: string; state: string }> {
    const creds = await this.loadClientCredentials();
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(16).toString('hex');
    const redirectUri = `http://127.0.0.1:${this.callbackPort}/callback`;

    const params = new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    // Start ephemeral localhost server to receive callback.
    await this.startCallbackServer(state, codeVerifier);

    log.info('OAuth flow started, waiting for user consent');
    return { authUrl, state };
  }

  /**
   * Wait for the OAuth callback and exchange the code for tokens.
   * Call this after `startAuth()` — it resolves when the user completes consent.
   */
  async waitForCallback(): Promise<void> {
    if (!this.pending) {
      throw new Error('No pending OAuth flow. Call startAuth() first.');
    }

    const code = await Promise.race([
      new Promise<string>((resolve, reject) => {
        this.pending!.resolve = resolve;
        this.pending!.reject = reject;
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('OAuth flow timed out.')), AUTH_TIMEOUT_MS),
      ),
    ]);

    await this.exchangeCode(code, this.pending.codeVerifier);
    this.stopCallbackServer();
  }

  /**
   * Handle an OAuth callback directly (for use by web API routes).
   */
  async handleCallback(code: string, state: string): Promise<void> {
    if (!this.pending || this.pending.state !== state) {
      throw new Error('Invalid OAuth state parameter.');
    }

    this.pending.resolve(code);
  }

  /** Get a valid access token, refreshing if needed. */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      await this.loadStoredTokens();
    }
    if (!this.tokens) {
      throw new Error('Not authenticated. Please connect your Google account.');
    }

    // Refresh if within 5 minutes of expiry.
    if (this.tokens.expiry_date - Date.now() < 5 * 60 * 1000) {
      await this.refreshAccessToken();
    }

    return this.tokens.access_token;
  }

  /** Revoke tokens and clear stored credentials. */
  async disconnect(): Promise<void> {
    if (this.tokens?.access_token) {
      try {
        const revokeUrl = `https://oauth2.googleapis.com/revoke?token=${this.tokens.access_token}`;
        await fetch(revokeUrl, { method: 'POST' });
        log.info('Google OAuth tokens revoked');
      } catch (err) {
        log.warn({ err }, 'Failed to revoke Google token (may have already expired)');
      }
    }

    this.tokens = undefined;
    await this.clearStoredTokens();
    this.stopCallbackServer();
  }

  /** Check if authenticated with valid (or refreshable) tokens. */
  isAuthenticated(): boolean {
    return !!this.tokens?.refresh_token;
  }

  /** Get token expiry timestamp (ms since epoch), or undefined. */
  getTokenExpiry(): number | undefined {
    return this.tokens?.expiry_date;
  }

  /** Load tokens from encrypted storage (called lazily). */
  async loadStoredTokens(): Promise<void> {
    try {
      const data = await readFile(SECRETS_FILE, 'utf-8');
      const secrets = JSON.parse(data) as Record<string, unknown>;
      const encrypted = secrets[SECRETS_KEY_LABEL] as string | undefined;
      if (!encrypted) return;

      const decrypted = decrypt(encrypted);
      this.tokens = JSON.parse(decrypted) as GoogleTokens;
      log.debug('Loaded stored Google tokens');
    } catch {
      // No stored tokens — that's fine.
    }
  }

  // ─── Private ────────────────────────────────────────────

  private async loadClientCredentials(): Promise<ClientCredentials> {
    if (this.clientCredentials) return this.clientCredentials;

    try {
      const raw = await readFile(this.credentialsPath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;

      // client_secret.json has one of: installed, web
      const installed = json.installed as ClientCredentials | undefined;
      const web = json.web as ClientCredentials | undefined;
      const creds = installed ?? web;

      if (!creds?.client_id || !creds?.client_secret) {
        throw new Error('Invalid client_secret.json: missing client_id or client_secret.');
      }

      this.clientCredentials = creds;
      return creds;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Google credentials not found at ${this.credentialsPath}. ` +
          'Upload client_secret.json via the web UI or place it at the configured path.',
        );
      }
      throw err;
    }
  }

  private async startCallbackServer(state: string, codeVerifier: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.callbackPort}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404).end('Not found');
          return;
        }

        const receivedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            '<h2>Authorization failed</h2><p>You can close this window.</p>',
          );
          this.pending?.reject(new Error(`Google OAuth error: ${error}`));
          return;
        }

        if (receivedState !== state || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(
            '<h2>Invalid callback</h2><p>State mismatch or missing code.</p>',
          );
          return;
        }

        // Exchange the authorization code for tokens immediately.
        try {
          await this.exchangeCode(code, codeVerifier);
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            '<h2>Connected!</h2><p>Google account linked successfully. You can close this window.</p>',
          );
          log.info('OAuth callback received and tokens exchanged successfully');
          this.pending?.resolve(code);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err: msg }, 'Token exchange failed in OAuth callback');
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            `<h2>Connection failed</h2><p>${msg}</p><p>Please try again.</p>`,
          );
          this.pending?.reject(err instanceof Error ? err : new Error(msg));
        }

        // Close the callback server after handling.
        this.stopCallbackServer();
      });

      server.listen(this.callbackPort, '127.0.0.1', () => {
        this.pending = {
          codeVerifier,
          state,
          server,
          resolve: () => {},
          reject: () => {},
        };
        resolve();
      });

      server.on('error', (err) => {
        reject(new Error(`Failed to start OAuth callback server on port ${this.callbackPort}: ${err.message}`));
      });
    });
  }

  private stopCallbackServer(): void {
    if (this.pending?.server) {
      this.pending.server.close();
      this.pending = undefined;
    }
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<void> {
    const creds = await this.loadClientCredentials();
    const redirectUri = `http://127.0.0.1:${this.callbackPort}/callback`;

    const body = new URLSearchParams({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${errBody}`);
    }

    const data = await response.json() as Record<string, unknown>;
    this.tokens = {
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      token_type: (data.token_type as string) || 'Bearer',
      expiry_date: Date.now() + ((data.expires_in as number) || 3600) * 1000,
      scope: (data.scope as string) || this.scopes.join(' '),
    };

    await this.storeTokens();
    log.info('Google OAuth tokens obtained and stored');
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available. Please re-authenticate.');
    }

    const creds = await this.loadClientCredentials();
    const body = new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: this.tokens.refresh_token,
      grant_type: 'refresh_token',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errBody = await response.text();
      log.error({ status: response.status, body: errBody }, 'Token refresh failed');
      throw new Error(`Token refresh failed (${response.status}). Please re-authenticate.`);
    }

    const data = await response.json() as Record<string, unknown>;
    this.tokens = {
      ...this.tokens,
      access_token: data.access_token as string,
      expiry_date: Date.now() + ((data.expires_in as number) || 3600) * 1000,
    };

    await this.storeTokens();
    log.debug('Google access token refreshed');
  }

  private async storeTokens(): Promise<void> {
    if (!this.tokens) return;

    try {
      await mkdir(dirname(SECRETS_FILE), { recursive: true });

      let secrets: Record<string, unknown> = {};
      try {
        const existing = await readFile(SECRETS_FILE, 'utf-8');
        secrets = JSON.parse(existing) as Record<string, unknown>;
      } catch {
        // File doesn't exist yet.
      }

      secrets[SECRETS_KEY_LABEL] = encrypt(JSON.stringify(this.tokens));
      await writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    } catch (err) {
      log.error({ err }, 'Failed to store Google tokens');
    }
  }

  private async clearStoredTokens(): Promise<void> {
    try {
      const data = await readFile(SECRETS_FILE, 'utf-8');
      const secrets = JSON.parse(data) as Record<string, unknown>;
      delete secrets[SECRETS_KEY_LABEL];
      await writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    } catch {
      // File may not exist.
    }
  }
}

// ─── Encryption helpers ──────────────────────────────────
// Simple symmetric encryption using a machine-specific key.
// Not a substitute for OS keychain, but acceptable for a self-hosted tool.

function deriveKey(): Buffer {
  const material = `guardianagent:${hostname()}:${userInfo().username}:google-tokens`;
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
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivB64, tagB64, dataB64] = parts;
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return decipher.update(Buffer.from(dataB64, 'base64')) + decipher.final('utf-8');
}
