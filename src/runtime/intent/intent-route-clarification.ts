import {
  isExplicitAutomationAuthoringRequest,
  isExplicitAutomationControlRequest,
} from './entity-resolvers/automation.js';
import {
  isExplicitCodingExecutionRequest,
  isExplicitCodingSessionControlRequest,
  isExplicitRepoInspectionRequest,
  isExplicitRepoPlanningRequest,
  isExplicitWorkspaceScopedRepoWorkRequest,
} from './request-patterns.js';
import { normalizeIntentGatewayRepairText } from './text.js';
import type { IntentGatewayDecision, IntentGatewayRecord, IntentGatewayRoute } from './types.js';

const AUTOMATION_NOUN_PATTERN = /\b(?:automation|automations|workflow|workflows|scheduled automation|scheduled task|assistant automation)\b/;
const AUTOMATION_CREATE_PATTERN = /\b(?:create|build|set up|setup|make|configure|automate|save)\b/;
const AUTOMATION_UPDATE_PATTERN = /\b(?:edit|update|change|modify|rename|enable|disable|run|delete|remove|inspect|show|list)\b/;

const SESSION_SIGNAL_PATTERN = /\b(?:session|sessions|workspace|workspaces|attached|attach|detached|detach|active|current workspace|current session|this chat)\b/;
const CODING_WORK_SIGNAL_PATTERN = /\b(?:repo|repository|codebase|source|file|files|function|class|module|symbol|path|paths|implement|review|inspect|search|grep|debug|refactor|fix|test|build|run)\b/;
const STRONG_REPO_SCOPE_PATTERN = /\b(?:repo|repository|codebase)\b/;

const UI_SURFACE_SIGNAL_PATTERN = /\b(?:dashboard|page|tab|panel|screen|portal|site)\b/;
const INTERNAL_GUARDIAN_SIGNAL_PATTERN = /\b(?:guardian|automations|config|system|control plane|guardian chat)\b/;
const EXTERNAL_WEBSITE_SIGNAL_PATTERN = /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|org|net|io|dev|app|ai)\b|external website|website|web site|url|browser|github|gitlab|bitbucket)\b/;

export interface IntentRouteClarificationOption {
  value: string;
  label: string;
  description?: string;
}

export interface IntentRouteClarification {
  prompt: string;
  options: IntentRouteClarificationOption[];
  candidateRoutes: IntentGatewayRoute[];
}

export function deriveIntentRouteClarification(input: {
  content: string;
  decision: Pick<IntentGatewayDecision, 'route' | 'confidence' | 'turnRelation'>;
  mode?: IntentGatewayRecord['mode'];
}): IntentRouteClarification | null {
  if (input.decision.turnRelation === 'clarification_answer' || input.decision.turnRelation === 'correction') {
    return null;
  }

  const normalized = normalizeIntentGatewayRepairText(input.content);
  if (!normalized) return null;

  return deriveCodingScopeClarification(normalized, input.decision)
    ?? deriveAutomationClarification(normalized, input.decision, input.mode)
    ?? deriveUiVsBrowserClarification(normalized, input.decision, input.mode);
}

function deriveCodingScopeClarification(
  normalized: string,
  decision: Pick<IntentGatewayDecision, 'route' | 'confidence'>,
): IntentRouteClarification | null {
  if (decision.route !== 'coding_task' && decision.route !== 'coding_session_control') {
    return null;
  }
  if (isStrongExplicitRepoWorkRequest(normalized)
    || isExplicitRepoInspectionRequest(normalized)
    || isExplicitRepoPlanningRequest(normalized)
    || isExplicitWorkspaceScopedRepoWorkRequest(normalized)
    || isExplicitCodingExecutionRequest(normalized)
    || isExplicitCodingSessionControlRequest(normalized)) {
    return null;
  }
  if (!SESSION_SIGNAL_PATTERN.test(normalized) || !CODING_WORK_SIGNAL_PATTERN.test(normalized)) {
    return null;
  }
  return {
    prompt: 'Do you want me to inspect or work inside the repo, or do you want me to manage the current coding workspace/session?',
    options: [
      {
        value: 'coding_task',
        label: 'Repo work',
        description: 'Inspect, search, review, or change code in the workspace repo.',
      },
      {
        value: 'coding_session_control',
        label: 'Workspace/session control',
        description: 'Check, list, switch, attach, or manage the coding workspace/session itself.',
      },
    ],
    candidateRoutes: ['coding_task', 'coding_session_control'],
  };
}

