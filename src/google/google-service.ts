/**
 * Native Google Workspace API service.
 *
 * Calls Google APIs via HTTPS with OAuth 2.0 PKCE.
 *
 * Spec: docs/specs/NATIVE-GOOGLE-AND-INSTRUCTION-STEPS-SPEC.md
 */

import { createLogger } from '../util/logging.js';
import type { GoogleAuth } from './google-auth.js';
import type { GoogleExecuteParams, GoogleResult } from './types.js';

const log = createLogger('google-service');

const DEFAULT_TIMEOUT = 30_000;
const MAX_PAGES = 20;

/** Maps service names to their Google API base URLs and versions. */
const SERVICE_ENDPOINTS: Record<string, { base: string; version: string }> = {
  gmail: { base: 'https://gmail.googleapis.com/gmail', version: 'v1' },
  calendar: { base: 'https://www.googleapis.com/calendar', version: 'v3' },
  drive: { base: 'https://www.googleapis.com/drive', version: 'v3' },
  docs: { base: 'https://docs.googleapis.com', version: 'v1' },
  sheets: { base: 'https://sheets.googleapis.com', version: 'v4' },
  contacts: { base: 'https://people.googleapis.com', version: 'v1' },
};

/**
 * Maps resource segment names to the path parameter that belongs between
 * the segment and its child. For example, "users" expects "userId" to follow:
 *   resource "users messages" + params {userId:"me"} → /users/me/messages
 */
const RESOURCE_PATH_PARAM_MAP: Record<string, string> = {
  users: 'userId',
  calendars: 'calendarId',
  events: 'eventId',
  files: 'fileId',
  documents: 'documentId',
  spreadsheets: 'spreadsheetId',
  messages: 'messageId',
  threads: 'threadId',
  labels: 'labelId',
  drafts: 'draftId',
  people: 'resourceName',
  connections: 'resourceName',
};

/**
 * Some Google APIs nest resources under a parent that the LLM omits.
 * For example, Calendar "events" actually lives at /calendars/{calendarId}/events.
 * This map injects the parent when a path param is present but its segment is missing.
 */
const IMPLICIT_PARENT_MAP: Record<string, { parentSegment: string; paramKey: string }> = {
  // Calendar: resource="events" + calendarId → /calendars/{calendarId}/events
  events: { parentSegment: 'calendars', paramKey: 'calendarId' },
  // Calendar: resource="calendarList" needs no parent (it's a top-level resource)
};

export interface GoogleServiceConfig {
  /** Enabled services. */
  services?: string[];
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/** Standard Google API methods that map directly to the resource URL without a suffix. */
const STANDARD_METHODS = new Set(['list', 'get', 'create', 'insert', 'update', 'patch', 'delete']);

export class GoogleService {
  private readonly auth: GoogleAuth;
  private readonly services: Set<string>;
  private readonly timeoutMs: number;

  constructor(auth: GoogleAuth, config?: GoogleServiceConfig) {
    this.auth = auth;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT;
    this.services = new Set(
      config?.services?.length
        ? config.services.map((s) => s.trim().toLowerCase())
        : ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'],
    );
  }

  /** Check if a service is enabled. */
  isServiceEnabled(service: string): boolean {
    return this.services.has(service.toLowerCase());
  }

  /** Get list of enabled services. */
  getEnabledServices(): string[] {
    return [...this.services];
  }

  /** Check if the user is authenticated. */
  isAuthenticated(): boolean {
    return this.auth.isAuthenticated();
  }

  /** Get an active access token (refreshes if needed). */
  async getAccessToken(): Promise<string> {
    return this.auth.getAccessToken();
  }

  /**
   * High-level helper to send a Gmail message.
   * Handles RFC822 formatting and base64url encoding.
   */
  async sendGmailMessage(message: { to: string; subject: string; body: string }): Promise<GoogleResult> {
    try {
      const accessToken = await this.getAccessToken();
      const rawMessage = [
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        message.body,
        '',
      ].join('\r\n');

      const encoded = Buffer.from(rawMessage, 'utf-8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');

      const url = `${SERVICE_ENDPOINTS.gmail.base}/${SERVICE_ENDPOINTS.gmail.version}/users/me/messages/send`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
      });

