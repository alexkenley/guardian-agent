import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { detectInjection, stripInvisibleChars } from '../guardian/input-sanitizer.js';

const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_FILES = 320;
const MAX_SCAN_BYTES = 24_000;
const MAX_FINDINGS = 12;

const IGNORED_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'out',
  'tmp',
  'temp',
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.md',
  '.txt',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
  '.cmd',
  '.bat',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.sql',
  '.graphql',
  '.dockerfile',
]);

const DOC_EXTENSIONS = new Set(['.md', '.txt']);
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.cmd', '.bat']);
const PROMPT_LIKE_BASENAMES = new Set([
  'readme.md',
  'readme',
  'instructions.md',
  'instructions.txt',
  'prompt.md',
  'prompt.txt',
]);
const PACKAGE_LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishonly',
  'publish',
  'postpublish',
]);

const HIGH_RISK_EXEC_PATTERNS: Array<{ kind: CodeWorkspaceTrustFindingKind; summary: string; regex: RegExp }> = [
  {
    kind: 'fetch_pipe_exec',
    summary: 'Network fetch piped directly into a shell.',
    regex: /\b(?:curl|wget)\b[^\n|]{0,400}\|\s*(?:bash|sh|zsh)\b/i,
  },
  {
    kind: 'fetch_pipe_exec',
    summary: 'PowerShell network fetch piped into immediate execution.',
    regex: /\b(?:iwr|irm|invoke-webrequest)\b[^\n|]{0,400}\|\s*(?:iex|invoke-expression)\b/i,
  },
  {
    kind: 'encoded_exec',
    summary: 'Encoded PowerShell execution pattern.',
    regex: /\bpowershell(?:\.exe)?\b[^\n]{0,200}\s-(?:enc|encodedcommand|e)\b/i,
  },
  {
    kind: 'inline_exec',
    summary: 'Inline interpreter execution pattern.',
    regex: /\b(?:python|python3|ruby|perl)\b[^\n]{0,160}\s-[ce]\b/i,
  },
  {
    kind: 'encoded_exec',
    summary: 'Base64-decoding execution pattern.',
    regex: /\b(?:frombase64string|base64\s+-d|certutil\s+-decode)\b/i,
  },
];

const WARN_EXEC_PATTERNS: Array<{ kind: CodeWorkspaceTrustFindingKind; summary: string; regex: RegExp }> = [
  {
    kind: 'network_fetch',
    summary: 'Network download command present in executable repo content.',
    regex: /\b(?:curl|wget|invoke-webrequest|iwr|irm)\b/i,
  },
  {
    kind: 'shell_launcher',
    summary: 'Shell-expression launcher pattern.',
    regex: /\b(?:bash|sh|zsh|powershell(?:\.exe)?)\b[^\n]{0,160}\s-(?:c|command)\b/i,
  },
  {
    kind: 'inline_exec',
    summary: 'Dynamic evaluation pattern.',
    regex: /\b(?:eval|invoke-expression|iex)\b/i,
  },
  {
    kind: 'inline_exec',
    summary: 'Inline Node.js execution pattern.',
    regex: /\bnode\b[^\n]{0,160}\s-[ce]\b/i,
  },
];

export type CodeWorkspaceTrustState = 'trusted' | 'caution' | 'blocked';
export type CodeWorkspaceTrustFindingSeverity = 'warn' | 'high';
export type CodeWorkspaceTrustFindingKind =
  | 'prompt_injection'
  | 'lifecycle_script'
  | 'fetch_pipe_exec'
  | 'encoded_exec'
  | 'inline_exec'
  | 'network_fetch'
  | 'shell_launcher'
  | 'native_av_detection'
  | 'privileged_client_secret'
  | 'public_env_secret'
  | 'hardcoded_fallback_secret'
  | 'permissive_rls_policy'
  | 'public_storage_bucket'
  | 'unsigned_webhook_handler';

export type CodeWorkspaceNativeProtectionStatus =
  | 'pending'
  | 'clean'
  | 'detected'
  | 'unavailable'
  | 'error';

