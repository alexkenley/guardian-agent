import http from 'node:http';
import https from 'node:https';

export interface VercelInstanceConfig {
  id: string;
  name: string;
  apiBaseUrl?: string;
  apiToken: string;
  teamId?: string;
  slug?: string;
}

type QueryValue = string | number | boolean | undefined | Array<string | number | boolean>;

export interface VercelRequestInput {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class VercelClient {
  readonly config: VercelInstanceConfig;
  readonly baseUrl: URL;

  constructor(config: VercelInstanceConfig) {
    this.config = { ...config };
    this.baseUrl = new URL(config.apiBaseUrl?.trim() || 'https://api.vercel.com');
  }

  async request<T = unknown>(input: VercelRequestInput): Promise<T> {
    const url = new URL(input.path, this.baseUrl);
    const scopedQuery = this.withScope(input.query);
    for (const [key, value] of Object.entries(scopedQuery)) {
      appendQueryValue(url.searchParams, key, value);
    }

    const transport = url.protocol === 'http:' ? http : https;
    const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.config.apiToken}`,
      'User-Agent': 'GuardianAgent-Cloud/1.0',
      ...input.headers,
    };
    if (bodyText !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyText).toString();
    }

    return await new Promise<T>((resolve, reject) => {
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
            const body = raw.trim();
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(extractVercelError(statusCode, body)));
              return;
            }
            if (!body) {
              resolve({} as T);
              return;
            }
            try {
              resolve(JSON.parse(body) as T);
            } catch (error) {
              if (statusCode === 200) {
                resolve(body as T);
                return;
              }
              reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
            }
          });
        },
      );

      req.setTimeout(input.timeoutMs ?? 15_000, () => {
        req.destroy(new Error('Request timed out'));
      });
      req.on('error', reject);
      if (bodyText !== undefined) req.write(bodyText);
      req.end();
    });
  }

  async listProjects(query?: Record<string, QueryValue>): Promise<unknown> {
    return this.request({ method: 'GET', path: '/v10/projects', query });
  }

  async getProject(projectIdOrName: string): Promise<unknown> {
    return this.request({ method: 'GET', path: `/v9/projects/${encodeURIComponent(projectIdOrName)}` });
  }

  async createProject(body: Record<string, unknown>): Promise<unknown> {
    return this.request({ method: 'POST', path: '/v10/projects', body });
  }

  async updateProject(projectIdOrName: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request({
      method: 'PATCH',
      path: `/v9/projects/${encodeURIComponent(projectIdOrName)}`,
      body,
    });
  }

  async deleteProject(projectIdOrName: string): Promise<unknown> {
    return this.request({
      method: 'DELETE',
      path: `/v9/projects/${encodeURIComponent(projectIdOrName)}`,
    });
  }

  async listDeployments(query?: Record<string, QueryValue>): Promise<unknown> {
    return this.request({ method: 'GET', path: '/v6/deployments', query });
  }

  async getDeployment(deploymentIdOrUrl: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      path: `/v13/deployments/${encodeURIComponent(deploymentIdOrUrl)}`,
    });
  }

  async createDeployment(body: Record<string, unknown>): Promise<unknown> {
    return this.request({ method: 'POST', path: '/v13/deployments', body });
  }

  async cancelDeployment(deploymentId: string): Promise<unknown> {
    return this.request({
      method: 'PATCH',
      path: `/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`,
    });
  }

  async promoteDeployment(projectIdOrName: string, deploymentId: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      path: `/v13/projects/${encodeURIComponent(projectIdOrName)}/promote/${encodeURIComponent(deploymentId)}`,
    });
  }

  async listProjectDomains(projectIdOrName: string, query?: Record<string, QueryValue>): Promise<unknown> {
    return this.request({
      method: 'GET',
      path: `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains`,
      query,
    });
  }

  async getProjectDomain(projectIdOrName: string, domain: string): Promise<unknown> {
    return this.request({
      method: 'GET',
      path: `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domain)}`,
    });
  }

  async addProjectDomain(projectIdOrName: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request({
      method: 'POST',
      path: `/v10/projects/${encodeURIComponent(projectIdOrName)}/domains`,
      body,
    });
  }

  async removeProjectDomain(projectIdOrName: string, domain: string): Promise<unknown> {
    return this.request({
      method: 'DELETE',
      path: `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domain)}`,
    });
  }

  async verifyProjectDomain(projectIdOrName: string, domain: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      path: `/v9/projects/${encodeURIComponent(projectIdOrName)}/domains/${encodeURIComponent(domain)}/verify`,
    });
  }

  async listProjectEnv(projectIdOrName: string, query?: Record<string, QueryValue>): Promise<unknown> {
    return this.request({
      method: 'GET',
      path: `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`,
      query,
    });
  }

  async createProjectEnv(projectIdOrName: string, body: Record<string, unknown>, upsert?: string): Promise<unknown> {
    return this.request({
      method: 'POST',
      path: `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`,
      query: upsert ? { upsert } : undefined,
      body,
    });
  }

  async updateProjectEnv(projectIdOrName: string, envId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request({
      method: 'PATCH',
      path: `/v10/projects/${encodeURIComponent(projectIdOrName)}/env/${encodeURIComponent(envId)}`,
      body,
    });
  }

  async deleteProjectEnv(projectIdOrName: string, envId: string, customEnvironmentId?: string): Promise<unknown> {
    return this.request({
      method: 'DELETE',
      path: `/v10/projects/${encodeURIComponent(projectIdOrName)}/env/${encodeURIComponent(envId)}`,
      query: customEnvironmentId ? { customEnvironmentId } : undefined,
    });
  }

  async getDeploymentEvents(deploymentId: string, query?: Record<string, QueryValue>): Promise<unknown> {
    return this.request({
      method: 'GET',
      path: `/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
      query,
    });
  }

  async getRuntimeLogs(
    projectId: string,
    deploymentId: string,
    query?: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.request({
      method: 'GET',
      path: `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs`,
      query,
    });
  }

  private withScope(query: Record<string, QueryValue> | undefined): Record<string, QueryValue> {
    const scoped: Record<string, QueryValue> = { ...(query ?? {}) };
    if (this.config.teamId?.trim()) {
      scoped['teamId'] = this.config.teamId.trim();
    } else if (this.config.slug?.trim()) {
      scoped['slug'] = this.config.slug.trim();
    }
    return scoped;
  }
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

function extractVercelError(statusCode: number, body: string): string {
  if (!body) {
    return `Request failed with ${statusCode}`;
  }
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    const message = parsed.error?.message || parsed.message;
    const code = parsed.error?.code || parsed.code;
    if (message && code) return `Request failed with ${statusCode}: ${code}: ${message}`;
    if (message) return `Request failed with ${statusCode}: ${message}`;
  } catch {
    // Fall back to raw body text.
  }
  return `Request failed with ${statusCode}: ${truncate(body, 300)}`;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}
