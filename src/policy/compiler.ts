/**
 * Policy rule compiler — transforms PolicyRule[] into sorted CompiledRule[]
 * with pre-built matcher functions for fast evaluation.
 */

import type { PolicyRule, CompiledRule, PolicyFamily, PolicyDecision } from './types.js';
import { matchConditions } from './matcher.js';

/**
 * Compile a single rule into a CompiledRule with a closure-based matcher.
 */
export function compileRule(rule: PolicyRule): CompiledRule {
  const conditions = rule.match;
  const decision: PolicyDecision = {
    kind: rule.decision.kind,
    reason: rule.decision.reason,
    ruleId: rule.id,
    obligations: rule.decision.obligations,
  };

  return {
    id: rule.id,
    family: rule.family,
    priority: rule.priority,
    matcher: (input) => matchConditions(input, conditions),
    decision,
  };
}

/**
 * Compile and sort rules for a given family.
 * Rules are sorted by priority (lower = higher precedence),
 * then by decision severity (deny > require_approval > allow).
 */
export function compileRules(rules: PolicyRule[], family?: PolicyFamily): CompiledRule[] {
  const filtered = family
    ? rules.filter(r => r.enabled && r.family === family)
    : rules.filter(r => r.enabled);

  const compiled = filtered.map(compileRule);

  // Sort: lower priority number = evaluated first.
  // At same priority: deny > require_approval > allow.
  const decisionOrder: Record<string, number> = {
    deny: 0,
    require_approval: 1,
    allow: 2,
  };

  compiled.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (decisionOrder[a.decision.kind] ?? 3) - (decisionOrder[b.decision.kind] ?? 3);
  });

  return compiled;
}