export interface CodeWorkspaceNativeProtection {
  provider: string;
  status: CodeWorkspaceNativeProtectionStatus;
  summary: string;
  observedAt: number;
  requestedAt?: number;
  details?: string[];
}

export interface CodeWorkspaceTrustFinding {
  severity: CodeWorkspaceTrustFindingSeverity;
  kind: CodeWorkspaceTrustFindingKind;
  path: string;
  summary: string;
  evidence?: string;
}

export interface CodeWorkspaceTrustAssessment {
  workspaceRoot: string;
  state: CodeWorkspaceTrustState;
  summary: string;
  assessedAt: number;
  scannedFiles: number;
  truncated: boolean;
  findings: CodeWorkspaceTrustFinding[];
  nativeProtection?: CodeWorkspaceNativeProtection | null;
}

export interface CodeWorkspaceTrustReview {
  decision: 'accepted';
  reviewedAt: number;
  reviewedBy: string;
  assessmentFingerprint: string;
  rawState: CodeWorkspaceTrustState;
  findingCount: number;
}

interface ScanContext {
  filesScanned: number;
  truncated: boolean;
  findings: CodeWorkspaceTrustFinding[];
  findingKeys: Set<string>;
}

function readTextIfExists(path: string, maxBytes = MAX_SCAN_BYTES): string {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8').slice(0, maxBytes);
  } catch {
    return '';
  }
}

function isTextCandidate(relativePath: string): boolean {
  const extension = extname(relativePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return true;
  const baseName = basename(relativePath).toLowerCase();
  return baseName === 'dockerfile' || baseName === 'makefile';
}

function shouldIgnoreDir(name: string): boolean {
  return IGNORED_DIRS.has(name.toLowerCase());
}

function isPromptLikeDocument(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const baseName = basename(normalized);
  const extension = extname(normalized);
  return PROMPT_LIKE_BASENAMES.has(baseName)
    || DOC_EXTENSIONS.has(extension)
    || normalized.startsWith('docs/')
    || normalized.includes('/prompts/')
    || normalized.includes('/instructions/');
}

function isExecutableRepoFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const baseName = basename(normalized);
  const extension = extname(normalized);
  return SCRIPT_EXTENSIONS.has(extension)
    || baseName === 'dockerfile'
    || baseName === 'makefile'
    || normalized.startsWith('.github/workflows/')
    || normalized.startsWith('.devcontainer/')
    || normalized.includes('/scripts/');
}

function isCodeFile(relativePath: string): boolean {
  const extension = extname(relativePath).toLowerCase();
  return [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.mts',
    '.cts',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.rb',
    '.php',
    '.cs',
    '.swift',
  ].includes(extension);
}

function isClientExposedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const extension = extname(normalized);
  return normalized.startsWith('web/public/')
    || normalized.startsWith('public/')
    || normalized.startsWith('src/client/')
    || normalized.startsWith('src/components/')
    || normalized.startsWith('src/pages/')
    || normalized.startsWith('pages/')
    || normalized.startsWith('app/')
    || normalized.includes('/client/')
    || normalized.includes('/components/')
    || extension === '.tsx'
    || extension === '.jsx'
    || extension === '.html';
}

