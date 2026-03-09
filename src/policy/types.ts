/**
 * Policy-as-Code types.
 *
 * Defines the canonical authorization model for GuardianAgent's
 * deterministic policy engine.
 */

// ── Decision types ──────────────────────────────────────────────

export type PolicyDecisionKind = 'allow' | 'deny' | 'require_approval';

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  reason: string;
  ruleId?: string;
  obligations?: string[];
}

// ── Policy input (canonical request shape) ──────────────────────

export type PolicyFamily = 'tool' | 'guardian' | 'admin' | 'event';

export interface PolicyPrincipal {
  kind: 'user' | 'agent' | 'system';
  id: string;
  channel?: string;
  capabilities?: string[];
  trustPreset?: string;
}

export interface PolicyResource {
  kind: string;
  id?: string;
  attrs?: Record<string, unknown>;
}

export interface PolicyInput {
  family: PolicyFamily;
  principal: PolicyPrincipal;
  action: string;
  resource: PolicyResource;
  context: Record<string, unknown>;
}

// ── Rule format ─────────────────────────────────────────────────

export type MatchPrimitive =
  | string
  | number
  | boolean
  | { in: (string | number)[] }
  | { notIn: (string | number)[] }
  | { gt: number }
  | { gte: number }
  | { lt: number }
  | { lte: number }
  | { startsWith: string }
  | { endsWith: string }
  | { regex: string }
  | { exists: boolean };

export interface MatchConditions {
  [path: string]: MatchPrimitive | MatchConditions[] | undefined;
  anyOf?: MatchConditions[];
  allOf?: MatchConditions[];
}

export interface PolicyRule {
  id: string;
  family: PolicyFamily;
  enabled: boolean;
  priority: number;
  description?: string;
  match: MatchConditions;
  decision: {
    kind: PolicyDecisionKind;
    reason: string;
    obligations?: string[];
  };
}

export interface PolicyFile {
  schemaVersion: number;
  rules: PolicyRule[];
}

// ── Compiled rule (internal) ────────────────────────────────────

export type CompiledMatcher = (input: PolicyInput) => boolean;

export interface CompiledRule {
  id: string;
  family: PolicyFamily;
  priority: number;
  matcher: CompiledMatcher;
  decision: PolicyDecision;
}

// ── Engine interface ────────────────────────────────────────────

export interface PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision;
  ruleCount(family?: PolicyFamily): number;
  reload(rules: PolicyRule[]): { loaded: number; skipped: number; errors: string[] };
}

// ── Shadow mode ─────────────────────────────────────────────────

export type MismatchClass =
  | 'policy_too_strict'
  | 'policy_too_permissive'
  | 'normalization_bug'
  | 'legacy_bug'
  | 'unknown';

export interface ShadowComparison {
  family: PolicyFamily;
  action: string;
  resourceSummary: string;
  legacyDecision: PolicyDecisionKind;
  policyDecision: PolicyDecisionKind;
  ruleId?: string;
  mismatch: boolean;
  mismatchClass?: MismatchClass;
}

// ── Config ──────────────────────────────────────────────────────

export type PolicyModeConfig = 'off' | 'shadow' | 'enforce';

export interface PolicyConfig {
  enabled: boolean;
  mode: PolicyModeConfig;
  families: {
    tool: PolicyModeConfig;
    admin: PolicyModeConfig;
    guardian: PolicyModeConfig;
    event: PolicyModeConfig;
  };
  rulesPath: string;
  mismatchLogLimit: number;
}

// ── Current schema version ──────────────────────────────────────

export const POLICY_SCHEMA_VERSION = 1;
