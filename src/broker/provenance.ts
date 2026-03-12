import type { ToolCategory } from '../tools/types.js';
import type { ProvenanceMetadata } from './types.js';

/**
 * Assigns taint labels to tool results based on the tool category.
 */
export function assignProvenance(
  toolName: string,
  category: ToolCategory | undefined,
  now: number = Date.now()
): ProvenanceMetadata {
  let source: 'local' | 'remote' = 'local';
  let trust: 'internal' | 'external' = 'internal';
  let tainted = false;

  // External / Remote categories
  if (
    category === 'browser' ||
    category === 'intel' ||
    category === 'forum' ||
    category === 'web' ||
    toolName.startsWith('mcp-') ||
    toolName === 'web_search' ||
    toolName === 'web_fetch' ||
    toolName === 'http_fetch'
  ) {
    source = 'remote';
    trust = 'external';
    tainted = true;
  }

  // Google Workspace / Email
  if (category === 'workspace' || category === 'email' || toolName.startsWith('gws') || toolName.includes('email')) {
    source = 'remote';
    trust = 'external';
    tainted = true;
  }

  return {
    source,
    trust,
    tainted,
    originTool: toolName,
    timestamp: now,
  };
}
