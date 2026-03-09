/**
 * Policy-as-Code — barrel export.
 */

export type {
  PolicyDecisionKind,
  PolicyDecision,
  PolicyFamily,
  PolicyPrincipal,
  PolicyResource,
  PolicyInput,
  PolicyRule,
  PolicyFile,
  PolicyEngine,
  PolicyConfig,
  PolicyModeConfig,
  MatchPrimitive,
  MatchConditions,
  CompiledRule,
  CompiledMatcher,
  ShadowComparison,
  MismatchClass,
} from './types.js';

export { POLICY_SCHEMA_VERSION } from './types.js';
export { createPolicyEngine, PolicyEngineImpl } from './engine.js';
export { compileRule, compileRules } from './compiler.js';
export { matchConditions, matchPrimitive, resolvePath } from './matcher.js';
export { loadPolicyFiles, loadSingleFile } from './rules.js';
export { normalizeToolRequest } from './normalize-tool.js';
export { ShadowEvaluator, shouldEvaluate, isEnforcing } from './shadow.js';
export type { ShadowStats, ShadowModeOptions, ShadowLogger } from './shadow.js';
