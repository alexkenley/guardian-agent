/**
 * Moltbook forum connector with hostile-site guardrails.
 *
 * This connector treats Moltbook as untrusted:
 * - strict host allowlist
 * - timeout + body-size limits
 * - no redirect follow
 * - response sanitization before use
 */

import { URL } from 'node:url';
import type { ForumConnector, ForumConnectorFinding, ForumConnectorStatus } from './forum-connector.js';

export interface MoltbookConnectorSecurityEvent {
  severity: 'info' | 'warn';
  code:
    | 'hostile_guard_enabled'
    | 'host_blocked'
    | 'insecure_scheme_blocked'
    | 'request_denied'
    | 'request_timeout'
    | 'request_failed'
    | 'response_too_large'
    | 'response_non_json'
    | 'suspicious_payload';
  message: string;
  details?: Record<string, unknown>;
}

export interface MoltbookConnectorOptions {
  enabled: boolean;
  mode: 'mock' | 'api';
  baseUrl?: string;
  apiKey?: string;
  searchPath: string;
  requestTimeoutMs: number;
  maxPostsPerQuery: number;
  maxResponseBytes: number;
  allowedHosts: string[];
  allowActiveResponse: boolean;
  admitRequest?: (url: string) => { allowed: boolean; reason?: string };
  now?: () => number;
  onSecurityEvent?: (event: MoltbookConnectorSecurityEvent) => void;
}

interface MoltbookPost {
  id?: string | number;
  url?: string;
  permalink?: string;
  title?: string;
  text?: string;
  content?: string;
  body?: string;
  author?: string;
  handle?: string;
}

const RISK_TERMS = ['deepfake', 'impersonation', 'fake', 'fraud', 'scam', 'hoax', 'exposed', 'leak'];
const SUSPICIOUS_MARKERS = ['<script', 'javascript:', 'onerror=', 'onload=', 'base64,'];

export class MoltbookConnector implements ForumConnector {
  readonly id = 'moltbook';
  readonly sourceType = 'forum';

  private readonly options: MoltbookConnectorOptions;
  private readonly now: () => number;
  private lastScanAt?: number;
  private lastError?: string;

  constructor(options: MoltbookConnectorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.emit({
      severity: 'info',
      code: 'hostile_guard_enabled',
      message: 'Moltbook connector initialized in hostile-site protection mode.',
      details: {
        enabled: options.enabled,
        mode: options.mode,
        allowedHosts: options.allowedHosts,
      },
    });
  }

  status(): ForumConnectorStatus {
    return {
      id: this.id,
      enabled: this.options.enabled,
      hostile: true,
      mode: this.options.mode,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
    };
  }

  allowsActivePublishing(): boolean {
    return this.options.allowActiveResponse;
  }

  async scan(targets: string[]): Promise<ForumConnectorFinding[]> {
    if (!this.options.enabled) return [];
    if (targets.length === 0) return [];

    this.lastError = undefined;
    const findings: ForumConnectorFinding[] = [];

    if (this.options.mode === 'mock') {
      for (const target of targets) {
        findings.push(...this.mockFindings(target));
      }
      this.lastScanAt = this.now();
      return findings;
    }

    for (const target of targets) {
      const fetched = await this.fetchTarget(target);
      findings.push(...fetched);
    }

    this.lastScanAt = this.now();
    return findings;
  }

