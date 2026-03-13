import type { ChatMessage } from '../llm/types.js';

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}[...truncated]`;
}

/**
 * Compact oldest tool-result messages when total character count exceeds
 * 80% of the token budget (approximated as budget * 4 chars per token).
 */
export function compactMessagesIfOverBudget(messages: ChatMessage[], budget: number): void {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  const threshold = budget * 4 * 0.8; // Convert token budget to chars, 80% threshold
  if (totalChars <= threshold) return;

  // Summarize oldest tool result messages to 200 chars each
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.content && msg.content.length > 200) {
      try {
        const parsed = JSON.parse(msg.content) as Record<string, unknown>;
        msg.content = JSON.stringify({
          success: parsed.success,
          status: parsed.status,
          summary: truncateText(String(parsed.message ?? parsed.output ?? ''), 150),
          compacted: true,
        });
      } catch {
        msg.content = truncateText(msg.content, 200);
      }
      // Check if we're now under budget
      const newTotal = messages.reduce((sum, m2) => sum + (m2.content?.length ?? 0), 0);
      if (newTotal <= threshold) return;
    }
  }
}
