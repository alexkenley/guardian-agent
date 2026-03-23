export function applyCredentialRefInput(
  target: Record<string, unknown>,
  field: string,
  credentialRef: string | undefined,
  inlineSecretProvided: boolean,
): void {
  if (credentialRef === undefined) return;
  const trimmed = credentialRef.trim();
  if (trimmed) {
    target[field] = trimmed;
    return;
  }
  if (!inlineSecretProvided) {
    delete target[field];
  }
}
