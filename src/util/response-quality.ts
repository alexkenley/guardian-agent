/** Detect degraded LLM responses that warrant a fallback retry. */
export function isResponseDegraded(content: string | undefined): boolean {
  if (!content?.trim()) return true;
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const rawToolMarkupPattern = /<\/?tool_result\b|<\/?tool_calls?\b|<\/?tool_call\b/i;
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
  if (rawToolMarkupPattern.test(trimmed)) return true;

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

/**
 * Detect conversational progress updates that narrate future work instead of
 * delivering the requested result. These responses are fluent enough to avoid
 * the degraded-response fallback, but they are still not valid terminal
 * answers for delegated execution.
 */
export function isIntermediateStatusResponse(content: string | undefined): boolean {
  if (!content?.trim()) return false;
  if (isResponseDegraded(content)) return false;

  const normalized = content.trim();
  const lower = normalized.toLowerCase();
  const presentTenseActionStartPattern = /^(?:creating|writing|saving|searching|reviewing|inspecting|checking|loading|reading|looking|listing|appending|continuing|renaming|moving|copying|deleting|running|opening)\b/i;
  if (/<\/?think>/i.test(normalized)) {
    return true;
  }
  if (/<details>\s*<summary>\s*(?:tool calls|raw tool results)/i.test(normalized)) {
    return true;
  }
  const rawLines = normalized.split(/\r?\n/);
  const lines = rawLines
    .map((line) => line.replace(/^[>\-\d.*#\s`]+/, '').replace(/[*_`]/g, '').trim())
    .filter(Boolean);
  const lineCount = lines.length;
  const finalLine = lines.at(-1) ?? '';
  const finalLineLooksOngoing = !!finalLine
    && finalLine.length <= 180
    && presentTenseActionStartPattern.test(finalLine)
    && !/\b(?:done|completed|created|wrote|written|saved|updated|ready|waiting for approval|approval required|blocked|failed|unable|cannot|can't|will not|won't|do not|don't)\b/i.test(finalLine);
  if (finalLineLooksOngoing && lineCount <= 8) {
    return true;
  }
  if (normalized.length > 320 || lineCount > 5) {
    return false;
  }

  const continuationMarkers = [
    /^(?:ok(?:ay)?|sure|alright|all right|right)[,:\s-]*(?:i['’]ll|i will|let me)\b/i,
    /^(?:i['’]ll|i will|let me)\b/i,
    presentTenseActionStartPattern,
    /\b(?:now|next|first)\s+(?:i['’]ll|i will|let me)\b/i,
    /\b(?:let me|i['’]ll|i will)\s+(?:inspect|check|review|look|find|apply|restart|resume|write|create|read|use|try|run|continue|proceed)\b/i,
  ];
  const terminalMarkers = [
    /\b(?:done|completed|created|wrote|written|saved|updated|ready|waiting for approval|approval required|blocked|failed|unable|cannot|can't|will not|won't|do not|don't|exact stdout|file content|what changed|results?:|summary:|report created)\b/i,
    /^(?:#{1,6}\s|\d+\.\s|- )/m,
  ];

  const looksOngoing = continuationMarkers.some((pattern) => pattern.test(normalized))
    || (/\b(?:before|then)\b/.test(lower) && /\b(?:i['’]ll|i will|let me)\b/.test(lower));
  if (!looksOngoing) return false;
  if (terminalMarkers.some((pattern) => pattern.test(normalized))) return false;
  return true;
}
