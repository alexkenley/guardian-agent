/**
 * In-process tool registry.
 */

import type { ToolDefinition, ToolHandler } from './types.js';

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .map((entry) => entry.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Return only tools that are NOT deferred (always-loaded). */
  listAlwaysLoaded(): ToolDefinition[] {
    return this.listDefinitions().filter((def) => !def.deferLoading);
  }

  /** Search tools by keyword match against name + description. */
  searchTools(query: string, maxResults: number = 10): ToolDefinition[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const scored: Array<{ def: ToolDefinition; score: number }> = [];
    for (const { definition: def } of this.tools.values()) {
      const haystack = `${def.name} ${def.description} ${def.shortDescription ?? ''} ${def.category ?? ''}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (def.name.toLowerCase().includes(term)) score += 3;
        else if (def.category?.toLowerCase().includes(term)) score += 2;
        else if (haystack.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ def, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.def);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
}
