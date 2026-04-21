import { normalizeIntentGatewayRepairText } from './text.js';

const WORKSPACE_SCOPE_PATTERN = /\b(?:coding\s+workspace|coding\s+session|workspace|session)\b/;
const REPO_MUTATION_PATTERN = /\b(?:create|add|make|write|generate|touch|update|edit|change|modify|fix|patch|rewrite|append|delete|remove)\b/;
const REPO_EXECUTION_PATTERN = /\b(?:run|test|build|lint|check|debug|investigate|inspect|review|search|find|grep)\b/;
const CODING_BACKEND_PATTERN = /\b(?:codex|claude(?:\s+code)?|gemini(?:\s+cli)?|aider)\b/;
const CODE_REPO_TARGET_PATTERN = /\b(?:source|function|class|module|component|symbol|tests?|test suite|unit tests?|build|compile|lint|check|readme)\b/;
const CODING_BACKEND_SCOPE_TARGET_PATTERN = /\b(?:top-level directory|root directory|workspace root|project root|repo root|directory|folder)\b/;
const SOURCE_TREE_PATH_PATTERN = /(?:^|\s)(?:src|docs|web|scripts|native|policies|skills)\//;
const REPO_FILE_REFERENCE_PATTERN = /\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|yml|yaml|txt|toml)\b/;
const EXACT_FILE_REQUEST_PATTERN = /\b(?:which\s+files?|what\s+files?|exact\s+files?|exact\s+file\s+paths?|exact\s+file\s+names?|file\s+names?|code\s+paths?|client-side\s+code\s+paths?|cite\s+the\s+exact\s+files?)\b/i;
const EXACT_FILE_LOOKUP_VERB_PATTERN = /\b(?:which|what|exact|cite|name|list|identify|locate|show|enumerate)\b/i;
const EXACT_FILE_TARGET_PATTERN = /\b(?:client-side\s+files?|files?|file\s+paths?|file\s+names?|functions?|code\s+paths?|client-side\s+code\s+paths?)\b/i;
const IMPLEMENTATION_LOOKUP_PATTERN = /\b(?:implement|implements|implemented|define|defines|defined|render|renders|rendered|rendering|path|paths|function|functions|keep|keeps|kept|align|aligned|responsible)\b/i;

export function looksLikeContextDependentPromptSelectionTurn(request: string): boolean {
  const normalized = request.trim().toLowerCase();
  if (!normalized || normalized.length > 64) return false;
  return /^(?:yes|yeah|yep|no|nope|ok|okay|sure|actually|instead|use\b|switch\b|continue\b|resume\b|retry\b|again\b|same\b|that\b|those\b|it\b|them\b|this\b)/.test(normalized)
    || /\b(?:that|those|it|them|same\s+(?:one|workspace|session)|again)\b/.test(normalized);
}

export function looksLikePendingActionContextTurn(request: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(request);
  if (!normalized) return false;
  return looksLikeContextDependentPromptSelectionTurn(normalized)
    || /^\/?(?:approve|approved|deny|denied|reject|decline)\b/.test(normalized)
    || /^pending approvals?\??$/.test(normalized)
    || /(?:\bwhat\b|\bwhich\b|\bshow\b|\blist\b|\bare there\b|\bdo i have\b|\bany\b|\bcurrent\b).*(?:\bpending approvals?\b|\bapprovals?\b.*\bpending\b)/.test(normalized)
    || /(?:\bpending approvals?\b|\bapprovals?\b.*\bpending\b).*\b(?:right now|currently|today)\b/.test(normalized)
    || /^(?:did\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task))(?:\s+\w+){0,3}\s+work|what happened(?:\s+(?:with|to|about)\s+(?:that|it|the\s+(?:last|previous)\s+(?:request|task)))?)\??$/.test(normalized)
    || /\bwhat are you waiting for\b/.test(normalized)
    || /\bwhy (?:are you|is this)\s+blocked\b/.test(normalized)
    || /\b(?:use|switch to)\s+(?:codex|claude(?:\s+code)?|gemini(?:\s+cli)?|aider)\b/.test(normalized)
    || /\bcoding backend\b/.test(normalized);
}

export function isConversationTranscriptReferenceRequest(request: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(request);
  if (!normalized) return false;
  return /\b(?:in|from|using)\s+(?:this|the)\s+(?:chat|conversation|thread)\b/.test(normalized)
    || /\byour\s+(?:first|last|previous|earlier)\s+(?:answer|response|reply|message|turn)\b/.test(normalized)
    || /\b(?:first|last|previous|earlier|older)\s+(?:answer|response|reply|message|turn)\b/.test(normalized)
    || /\b(?:based on|using)\s+(?:that|the)\s+(?:answer|response|reply|message|turn)\b/.test(normalized);
}

export function looksLikeStandaloneGreetingTurn(request: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(request);
  if (!normalized || normalized.length > 48) return false;
  return /^(?:hi|hello|hey|hiya|howdy|greetings|good\s+(?:morning|afternoon|evening))(?:[.!?]+)?$/.test(normalized);
}

export function isExplicitComplexPlanningRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  return /\buse (?:your|the) complex[- ]planning path\b/.test(normalized)
    || /\b(?:your|the)\s+complex[- ]planning path\b[^.!?\n]{0,40}\bfor this request\b/.test(normalized)
    || /\b(?:route|send) (?:this|it|the request)?\s*(?:through|to) (?:your |the )?complex[- ]planning path\b/.test(normalized)
    || /\b(?:use|run|route|handle|take)\b[^.!?\n]{0,80}\b(?:dag planner|dag path|planner path)\b/.test(normalized);
}

export function isExplicitRepoPlanningRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  const hasPlanningIntent = /\b(?:implementation|migration|refactor|rollout|execution)\s+plan\b/.test(normalized)
    || /\bwrite\s+an?\s+plan\b/.test(normalized)
    || /\bplan\b/.test(normalized) && /\bbefore editing\b/.test(normalized);
  if (!hasPlanningIntent) return false;
  return /\b(?:this app|this repo|this repository|this workspace|the codebase|the repository|the app)\b/.test(normalized);
}

export function isExplicitRepoInspectionRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;

  const mentionsRepoScope = /\b(?:this repo|this repository|this workspace|the repo|the repository|the codebase|the workspace|repo|repository|codebase)\b/.test(normalized);
  const mentionsCodeArtifact = /\b(?:source|function|class|module|component|symbol)\b/.test(normalized)
    || /(?:^|\s)(?:src|docs|web|scripts|native|policies|skills)\//.test(normalized)
    || /\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|yml|yaml)\b/.test(normalized);
  const asksForFileOrSymbolLocation = /\btell me which files?\b/.test(normalized)
    || /\bwhich files?\b.*\b(?:implement|define|render|handle|contain|route|wire|own|use)\b/.test(normalized)
    || /\bwhere\b.*\bdefined\b/.test(normalized);
  const usesPositiveInspectionVerb = /\b(?:inspect|review|scan|trace|grep)\b/.test(normalized)
    || /\bsearch\s+(?:this|the)?\s*(?:repo|repository|codebase|workspace)\b/.test(normalized)
    || /\bfind\b.*\b(?:in|across)\s+(?:this|the)?\s*(?:repo|repository|codebase|workspace)\b/.test(normalized)
    || /\blook\s+(?:through|in|across|at)\b/.test(normalized);
  const negatesRepoSearch = /\bdo\s+not\s+(?:re-?)?search\b/.test(normalized)
    || /\bwithout\s+(?:re-?)?search(?:ing)?\b/.test(normalized);

  return asksForFileOrSymbolLocation && (mentionsRepoScope || mentionsCodeArtifact)
    || usesPositiveInspectionVerb && !negatesRepoSearch && (mentionsCodeArtifact || asksForFileOrSymbolLocation);
}

export function requestNeedsExactFileReferences(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  const namesExactTargets = EXACT_FILE_LOOKUP_VERB_PATTERN.test(normalized)
    && EXACT_FILE_TARGET_PATTERN.test(normalized);
  return IMPLEMENTATION_LOOKUP_PATTERN.test(normalized)
    && (EXACT_FILE_REQUEST_PATTERN.test(normalized) || namesExactTargets);
}

export function isExplicitWorkspaceScopedRepoWorkRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized || !WORKSPACE_SCOPE_PATTERN.test(normalized)) return false;

  const hasConcreteRepoTarget = CODE_REPO_TARGET_PATTERN.test(normalized)
    || SOURCE_TREE_PATH_PATTERN.test(normalized)
    || REPO_FILE_REFERENCE_PATTERN.test(normalized)
    || (CODING_BACKEND_PATTERN.test(normalized) && CODING_BACKEND_SCOPE_TARGET_PATTERN.test(normalized));
  if (!hasConcreteRepoTarget) return false;

  return REPO_MUTATION_PATTERN.test(normalized)
    || (CODING_BACKEND_PATTERN.test(normalized) && REPO_EXECUTION_PATTERN.test(normalized));
}

export function isExplicitCodingSessionControlRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  if (
    isExplicitRepoInspectionRequest(normalized)
    || isExplicitWorkspaceScopedRepoWorkRequest(normalized)
    || isExplicitCodingExecutionRequest(normalized)
  ) {
    return false;
  }
  return /\bwhat\s+(?:coding\s+)?(?:workspace|session)\b/.test(normalized)
    || /\bwhich\s+(?:coding\s+)?(?:workspace|session)\b/.test(normalized)
    || /\b(?:current|active|attached)\s+(?:coding\s+)?(?:workspace|session)\b/.test(normalized)
    || /\bthis chat\b.*\battached\b/.test(normalized)
    || /\b(?:list|show)\s+(?:my|the)?\s*(?:coding\s+)?(?:workspaces|sessions)\b/.test(normalized)
    || /\b(?:switch|attach|detach|connect|disconnect|create)\b.*\b(?:coding\s+)?(?:workspace|session)\b/.test(normalized)
    || /\b(?:switch|attach)\b.*\bthis chat\b/.test(normalized);
}

export function isExplicitCodingExecutionRequest(content: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  
  const hasCodingTool = /\b(npm|pnpm|yarn|bun|pip|pip3|python|python3|go|cargo|rustc|javac|make|cmake|git|docker|kubectl)\b/i.test(normalized);
  const hasCodingCommand = /\b(install|run|test|build|deploy|ci|add|remove|update|status|diff|commit|push|pull)\b/i.test(normalized);
  
  // Also match "run [anything] in [path]" which is almost always a task
  // Ensure we don't match across sentences by excluding period/newline
  const isRunInPath = /\brun\s+[^.!?\n]+?\s+in\s+[^.!?\n]+?\b/i.test(normalized);
  
  return (hasCodingTool && hasCodingCommand) || isRunInPath;
}
