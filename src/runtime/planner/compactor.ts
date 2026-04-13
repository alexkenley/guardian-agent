import type { PlanNode } from './types.js';

export class ContextCompactor {
  constructor(
    private readonly chatFn: (messages: any[], options?: any) => Promise<any>
  ) {}

  async compactNodeResult(node: PlanNode): Promise<string | undefined> {
    if (!node.result) return undefined;

    const rawResultStr = typeof node.result === 'string' 
      ? node.result 
      : JSON.stringify(node.result);

    // Skip compaction if the result is already relatively small
    if (rawResultStr.length < 500) {
      return undefined;
    }

    const prompt = `
You are the Guardian Agent Context Compactor.
A sub-task within a complex Execution Plan has completed, and its raw output is large.
To prevent prompt bloat for future planning and execution steps, you must compress the output into a dense "insight node".
Retain all factual insights, data shaping results, file paths, and identifiers. Discard boilerplate, formatting, and noisy logs.

Sub-Task Description: ${node.description}

Raw Execution Result:
${rawResultStr}

Provide a dense, highly compressed summary of the result:
`;

    try {
      const response = await this.chatFn([
        { role: 'system', content: 'You are a context compaction engine that produces dense insight summaries.' },
        { role: 'user', content: prompt }
      ]);
      const content = response?.content;
      return content?.trim() || undefined;
    } catch (err) {
      console.error('ContextCompactor: Failed to compact result:', err);
      return undefined;
    }
  }
}
