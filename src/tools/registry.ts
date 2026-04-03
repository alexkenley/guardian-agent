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

  /** Search tools by exact name, family prefix, category, then keyword fallback. */
  searchTools(query: string, maxResults: number = 10): ToolDefinition[] {
    const normalizedQuery = query.toLowerCase().trim();
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const scored: Array<{ def: ToolDefinition; score: number }> = [];
    for (const { definition: def } of this.tools.values()) {
      const name = def.name.toLowerCase();
      const category = def.category?.toLowerCase() ?? '';
      const shortDescription = def.shortDescription?.toLowerCase() ?? '';
      const description = def.description.toLowerCase();
      const familyPrefix = name.includes('_') ? name.split('_')[0] : name;
      const haystack = `${name} ${description} ${shortDescription} ${category}`;
      let score = 0;

      if (name === normalizedQuery) score += 1000;
      if (name.startsWith(normalizedQuery)) score += 600;
      if (familyPrefix === normalizedQuery) score += 450;
      if (category === normalizedQuery) score += 400;

      for (const term of terms) {
        if (name === term) score += 220;
        else if (name.startsWith(term)) score += 120;
        else if (name.includes(term)) score += 60;

        if (familyPrefix === term) score += 110;
        if (category === term) score += 100;
        else if (category.includes(term)) score += 45;

        if (shortDescription.includes(term)) score += 20;
        if (description.includes(term)) score += 14;
        if (haystack.includes(term)) score += 4;
      }

      if (score > 0) scored.push({ def, score });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
      .slice(0, maxResults)
      .map((s) => s.def);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
}
