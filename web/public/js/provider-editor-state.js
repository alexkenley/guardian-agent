export function canTestProviderConnection(selectedProfile, providerName) {
  const selected = typeof selectedProfile === 'string' ? selectedProfile.trim() : '';
  const name = typeof providerName === 'string' ? providerName.trim() : '';
  return !!selected && !!name && selected === name;
}
