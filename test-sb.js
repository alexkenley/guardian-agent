function extractSecondBrainTextBody(text) {
  const sayingMatch = text.match(/\b(?:saying|say|says|write|content)\b\s*:?\s*(["'])([\s\S]+?)\1/i);
  if (sayingMatch?.[2]?.trim()) {
    return sayingMatch[2].trim();
  }
  const quotedMatch = text.match(/(["'])([\s\S]+?)\1/);
  const quoted = quotedMatch?.[2]?.trim() ?? '';
  if (quoted) return quoted;

  const unquotedMatch = text.match(/\b(?:reminding\s+me(?:\s+to|\s+that)?|remind\s+me(?:\s+to|\s+that)?|saying(?:\s+that)?|that\s+says|about|to\s+note\s+that)\s+([\s\S]+?)(?:$|\n)/i);
  if (unquotedMatch?.[1]?.trim()) {
    return unquotedMatch[1].trim().replace(/[.!?]+$/, '');
  }

  return '';
}

console.log(extractSecondBrainTextBody("Add a note to my Second Brain reminding me to check the test-second-brain-chat-crud harness later today."));
console.log(extractSecondBrainTextBody("As I said in the request - reminding me to check the test-second-brain-chat-crud harness later today."));
console.log(extractSecondBrainTextBody("Create a note about the meeting tomorrow"));
console.log(extractSecondBrainTextBody("Make a note saying we need more tests"));
