const RAW_TOOL_MARKUP_PATTERN = /<\/?tool_results?\b|<\/?tool_calls?\b|<\/?tool_call\b|<\/?[a-z][\w.-]*:tool_calls?\b|<\/?invoke\b|<\/?parameter\b|<\|tool_(?:calls_section|call)(?:_begin|_end)?\|>|\[\s*\/?\s*tool_results?\s*\]|\[\s*\/?\s*tool_calls?\s*\]|\[\s*\/?\s*tool_call\s*\]/i;

export function looksLikeRawToolMarkup(content: string | undefined): boolean {
  if (!content?.trim()) return false;
  return RAW_TOOL_MARKUP_PATTERN.test(content);
}

export function lacksUsableAssistantContent(content: string | undefined): boolean {
  if (!content?.trim()) return true;
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const degradedPatterns = [
    'tool round status:',
    'i could not generate',
    'i cannot generate',
    'i can\'t assist with that',
    'i\'m unable to help',
    'i am unable to',
    'i don\'t have the ability',
    'i cannot help with',
    'as an ai, i cannot',
  ];
  if (degradedPatterns.some((pattern) => lower.includes(pattern))) return true;
  if (looksLikeRawToolMarkup(trimmed)) return true;

  if (trimmed.length < 200 && /^\{[\s\S]*\}$/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export function looksLikeOngoingWorkResponse(content: string | undefined): boolean {
  if (!content?.trim()) return false;
  if (lacksUsableAssistantContent(content)) return false;

  const normalized = content.trim();
  const lower = normalized.toLowerCase();
  const presentTenseActionStartPattern = /(?:^|[\.\?!]\s+)(?:attempting|creating|writing|saving|searching|reviewing|inspecting|checking|loading|reading|looking|listing|appending|continuing|renaming|moving|copying|deleting|running|opening)\b/i;
  if (/<\/?think>/i.test(normalized)) {
    return true;
  }
  if (/<details>\s*<summary>\s*(?:tool calls|raw tool results)/i.test(normalized)) {
    return true;
  }

  const explicitContinuationPrompt = /\b(?:let me know if you(?:['’]d like me to| want me to)? continue|say (?:['"]?continue['"]?|['"]?go ahead['"]?)|should i (?:proceed|continue|retry|try|finish|do)|would you like me to (?:continue|retry|try|finish|do|proceed)|want me to (?:continue|retry|try|finish|do|proceed)|shall i (?:continue|retry|try|finish|do|proceed)|next steps needed|proceed with (?:the|those|remaining)? steps?)\b/i;
  if (explicitContinuationPrompt.test(lower)) {
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
    && (presentTenseActionStartPattern.test(finalLine) || explicitContinuationPrompt.test(finalLine))
    && !/\b(?:done|completed|created|wrote|written|saved|updated|ready|waiting for approval|approval required|blocked|failed|unable|cannot|can't|will not|won't|do not|don't)\b/i.test(finalLine);
  if (finalLineLooksOngoing && lineCount <= 12) {
    return true;
  }
  if (normalized.length > 1000 || lineCount > 20) {
    return false;
  }

  const continuationMarkers = [
    /^(?:ok(?:ay)?|sure|alright|all right|right)[,:\s-]*(?:i['’]ll|i will(?!\s+not)|let me)\b/i,
    /^(?:i['’]ll|i will(?!\s+not)|let me)\b/i,
    /^(?:we['’]ll|we will(?!\s+not)|let['’]s)\s+(?:search|fetch|browse|look|find|inspect|review|check|synthesize|analy[sz]e)\b/i,
    /^(?:will perform|will call|will use|will run)\b/i,
    presentTenseActionStartPattern,
    /\b(?:now|next|first|then)\s+(?:i['’]ll|i will(?!\s+not)|let me)\b/i,
    /\b(?:let me|i['’]ll|i will(?!\s+not))\s+(?:inspect|check|review|verify|look|find|search|narrow|apply|restart|resume|write|create|read|use|try|run|continue|proceed|retry|delete|remove|append|save|deliver|provide|return)\b/i,
    /\b(?:proceeding to|moving on to|next step is|i still need to)\b/i,
  ];
  const terminalMarkers = [
    /\b(?:done|completed|created|wrote|written|saved|updated|ready|waiting for approval|approval required|blocked|failed|unable|cannot|can't|will not|won't|do not|don't|exact stdout|file content|what changed|results?:|summary:|report created)\b/i,
    /^(?:#{1,6}\s|\d+\.\s|- )/m,
  ];

  const looksOngoing = continuationMarkers.some((pattern) => pattern.test(normalized))
    || (/\b(?:before|then)\b/.test(lower) && /\b(?:i['’]ll|i will|let me)\b/.test(lower));

  if (!looksOngoing) return false;

  const finalLineMatchesContinuation = continuationMarkers.some((pattern) => pattern.test(finalLine));
  if (finalLineMatchesContinuation) return true;

  if (terminalMarkers.some((pattern) => pattern.test(normalized))) return false;
  return true;
}