      const data = await response.json() as any;
      if (!response.ok) {
        return { success: false, error: data.error?.message || response.statusText };
      }

      return {
        success: true,
        data: {
          messageId: data.id,
          threadId: data.threadId,
          status: 'sent',
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Execute a Google Workspace API call.
   * Parameter shape mirrors GWSExecuteParams for transparent routing.
   */
  async execute(params: GoogleExecuteParams): Promise<GoogleResult> {
    const { service, resource, method } = params;
    const svc = service.toLowerCase();

    if (!this.isServiceEnabled(svc)) {
      return {
        success: false,
        error: `Service '${svc}' is not enabled. Enabled services: ${this.getEnabledServices().join(', ')}`,
      };
    }

    const endpoint = SERVICE_ENDPOINTS[svc];
    if (!endpoint) {
      return { success: false, error: `Unsupported service: '${svc}'` };
    }

    // Apply defaults for common path parameters if missing
    const finalParams = { ...(params.params || {}) };
    if (svc === 'gmail' && finalParams.userId === undefined) finalParams.userId = 'me';
    if (svc === 'calendar' && finalParams.calendarId === undefined) finalParams.calendarId = 'primary';

    try {
      const accessToken = await this.auth.getAccessToken();
      const url = this.buildUrl(endpoint, svc, resource, params.subResource, method, finalParams);
      const httpMethod = this.inferHttpMethod(method, params.json);

      log.debug({ service: svc, resource, method, httpMethod, url: url.toString() }, 'Google API call');

      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      };

      let body: string | undefined;
      if (params.json && Object.keys(params.json).length > 0) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(params.json);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        let result = await this.doFetch(url.toString(), httpMethod, headers, body, controller.signal);

        // Auto-paginate if requested.
        if (params.pageAll && result.success && result.data) {
          result = await this.paginate(result, url, httpMethod, headers, params.pageLimit);
        }

        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ service: svc, resource, method, err: message }, 'Google API call failed');
      return { success: false, error: message };
    }
  }

  /**
   * Look up API schema for a service method.
   * Uses the Google Discovery API to retrieve method documentation.
   */
  async schema(schemaPath: string): Promise<GoogleResult> {
    try {
      const parts = schemaPath.split('.').filter(Boolean);
      const svc = parts[0]?.toLowerCase();
      if (!svc) return { success: false, error: 'schemaPath must start with a service name (e.g. gmail.users.messages.list)' };

      const endpoint = SERVICE_ENDPOINTS[svc];
      if (!endpoint) return { success: false, error: `Unknown service: ${svc}` };

      // Use the Google Discovery API to get the REST description.
      const discoveryUrl = `https://discovery.googleapis.com/discovery/v1/apis/${svc}/${endpoint.version}/rest`;
      const resp = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return { success: false, error: `Discovery API returned ${resp.status}` };

      const doc = await resp.json() as Record<string, unknown>;
      return { success: true, data: doc };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Private ────────────────────────────────────────────

  private buildUrl(
    endpoint: { base: string; version: string },
    _service: string,
    resource: string,
    subResource: string | undefined,
    method: string,
    params: Record<string, unknown> | undefined,
  ): URL {
    // Normalize resource segments: "users messages" or "users.messages" → ["users", "messages"]
    const segments = resource.trim().replace(/\./g, ' ').split(/\s+/).filter(Boolean);
    if (subResource) {
      segments.push(...subResource.trim().replace(/\./g, ' ').split(/\s+/).filter(Boolean));
    }

    // Inject implicit parent segments when needed.
    // E.g. resource=["events"] + params={calendarId:"primary"} → ["calendars","events"]
    // so the URL becomes /calendars/primary/events.
    const firstSegment = segments[0];
    const implicit = firstSegment ? IMPLICIT_PARENT_MAP[firstSegment] : undefined;
    if (implicit && params?.[implicit.paramKey] != null && !segments.includes(implicit.parentSegment)) {
      segments.unshift(implicit.parentSegment);
    }

    // Build path by interpolating path params between resource segments.
    // Example: segments=["users","messages"], params={userId:"me",maxResults:10}
    //   → /v1/users/me/messages?maxResults=10
    const consumedParams = new Set<string>();
    const pathParts = [endpoint.version];

    for (const segment of segments) {
      pathParts.push(segment);
      // Check if this segment expects a path param after it.
      const paramKey = RESOURCE_PATH_PARAM_MAP[segment];
      if (paramKey && params?.[paramKey] != null) {
        pathParts.push(encodeURIComponent(String(params[paramKey])));
        consumedParams.add(paramKey);
      }
    }

    // If the method is not a standard REST method, append it to the path.
    // Example: gmail.users.messages.send → /v1/users/me/messages/send
    // Example: drive.files.copy → /v1/files/{fileId}/copy
    const normalizedMethod = method.toLowerCase();
    if (!STANDARD_METHODS.has(normalizedMethod)) {
      // For some methods like 'send', they belong to the resource level even if an ID is present.
      // But for others like 'copy', they belong to the instance.
      // Google API convention: if it's a resource-level action (like send), it's usually /resource/action.
      // If it's an instance-level action (like copy), it's /resource/id/action.
      // Our loop above already added the ID if it was in RESOURCE_PATH_PARAM_MAP.
      pathParts.push(normalizedMethod);
    }

    const path = '/' + pathParts.join('/');

    // Remaining params become query string.
    const urlParams = new URLSearchParams();
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (consumedParams.has(key)) continue;
        urlParams.set(key, String(value));
      }
    }

    const url = new URL(`${endpoint.base}${path}`);
    urlParams.forEach((value, key) => url.searchParams.set(key, value));
    return url;
  }

