/** Detect degraded LLM responses that warrant a fallback retry. */
export function isResponseDegraded(content: string | undefined): boolean {
  if (!content?.trim()) return true;
  const lower = content.trim().toLowerCase();
  const degradedPatterns = [
    'i could not generate',
    'i cannot generate',
    'i can\'t assist with that',
    'i\'m unable to help',
    'i am unable to',
    'i don\'t have the ability',
    'i cannot help with',
    'as an ai, i cannot',
  ];
  return degradedPatterns.some(p => lower.includes(p));
}
