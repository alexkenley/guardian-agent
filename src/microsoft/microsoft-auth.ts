/**
 * Microsoft OAuth2 with PKCE for native Microsoft 365 integration.
 *
 * Handles the full OAuth lifecycle: authorization URL generation, localhost
 * callback, token exchange, encrypted storage, and transparent refresh.
 *
 * Mirrors the GoogleAuth pattern exactly — hand-rolled PKCE, no MSAL, no SDK.
 *
 * Spec: docs/specs/MICROSOFT-365-INTEGRATION-SPEC.md
 */

import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { createLogger } from '../util/logging.js';
import { MICROSOFT_LOGIN_BASE } from './types.js';
import type { MicrosoftTokens } from './types.js';

const log = createLogger('microsoft-auth');

const SECRETS_FILE = join(homedir(), '.guardianagent', 'secrets.enc.json');
const SECRETS_KEY_LABEL = 'microsoft-tokens';
const ALGORITHM = 'aes-256-gcm';
const AUTH_TIMEOUT_MS = 120_000; // 2 minutes for user to complete consent

export interface MicrosoftAuthConfig {
  /** Application (client) ID from Microsoft Entra app registration. */
  clientId: string;
  /** Tenant ID. Defaults to 'common' for multi-tenant + personal accounts. */
  tenantId?: string;
  /** Port for the localhost OAuth callback server. */
  callbackPort: number;
  /** Scopes to request (excluding offline_access, which is always appended). */
  scopes: string[];
}

interface PendingAuth {
  codeVerifier: string;
  state: string;
  server: Server;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
}

export class MicrosoftAuth {
  private readonly clientId: string;
  private readonly tenantId: string;
  private readonly callbackPort: number;
  private readonly scopes: string[];
  private tokens?: MicrosoftTokens;
  private pending?: PendingAuth;

  constructor(config: MicrosoftAuthConfig) {
    this.clientId = config.clientId;
    this.tenantId = config.tenantId || 'common';
    this.callbackPort = config.callbackPort;
    this.scopes = config.scopes;
  }

  /**
   * Start the OAuth flow.
   * Returns the authorization URL that should be opened in the user's browser.
   */
  async startAuth(): Promise<{ authUrl: string; state: string }> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(16).toString('hex');
    const redirectUri = `http://localhost:${this.callbackPort}/callback`;

    // Always include offline_access for refresh tokens, and User.Read for /me endpoint.
    const allScopes = new Set([...this.scopes, 'offline_access', 'User.Read']);

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: [...allScopes].join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    const authUrl = `${MICROSOFT_LOGIN_BASE}/${this.tenantId}/oauth2/v2.0/authorize?${params}`;

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
      throw new Error('Not authenticated. Please connect your Microsoft account.');
    }

    // Refresh if within 5 minutes of expiry.
    if (this.tokens.expiry_date - Date.now() < 5 * 60 * 1000) {
      await this.refreshAccessToken();
    }

    return this.tokens.access_token;
  }

  /** Disconnect: clear locally stored encrypted tokens. */
  async disconnect(): Promise<void> {
    // Microsoft doesn't have a direct token revoke endpoint like Google's /revoke.
    // Clear local storage. The user can optionally sign out via the logout URL.
    this.tokens = undefined;
    await this.clearStoredTokens();
    this.stopCallbackServer();
    log.info('Microsoft tokens cleared');
  }

  /** Check if authenticated with valid (or refreshable) tokens. */
  isAuthenticated(): boolean {
    return !!this.tokens?.refresh_token;
  }

  /** Get token expiry timestamp (ms since epoch), or undefined. */
  getTokenExpiry(): number | undefined {
    return this.tokens?.expiry_date;
  }

  /** Callback invoked when token refresh fails so the host can alert the user. */
  onAuthFailure?: (service: string, error: string) => void;

  /** Load tokens from encrypted storage (called lazily). */
  async loadStoredTokens(): Promise<void> {
    try {
      const data = await readFile(SECRETS_FILE, 'utf-8');
      const secrets = JSON.parse(data) as Record<string, unknown>;
      const encrypted = secrets[SECRETS_KEY_LABEL] as string | undefined;
      if (!encrypted) return;

      const decrypted = decrypt(encrypted);
      this.tokens = JSON.parse(decrypted) as MicrosoftTokens;
      log.debug('Loaded stored Microsoft tokens');

      // Proactively refresh if token is expired or about to expire
      if (this.tokens.expiry_date - Date.now() < 5 * 60 * 1000) {
        try {
          await this.refreshAccessToken();
          log.info('Proactively refreshed expired Microsoft access token at startup');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err: msg }, 'Failed to refresh Microsoft token at startup — user will need to re-authenticate');
          this.onAuthFailure?.('microsoft', msg);
        }
      }
    } catch {
      // No stored tokens — that's fine.
    }
  }

  // ─── Private ────────────────────────────────────────────

  private async startCallbackServer(state: string, codeVerifier: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${this.callbackPort}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404).end('Not found');
          return;
        }

        const receivedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(
            `<h2>Authorization failed</h2><p>${errorDesc || error}</p><p>You can close this window.</p>`,
          );
          this.pending?.reject(new Error(`Microsoft OAuth error: ${errorDesc || error}`));
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
            '<h2>Connected!</h2><p>Microsoft account linked successfully. You can close this window.</p>',
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
    const redirectUri = `http://localhost:${this.callbackPort}/callback`;

    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      scope: [...new Set([...this.scopes, 'offline_access', 'User.Read'])].join(' '),
    });

    const tokenUrl = `${MICROSOFT_LOGIN_BASE}/${this.tenantId}/oauth2/v2.0/token`;
    const response = await fetch(tokenUrl, {
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
    log.info('Microsoft OAuth tokens obtained and stored');
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available. Please re-authenticate.');
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      scope: [...new Set([...this.scopes, 'offline_access', 'User.Read'])].join(' '),
    });

    const tokenUrl = `${MICROSOFT_LOGIN_BASE}/${this.tenantId}/oauth2/v2.0/token`;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errBody = await response.text();
      log.error({ status: response.status, body: errBody }, 'Token refresh failed');
      const error = `Token refresh failed (${response.status}). Please re-authenticate.`;
      this.onAuthFailure?.('microsoft', error);
      throw new Error(error);
    }

    const data = await response.json() as Record<string, unknown>;
    this.tokens = {
      ...this.tokens,
      access_token: data.access_token as string,
      expiry_date: Date.now() + ((data.expires_in as number) || 3600) * 1000,
      // Microsoft may return a new refresh_token on refresh.
      refresh_token: (data.refresh_token as string) || this.tokens.refresh_token,
    };

    await this.storeTokens();
    log.debug('Microsoft access token refreshed');
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
      log.error({ err }, 'Failed to store Microsoft tokens');
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
// Same symmetric encryption as GoogleAuth but with a different key label.

function deriveKey(): Buffer {
  const material = `guardianagent:${hostname()}:${userInfo().username}:microsoft-tokens`;
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
