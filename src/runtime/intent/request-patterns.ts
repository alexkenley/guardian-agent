import type { AnswerConstraints } from '../execution/types.js';
import { normalizeIntentGatewayRepairText } from './text.js';

const WORKSPACE_SCOPE_PATTERN = /\b(?:coding\s+workspace|coding\s+session|workspace|session)\b/;
const REPO_MUTATION_PATTERN = /\b(?:create|add|make|write|generate|touch|update|edit|change|modify|fix|patch|rewrite|append|delete|remove)\b/;
const REPO_EXECUTION_PATTERN = /\b(?:run|test|build|lint|check|debug|investigate|inspect|review|search|find|grep)\b/;
const CODING_BACKEND_PATTERN = /\b(?:codex|claude(?:\s+code)?|gemini(?:\s+cli)?|aider)\b/;
const CODE_REPO_TARGET_PATTERN = /\b(?:source|function|class|module|component|symbol|tests?|test suite|unit tests?|build|compile|lint|check|readme)\b/;
const REPO_DOCUMENT_ARTIFACT_PATTERN = /\b(?:(?:technical\s+)?implementation\s+plan|business\s+plan|design\s+(?:doc|docs|document|plan)|architecture\s+(?:doc|docs|document|plan)|requirements?\s+(?:doc|docs|document)|spec(?:ification)?|roadmap|changelog|readme|operator\s+guide|runbook)\b/;
const CODING_BACKEND_SCOPE_TARGET_PATTERN = /\b(?:top-level directory|root directory|workspace root|project root|repo root|directory|folder)\b/;
const SOURCE_TREE_PATH_PATTERN = /(?:^|\s)(?:src|docs|web|scripts|native|policies|skills)\//;
const REPO_FILE_REFERENCE_PATTERN = /\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|yml|yaml|txt|toml)\b/;
const EXACT_FILE_REQUEST_PATTERN = /\b(?:which\s+(?:files?|pages?|modules?|components?)|what\s+(?:files?|pages?|modules?|components?)|exact\s+files?|exact\s+file\s+paths?|exact\s+file\s+names?|file\s+names?|code\s+paths?|client-side\s+code\s+paths?|cite\s+the\s+exact\s+files?)\b/i;
const EXACT_FILE_LOOKUP_VERB_PATTERN = /\b(?:which|what|exact|cite|name|list|identify|locate|show|enumerate)\b/i;
const EXACT_FILE_TARGET_PATTERN = /\b(?:web\s+pages?|client-side\s+files?|files?|file\s+paths?|file\s+names?|pages?|modules?|components?|functions?|code\s+paths?|client-side\s+code\s+paths?)\b/i;
const IMPLEMENTATION_LOOKUP_PATTERN = /\b(?:implement|implements|implemented|define|defines|defined|render|renders|rendered|rendering|consume|consumes|consumed|consumer|consumers|import|imports|imported|use|uses|used|using|path|paths|function|functions|keep|keeps|kept|align|aligned|responsible)\b/i;

