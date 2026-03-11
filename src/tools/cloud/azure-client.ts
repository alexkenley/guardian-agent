import http from 'node:http';
import https from 'node:https';

export type AzureServiceName = 'oauth2Token' | 'management' | 'blob';

export interface AzureInstanceConfig {
  id: string;
  name: string;
  subscriptionId: string;
  tenantId?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  defaultResourceGroup?: string;
  blobBaseUrl?: string;
  endpoints?: {
    oauth2Token?: string;
    management?: string;
  };
}

type QueryValue = string | number | boolean | undefined | Array<string | number | boolean>;

interface AzureRequestInput {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  service: AzureServiceName;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface AzureRawRequestInput {
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

const ARM_API_VERSIONS = {
  subscriptions: '2022-12-01',
  resourceGroups: '2021-04-01',
  compute: '2024-07-01',
  web: '2024-04-01',
  storage: '2024-01-01',
  dns: '2018-05-01',
  metrics: '2023-10-01',
  activityLogs: '2015-04-01',
} as const;

export class AzureClient {
  readonly config: AzureInstanceConfig;
  private readonly tokenCache = new Map<string, CachedAccessToken>();

  constructor(config: AzureInstanceConfig) {
    this.config = { ...config };
  }

  async getSubscription(): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}`,
      query: { 'api-version': ARM_API_VERSIONS.subscriptions },
    });
  }

  async listResourceGroups(top?: number): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourcegroups`,
      query: {
        'api-version': ARM_API_VERSIONS.resourceGroups,
        $top: top,
      },
    });
  }

  async listVms(resourceGroup?: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: resourceGroup?.trim()
        ? `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines`
        : `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/providers/Microsoft.Compute/virtualMachines`,
      query: { 'api-version': ARM_API_VERSIONS.compute },
    });
  }

  async getVm(resourceGroup: string, vmName: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(vmName)}`,
      query: { 'api-version': ARM_API_VERSIONS.compute },
    });
  }

  async startVm(resourceGroup: string, vmName: string): Promise<unknown> {
    return this.vmAction(resourceGroup, vmName, 'start');
  }

  async powerOffVm(resourceGroup: string, vmName: string): Promise<unknown> {
    return this.vmAction(resourceGroup, vmName, 'powerOff');
  }

  async restartVm(resourceGroup: string, vmName: string): Promise<unknown> {
    return this.vmAction(resourceGroup, vmName, 'restart');
  }

  async deallocateVm(resourceGroup: string, vmName: string): Promise<unknown> {
    return this.vmAction(resourceGroup, vmName, 'deallocate');
  }

  async listWebApps(resourceGroup?: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: resourceGroup?.trim()
        ? `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites`
        : `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/providers/Microsoft.Web/sites`,
      query: { 'api-version': ARM_API_VERSIONS.web },
    });
  }

  async getWebApp(resourceGroup: string, name: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}`,
      query: { 'api-version': ARM_API_VERSIONS.web },
    });
  }

  async getWebAppConfig(resourceGroup: string, name: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/config/web`,
      query: { 'api-version': ARM_API_VERSIONS.web },
    });
  }

  async restartWebApp(resourceGroup: string, name: string, softRestart?: boolean): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Web/sites/${encodeURIComponent(name)}/restart`,
      query: {
        'api-version': ARM_API_VERSIONS.web,
        softRestart: softRestart === undefined ? undefined : softRestart,
      },
    });
  }

  async listStorageAccounts(resourceGroup?: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: resourceGroup?.trim()
        ? `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts`
        : `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/providers/Microsoft.Storage/storageAccounts`,
      query: { 'api-version': ARM_API_VERSIONS.storage },
    });
  }

  async listBlobContainers(accountName: string): Promise<{ containers: string[]; rawXml: string }> {
    const xml = await this.requestBlob({
      method: 'GET',
      accountName,
      path: '/',
      query: { comp: 'list' },
    });
    return {
      containers: extractXmlTagValues(xml, 'Name'),
      rawXml: xml,
    };
  }

  async listBlobs(accountName: string, container: string, prefix?: string): Promise<{ blobs: string[]; rawXml: string }> {
    const xml = await this.requestBlob({
      method: 'GET',
      accountName,
      path: `/${encodeURIComponent(container)}`,
      query: {
        restype: 'container',
        comp: 'list',
        prefix: prefix?.trim() || undefined,
      },
    });
    return {
      blobs: extractXmlTagValues(xml, 'Name'),
      rawXml: xml,
    };
  }

  async putBlobText(accountName: string, container: string, blobName: string, body: string, contentType?: string): Promise<unknown> {
    const token = await this.getAccessToken('https://storage.azure.com/.default');
    return this.requestRaw({
      method: 'PUT',
      url: this.buildBlobUrl(accountName, `/${encodeURIComponent(container)}/${encodeBlobPath(blobName)}`),
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-version': '2023-11-03',
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': contentType?.trim() || 'text/plain; charset=utf-8',
      },
      bodyText: body,
    });
  }

  async deleteBlob(accountName: string, container: string, blobName: string): Promise<unknown> {
    const token = await this.getAccessToken('https://storage.azure.com/.default');
    return this.requestRaw({
      method: 'DELETE',
      url: this.buildBlobUrl(accountName, `/${encodeURIComponent(container)}/${encodeBlobPath(blobName)}`),
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-version': '2023-11-03',
      },
    });
  }

  async listDnsZones(resourceGroup?: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: resourceGroup?.trim()
        ? `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/dnszones`
        : `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/providers/Microsoft.Network/dnszones`,
      query: { 'api-version': ARM_API_VERSIONS.dns },
    });
  }

  async listDnsRecordSets(resourceGroup: string, zoneName: string, recordType?: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/dnszones/${encodeURIComponent(zoneName)}/${encodeURIComponent(recordType?.trim() || 'ALL')}`,
      query: { 'api-version': ARM_API_VERSIONS.dns },
    });
  }

  async upsertDnsRecordSet(resourceGroup: string, zoneName: string, recordType: string, relativeRecordSetName: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request({
      method: 'PUT',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/dnszones/${encodeURIComponent(zoneName)}/${encodeURIComponent(recordType)}/${encodeURIComponent(relativeRecordSetName)}`,
      query: { 'api-version': ARM_API_VERSIONS.dns },
      body,
    });
  }

  async deleteDnsRecordSet(resourceGroup: string, zoneName: string, recordType: string, relativeRecordSetName: string): Promise<unknown> {
    return this.request({
      method: 'DELETE',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Network/dnszones/${encodeURIComponent(zoneName)}/${encodeURIComponent(recordType)}/${encodeURIComponent(relativeRecordSetName)}`,
      query: { 'api-version': ARM_API_VERSIONS.dns },
    });
  }

  async listMetrics(resourceId: string, input: { metricnames: string; timespan?: string; interval?: string; aggregation?: string; top?: number; orderby?: string; filter?: string }): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `${resourceId.replace(/\/+$/, '')}/providers/microsoft.insights/metrics`,
      query: {
        'api-version': ARM_API_VERSIONS.metrics,
        metricnames: input.metricnames,
        timespan: input.timespan,
        interval: input.interval,
        aggregation: input.aggregation,
        top: input.top,
        orderby: input.orderby,
        $filter: input.filter,
      },
    });
  }

  async listActivityLogs(filter?: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/providers/microsoft.insights/eventtypes/management/values`,
      query: {
        'api-version': ARM_API_VERSIONS.activityLogs,
        $filter: filter,
      },
    });
  }

  async request<T = unknown>(input: AzureRequestInput): Promise<T> {
    const token = await this.getAccessToken(input.service === 'blob' ? 'https://storage.azure.com/.default' : 'https://management.azure.com/.default');
    const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
    return this.requestRaw({
      method: input.method,
      url: this.buildUrl(input.service, input.path, input.query),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'GuardianAgent-Cloud/1.0',
        ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...input.headers,
      },
      timeoutMs: input.timeoutMs,
      bodyText,
    }) as Promise<T>;
  }

  async getAccessToken(scope: string): Promise<string> {
    if (this.config.accessToken?.trim()) {
      return this.config.accessToken.trim();
    }

    const cached = this.tokenCache.get(scope);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    if (!this.config.tenantId?.trim() || !this.config.clientId?.trim() || !this.config.clientSecret?.trim()) {
      throw new Error(`Azure profile '${this.config.id}' does not have a resolved access token or service principal credentials.`);
    }

    const response = await this.requestRaw<{
      access_token: string;
      expires_in?: number | string;
    }>({
      method: 'POST',
      url: this.endpointFor('oauth2Token'),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      bodyText: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope,
      }).toString(),
    });
    if (!response.access_token?.trim()) {
      throw new Error('Azure OAuth token exchange did not return access_token.');
    }
    const expiresIn = Number(response.expires_in ?? 3600);
    this.tokenCache.set(scope, {
      token: response.access_token.trim(),
      expiresAt: Date.now() + Math.max(300, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    });
    return response.access_token.trim();
  }

  buildUrl(service: AzureServiceName, path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.endpointFor(service));
    for (const [key, value] of Object.entries(query ?? {})) {
      appendQueryValue(url.searchParams, key, value);
    }
    return url.toString();
  }

  endpointFor(service: AzureServiceName): string {
    switch (service) {
      case 'oauth2Token':
        return this.config.endpoints?.oauth2Token?.trim()
          || `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId?.trim() || 'common')}/oauth2/v2.0/token`;
      case 'management':
        return this.config.endpoints?.management?.trim() || 'https://management.azure.com';
      case 'blob':
        return this.config.blobBaseUrl?.trim() || 'https://blob.core.windows.net';
    }
  }

  private async vmAction(resourceGroup: string, vmName: string, action: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      service: 'management',
      path: `/subscriptions/${encodeURIComponent(this.config.subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(vmName)}/${action}`,
      query: { 'api-version': ARM_API_VERSIONS.compute },
    });
  }

  private async requestBlob(input: {
    method: 'GET' | 'PUT' | 'DELETE';
    accountName: string;
    path: string;
    query?: Record<string, QueryValue>;
    bodyText?: string;
    headers?: Record<string, string>;
  }): Promise<string> {
    const token = await this.getAccessToken('https://storage.azure.com/.default');
    const response = await requestRawText({
      method: input.method,
      url: this.buildBlobUrl(input.accountName, input.path, input.query),
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-version': '2023-11-03',
        ...input.headers,
      },
      bodyText: input.bodyText,
    });
    return response;
  }

  private async requestRaw<T = unknown>(input: AzureRawRequestInput): Promise<T> {
    const response = await requestRawText(input);
    const body = response.trim();
    if (!body) {
      return {} as T;
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as T;
    }
  }

  private buildBlobUrl(accountName: string, path: string, query?: Record<string, QueryValue>): string {
    const base = this.config.blobBaseUrl?.trim()
      ? new URL(this.config.blobBaseUrl)
      : new URL(`https://${accountName}.blob.core.windows.net`);
    const url = new URL(path, `${base.origin}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      appendQueryValue(url.searchParams, key, value);
    }
    return url.toString();
  }
}

async function requestRawText(input: AzureRawRequestInput): Promise<string> {
  const url = new URL(input.url);
  const transport = url.protocol === 'http:' ? http : https;
  const headers = { ...(input.headers ?? {}) };
  if (input.bodyText !== undefined) {
    headers['Content-Length'] = Buffer.byteLength(input.bodyText).toString();
  }
  return await new Promise<string>((resolve, reject) => {
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
            reject(new Error(extractAzureError(statusCode, raw)));
            return;
          }
          resolve(raw);
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

function extractAzureError(statusCode: number, body: string): string {
  if (!body.trim()) return `Request failed with ${statusCode}`;
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        code?: string;
        message?: string;
      };
      code?: string;
      message?: string;
    };
    const code = parsed.error?.code || parsed.code;
    const message = parsed.error?.message || parsed.message;
    if (code && message) return `Request failed with ${statusCode}: ${code}: ${message}`;
    if (message) return `Request failed with ${statusCode}: ${message}`;
  } catch {
    const xmlCode = extractFirstXmlTagValue(body, 'Code');
    const xmlMessage = extractFirstXmlTagValue(body, 'Message');
    if (xmlCode && xmlMessage) return `Request failed with ${statusCode}: ${xmlCode}: ${xmlMessage}`;
  }
  return `Request failed with ${statusCode}: ${truncate(body, 300)}`;
}

function extractXmlTagValues(xml: string, tagName: string): string[] {
  const matches = xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'g')) ?? [];
  return matches
    .map((entry) => extractFirstXmlTagValue(entry, tagName))
    .filter((value): value is string => !!value?.trim());
}

function extractFirstXmlTagValue(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
  return match?.[1];
}

function encodeBlobPath(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}
