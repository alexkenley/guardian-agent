export function parseStructuredJsonObject<T extends Record<string, unknown>>(content: string): T | null {
  const normalized = normalizeStructuredJsonText(content).trim();
  if (!normalized) return null;

  const unfenced = stripMarkdownJsonFence(normalized);
  const direct = parseJsonObject<T>(unfenced);
  if (direct) return direct;

  const extracted = extractStructuredJsonObject(unfenced);
  if (!extracted) return null;
  return parseJsonObject<T>(extracted);
}

function parseJsonObject<T extends Record<string, unknown>>(value: string): T | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function stripMarkdownJsonFence(content: string): string {
  const fenced = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || content;
}

function normalizeStructuredJsonText(content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'');
}

function extractStructuredJsonObject(content: string): string | null {
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  return content.slice(firstBrace, lastBrace + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