function toEvidence(match: RegExpMatchArray | null | undefined): string | undefined {
  const raw = match?.[0]?.trim();
  if (!raw) return undefined;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157).trim()}...`;
}

function pushFinding(context: ScanContext, finding: CodeWorkspaceTrustFinding): void {
  const key = `${finding.severity}:${finding.kind}:${finding.path}:${finding.summary}`;
  if (context.findingKeys.has(key)) return;
  if (context.findings.length < MAX_FINDINGS) {
    context.findingKeys.add(key);
    context.findings.push(finding);
    return;
  }

  if (finding.severity !== 'high') return;
  const replacementIndex = context.findings.findIndex((candidate) => candidate.severity !== 'high');
  if (replacementIndex === -1) return;

  const replaced = context.findings[replacementIndex];
  const replacedKey = `${replaced.severity}:${replaced.kind}:${replaced.path}:${replaced.summary}`;
  context.findingKeys.delete(replacedKey);
  context.findingKeys.add(key);
  context.findings.splice(replacementIndex, 1, finding);
}

function prioritizeAssessmentFindings(findings: CodeWorkspaceTrustFinding[]): CodeWorkspaceTrustFinding[] {
  return [...findings].sort((left, right) => {
    if (left.kind === 'native_av_detection' && right.kind !== 'native_av_detection') return -1;
    if (right.kind === 'native_av_detection' && left.kind !== 'native_av_detection') return 1;
    if (left.severity !== right.severity) return left.severity === 'high' ? -1 : 1;
    const leftPath = String(left.path || '');
    const rightPath = String(right.path || '');
    if (leftPath !== rightPath) return leftPath.localeCompare(rightPath);
    return String(left.kind || '').localeCompare(String(right.kind || ''));
  });
}

function scanPromptInjection(relativePath: string, content: string, context: ScanContext): void {
  if (!isPromptLikeDocument(relativePath)) return;
  const cleaned = stripInvisibleChars(content);
  const detection = detectInjection(cleaned);
  if (detection.score < 3) return;
  pushFinding(context, {
    severity: 'warn',
    kind: 'prompt_injection',
    path: relativePath,
    summary: `Prompt-injection-like text found in repo content (signals: ${detection.signals.slice(0, 3).join(', ')}).`,
  });
}

function scanExecutablePatterns(relativePath: string, content: string, context: ScanContext): void {
  if (!isExecutableRepoFile(relativePath)) return;

  for (const pattern of HIGH_RISK_EXEC_PATTERNS) {
    const match = content.match(pattern.regex);
    if (!match) continue;
    pushFinding(context, {
      severity: 'high',
      kind: pattern.kind,
      path: relativePath,
      summary: pattern.summary,
      evidence: toEvidence(match),
    });
  }

  for (const pattern of WARN_EXEC_PATTERNS) {
    const match = content.match(pattern.regex);
    if (!match) continue;
    pushFinding(context, {
      severity: 'warn',
      kind: pattern.kind,
      path: relativePath,
      summary: pattern.summary,
      evidence: toEvidence(match),
    });
  }
}

function scanPackageManifest(relativePath: string, content: string, context: ScanContext): void {
  if (basename(relativePath).toLowerCase() !== 'package.json') return;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const scripts = parsed.scripts && typeof parsed.scripts === 'object'
      ? parsed.scripts as Record<string, unknown>
      : {};
    const lifecycleNames = Object.keys(scripts).filter((name) => PACKAGE_LIFECYCLE_SCRIPTS.has(name.toLowerCase()));
    if (lifecycleNames.length === 0) return;

    pushFinding(context, {
      severity: 'warn',
      kind: 'lifecycle_script',
      path: relativePath,
      summary: `Lifecycle scripts present: ${lifecycleNames.slice(0, 5).join(', ')}.`,
    });

    for (const name of lifecycleNames) {
      const value = typeof scripts[name] === 'string' ? scripts[name] : '';
      if (!value.trim()) continue;
      for (const pattern of HIGH_RISK_EXEC_PATTERNS) {
        const match = value.match(pattern.regex);
        if (!match) continue;
        pushFinding(context, {
          severity: 'high',
          kind: pattern.kind,
          path: `${relativePath}#scripts.${name}`,
          summary: `${name} script contains a high-risk execution pattern.`,
          evidence: toEvidence(match),
        });
      }
      for (const pattern of WARN_EXEC_PATTERNS) {
        const match = value.match(pattern.regex);
        if (!match) continue;
        pushFinding(context, {
          severity: 'warn',
          kind: pattern.kind,
          path: `${relativePath}#scripts.${name}`,
          summary: `${name} script contains a suspicious execution pattern.`,
          evidence: toEvidence(match),
        });
      }
    }
  } catch {
    // Ignore invalid package manifests during trust assessment.
  }
}

