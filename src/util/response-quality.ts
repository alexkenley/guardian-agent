/** Detect degraded LLM responses that warrant a fallback retry. */
export function isResponseDegraded(content: string | undefined): boolean {
  if (!content?.trim()) return true;
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
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
  if (degradedPatterns.some(p => lower.includes(p))) return true;

  // Detect raw JSON output — the model tried to "call" a tool by printing its
  // arguments as text instead of using the proper tool_use format.
  if (trimmed.length < 200 && /^\{[\s\S]*\}$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Not valid JSON — leave it alone.
    }
  }

  return false;
}