function deriveAutomationClarification(
  normalized: string,
  decision: Pick<IntentGatewayDecision, 'route' | 'confidence'>,
  mode: IntentGatewayRecord['mode'] | undefined,
): IntentRouteClarification | null {
  if (decision.route !== 'automation_authoring' && decision.route !== 'automation_control') {
    return null;
  }
  if (!AUTOMATION_NOUN_PATTERN.test(normalized)) {
    return null;
  }

  const hasCreateLanguage = AUTOMATION_CREATE_PATTERN.test(normalized);
  const hasUpdateLanguage = AUTOMATION_UPDATE_PATTERN.test(normalized);
  if (hasCreateLanguage && hasUpdateLanguage) {
    return {
      prompt: 'Do you want me to create a new automation, or update an existing automation?',
      options: [
        {
          value: 'automation_authoring',
          label: 'Create new automation',
          description: 'Build a new automation or workflow from the request.',
        },
        {
          value: 'automation_control',
          label: 'Edit existing automation',
          description: 'Inspect, rename, run, enable, disable, or update an existing automation.',
        },
      ],
      candidateRoutes: ['automation_authoring', 'automation_control'],
    };
  }

  const explicitAuthoring = isExplicitAutomationAuthoringRequest(normalized);
  const explicitControl = isExplicitAutomationControlRequest(normalized);
  if (explicitAuthoring !== explicitControl) {
    return null;
  }
  if (!(hasCreateLanguage && hasUpdateLanguage)
    && !shouldUseConfidenceBackstop(decision.confidence, mode)) {
    return null;
  }

  return {
    prompt: 'Do you want me to create a new automation, or update an existing automation?',
    options: [
      {
        value: 'automation_authoring',
        label: 'Create new automation',
        description: 'Build a new automation or workflow from the request.',
      },
      {
        value: 'automation_control',
        label: 'Edit existing automation',
        description: 'Inspect, rename, run, enable, disable, or update an existing automation.',
      },
    ],
    candidateRoutes: ['automation_authoring', 'automation_control'],
  };
}

function deriveUiVsBrowserClarification(
  normalized: string,
  decision: Pick<IntentGatewayDecision, 'route' | 'confidence'>,
  mode: IntentGatewayRecord['mode'] | undefined,
): IntentRouteClarification | null {
  if (decision.route !== 'ui_control' && decision.route !== 'browser_task') {
    return null;
  }
  if (!UI_SURFACE_SIGNAL_PATTERN.test(normalized)) {
    return null;
  }
  if (INTERNAL_GUARDIAN_SIGNAL_PATTERN.test(normalized) || EXTERNAL_WEBSITE_SIGNAL_PATTERN.test(normalized)) {
    return null;
  }
  if (!shouldUseConfidenceBackstop(decision.confidence, mode)) {
    return null;
  }
  return {
    prompt: 'Do you mean a Guardian page, or an external website?',
    options: [
      {
        value: 'ui_control',
        label: 'Guardian page',
        description: 'Open or navigate an internal Guardian page, tab, or dashboard surface.',
      },
      {
        value: 'browser_task',
        label: 'External website',
        description: 'Open or inspect a website outside Guardian.',
      },
    ],
    candidateRoutes: ['ui_control', 'browser_task'],
  };
}

function shouldUseConfidenceBackstop(
  confidence: IntentGatewayDecision['confidence'],
  mode: IntentGatewayRecord['mode'] | undefined,
): boolean {
  return confidence !== 'high'
    || mode === 'json_fallback'
    || mode === 'route_only_fallback'
    || mode === 'confirmation';
}

function isStrongExplicitRepoWorkRequest(normalized: string): boolean {
  return STRONG_REPO_SCOPE_PATTERN.test(normalized)
    || /\bwhich files?\b/.test(normalized)
    || /\b[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|py|go|java|yml|yaml)\b/.test(normalized)
    || /\b(?:file|files|function|class|module|symbol|path|paths)\b/.test(normalized);
}