  private inferHttpMethod(method: string, json?: Record<string, unknown>): string {
    const lower = method.toLowerCase();
    if (['get', 'list'].includes(lower)) return 'GET';
    if (['delete', 'trash', 'remove'].includes(lower)) return 'DELETE';
    if (['update', 'patch', 'modify'].includes(lower)) return 'PATCH';
    if (['create', 'insert', 'send', 'import', 'copy', 'move', 'watch', 'stop'].includes(lower)) return 'POST';
    // If there's a body, default to POST; otherwise GET.
    return json && Object.keys(json).length > 0 ? 'POST' : 'GET';
  }

  private async doFetch(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<GoogleResult> {
    const resp = await fetch(url, { method, headers, body, signal });
    const text = await resp.text();

    if (!resp.ok) {
      let errorMessage = `HTTP ${resp.status}`;
      try {
        const errJson = JSON.parse(text) as { error?: { message?: string; code?: number } };
        if (errJson.error?.message) errorMessage = errJson.error.message;
      } catch {
        if (text) errorMessage = text;
      }
      return { success: false, error: errorMessage };
    }

    if (!text.trim()) return { success: true, data: null };

    try {
      return { success: true, data: JSON.parse(text) };
    } catch {
      return { success: true, data: text };
    }
  }

  private async paginate(
    firstResult: GoogleResult,
    baseUrl: URL,
    method: string,
    headers: Record<string, string>,
    pageLimit?: number,
  ): Promise<GoogleResult> {
    const maxPages = Math.min(pageLimit ?? MAX_PAGES, MAX_PAGES);
    const allItems: unknown[] = [];

    const extractItems = (data: unknown): unknown[] => {
      if (!data || typeof data !== 'object') return [];
      const obj = data as Record<string, unknown>;
      // Google APIs use various field names for result arrays.
      for (const key of ['messages', 'files', 'events', 'items', 'documents', 'spreadsheets', 'connections', 'results']) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[];
      }
      return [];
    };

    allItems.push(...extractItems(firstResult.data));
    let nextPageToken = (firstResult.data as Record<string, unknown>)?.nextPageToken as string | undefined;
    let pages = 1;

    while (nextPageToken && pages < maxPages) {
      const url = new URL(baseUrl.toString());
      url.searchParams.set('pageToken', nextPageToken);

      const result = await this.doFetch(url.toString(), method, headers, undefined, AbortSignal.timeout(this.timeoutMs));
      if (!result.success) break;

      allItems.push(...extractItems(result.data));
      nextPageToken = (result.data as Record<string, unknown>)?.nextPageToken as string | undefined;
      pages += 1;
    }

    return {
      success: true,
      data: {
        items: allItems,
        totalItems: allItems.length,
        pages,
        truncated: !!nextPageToken,
      },
    };
  }
}
