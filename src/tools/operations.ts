/**
 * Side-effectful tool operations.
 *
 * Handles job storage, execution timing, and approval creation.
 */

import type { ToolJobRecord, ToolResult, ToolRunResponse, ToolExecutionRequest } from './types.js';

/**
 * Enforce MAX_JOBS cap on a jobs array, removing oldest entries.
 * Mutates the array and map in place.
 */
export function enforceJobsCap(
  jobs: ToolJobRecord[],
  jobsById: Map<string, ToolJobRecord>,
  maxJobs: number,
): void {
  while (jobs.length > maxJobs) {
    const removed = jobs.pop();
    if (removed) jobsById.delete(removed.id);
  }
}

/**
 * Execute an approved tool and update the job record with timing/status.
 * Returns the run response.
 */
export async function executeApprovedTool(
  job: ToolJobRecord,
  request: ToolExecutionRequest,
  args: Record<string, unknown>,
  handler: (args: Record<string, unknown>, request: ToolExecutionRequest) => Promise<ToolResult>,
  now: () => number,
): Promise<ToolRunResponse> {
  job.status = 'running';
  job.startedAt = now();

  try {
    const result = await handler(args, request);
    if (!result.success) {
      job.status = 'failed';
      job.error = result.error ?? 'Tool failed.';
      job.completedAt = now();
      job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
      return {
        success: false,
        status: job.status,
        jobId: job.id,
        message: job.error,
      };
    }

    job.status = 'succeeded';
    job.completedAt = now();
    job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
    return {
      success: true,
      status: job.status,
      jobId: job.id,
      message: `Tool '${job.toolName}' completed.`,
      output: result.output,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.status = 'failed';
    job.error = message;
    job.completedAt = now();
    job.durationMs = job.completedAt - (job.startedAt ?? job.createdAt);
    return {
      success: false,
      status: job.status,
      jobId: job.id,
      message: job.error,
    };
  }
}