function scanCredentialAntiPatterns(relativePath: string, content: string, context: ScanContext): void {
  const publicEnvMatch = content.match(/\b(?:NEXT_PUBLIC|VITE|PUBLIC|REACT_APP)_[A-Z0-9_]*(?:SECRET|TOKEN|PRIVATE|SERVICE[_-]?ROLE|PASSWORD|DATABASE|DB[_-]?URL|API[_-]?KEY|OPENAI|ANTHROPIC|AWS|STRIPE[_-]?SK|SENDGRID|TWILIO)[A-Z0-9_]*\b/i);
  if (publicEnvMatch) {
    pushFinding(context, {
      severity: 'high',
      kind: 'public_env_secret',
      path: relativePath,
      summary: 'Publicly bundled environment variable name appears to contain secret material.',
      evidence: toEvidence(publicEnvMatch),
    });
  }

  const serviceRoleMatch = content.match(/\b(?:SUPABASE_)?SERVICE[_-]?ROLE(?:_KEY)?\b|service[_-]?role/i);
  if (serviceRoleMatch && /\b(?:supabase|createClient|NEXT_PUBLIC|VITE|REACT_APP|PUBLIC_)/i.test(content)) {
    const clientExposed = isClientExposedPath(relativePath) || /\b(?:NEXT_PUBLIC|VITE|REACT_APP|PUBLIC_)/i.test(content);
    pushFinding(context, {
      severity: clientExposed ? 'high' : 'warn',
      kind: 'privileged_client_secret',
      path: relativePath,
      summary: clientExposed
        ? 'Privileged service-role credential appears in client-exposed code or public environment configuration.'
        : 'Privileged service-role credential reference appears in repo code.',
      evidence: toEvidence(serviceRoleMatch),
    });
  }

  const fallbackPatterns = [
    /\b(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PRIVATE)[A-Z0-9_]*)\s*(?:\|\||\?\?)\s*(['"`])([^'"`]{4,})\2/gi,
    /\benviron\.get\(\s*(['"`])([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PRIVATE)[A-Z0-9_]*)\1\s*,\s*(['"`])([^'"`]{4,})\3\s*\)/gi,
  ];
  for (const regex of fallbackPatterns) {
    for (const match of content.matchAll(regex)) {
      const fallback = match[3] || match[4] || '';
      if (!/(?:secret|token|password|passwd|changeme|change-me|dev|test|example|placeholder|key)/i.test(fallback) && fallback.length < 16) {
        continue;
      }
      pushFinding(context, {
        severity: 'high',
        kind: 'hardcoded_fallback_secret',
        path: relativePath,
        summary: 'Secret-like environment lookup has a hardcoded fallback value.',
        evidence: toEvidence(match),
      });
      break;
    }
  }
}

function scanAuthorizationAntiPatterns(relativePath: string, content: string, context: ScanContext): void {
  if (extname(relativePath).toLowerCase() !== '.sql') return;

  const permissivePolicyMatch = content.match(/\b(?:create|alter)\s+policy\b[\s\S]{0,600}\b(?:using|with\s+check)\s*\(\s*(?:true|auth\.uid\(\)\s+is\s+not\s+null)\s*\)/i);
  if (permissivePolicyMatch) {
    pushFinding(context, {
      severity: 'high',
      kind: 'permissive_rls_policy',
      path: relativePath,
      summary: 'Supabase/Postgres policy appears permissive and may not enforce row ownership.',
      evidence: toEvidence(permissivePolicyMatch),
    });
  }
}

function scanExposureAntiPatterns(relativePath: string, content: string, context: ScanContext): void {
  const publicBucketMatch = content.match(/(?:storage\.buckets|createBucket|bucket|buckets)[\s\S]{0,240}\bpublic\b\s*[:=]\s*true/i)
    || content.match(/\binsert\s+into\s+storage\.buckets\b[\s\S]{0,240}\btrue\b/i);
  if (publicBucketMatch) {
    pushFinding(context, {
      severity: 'warn',
      kind: 'public_storage_bucket',
      path: relativePath,
      summary: 'Storage bucket configuration appears to enable public access.',
      evidence: toEvidence(publicBucketMatch),
    });
  }
}

function scanWebhookAntiPatterns(relativePath: string, content: string, context: ScanContext): void {
  if (!isCodeFile(relativePath)) return;
  const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
  const mentionsWebhook = normalizedPath.includes('webhook') || /\bwebhooks?\b/i.test(content);
  if (!mentionsWebhook) return;
  const consumesBody = /\b(?:req\.body|request\.json\s*\(|request\.text\s*\(|await\s+.*\.json\s*\(|rawBody|bodyParser)\b/i.test(content);
  if (!consumesBody) return;
  const verifiesSignature = /\b(?:constructEvent|x-hub-signature|x-signature|stripe-signature|svix-signature|webhook-signature|createHmac|timingSafeEqual|verifyWebhook|verifySignature|signature)\b/i.test(content);
  if (verifiesSignature) return;
  pushFinding(context, {
    severity: 'warn',
    kind: 'unsigned_webhook_handler',
    path: relativePath,
    summary: 'Webhook-like handler consumes request body without an obvious signature verification check.',
  });
}

function scanSaasAntiPatterns(relativePath: string, content: string, context: ScanContext): void {
  scanCredentialAntiPatterns(relativePath, content, context);
  scanAuthorizationAntiPatterns(relativePath, content, context);
  scanExposureAntiPatterns(relativePath, content, context);
  scanWebhookAntiPatterns(relativePath, content, context);
}

function scanFile(workspaceRoot: string, relativePath: string, context: ScanContext): void {
  if (context.filesScanned >= MAX_SCAN_FILES) {
    context.truncated = true;
    return;
  }
  if (!isTextCandidate(relativePath)) return;

  const absolutePath = join(workspaceRoot, relativePath);
  let size = 0;
  try {
    size = statSync(absolutePath).size;
  } catch {
    return;
  }
  if (size > MAX_SCAN_BYTES * 8) return;

  const content = readTextIfExists(absolutePath, MAX_SCAN_BYTES);
  if (!content.trim()) return;

  context.filesScanned += 1;
  scanPromptInjection(relativePath, content, context);
  scanExecutablePatterns(relativePath, content, context);
  scanPackageManifest(relativePath, content, context);
  scanSaasAntiPatterns(relativePath, content, context);
}

function visitDirectory(workspaceRoot: string, absoluteDir: string, relativeDir: string, depth: number, context: ScanContext): void {
  if (depth > MAX_SCAN_DEPTH || context.truncated) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (context.truncated) break;
    if (entry.isDirectory()) {
      if (shouldIgnoreDir(entry.name)) continue;
      const nextRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      visitDirectory(workspaceRoot, join(absoluteDir, entry.name), nextRelative, depth + 1, context);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    scanFile(workspaceRoot, relativePath, context);
  }
}

function deriveAssessmentState(findings: CodeWorkspaceTrustFinding[]): CodeWorkspaceTrustState {
  return findings.some((finding) => finding.severity === 'high')
    ? 'blocked'
    : findings.length > 0
      ? 'caution'
      : 'trusted';
}

function summarizeAssessment(
  state: CodeWorkspaceTrustState,
  findings: CodeWorkspaceTrustFinding[],
  scannedFiles: number,
  truncated: boolean,
  nativeProtection?: CodeWorkspaceNativeProtection | null,
): string {
  const highCount = findings.filter((finding) => finding.severity === 'high').length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const scanSuffix = `${scannedFiles} scanned file${scannedFiles === 1 ? '' : 's'}${truncated ? ' (truncated)' : ''}.`;
  const nativeSuffix = nativeProtection?.summary
    ? ` Native AV: ${nativeProtection.summary}`
    : '';

  if (state === 'trusted') {
    return `Static workspace review found no suspicious repo-execution or prompt-injection indicators in ${scanSuffix}${nativeSuffix}`;
  }
  if (state === 'blocked') {
    return `Static workspace review found ${highCount} high-risk and ${warnCount} warning indicator${highCount + warnCount === 1 ? '' : 's'}. Repo execution and persistence actions should require approval until reviewed. ${scanSuffix}${nativeSuffix}`;
  }
  return `Static workspace review found ${warnCount} suspicious indicator${warnCount === 1 ? '' : 's'}. Repo content is not trusted for automatic execution or persistence until reviewed. ${scanSuffix}${nativeSuffix}`;
}

function stripNativeProtectionFindings(findings: CodeWorkspaceTrustFinding[]): CodeWorkspaceTrustFinding[] {
  return findings.filter((finding) => finding.kind !== 'native_av_detection');
}

function buildNativeProtectionFindings(
  nativeProtection: CodeWorkspaceNativeProtection | null | undefined,
): CodeWorkspaceTrustFinding[] {
  if (!nativeProtection || nativeProtection.status !== 'detected') return [];
  const details = Array.isArray(nativeProtection.details)
    ? nativeProtection.details.filter((detail) => typeof detail === 'string' && detail.trim()).slice(0, 4)
    : [];
  return [{
    severity: 'high',
    kind: 'native_av_detection',
    path: '[native-av]',
    summary: `Native AV provider '${nativeProtection.provider}' reported a detection in the workspace.`,
    evidence: details.length > 0 ? details.join(' | ') : undefined,
  }];
}

function cloneCodeWorkspaceNativeProtection(
  nativeProtection: CodeWorkspaceNativeProtection | null | undefined,
): CodeWorkspaceNativeProtection | null {
  if (!nativeProtection) return null;
  return {
    ...nativeProtection,
    details: Array.isArray(nativeProtection.details) ? [...nativeProtection.details] : [],
  };
}

function serializeAssessmentForFingerprint(assessment: CodeWorkspaceTrustAssessment): string {
  // Manual review should track the findings/operators actually accepted.
  // Non-detection native-protection refreshes (pending/clean/unavailable)
  // should not immediately clear that acceptance.
  return JSON.stringify({
    workspaceRoot: assessment.workspaceRoot,
    state: assessment.state,
    findings: Array.isArray(assessment.findings)
      ? assessment.findings.map((finding) => ({
        severity: finding.severity,
        kind: finding.kind,
        path: finding.path,
        summary: finding.summary,
        evidence: finding.evidence ?? '',
      }))
      : [],
  });
}

export function applyCodeWorkspaceNativeProtection(
  assessment: CodeWorkspaceTrustAssessment,
  nativeProtection: CodeWorkspaceNativeProtection | null | undefined,
): CodeWorkspaceTrustAssessment {
  const clonedNativeProtection = cloneCodeWorkspaceNativeProtection(nativeProtection);
  const findings = prioritizeAssessmentFindings([
    ...stripNativeProtectionFindings(Array.isArray(assessment.findings) ? assessment.findings : []),
    ...buildNativeProtectionFindings(clonedNativeProtection),
  ]);
  const state = deriveAssessmentState(findings);
  return {
    ...assessment,
    state,
    summary: summarizeAssessment(
      state,
      findings,
      assessment.scannedFiles,
      assessment.truncated,
      clonedNativeProtection,
    ),
    findings,
    nativeProtection: clonedNativeProtection,
  };
}

export function getCodeWorkspaceTrustAssessmentFingerprint(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
): string {
  if (!assessment) return '';
  return createHash('sha256')
    .update(serializeAssessmentForFingerprint(assessment))
    .digest('hex');
}

export function isCodeWorkspaceTrustReviewEligible(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
): boolean {
  if (!assessment) return false;
  if (assessment.state === 'trusted') return false;
  return !assessment.findings.some((finding) => finding.kind === 'native_av_detection');
}

export function createCodeWorkspaceTrustReview(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  reviewedBy: string,
  now = Date.now(),
): CodeWorkspaceTrustReview | null {
  if (!isCodeWorkspaceTrustReviewEligible(assessment)) return null;
  if (!assessment) return null;
  const eligibleAssessment = assessment;
  return {
    decision: 'accepted',
    reviewedAt: now,
    reviewedBy: reviewedBy.trim() || 'unknown',
    assessmentFingerprint: getCodeWorkspaceTrustAssessmentFingerprint(eligibleAssessment),
    rawState: eligibleAssessment.state,
    findingCount: Array.isArray(eligibleAssessment.findings) ? eligibleAssessment.findings.length : 0,
  };
}

export function cloneCodeWorkspaceTrustReview(
  review: CodeWorkspaceTrustReview | null | undefined,
): CodeWorkspaceTrustReview | null {
  if (!review) return null;
  return {
    ...review,
  };
}

export function isCodeWorkspaceTrustReviewActive(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  review: CodeWorkspaceTrustReview | null | undefined,
): boolean {
  if (!assessment || !review) return false;
  if (review.decision !== 'accepted') return false;
  if (!isCodeWorkspaceTrustReviewEligible(assessment)) return false;
  return review.assessmentFingerprint === getCodeWorkspaceTrustAssessmentFingerprint(assessment);
}

export function reconcileCodeWorkspaceTrustReview(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  review: CodeWorkspaceTrustReview | null | undefined,
): CodeWorkspaceTrustReview | null {
  return isCodeWorkspaceTrustReviewActive(assessment, review)
    ? cloneCodeWorkspaceTrustReview(review)
    : null;
}

export function getEffectiveCodeWorkspaceTrustState(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  review: CodeWorkspaceTrustReview | null | undefined,
): CodeWorkspaceTrustState | null {
  if (!assessment) return null;
  return isCodeWorkspaceTrustReviewActive(assessment, review)
    ? 'trusted'
    : assessment.state;
}

export function cloneCodeWorkspaceTrustAssessment(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
): CodeWorkspaceTrustAssessment | null {
  if (!assessment) return null;
  return {
    ...assessment,
    findings: Array.isArray(assessment.findings)
      ? assessment.findings.map((finding) => ({ ...finding }))
      : [],
    nativeProtection: cloneCodeWorkspaceNativeProtection(assessment.nativeProtection),
  };
}

export function assessCodeWorkspaceTrustSync(workspaceRoot: string, now = Date.now()): CodeWorkspaceTrustAssessment {
  const context: ScanContext = {
    filesScanned: 0,
    truncated: false,
    findings: [],
    findingKeys: new Set<string>(),
  };

  visitDirectory(workspaceRoot, workspaceRoot, '', 0, context);

  const findings = prioritizeAssessmentFindings(context.findings);
  const state = deriveAssessmentState(findings);

  return {
    workspaceRoot,
    state,
    summary: summarizeAssessment(state, findings, context.filesScanned, context.truncated),
    assessedAt: now,
    scannedFiles: context.filesScanned,
    truncated: context.truncated,
    findings,
    nativeProtection: null,
  };
}

export function shouldRefreshCodeWorkspaceTrust(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  workspaceRoot: string,
  now = Date.now(),
): boolean {
  if (!assessment) return true;
  if (assessment.workspaceRoot !== workspaceRoot) return true;
  return (now - (assessment.assessedAt || 0)) > 5 * 60_000;
}

export function shouldRefreshCodeWorkspaceNativeProtection(
  assessment: CodeWorkspaceTrustAssessment | null | undefined,
  workspaceRoot: string,
  now = Date.now(),
): boolean {
  if (!assessment) return true;
  if (assessment.workspaceRoot !== workspaceRoot) return true;
  if (!assessment.nativeProtection) return true;

  const observedAt = assessment.nativeProtection.observedAt || 0;
  const requestedAt = assessment.nativeProtection.requestedAt || observedAt;
  if (assessment.nativeProtection.status === 'pending') {
    return (now - requestedAt) > 5 * 60_000;
  }

  const staleAfterMs = assessment.nativeProtection.status === 'unavailable'
    ? 12 * 60 * 60_000
    : 6 * 60 * 60_000;
  return (now - observedAt) > staleAfterMs;
}
