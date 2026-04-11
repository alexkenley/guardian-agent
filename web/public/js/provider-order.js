function configuredProviderBucketRank(entry) {
  if (!entry) return 3;
  if (entry.locality === 'local' || entry.tier === 'local') return 0;
  if (entry.tier === 'managed_cloud') return 1;
  if (entry.tier === 'frontier') return 2;
  return 3;
}

export function sortConfiguredProviders(entries) {
  return [...entries].sort((left, right) => (
    configuredProviderBucketRank(left) - configuredProviderBucketRank(right)
    || String(left?.name || '').localeCompare(String(right?.name || ''))
    || String(left?.provider || '').localeCompare(String(right?.provider || ''))
  ));
}

