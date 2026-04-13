import type { AssistantResponseStyleConfig } from '../config/types.js';

export function buildResponseStylePrompt(responseStyle?: AssistantResponseStyleConfig): string {
  if (!responseStyle || responseStyle.enabled === false) {
    return '';
  }

  const level = responseStyle?.level ?? 'balanced';
  const lines = [
    'Configured response-style preference:',
    'This is presentation guidance only. Do not omit material risks, caveats, or verification details just to be shorter.',
  ];

  switch (level) {
    case 'light':
      lines.push(
        '- Keep replies a bit tighter and clearer than default.',
        '- Prefer short paragraphs, direct phrasing, and minimal repetition.',
      );
      break;
    case 'strong':
      lines.push(
        '- Minimize token usage aggressively while preserving correctness.',
        '- Lead with the answer, keep supporting detail compact, and avoid filler or throat-clearing.',
        '- Use bullets or short sections only when they materially improve scanability.',
      );
      break;
    case 'balanced':
    default:
      lines.push(
        '- Keep replies concise, well-structured, and high-signal.',
        '- Lead with the result, then brief supporting detail.',
        '- Prefer compact structure without sounding abrupt.',
      );
      break;
  }

  return lines.join('\n');
}
