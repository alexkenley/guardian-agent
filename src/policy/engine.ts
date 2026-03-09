/**
 * Policy Engine — deterministic rule evaluation.
 *
 * Evaluates compiled rules against a PolicyInput and returns the
 * first matching decision. Falls back to family defaults when no
 * rule matches.
 */

import type {
  PolicyInput,
  PolicyDecision,
  PolicyFamily,
  PolicyRule,
  CompiledRule,
  PolicyEngine as IPolicyEngine,
} from './types.js';
import { compileRules } from './compiler.js';

// ── Family defaults ─────────────────────────────────────────────

/**
 * Tool-family default depends on policyMode and risk.
 * All other families default to deny.
 */
function toolFamilyDefault(input: PolicyInput): PolicyDecision {
  const mode = input.context.policyMode as string | undefined;
  const isReadOnly = input.context.isReadOnly === true;

  if (mode === 'autonomous') {
    return { kind: 'allow', reason: 'Tool family default: autonomous mode allows all.' };
  }

  if (isReadOnly) {
    return { kind: 'allow', reason: 'Tool family default: read-only tools are allowed.' };
  }

  return {
    kind: 'require_approval',
    reason: `Tool family default: mutating tools require approval in ${mode ?? 'unknown'} mode.`,
  };
}

const FAMILY_DEFAULTS: Record<PolicyFamily, (input: PolicyInput) => PolicyDecision> = {
  tool: toolFamilyDefault,
  guardian: () => ({ kind: 'deny', reason: 'Guardian family default: deny unknown actions.' }),
  admin: () => ({ kind: 'deny', reason: 'Admin family default: deny without explicit authorization.' }),
  event: () => ({ kind: 'deny', reason: 'Event family default: deny unknown event targets.' }),
};

// ── Engine implementation ───────────────────────────────────────

export class PolicyEngineImpl implements IPolicyEngine {
  private rulesByFamily: Map<PolicyFamily, CompiledRule[]> = new Map();
  private allRules: CompiledRule[] = [];

  constructor(rules?: PolicyRule[]) {
    if (rules && rules.length > 0) {
      this.reload(rules);
    }
  }

  /**
   * Evaluate a PolicyInput against loaded rules.
   * Returns the first matching rule's decision, or the family default.
   */
  evaluate(input: PolicyInput): PolicyDecision {
    const familyRules = this.rulesByFamily.get(input.family);
    if (familyRules) {
      for (const rule of familyRules) {
        try {
          if (rule.matcher(input)) {
            return rule.decision;
          }
        } catch {
          // Matcher error — skip this rule, continue evaluation.
          // In enforce mode the engine returns deny on total failure,
          // but a single broken rule should not block everything.
        }
      }
    }

    // No rule matched — apply family default
    const defaultFn = FAMILY_DEFAULTS[input.family];
    return defaultFn ? defaultFn(input) : { kind: 'deny', reason: 'Unknown policy family.' };
  }

  /**
   * Return the number of compiled rules, optionally filtered by family.
   */
  ruleCount(family?: PolicyFamily): number {
    if (family) {
      return this.rulesByFamily.get(family)?.length ?? 0;
    }
    return this.allRules.length;
  }

  /**
   * Load or reload rules. Returns counts and any validation errors.
   */
  reload(rules: PolicyRule[]): { loaded: number; skipped: number; errors: string[] } {
    const errors: string[] = [];
    const valid: PolicyRule[] = [];

    for (const rule of rules) {
      const err = validateRule(rule);
      if (err) {
        errors.push(`Rule '${rule.id ?? '(no id)'}': ${err}`);
      } else {
        valid.push(rule);
      }
    }

    // Check for duplicate IDs
    const seenIds = new Set<string>();
    for (const rule of valid) {
      if (seenIds.has(rule.id)) {
        errors.push(`Rule '${rule.id}': duplicate id (keeping first occurrence)`);
      }
      seenIds.add(rule.id);
    }

    // Deduplicate (keep first occurrence)
    const deduped = valid.filter((r, i) =>
      valid.findIndex(v => v.id === r.id) === i,
    );

    // Compile all
    this.allRules = compileRules(deduped);

    // Index by family
    this.rulesByFamily.clear();
    const families: PolicyFamily[] = ['tool', 'guardian', 'admin', 'event'];
    for (const family of families) {
      const familyRules = compileRules(deduped, family);
      if (familyRules.length > 0) {
        this.rulesByFamily.set(family, familyRules);
      }
    }

    return {
      loaded: deduped.filter(r => r.enabled).length,
      skipped: rules.length - deduped.length + deduped.filter(r => !r.enabled).length,
      errors,
    };
  }
}

// ── Rule validation ─────────────────────────────────────────────

const VALID_FAMILIES = new Set<string>(['tool', 'guardian', 'admin', 'event']);
const VALID_DECISIONS = new Set<string>(['allow', 'deny', 'require_approval']);

function validateRule(rule: PolicyRule): string | null {
  if (!rule.id || typeof rule.id !== 'string') return 'missing or invalid id';
  if (!VALID_FAMILIES.has(rule.family)) return `invalid family '${rule.family}'`;
  if (typeof rule.enabled !== 'boolean') return 'enabled must be boolean';
  if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
    return 'priority must be a finite number';
  }
  if (!rule.match || typeof rule.match !== 'object') return 'match must be an object';
  if (!rule.decision || typeof rule.decision !== 'object') return 'decision must be an object';
  if (!VALID_DECISIONS.has(rule.decision.kind)) {
    return `invalid decision kind '${rule.decision.kind}'`;
  }
  if (!rule.decision.reason || typeof rule.decision.reason !== 'string') {
    return 'decision.reason must be a non-empty string';
  }
  return null;
}

/**
 * Create a new PolicyEngine instance.
 */
export function createPolicyEngine(rules?: PolicyRule[]): IPolicyEngine {
  return new PolicyEngineImpl(rules);
}
