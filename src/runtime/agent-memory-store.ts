/**
 * Per-agent persistent knowledge base.
 *
 * Each agent gets a markdown file (~/.guardianagent/memory/{agentId}.md)
 * that stores curated long-term memories — facts, preferences, decisions,
 * and summaries that survive context window trimming.
 *
 * Inspired by OpenClaw's MEMORY.md pattern: the agent's knowledge base is
 * always loaded into context, and agents can write to it via memory tools.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Configuration for the agent knowledge base. */
export interface AgentMemoryStoreConfig {
  /** Enable the knowledge base system. */
  enabled: boolean;
  /** Base directory for memory files (default: ~/.guardianagent/memory). */
  basePath?: string;
  /** Maximum characters loaded into LLM context from the knowledge base. */
  maxContextChars: number;
  /** Maximum total file size in characters before pruning warning. */
  maxFileChars: number;
}

export const DEFAULT_MEMORY_STORE_CONFIG: AgentMemoryStoreConfig = {
  enabled: true,
  maxContextChars: 4000,
  maxFileChars: 20000,
};

/** A single memory entry with metadata. */
export interface MemoryEntry {
  /** The memory content. */
  content: string;
  /** When the memory was created (ISO timestamp). */
  createdAt: string;
  /** Optional category/tag for organization. */
  category?: string;
}

/**
 * Persistent per-agent knowledge base backed by markdown files.
 *
 * Memory files use a simple markdown format:
 * ```
 * ## Category Name
 * - Memory fact 1
 * - Memory fact 2
 *
 * ## Another Category
 * - More facts
 * ```
 */
export class AgentMemoryStore {
  private readonly basePath: string;
  private readonly config: AgentMemoryStoreConfig;
  private readonly cache = new Map<string, string>();

  constructor(config: Partial<AgentMemoryStoreConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_STORE_CONFIG, ...config };
    this.basePath = this.config.basePath ?? join(homedir(), '.guardianagent', 'memory');

    if (this.config.enabled) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  /** Resolve the file path for an agent's knowledge base. */
  private filePath(agentId: string): string {
    // Sanitize agent ID to prevent path traversal
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.basePath, `${safe}.md`);
  }

  /**
   * Load the full knowledge base for an agent.
   * Returns empty string if no knowledge base exists.
   */
  load(agentId: string): string {
    if (!this.config.enabled) return '';

    const cached = this.cache.get(agentId);
    if (cached !== undefined) return cached;

    const path = this.filePath(agentId);
    if (!existsSync(path)) {
      this.cache.set(agentId, '');
      return '';
    }

    try {
      const content = readFileSync(path, 'utf-8');
      this.cache.set(agentId, content);
      return content;
    } catch {
      return '';
    }
  }

  /**
   * Load the knowledge base truncated to maxContextChars for LLM context injection.
   * If the file exceeds the limit, a truncation notice is appended.
   */
  loadForContext(agentId: string): string {
    const full = this.load(agentId);
    if (!full) return '';

    if (full.length <= this.config.maxContextChars) return full;

    return full.slice(0, this.config.maxContextChars) + '\n\n[... knowledge base truncated — use memory_search to find specific facts]';
  }

  /**
   * Save the full knowledge base content for an agent, replacing existing.
   */
  save(agentId: string, content: string): void {
    if (!this.config.enabled) return;

    const path = this.filePath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    this.cache.set(agentId, content);
  }

  /**
   * Append a memory entry to the agent's knowledge base.
   * Organizes under category headings if provided.
   */
  append(agentId: string, entry: MemoryEntry): void {
    if (!this.config.enabled) return;

    const existing = this.load(agentId);
    const timestamp = entry.createdAt;
    const line = `- ${entry.content} _(${timestamp})_\n`;

    let newContent: string;
    if (entry.category) {
      const heading = `## ${entry.category}`;
      const headingIndex = existing.indexOf(heading);
      if (headingIndex >= 0) {
        // Find the end of this section (next ## or EOF)
        const nextHeading = existing.indexOf('\n## ', headingIndex + heading.length);
        const insertAt = nextHeading >= 0 ? nextHeading : existing.length;
        newContent = existing.slice(0, insertAt) + line + existing.slice(insertAt);
      } else {
        // Create new section
        newContent = existing + (existing.length > 0 ? '\n' : '') + `${heading}\n${line}`;
      }
    } else {
      newContent = existing + (existing.length > 0 ? '\n' : '') + line;
    }

    this.save(agentId, newContent);
  }

  /**
   * Append a raw text block to the knowledge base (for memory flush summaries).
   */
  appendRaw(agentId: string, text: string): void {
    if (!this.config.enabled) return;

    const path = this.filePath(agentId);
    mkdirSync(dirname(path), { recursive: true });

    const existing = this.load(agentId);
    const separator = existing.length > 0 ? '\n\n' : '';
    const newContent = existing + separator + text;

    writeFileSync(path, newContent, 'utf-8');
    this.cache.set(agentId, newContent);
  }

  /**
   * Search the knowledge base for a query string (case-insensitive substring).
   * Returns matching lines with surrounding context.
   */
  search(agentId: string, query: string): string[] {
    const content = this.load(agentId);
    if (!content) return [];

    const lines = content.split('\n');
    const lowerQuery = query.toLowerCase();
    const matches: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerQuery)) {
        // Include 1 line before and after for context
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 1);
        const contextLines = lines.slice(start, end + 1).join('\n');
        matches.push(contextLines);
      }
    }

    return matches;
  }

  /** Check if an agent has any stored memories. */
  exists(agentId: string): boolean {
    if (!this.config.enabled) return false;
    return existsSync(this.filePath(agentId));
  }

  /** Get the character count of the knowledge base. */
  size(agentId: string): number {
    return this.load(agentId).length;
  }

  /** Clear the in-memory cache (forces re-read from disk on next load). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Delete an agent's knowledge base entirely. */
  delete(agentId: string): boolean {
    if (!this.config.enabled) return false;

    const path = this.filePath(agentId);
    if (!existsSync(path)) return false;

    try {
      const { unlinkSync } = require('node:fs');
      unlinkSync(path);
      this.cache.delete(agentId);
      return true;
    } catch {
      return false;
    }
  }

  /** List all agent IDs that have knowledge bases. */
  listAgents(): string[] {
    if (!this.config.enabled) return [];

    try {
      const { readdirSync } = require('node:fs');
      const files = readdirSync(this.basePath) as string[];
      return files
        .filter((f: string) => f.endsWith('.md'))
        .map((f: string) => f.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }
}