  private async fetchTarget(target: string): Promise<ForumConnectorFinding[]> {
    const url = this.buildSearchUrl(target);
    if (!url) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      if (this.options.admitRequest) {
        const decision = this.options.admitRequest(url);
        if (!decision.allowed) {
          this.emit({
            severity: 'warn',
            code: 'request_denied',
            message: `Moltbook request denied by guardian policy: ${decision.reason ?? 'denied'}`,
            details: { url },
          });
          return [];
        }
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'GuardianAgent-ThreatIntel/1.0',
      };
      if (this.options.apiKey?.trim()) {
        headers.Authorization = `Bearer ${this.options.apiKey.trim()}`;
      }

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      });

      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > this.options.maxResponseBytes) {
        this.emit({
          severity: 'warn',
          code: 'response_too_large',
          message: 'Moltbook response exceeded maxResponseBytes and was discarded.',
          details: { bytes: buffer.byteLength, limit: this.options.maxResponseBytes },
        });
        return [];
      }

      const rawText = Buffer.from(buffer).toString('utf-8');
      const text = sanitizeText(rawText);
      if (containsSuspiciousPayload(text)) {
        this.emit({
          severity: 'warn',
          code: 'suspicious_payload',
          message: 'Suspicious payload markers detected in Moltbook response.',
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.emit({
          severity: 'warn',
          code: 'response_non_json',
          message: 'Moltbook response was not valid JSON.',
          details: { url },
        });
        return [];
      }

      const posts = extractPosts(parsed);
      return posts
        .map((post) => toFinding(post, target))
        .filter((finding): finding is ForumConnectorFinding => !!finding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      if (message.includes('aborted') || message.includes('AbortError')) {
        this.emit({
          severity: 'warn',
          code: 'request_timeout',
          message: 'Moltbook request timed out.',
          details: { timeoutMs: this.options.requestTimeoutMs },
        });
      } else {
        this.emit({
          severity: 'warn',
          code: 'request_failed',
          message: 'Moltbook request failed.',
          details: { error: message },
        });
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private buildSearchUrl(target: string): string | null {
    const base = this.options.baseUrl?.trim();
    if (!base) {
      this.lastError = 'Moltbook baseUrl is required in api mode.';
      return null;
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(base);
    } catch {
      this.lastError = `Invalid Moltbook baseUrl: ${base}`;
      return null;
    }

    const hostname = baseUrl.hostname.toLowerCase();
    const allowed = this.options.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(hostname)) {
      this.emit({
        severity: 'warn',
        code: 'host_blocked',
        message: `Blocked Moltbook request to non-allowlisted host '${hostname}'.`,
        details: { allowedHosts: allowed },
      });
      this.lastError = `Host '${hostname}' is not allowlisted for Moltbook connector.`;
      return null;
    }

    const isHttps = baseUrl.protocol === 'https:';
    const isLocalHttp = baseUrl.protocol === 'http:' &&
      (hostname === 'localhost' || hostname === '127.0.0.1');
    if (!isHttps && !isLocalHttp) {
      this.emit({
        severity: 'warn',
        code: 'insecure_scheme_blocked',
        message: `Blocked Moltbook request using insecure scheme '${baseUrl.protocol}'.`,
      });
      this.lastError = `Insecure scheme '${baseUrl.protocol}' is not allowed for Moltbook connector.`;
      return null;
    }

    const endpoint = new URL(this.options.searchPath, baseUrl);
    endpoint.searchParams.set('q', target);
    endpoint.searchParams.set('limit', String(this.options.maxPostsPerQuery));
    return endpoint.toString();
  }

  private mockFindings(target: string): ForumConnectorFinding[] {
    const message = `Potential impersonation thread detected mentioning '${target}' on Moltbook.`;
    return [
      {
        target,
        summary: message,
        url: `https://moltbook.com/mock/${encodeURIComponent(target)}`,
        severity: target.includes('deepfake') ? 'high' : 'medium',
        confidence: target.includes('deepfake') ? 0.82 : 0.58,
        labels: ['forum', 'moltbook', 'hostile_site'],
      },
    ];
  }

  private emit(event: MoltbookConnectorSecurityEvent): void {
    this.options.onSecurityEvent?.(event);
  }
}

function sanitizeText(input: string): string {
  const strippedControls = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return strippedControls.slice(0, 1_000_000);
}

function containsSuspiciousPayload(input: string): boolean {
  const lower = input.toLowerCase();
  return SUSPICIOUS_MARKERS.some((marker) => lower.includes(marker));
}

function extractPosts(payload: unknown): MoltbookPost[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord) as unknown as MoltbookPost[];
  }
  if (!isRecord(payload)) return [];

  const fromKnownKeys = payload['posts'] ?? payload['items'] ?? payload['results'];
  if (Array.isArray(fromKnownKeys)) {
    return fromKnownKeys.filter(isRecord) as unknown as MoltbookPost[];
  }
  return [];
}

function toFinding(post: MoltbookPost, target: string): ForumConnectorFinding | null {
  const body = sanitizeText([post.title, post.text, post.content, post.body].filter(Boolean).join(' '));
  if (!body) return null;

  const lowerBody = body.toLowerCase();
  const lowerTarget = target.toLowerCase();
  if (!lowerBody.includes(lowerTarget)) return null;

  const matchedRisk = RISK_TERMS.filter((term) => lowerBody.includes(term));
  if (matchedRisk.length === 0) return null;

  const url = post.url ?? post.permalink;
  const severity = matchedRisk.includes('deepfake') || matchedRisk.includes('impersonation')
    ? 'high'
    : 'medium';
  const confidence = severity === 'high' ? 0.8 : 0.62;

  return {
    target,
    summary: `Moltbook post mentions '${target}' with risk terms: ${matchedRisk.join(', ')}.`,
    url,
    severity,
    confidence,
    labels: ['forum', 'moltbook', 'hostile_site', ...matchedRisk],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
