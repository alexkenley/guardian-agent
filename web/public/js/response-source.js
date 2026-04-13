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

function inferProviderTier(providerName, providerProfileName) {
  const normalized = normalizeProviderIdentity(providerName || providerProfileName);
  if (!normalized) return null;
  if (normalized.startsWith('ollamacloud')) return 'managed_cloud';
  if (normalized.startsWith('ollama')) return 'local';
  if (
    normalized.startsWith('openai')
    || normalized.startsWith('anthropic')
    || normalized.startsWith('groq')
    || normalized.startsWith('mistral')
    || normalized.startsWith('deepseek')
    || normalized.startsWith('together')
    || normalized.startsWith('xai')
    || normalized.startsWith('grok')
    || normalized.startsWith('google')
    || normalized.startsWith('gemini')
  ) {
    return 'frontier';
  }
  return null;
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

function normalizeProviderIdentity(value) {
  return (typeof value === 'string' ? value : '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function formatProviderProfileName(providerName, providerProfileName) {
  const raw = typeof providerProfileName === 'string' ? providerProfileName.trim() : '';
  if (!raw) return '';
  if (normalizeProviderIdentity(providerName) === normalizeProviderIdentity(raw)) return '';
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
  const providerTier = normalizeProviderTier(value?.providerTier)
    || inferProviderTier(providerName, providerProfileName);
  const tier = value?.tier === 'local' || value?.tier === 'external'
    ? value.tier
    : '';
  const model = typeof value?.model === 'string' && value.model.trim()
    ? value.model.trim()
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
  if (model) {
    labelParts.push(model);
  }
  const titleParts = [];
  if (usedFallback) titleParts.push('Guardian retried with an alternate model.');
  if (notice) titleParts.push(notice);
  if (providerProfileName) titleParts.push(`Profile: ${providerProfileName}.`);
  if (model) titleParts.push(`Model: ${model}.`);
  if (tier && tier !== locality) {
    titleParts.push(`Requested ${tier} route.`);
  }
  return {
    locality,
    providerName,
    providerProfileName,
    providerTier,
    model,
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
