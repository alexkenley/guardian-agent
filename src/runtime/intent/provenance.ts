import type {
  IntentGatewayDecisionProvenance,
  IntentGatewayEntities,
  IntentGatewayProvenanceSource,
  IntentGatewayRecord,
} from './types.js';

const ENTITY_KEYS = [
  'automationName',
  'newAutomationName',
  'automationReadView',
  'manualOnly',
  'scheduled',
  'enabled',
  'uiSurface',
  'urls',
  'query',
  'path',
  'sessionTarget',
  'codeSessionResource',
  'emailProvider',
  'mailboxReadMode',
  'calendarTarget',
  'calendarWindowDays',
  'personalItemType',
  'codingBackend',
  'codingBackendRequested',
  'codingRemoteExecRequested',
  'codingRunStatusCheck',
  'toolName',
  'profileId',
  'command',
  'searchSourceId',
  'searchSourceName',
  'searchSourceType',
] as const satisfies ReadonlyArray<keyof IntentGatewayEntities>;

export function classifierProvenanceSourceForMode(
  mode: IntentGatewayRecord['mode'],
): IntentGatewayProvenanceSource {
  switch (mode) {
    case 'confirmation':
      return 'classifier.confirmation';
    case 'json_fallback':
      return 'classifier.json_fallback';
    case 'route_only_fallback':
      return 'classifier.route_only_fallback';
    case 'primary':
    default:
      return 'classifier.primary';
  }
}

export function normalizeIntentGatewayProvenanceSource(
  value: unknown,
): IntentGatewayProvenanceSource | undefined {
  switch (value) {
    case 'classifier.primary':
    case 'classifier.json_fallback':
    case 'classifier.route_only_fallback':
    case 'classifier.confirmation':
    case 'resolver.email':
    case 'resolver.coding':
    case 'resolver.personal_assistant':
    case 'resolver.automation':
    case 'resolver.provider_config':
    case 'resolver.tool_inventory':
    case 'resolver.clarification':
    case 'repair.structured':
    case 'repair.automation_name':
    case 'derived.workload':
      return value;
    default:
      return undefined;
  }
}

export function normalizeIntentGatewayDecisionProvenance(
  value: unknown,
): IntentGatewayDecisionProvenance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const entities = normalizeIntentGatewayEntityProvenance(record.entities);
  const normalized: IntentGatewayDecisionProvenance = {
    ...(normalizeIntentGatewayProvenanceSource(record.route)
      ? { route: normalizeIntentGatewayProvenanceSource(record.route)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.operation)
      ? { operation: normalizeIntentGatewayProvenanceSource(record.operation)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.resolvedContent)
      ? { resolvedContent: normalizeIntentGatewayProvenanceSource(record.resolvedContent)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.executionClass)
      ? { executionClass: normalizeIntentGatewayProvenanceSource(record.executionClass)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.preferredTier)
      ? { preferredTier: normalizeIntentGatewayProvenanceSource(record.preferredTier)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.requiresRepoGrounding)
      ? { requiresRepoGrounding: normalizeIntentGatewayProvenanceSource(record.requiresRepoGrounding)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.requiresToolSynthesis)
      ? { requiresToolSynthesis: normalizeIntentGatewayProvenanceSource(record.requiresToolSynthesis)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.requireExactFileReferences)
      ? { requireExactFileReferences: normalizeIntentGatewayProvenanceSource(record.requireExactFileReferences)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.expectedContextPressure)
      ? { expectedContextPressure: normalizeIntentGatewayProvenanceSource(record.expectedContextPressure)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.preferredAnswerPath)
      ? { preferredAnswerPath: normalizeIntentGatewayProvenanceSource(record.preferredAnswerPath)! }
      : {}),
    ...(normalizeIntentGatewayProvenanceSource(record.simpleVsComplex)
      ? { simpleVsComplex: normalizeIntentGatewayProvenanceSource(record.simpleVsComplex)! }
      : {}),
    ...(entities ? { entities } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeIntentGatewayEntityProvenance(
  value: unknown,
): IntentGatewayDecisionProvenance['entities'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    ENTITY_KEYS.flatMap((key) => {
      const source = normalizeIntentGatewayProvenanceSource(record[key]);
      return source ? [[key, source]] : [];
    }),
  ) as Partial<Record<keyof IntentGatewayEntities, IntentGatewayProvenanceSource>>;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
