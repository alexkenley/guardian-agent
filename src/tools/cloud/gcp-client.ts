import { createSign } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export type GcpServiceName =
  | 'oauth2Token'
  | 'cloudResourceManager'
  | 'serviceUsage'
  | 'compute'
  | 'run'
  | 'storage'
  | 'dns'
  | 'logging';

export interface GcpInstanceConfig {
  id: string;
  name: string;
  projectId: string;
  location?: string;
  accessToken?: string;
  serviceAccountJson?: string;
  endpoints?: {
    oauth2Token?: string;
    cloudResourceManager?: string;
    serviceUsage?: string;
    compute?: string;
    run?: string;
    storage?: string;
    dns?: string;
    logging?: string;
  };
}

type QueryValue = string | number | boolean | undefined | Array<string | number | boolean>;

interface GcpRequestInput {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  service: GcpServiceName;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface GcpRawRequestInput {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  bodyText?: string;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class GcpClient {
  readonly config: GcpInstanceConfig;
  private cachedAccessToken?: CachedAccessToken;

  constructor(config: GcpInstanceConfig) {
    this.config = { ...config };
  }

  async getProject(): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'cloudResourceManager',
      path: `/v1/projects/${encodeURIComponent(this.config.projectId)}`,
    });
  }

  async listEnabledServices(pageSize?: number): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'serviceUsage',
      path: `/v1/projects/${encodeURIComponent(this.config.projectId)}/services`,
      query: {
        filter: 'state:ENABLED',
        pageSize,
      },
    });
  }

  async listComputeInstances(input: { filter?: string; maxResults?: number }): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'compute',
      path: `/compute/v1/projects/${encodeURIComponent(this.config.projectId)}/aggregated/instances`,
      query: {
        filter: input.filter,
        maxResults: input.maxResults,
      },
    });
  }

  async getComputeInstance(zone: string, instance: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'compute',
      path: `/compute/v1/projects/${encodeURIComponent(this.config.projectId)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instance)}`,
    });
  }

  async startComputeInstance(zone: string, instance: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'compute',
      path: `/compute/v1/projects/${encodeURIComponent(this.config.projectId)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instance)}/start`,
    });
  }

  async stopComputeInstance(zone: string, instance: string, discardLocalSsd?: boolean): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'compute',
      path: `/compute/v1/projects/${encodeURIComponent(this.config.projectId)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instance)}/stop`,
      query: discardLocalSsd !== undefined ? { discardLocalSsd } : undefined,
    });
  }

  async resetComputeInstance(zone: string, instance: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'compute',
      path: `/compute/v1/projects/${encodeURIComponent(this.config.projectId)}/zones/${encodeURIComponent(zone)}/instances/${encodeURIComponent(instance)}/reset`,
    });
  }

  async listCloudRunServices(location: string, pageSize?: number): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'run',
      path: `/v2/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/services`,
      query: { pageSize },
    });
  }

  async getCloudRunService(location: string, serviceName: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'run',
      path: `/v2/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/services/${encodeURIComponent(serviceName)}`,
    });
  }

  async listCloudRunRevisions(location: string, filter?: string, pageSize?: number): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'run',
      path: `/v2/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/revisions`,
      query: {
        filter,
        pageSize,
      },
    });
  }

  async updateCloudRunTraffic(location: string, serviceName: string, traffic: unknown[], etag?: string): Promise<unknown> {
    return this.request({
      method: 'PATCH',
      service: 'run',
      path: `/v2/projects/${encodeURIComponent(this.config.projectId)}/locations/${encodeURIComponent(location)}/services/${encodeURIComponent(serviceName)}`,
      query: { updateMask: 'traffic' },
      body: etag ? { traffic, etag } : { traffic },
    });
  }

  async listStorageBuckets(maxResults?: number): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'storage',
      path: '/storage/v1/b',
      query: {
        project: this.config.projectId,
        maxResults,
      },
    });
  }

  async listStorageObjects(bucket: string, input: { prefix?: string; maxResults?: number }): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'storage',
      path: `/storage/v1/b/${encodeURIComponent(bucket)}/o`,
      query: {
        prefix: input.prefix,
        maxResults: input.maxResults,
      },
    });
  }

  async getStorageObjectText(bucket: string, objectName: string): Promise<{ metadata: unknown; bodyText: string }> {
    const metadata = await this.request({
      method: 'GET',
      service: 'storage',
      path: `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
    });
    const token = await this.getAccessToken(['https://www.googleapis.com/auth/cloud-platform']);
    const downloadUrl = this.buildUrl(
      'storage',
      `/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
      { alt: 'media' },
    );
    const bodyText = await this.requestRawText({
      method: 'GET',
      url: downloadUrl,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { metadata, bodyText };
  }

  async putStorageObjectText(bucket: string, objectName: string, body: string, contentType?: string): Promise<unknown> {
    const token = await this.getAccessToken(['https://www.googleapis.com/auth/cloud-platform']);
    return this.requestRawJson({
      method: 'POST',
      url: this.buildUrl(
        'storage',
        `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        {
          uploadType: 'media',
          name: objectName,
        },
      ),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType?.trim() || 'text/plain; charset=utf-8',
      },
      bodyText: body,
    });
  }

  async deleteStorageObject(bucket: string, objectName: string): Promise<unknown> {
    return this.request({
      method: 'DELETE',
      service: 'storage',
      path: `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`,
    });
  }

  async listDnsZones(input: { dnsName?: string; maxResults?: number }): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'dns',
      path: `/dns/v1/projects/${encodeURIComponent(this.config.projectId)}/managedZones`,
      query: {
        dnsName: input.dnsName,
        maxResults: input.maxResults,
      },
    });
  }

  async listDnsRecordSets(managedZone: string, input: { name?: string; type?: string; maxResults?: number }): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'dns',
      path: `/dns/v1/projects/${encodeURIComponent(this.config.projectId)}/managedZones/${encodeURIComponent(managedZone)}/rrsets`,
      query: {
        name: input.name,
        type: input.type,
        maxResults: input.maxResults,
      },
    });
  }

  async changeDnsRecordSets(managedZone: string, body: { additions?: unknown[]; deletions?: unknown[] }): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'dns',
      path: `/dns/v1/projects/${encodeURIComponent(this.config.projectId)}/managedZones/${encodeURIComponent(managedZone)}/changes`,
      body,
    });
  }

  async listLogEntries(body: {
    resourceNames: string[];
    filter?: string;
    pageSize?: number;
    orderBy?: string;
  }): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'logging',
      path: '/v2/entries:list',
      body,
    });
  }

  async request<T = unknown>(input: GcpRequestInput): Promise<T> {
    const scopes = scopesForService(input.service, input.method);
    const token = await this.getAccessToken(scopes);
    const url = this.buildUrl(input.service, input.path, input.query);
    const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'GuardianAgent-Cloud/1.0',
      ...input.headers,
    };
    if (bodyText !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    return this.requestRawJson({
      method: input.method,
      url,
      headers,
      timeoutMs: input.timeoutMs,
      bodyText,
    });
  }

  async getAccessToken(scopes: string[]): Promise<string> {
    if (this.config.accessToken?.trim()) {
      return this.config.accessToken.trim();
    }
    const cached = this.cachedAccessToken;
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    const key = this.parseServiceAccountJson();
    const tokenUrl = key.token_uri?.trim() || this.endpointFor('oauth2Token');
    const assertion = createJwtAssertion({
      issuer: key.client_email,
      subject: key.client_email,
      audience: tokenUrl,
      scope: scopes.join(' '),
      privateKey: key.private_key,
    });
    const response = await this.requestRawJson<{
      access_token: string;
      token_type?: string;
      expires_in?: number;
    }>({
      method: 'POST',
      url: tokenUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      bodyText: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!response.access_token?.trim()) {
      throw new Error('GCP OAuth token exchange did not return access_token.');
    }
    this.cachedAccessToken = {
      token: response.access_token.trim(),
      expiresAt: Date.now() + Math.max(300, Number(response.expires_in ?? 3600)) * 1000,
    };
    return this.cachedAccessToken.token;
  }

  buildUrl(service: GcpServiceName, path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.endpointFor(service));
    for (const [key, value] of Object.entries(query ?? {})) {
      appendQueryValue(url.searchParams, key, value);
    }
    return url.toString();
  }

  endpointFor(service: GcpServiceName): string {
    const override = this.config.endpoints?.[service]?.trim();
    if (override) return override;
    switch (service) {
      case 'oauth2Token':
        return 'https://oauth2.googleapis.com/token';
      case 'cloudResourceManager':
        return 'https://cloudresourcemanager.googleapis.com';
      case 'serviceUsage':
        return 'https://serviceusage.googleapis.com';
      case 'compute':
        return 'https://compute.googleapis.com';
      case 'run':
        return 'https://run.googleapis.com';
      case 'storage':
        return 'https://storage.googleapis.com';
      case 'dns':
        return 'https://dns.googleapis.com';
      case 'logging':
        return 'https://logging.googleapis.com';
    }
  }

  private parseServiceAccountJson(): ServiceAccountKey {
    if (!this.config.serviceAccountJson?.trim()) {
      throw new Error(`GCP profile '${this.config.id}' does not have a resolved access token or service account JSON.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.config.serviceAccountJson);
    } catch (error) {
      throw new Error(`GCP profile '${this.config.id}' serviceAccountJson is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`GCP profile '${this.config.id}' serviceAccountJson must decode to an object.`);
    }
    const key = parsed as Partial<ServiceAccountKey>;
    if (!key.client_email?.trim()) {
      throw new Error(`GCP profile '${this.config.id}' serviceAccountJson is missing client_email.`);
    }
    if (!key.private_key?.trim()) {
      throw new Error(`GCP profile '${this.config.id}' serviceAccountJson is missing private_key.`);
    }
    return {
      client_email: key.client_email,
      private_key: key.private_key,
      token_uri: key.token_uri,
    };
  }

  private async requestRawJson<T = unknown>(input: GcpRawRequestInput): Promise<T> {
    const response = await requestRaw(input);
    const body = response.body.trim();
    if (!body) {
      return {} as T;
    }
    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async requestRawText(input: GcpRawRequestInput): Promise<string> {
    const response = await requestRaw(input);
    return response.body;
  }
}

function scopesForService(service: GcpServiceName, method: string): string[] {
  void service;
  void method;
  return ['https://www.googleapis.com/auth/cloud-platform'];
}

async function requestRaw(input: GcpRawRequestInput): Promise<{ statusCode: number; body: string }> {
  const url = new URL(input.url);
  const transport = url.protocol === 'http:' ? http : https;
  const headers = { ...input.headers };
  if (input.bodyText !== undefined) {
    headers['Content-Length'] = Buffer.byteLength(input.bodyText).toString();
  }

  return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        method: input.method,
        path: `${url.pathname}${url.search}`,
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
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(extractGoogleApiError(statusCode, raw)));
            return;
          }
          resolve({ statusCode, body: raw });
        });
      },
    );

    req.setTimeout(input.timeoutMs ?? 15_000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    if (input.bodyText !== undefined) req.write(input.bodyText);
    req.end();
  });
}

function extractGoogleApiError(statusCode: number, body: string): string {
  if (!body.trim()) return `Request failed with ${statusCode}`;
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ message?: string }>;
      };
    };
    const message = parsed.error?.message || parsed.error?.errors?.find((entry) => entry.message?.trim())?.message;
    const status = parsed.error?.status;
    if (message && status) return `Request failed with ${statusCode}: ${status}: ${message}`;
    if (message) return `Request failed with ${statusCode}: ${message}`;
  } catch {
    // Fall back to raw body text.
  }
  return `Request failed with ${statusCode}: ${truncate(body, 300)}`;
}

function appendQueryValue(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      params.append(key, String(item));
    }
    return;
  }
  params.set(key, String(value));
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function createJwtAssertion(input: {
  issuer: string;
  subject: string;
  audience: string;
  scope: string;
  privateKey: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claims = base64UrlJson({
    iss: input.issuer,
    sub: input.subject,
    aud: input.audience,
    scope: input.scope,
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(input.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
