import type { ToolJobRecord } from './types.js';

export function parseToolJobOutputPreview(resultPreview: string | undefined): unknown {
  if (!resultPreview) {
    return undefined;
  }
  try {
    return JSON.parse(resultPreview);
  } catch {
    return undefined;
  }
}

export function buildToolResultPayloadFromJob(
  job: Pick<ToolJobRecord, 'status' | 'resultPreview' | 'error'> | null | undefined,
): Record<string, unknown> {
  if (!job) {
    return { success: false, message: 'Job not found' };
  }
  if (job.status === 'succeeded') {
    const output = parseToolJobOutputPreview(job.resultPreview);
    if (output !== undefined) {
      return { success: true, output };
    }
    return {
      success: true,
      message: job.resultPreview || 'Executed successfully.',
    };
  }
  return {
    success: false,
    error: job.error || 'Failed or denied.',
  };
}