const RAW_SECRET_DISCLOSURE_VERB_PATTERN = /\b(?:print|show|reveal|display|dump|extract|exfiltrate|leak|return|give|read|open|cat|list)\b/;
const RAW_SECRET_TARGET_PATTERN = /\b(?:api\s*keys?|tokens?|bearer\s*tokens?|telegram\s*(?:bot\s*)?tokens?|provider\s+credentials?|credential\s+values?|credentials?|secrets?|secret\s+store|access\s+tokens?|refresh\s+tokens?)\b/;
const RAW_SECRET_QUALIFIER_PATTERN = /\b(?:raw|actual|full|unredacted|plain\s*text|plaintext|values?)\b/;
const RAW_SECRET_PROTECTED_SOURCE_PATTERN = /(?:^|[\\/\s.])\.guardianagent\b|\bguardianagent\b.{0,80}\b(?:config|configuration|credential|credentials|secrets?)\b|\b(?:config|configuration|credential|credentials?)\s+files?\b/;
const RAW_SECRET_REDACTION_REQUEST_PATTERN = /\b(?:redacted|redact|masked|mask|sanitize|sanitized|without\s+(?:printing|revealing|showing|displaying)\s+(?:raw\s+)?(?:secrets?|credentials?|tokens?|api\s*keys?))\b/;
const NEGATED_RAW_SECRET_DISCLOSURE_CLAUSE_PATTERN = /\b(?:(?:do\s+not|don't|never)\s+(?:expose|include|print|show|reveal|display|dump|extract|exfiltrate|leak|return|give|read|open|cat|list)|without\s+(?:exposing|including|printing|revealing|showing|displaying|dumping|extracting|exfiltrating|leaking|returning|giving|reading|opening|listing))\b[^.!?\n]{0,180}\b(?:raw\s+)?(?:api\s*keys?|bearer\s*tokens?|telegram\s*(?:bot\s*)?tokens?|provider\s+credentials?|credential\s+values?|credentials?|secrets?|secret\s+store|access\s+tokens?|refresh\s+tokens?)\b[^.!?\n]*/g;
const EXTERNAL_INSTRUCTION_SOURCE_PATTERN = /\b(?:web\s*(?:page|site)?|website|url|link|external\s+(?:content|page|site)|browser\s+content|page|document|search\s+result|https?:\/\/)\b/;
const FOLLOW_EXTERNAL_INSTRUCTION_PATTERN = /\b(?:follow|obey|execute|apply|use|honou?r|trust)\b[^.!?\n]{0,120}\b(?:instructions?|prompt|system\s+prompt|rules?|commands?)\b/;
const PROMPT_INJECTION_PAYLOAD_PATTERN = /\b(?:reveal|print|show|display|dump|include|expose|leak|return)\b[^.!?\n]{0,120}\b(?:secrets?|system\s+prompt|developer\s+(?:message|instructions?)|hidden\s+(?:prompt|instructions?)|api\s*keys?|tokens?|credentials?)\b|\b(?:change|modify|replace|override|ignore|bypass)\b[^.!?\n]{0,120}\b(?:system\s+prompt|instructions?|rules?|guardrails?|policy|policies)\b/;
const DIRECT_REPLY_LEAD_PATTERN = /^(?:reply|respond|answer|say)\b/;
const DIRECT_REPLY_EXACTNESS_PATTERN = /\b(?:exactly|no other text|only this|just this|marker)\b/;
const DIRECT_REPLY_INSTRUCTION_PATTERN = /(?:^|[.!?]\s+)(?:reply|respond|answer|say)\s+(?:with\s+)?(?:exactly|only|just)\b/;
const DIRECT_REPLY_CONTEXT_CLAUSE_PATTERN = /^(?:for\s+(?:this|the)\s+(?:chat|conversation|thread)\s+only|in\s+(?:this|the)\s+(?:chat|conversation|thread)\s+only|the\s+temporary\s+marker\s+is\b|temporary\s+marker\s+is\b|do\s+not\s+save\s+(?:it|this|that|the\s+marker)\s+to\s+memory\b|don'?t\s+save\s+(?:it|this|that|the\s+marker)\s+to\s+memory\b|context\b|note\b)/;

export function looksLikeContextDependentPromptSelectionTurn(request: string): boolean {
  const normalized = request.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(?:thing|one|item|request|topic|subject)\s+(?:we\s+)?(?:talked|discussed|mentioned)\s+(?:about\s+)?(?:before|earlier|previously)\b/.test(normalized)) {
    return true;
  }
  if (normalized.length > 64) return false;
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

export function looksLikeSelfContainedDirectAnswerTurn(request: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(request);
  if (!normalized || normalized.length > 240) return false;
  if (DIRECT_REPLY_LEAD_PATTERN.test(normalized)) {
    return DIRECT_REPLY_EXACTNESS_PATTERN.test(normalized);
  }

  const directInstruction = normalized.match(DIRECT_REPLY_INSTRUCTION_PATTERN);
  if (!directInstruction || !DIRECT_REPLY_EXACTNESS_PATTERN.test(normalized.slice(directInstruction.index))) {
    return false;
  }

  const contextPrefix = normalized.slice(0, directInstruction.index).trim();
  if (!contextPrefix) return true;
  return contextPrefix
    .split(/[.!?]+|\s+and\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .every((clause) => DIRECT_REPLY_CONTEXT_CLAUSE_PATTERN.test(clause));
}

export function isRawCredentialDisclosureRequest(request: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(request);
  if (!normalized || RAW_SECRET_REDACTION_REQUEST_PATTERN.test(normalized)) return false;
  const positiveCandidate = normalized
    .replace(NEGATED_RAW_SECRET_DISCLOSURE_CLAUSE_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!positiveCandidate) return false;
  if (!RAW_SECRET_DISCLOSURE_VERB_PATTERN.test(positiveCandidate)) return false;
  if (!RAW_SECRET_TARGET_PATTERN.test(positiveCandidate)) return false;
  return RAW_SECRET_QUALIFIER_PATTERN.test(positiveCandidate)
    || RAW_SECRET_PROTECTED_SOURCE_PATTERN.test(positiveCandidate);
}

export function isExplicitExternalPromptInjectionRequest(request: string | undefined): boolean {
  const normalized = normalizeIntentGatewayRepairText(request);
  if (!normalized) return false;
  return EXTERNAL_INSTRUCTION_SOURCE_PATTERN.test(normalized)
    && FOLLOW_EXTERNAL_INSTRUCTION_PATTERN.test(normalized)
    && PROMPT_INJECTION_PAYLOAD_PATTERN.test(normalized);
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
  const mentionsCodeArtifact = /\b(?:source|function|class|module|component|symbols?)\b/.test(normalized)
    || /(?:^|\s)(?:src|docs|web|scripts|native|policies|skills)\//.test(normalized)
    || /\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|yml|yaml)\b/.test(normalized);
  const asksForFileOrSymbolLocation = /\btell me which files?\b/.test(normalized)
    || /\bwhich files?\b.*\b(?:implement|define|render|handle|contain|route|wire|own|use)\b/.test(normalized)
    || /\bfind\s+(?:the\s+)?files?\b.*\b(?:implement|define|render|handle|contain|route|wire|own|use)\b/.test(normalized)
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
    || REPO_DOCUMENT_ARTIFACT_PATTERN.test(normalized)
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

const SYMBOL_REQUEST_PATTERN = /\b(?:functions?|types?|classes?|symbols?|interfaces?|methods?|variables?|constants?|enums?)\b/i;
const READONLY_MODIFIER_PATTERN = /\b(?:do\s+not\s+edit|don'?t\s+edit|without\s+editing|read[\s-]*only|no\s+(?:editing|modifications?|changes?|writes?))\b/i;
const IMPLEMENTATION_QUEST_PATTERN = /\b(?:which|what)\s+.*\b(?:implement|define|defines|defined|render|renders|rendered|consume|consumes|consumer|consumers|import|imports|imported|use|uses|used|responsible|own|handles?)\b/i;
const COMMA_SEPARATED_FILE_PATHS_PATTERN = /\bcomma[-\s]separated\b[^.!?\n]{0,120}\b(?:files?|file\s+paths?|paths?|relative\s+file\s+paths?)\b|\b(?:files?|file\s+paths?|paths?|relative\s+file\s+paths?)\b[^.!?\n]{0,120}\bcomma[-\s]separated\b/i;
const STRICT_OUTPUT_ONLY_PATTERN = /\b(?:reply|respond|answer|return)\b[^.!?\n]{0,80}\b(?:only|exactly|with\s+only)\b|\b(?:and\s+)?no\s+other\s+text\b|\bonly\s+(?:the\s+)?(?:marker|answer|file\s+paths?|paths?|comma[-\s]separated)/i;

export function deriveAnswerConstraints(content: string | undefined): AnswerConstraints {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return {};

  const constraints: AnswerConstraints = {};

  if (requestNeedsExactFileReferences(content)) {
    constraints.requiresImplementationFiles = true;
  }

  if (SYMBOL_REQUEST_PATTERN.test(normalized)) {
    constraints.requiresSymbolNames = true;
  }

  if (READONLY_MODIFIER_PATTERN.test(normalized)) {
    constraints.readonly = true;
  }

  if (IMPLEMENTATION_QUEST_PATTERN.test(normalized)) {
    constraints.requiresImplementationFiles = true;
  }

  if (COMMA_SEPARATED_FILE_PATHS_PATTERN.test(normalized)) {
    constraints.commaSeparatedFilePaths = true;
    constraints.requiresImplementationFiles = true;
  }

  if (STRICT_OUTPUT_ONLY_PATTERN.test(normalized)) {
    constraints.strictOutputOnly = true;
  }

  return constraints;
}
