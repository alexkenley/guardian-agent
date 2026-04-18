import { describe, expect, it } from 'vitest';

import { isIntermediateStatusResponse, isResponseDegraded } from './response-quality.js';

describe('response quality', () => {
  it('treats raw tool markup as degraded output', () => {
    expect(isResponseDegraded('<tool_result>{"success":true}</tool_result>')).toBe(true);
    expect(isResponseDegraded('<tool_calls></tool_calls>')).toBe(true);
  });

  it('treats present-tense mutation narration as intermediate', () => {
    expect(isIntermediateStatusResponse('Creating the file at tmp/trace-smoke.md now.')).toBe(true);
    expect(isIntermediateStatusResponse('Searching the repo for the relevant files now.')).toBe(true);
  });

  it('does not mark completed result summaries as intermediate', () => {
    expect(isIntermediateStatusResponse('Created tmp/trace-smoke.md with the two requested findings.')).toBe(false);
    expect(isIntermediateStatusResponse('Results: inspected src/runtime/intent-gateway.ts and src/supervisor/worker-manager.ts.')).toBe(false);
  });
});
