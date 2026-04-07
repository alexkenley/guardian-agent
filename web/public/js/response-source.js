function normalizeLocality(locality) {
  return locality === 'local' || locality === 'external' || locality === 'fallback'
    ? locality
    : null;
}

function normalizeProviderTier(tier) {
  return tier === 'local' || tier === 'managed_cloud' || tier === 'frontier'
    ? tier
    : null;
}

function formatTierLabel(tier, locality) {
  if (tier === 'managed_cloud') return 'managed cloud';
  if (tier === 'frontier') return 'frontier';
  if (tier === 'local') return 'local';
  return locality;
}

function formatProviderName(providerName) {
  return providerName.replaceAll('_', ' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatProviderProfileName(providerName, providerProfileName) {
  const raw = typeof providerProfileName === 'string' ? providerProfileName.trim() : '';
  if (!raw) return '';
  const normalizedProviderName = typeof providerName === 'string' ? providerName.trim() : '';
  if (!normalizedProviderName) {
    return raw.replaceAll('_', ' ');
  }
  const variants = [
    normalizedProviderName,
    normalizedProviderName.replaceAll('_', '-'),
    normalizedProviderName.replaceAll('_', ' '),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  for (const variant of variants) {
    const simplified = raw.replace(new RegExp(`^${escapeRegExp(variant)}(?:[-_\\s]+)?`, 'i'), '').trim();
    if (simplified && simplified.toLowerCase() !== raw.toLowerCase()) {
      return simplified.replaceAll('_', ' ');
    }
  }
  return raw.replaceAll('_', ' ');
}

export function describeResponseSource(value) {
  const locality = normalizeLocality(value?.locality) || 'system';
  const providerName = typeof value?.providerName === 'string' && value.providerName.trim()
    ? value.providerName.trim()
    : '';
  const providerProfileName = typeof value?.providerProfileName === 'string' && value.providerProfileName.trim()
    ? value.providerProfileName.trim()
    : '';
  const providerTier = normalizeProviderTier(value?.providerTier);
  const tier = value?.tier === 'local' || value?.tier === 'external'
    ? value.tier
    : '';
  const usedFallback = value?.usedFallback === true;
  const notice = typeof value?.notice === 'string' && value.notice.trim()
    ? value.notice.trim()
    : '';
  const labelParts = [formatTierLabel(providerTier, locality)];
  if (providerName) {
    labelParts.push(formatProviderName(providerName));
  }
  const profileLabel = formatProviderProfileName(providerName, providerProfileName);
  if (profileLabel && profileLabel.toLowerCase() !== formatProviderName(providerName).toLowerCase()) {
    labelParts.push(profileLabel);
  }
  if (usedFallback) {
    labelParts.push('fallback');
  }
  const titleParts = [];
  if (notice) titleParts.push(notice);
  if (providerProfileName) titleParts.push(`Profile: ${providerProfileName}.`);
  if (tier && tier !== locality) {
    titleParts.push(`Requested ${tier} route.`);
  }
  return {
    locality,
    providerName,
    providerProfileName,
    providerTier,
    tier,
    usedFallback,
    notice,
    label: labelParts.join(' · '),
    title: titleParts.join(' '),
  };
}

export function createResponseSourceBadge(value) {
  const source = describeResponseSource(value);
  const badge = document.createElement('div');
  badge.className = 'chat-msg-source';
  badge.textContent = source.label;
  if (source.title) {
    badge.title = source.title;
  }
  return badge;
}

export function renderResponseSourceBadgeMarkup(value, esc, escAttr) {
  const source = describeResponseSource(value);
  const titleAttr = source.title ? ` title="${escAttr(source.title)}"` : '';
  return `<div class="chat-msg-source"${titleAttr}>${esc(source.label)}</div>`;
}
