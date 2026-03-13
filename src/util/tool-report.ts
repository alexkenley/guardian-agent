const TOOL_REPORT_PATTERN = /\bwhat exact tool(?:s)? did you use\b|\bwhich exact tool(?:s)? did you use\b|\bwhat tool(?:s)? did you use\b|\bwhich tool(?:s)? did you use\b/i;

/** Check whether the user is asking about recently-used tools. */
export function isToolReportQuery(content: string): boolean {
  return TOOL_REPORT_PATTERN.test(content);
}

/** Format a list of job records into a human-readable tool report. */
export function formatToolReport(
  jobs: Array<{
    toolName: string;
    status: string;
    argsRedacted?: Record<string, unknown>;
    completedAt?: number;
    createdAt?: number;
  }>,
): string {
  const now = Date.now();
  const recent = jobs
    .filter((job) => job.status !== 'running' && job.status !== 'pending_approval')
    .filter((job) => now - ((job.completedAt ?? job.createdAt) ?? now) <= 30 * 60_000)
    .slice(0, 6)
    .reverse();

  if (recent.length === 0) return '';

  const lines: string[] = [];
  for (const [index, job] of recent.entries()) {
    lines.push(`${index + 1}. ${job.toolName}`);
    lines.push(`Status: ${job.status}`);
    lines.push('Arguments:');
    lines.push('```json');
    lines.push(JSON.stringify(job.argsRedacted ?? {}, null, 2));
    lines.push('```');
    if (index < recent.length - 1) {
      lines.push('');
    }
  }
  return lines.join('\n');
}
