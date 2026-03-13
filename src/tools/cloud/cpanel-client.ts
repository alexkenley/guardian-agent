import http from 'node:http';
import https from 'node:https';
import { normalizeCpanelConnectionConfig } from './cpanel-profile.js';

export interface CpanelInstanceConfig {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  apiToken: string;
  type: 'cpanel' | 'whm';
  ssl?: boolean;
  allowSelfSigned?: boolean;
  defaultCpanelUser?: string;
}

export interface CpanelRequestInput {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface NormalizedApiResponse<T = unknown> {
  data: T;
  errors: string[];
  warnings: string[];
  messages: string[];
  metadata: Record<string, unknown>;
}

export class CpanelClient {
  readonly config: CpanelInstanceConfig;

  constructor(config: CpanelInstanceConfig) {
    this.config = normalizeCpanelConnectionConfig({
      ...config,
      ssl: config.ssl !== false,
    });
  }

  async request(input: CpanelRequestInput): Promise<unknown> {
    const ssl = this.config.ssl !== false;
    const port = this.config.port ?? defaultPortFor(this.config.type, ssl);
    const query = toSearchParams(input.query);
    const path = `${input.path}${query ? `?${query}` : ''}`;
    const transport = ssl ? https : http;
    const authScheme = this.config.type === 'whm' ? 'whm' : 'cpanel';
    const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `${authScheme} ${this.config.username}:${this.config.apiToken}`,
      'User-Agent': 'GuardianAgent-Cloud/1.0',
      ...input.headers,
    };
    if (bodyText) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyText).toString();
    }

    return await new Promise<unknown>((resolve, reject) => {
      const req = transport.request(
        {
          hostname: this.config.host,
          port,
          method: input.method,
          path,
          rejectUnauthorized: !this.config.allowSelfSigned,
          headers,
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            const statusCode = res.statusCode ?? 500;
            const body = raw.trim();
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`Request failed with ${statusCode}${body ? `: ${truncate(body, 300)}` : ''}`));
              return;
            }
            if (!body) {
              resolve({});
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
            }
          });
        },
      );

      req.setTimeout(input.timeoutMs ?? 15_000, () => {
        req.destroy(new Error('Request timed out'));
      });
      req.on('error', reject);
      if (bodyText) req.write(bodyText);
      req.end();
    });
  }

  async uapi(
    module: string,
    fn: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: { method?: 'GET' | 'POST' },
  ): Promise<NormalizedApiResponse> {
    if (this.config.type !== 'cpanel') {
      throw new Error(`Profile '${this.config.id}' is not a direct cPanel profile`);
    }
    const raw = await this.request({
      method: options?.method ?? 'GET',
      path: `/execute/${encodeURIComponent(module)}/${encodeURIComponent(fn)}`,
      query: params,
    });
    return unwrapUapiResponse(raw);
  }

  async whm(
    fn: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: { method?: 'GET' | 'POST' },
  ): Promise<NormalizedApiResponse> {
    if (this.config.type !== 'whm') {
      throw new Error(`Profile '${this.config.id}' is not a WHM profile`);
    }
    const raw = await this.request({
      method: options?.method ?? 'GET',
      path: `/json-api/${encodeURIComponent(fn)}`,
      query: {
        'api.version': 1,
        ...params,
      },
    });
    return unwrapWhmResponse(raw);
  }

  async whmCpanel(
    user: string,
    module: string,
    fn: string,
    params?: Record<string, string | number | boolean | undefined>,
    options?: { method?: 'GET' | 'POST' },
  ): Promise<NormalizedApiResponse> {
    const bridged = await this.whm('cpanel', {
      'cpanel_jsonapi_user': user,
      'cpanel_jsonapi_apiversion': 3,
      'cpanel_jsonapi_module': module,
      'cpanel_jsonapi_func': fn,
      ...params,
    }, options);
    return unwrapUapiResponse(bridged.data);
  }
}

export function unwrapUapiResponse(raw: unknown): NormalizedApiResponse {
  const root = asRecord(raw, 'Invalid UAPI response');
  const result = asRecord(root['result'], 'Invalid UAPI response: missing result');
  const status = Number(result['status'] ?? 0);
  const errors = toStringArray(result['errors']);
  const warnings = toStringArray(result['warnings']);
  const messages = toStringArray(result['messages']);
  const metadata = asLooseRecord(result['metadata']);

  if (status !== 1) {
    throw new Error(firstMessage(errors, messages, warnings) ?? 'UAPI request failed');
  }

  return {
    data: result['data'],
    errors,
    warnings,
    messages,
    metadata,
  };
}

export function unwrapWhmResponse(raw: unknown): NormalizedApiResponse {
  const root = asRecord(raw, 'Invalid WHM API response');
  const metadata = asRecord(root['metadata'], 'Invalid WHM API response: missing metadata');
  const status = Number(metadata['result'] ?? 0);
  const errors = toStringArray(metadata['reason']);
  const warnings = toStringArray(root['warnings']);
  const messages = toStringArray(root['messages']);

  if (status !== 1) {
    throw new Error(firstMessage(errors, messages, warnings) ?? 'WHM API request failed');
  }

  return {
    data: root['data'],
    errors,
    warnings,
    messages,
    metadata,
  };
}

function defaultPortFor(type: 'cpanel' | 'whm', ssl: boolean): number {
  if (type === 'whm') return ssl ? 2087 : 2086;
  return ssl ? 2083 : 2082;
}

function toSearchParams(query: Record<string, string | number | boolean | undefined> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function asLooseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function firstMessage(...groups: string[][]): string | undefined {
  for (const group of groups) {
    const found = group.find(Boolean);
    if (found) return found;
  }
  return undefined;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}
