/**
 * Detect whether the user's message explicitly asks to save/remember something,
 * which is the only case where implicit memory_save tool calls are allowed.
 */
export function shouldAllowImplicitMemorySave(content: string): boolean {
  const lower = content.trim().toLowerCase();
  if (!lower) return false;
  return /\b(remember|memory_save|save (?:this|that|it|these|those|fact|preference|note)|store (?:this|that|it|these|those|fact|preference|note)|keep (?:this|that|it) (?:for later|in mind)|note (?:this|that|it)|commit (?:this|that|it) to memory)\b/.test(lower);
}
