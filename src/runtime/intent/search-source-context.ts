import type { GuardianAgentConfig } from '../../config/types.js';
import type { SearchStatusResponse } from '../../search/types.js';
import type { IntentGatewaySearchSourceSummary } from './types.js';

export function buildIntentGatewaySearchSourceSummaries(
  config: GuardianAgentConfig | undefined,
  status?: SearchStatusResponse | null,
): IntentGatewaySearchSourceSummary[] {
  const configuredSources = config?.assistant?.tools?.search?.sources ?? [];
  const collectionById = new Map((status?.collections ?? []).map((collection) => [collection.id, collection]));

  return configuredSources
    .filter((source) => source.id.trim() && source.name.trim())
    .slice(0, 20)
    .map((source) => {
      const collection = collectionById.get(source.id);
      return {
        id: source.id,
        name: source.name,
        type: source.type,
        enabled: source.enabled !== false,
        indexedSearchAvailable: source.enabled !== false
          && (source.type === 'directory' || source.type === 'file'),
        ...(collection ? { documentCount: collection.documentCount } : {}),
        ...(collection ? { chunkCount: collection.chunkCount } : {}),
      };
    });
}
