const EXACT_FILE_REQUEST_PATTERN = /\b(?:which\s+files?|what\s+files?|exact\s+files?|exact\s+file\s+paths?|exact\s+file\s+names?|file\s+names?|code\s+paths?|client-side\s+code\s+paths?|cite\s+the\s+exact\s+files?)\b/i;
const EXACT_FILE_LOOKUP_VERB_PATTERN = /\b(?:which|what|exact|cite|name|list|identify|locate|show|enumerate)\b/i;
const EXACT_FILE_TARGET_PATTERN = /\b(?:client-side\s+files?|files?|file\s+paths?|file\s+names?|functions?|code\s+paths?|client-side\s+code\s+paths?)\b/i;
const IMPLEMENTATION_LOOKUP_PATTERN = /\b(?:implement|implements|implemented|define|defines|defined|render|renders|rendered|rendering|path|paths|function|functions|keep|keeps|kept|align|aligned|responsible)\b/i;

function normalizeIntentGatewayRepairText(text) {
  return text ? text.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

function requestNeedsExactFileReferences(content) {
  const normalized = normalizeIntentGatewayRepairText(content);
  if (!normalized) return false;
  const namesExactTargets = EXACT_FILE_LOOKUP_VERB_PATTERN.test(normalized)
    && EXACT_FILE_TARGET_PATTERN.test(normalized);
  return IMPLEMENTATION_LOOKUP_PATTERN.test(normalized)
    && (EXACT_FILE_REQUEST_PATTERN.test(normalized) || namesExactTargets);
}

const req1 = "Inspect this repo and find the exact file and line number where the 'IntentGatewayRecord' interface is defined. You must return the exact file path and line snippet.";
console.log(requestNeedsExactFileReferences(req1));

