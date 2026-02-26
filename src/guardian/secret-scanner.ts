/**
 * Secret scanner — detects sensitive content in text and file paths.
 *
 * Prevents agents from accidentally exfiltrating or writing secrets.
 * Supports built-in patterns for major cloud providers, CI/CD tokens,
 * and generic secret formats, plus custom regex patterns.
 */

/** A detected secret in content. */
export interface SecretMatch {
  /** Pattern name that matched. */
  pattern: string;
  /** The matched text (redacted for safe display). */
  match: string;
  /** The raw matched text (for redaction/replacement). */
  rawMatch: string;
  /** Character offset in the content. */
  offset: number;
}

/** Built-in secret detection patterns. */
const BUILTIN_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  // ─── AWS ───────────────────────────────────────────────────
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Secret Key', regex: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi },
  { name: 'AWS Session Token', regex: /(?:aws_session_token|x-amz-security-token)\s*[=:]\s*[A-Za-z0-9/+=]{100,}/gi },

  // ─── GCP / Google ──────────────────────────────────────────
  { name: 'GCP Service Account', regex: /"type"\s*:\s*"service_account"/g },
  { name: 'Google AI API Key', regex: /AIza[A-Za-z0-9_-]{35}/g },

  // ─── Azure ─────────────────────────────────────────────────
  { name: 'Azure Storage Key', regex: /DefaultEndpointsProtocol=https;.*?AccountKey=[A-Za-z0-9+/=]+/gi },

  // ─── GitHub ────────────────────────────────────────────────
  { name: 'GitHub Token', regex: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub OAuth', regex: /gho_[A-Za-z0-9]{36,}/g },
  { name: 'GitHub App Token', regex: /(?:ghs|ghr)_[A-Za-z0-9]{36,}/g },

  // ─── GitLab ────────────────────────────────────────────────
  { name: 'GitLab PAT', regex: /glpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitLab Pipeline Token', regex: /glptt-[A-Za-z0-9_-]{20,}/g },

  // ─── OpenAI / Anthropic ────────────────────────────────────
  { name: 'OpenAI API Key', regex: /sk-(?!ant-)[A-Za-z0-9][A-Za-z0-9-]{20,}/g },
  { name: 'Anthropic API Key', regex: /sk-ant-[A-Za-z0-9-]{20,}/g },

  // ─── Stripe ────────────────────────────────────────────────
  { name: 'Stripe Live Key', regex: /sk_live_[0-9a-zA-Z]{20,}/g },
  { name: 'Stripe Test Key', regex: /sk_test_[0-9a-zA-Z]{20,}/g },

  // ─── Communication Services ────────────────────────────────
  { name: 'Slack Token', regex: /xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}/g },
  { name: 'Slack Webhook', regex: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
  { name: 'Twilio API Key', regex: /SK[0-9a-fA-F]{32}/g },
  { name: 'SendGrid API Key', regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { name: 'Telegram Bot Token', regex: /[0-9]{8,10}:[A-Za-z0-9_-]{35}/g },

  // ─── Package Registries ────────────────────────────────────
  { name: 'npm Token', regex: /npm_[A-Za-z0-9]{36}/g },

  // ─── Infrastructure ────────────────────────────────────────
  { name: 'Heroku API Key', regex: /[hH]eroku.*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g },
  { name: 'Mailgun API Key', regex: /key-[A-Za-z0-9]{32}/g },

  // ─── Tokens & Certs ────────────────────────────────────────
  { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'PEM Private Key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'Connection String', regex: /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/gi },

  // ─── Generic Patterns ──────────────────────────────────────
  { name: 'Generic Secret', regex: /(?:password|passwd|secret|token|api_key|apikey)\s*[=:]\s*['"][^\s'"]{8,}['"]/gi },

  // ─── PII (Personal Identifiable Information) ───────────────
  { name: 'Email Address', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
  { name: 'US Social Security Number', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: 'Credit Card Number', regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g },
  { name: 'Phone Number (US)', regex: /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
];

/** File path patterns that are always denied. */
const DENIED_PATH_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: '.env file', regex: /(?:^|\/)\.env(?:\.\w+)?$/i },
  { name: 'PEM file', regex: /\.pem$/i },
  { name: 'Key file', regex: /\.key$/i },
  { name: 'Credentials file', regex: /(?:^|\/)credentials(?:\.\w+)?$/i },
  { name: 'SSH private key', regex: /(?:^|\/)id_rsa(?:$|[^.])/i },
  { name: 'SSH key', regex: /(?:^|\/)id_(?:ed25519|ecdsa|dsa)$/i },
  { name: 'P12/PFX cert', regex: /\.(?:p12|pfx)$/i },
  { name: 'Keystore', regex: /\.(?:jks|keystore)$/i },
  // New denied paths
  { name: 'npmrc file', regex: /(?:^|\/)\.npmrc$/i },
  { name: 'Terraform vars', regex: /\.tfvars$/i },
  { name: 'Terraform state', regex: /\.tfstate(?:\.backup)?$/i },
  { name: 'Docker compose secrets', regex: /(?:^|\/)docker-compose[^/]*\.ya?ml$/i },
  { name: 'Kubeconfig', regex: /(?:^|\/)(?:\.kube\/config|kubeconfig)$/i },
];

export class SecretScanner {
  private patterns: Array<{ name: string; regex: RegExp }>;
  private deniedPaths: Array<{ name: string; regex: RegExp }>;

  constructor(additionalPatterns?: string[]) {
    this.patterns = [...BUILTIN_PATTERNS];
    this.deniedPaths = [...DENIED_PATH_PATTERNS];

    if (additionalPatterns) {
      for (const pattern of additionalPatterns) {
        this.patterns.push({
          name: `Custom: ${pattern}`,
          regex: new RegExp(pattern, 'g'),
        });
      }
    }
  }

  /** Scan content for secrets. Returns all matches. */
  scanContent(content: string): SecretMatch[] {
    const matches: SecretMatch[] = [];

    for (const { name, regex } of this.patterns) {
      // Reset lastIndex for stateful regexes
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        matches.push({
          pattern: name,
          match: redact(match[0]),
          rawMatch: match[0],
          offset: match.index,
        });
      }
    }

    return matches;
  }

  /** Check if a file path is in the denied list. */
  isDeniedPath(filePath: string): { denied: boolean; reason?: string } {
    // Normalize backslashes to forward slashes for platform-agnostic matching
    const normalized = filePath.replace(/\\/g, '/');
    for (const { name, regex } of this.deniedPaths) {
      regex.lastIndex = 0;
      if (regex.test(normalized)) {
        return { denied: true, reason: name };
      }
    }
    return { denied: false };
  }

  /** Add custom denied path patterns (from config). */
  addDeniedPaths(patterns: string[]): void {
    for (const pattern of patterns) {
      this.deniedPaths.push({
        name: `Custom denied: ${pattern}`,
        regex: new RegExp(pattern, 'i'),
      });
    }
  }

  /** Convenience: scan file path AND content together. */
  scanFile(filePath: string, content: string): {
    pathDenied: boolean;
    pathReason?: string;
    secrets: SecretMatch[];
  } {
    const pathCheck = this.isDeniedPath(filePath);
    const secrets = this.scanContent(content);
    return {
      pathDenied: pathCheck.denied,
      pathReason: pathCheck.reason,
      secrets,
    };
  }
}

/** Redact a secret value, showing only first/last few chars. */
function redact(value: string): string {
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '...' + value.slice(-4);
}
