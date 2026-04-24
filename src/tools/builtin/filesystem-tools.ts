import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { scanWriteContent } from '../../guardian/argument-sanitizer.js';
import { inferMimeType, parseDocument } from '../../search/document-parser.js';
import { ToolRegistry } from '../registry.js';
import type { ToolExecutionRequest } from '../types.js';

interface FilesystemToolRegistrarContext {
  registry: ToolRegistry;
  requireString: (value: unknown, field: string) => string;
  requireStringAllowEmpty: (value: unknown, field: string) => string;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
  guardAction: (request: ToolExecutionRequest, action: string, details: Record<string, unknown>) => void;
  resolveAllowedPath: (inputPath: string, request?: Partial<ToolExecutionRequest>) => Promise<string>;
  maxSearchResults: number;
  maxSearchFiles: number;
  maxSearchFileBytes: number;
  maxReadBytes: number;
}

export const CRITICAL_FILESYSTEM_PATH_PATTERNS = [
  /(^|[\\\/])\.git([\\\/]|$)/i,
  /(^|[\\\/])\.github([\\\/]|$)/i,
  /(^|[\\\/])\.guardianagent([\\\/]|$)/i,
  /(^|[\\\/])\.env(\..*)?$/i,
];

export function isCriticalFilesystemPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return CRITICAL_FILESYSTEM_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getCriticalFilesystemPathBlockReason(path: string, action: string): string | null {
  if (!isCriticalFilesystemPath(path)) {
    return null;
  }
  return `Action '${action}' blocked: path '${path}' is a critical repository metadata directory or sensitive configuration file.`;
}

export function registerBuiltinFilesystemTools(context: FilesystemToolRegistrarContext): void {
  const {
    requireString,
    requireStringAllowEmpty,
    asString,
    asNumber,
    maxSearchResults,
    maxSearchFiles,
    maxSearchFileBytes,
    maxReadBytes,
  } = context;

  function checkCriticalPath(path: string, action: string): { success: boolean; error?: string } {
    const reason = getCriticalFilesystemPathBlockReason(path, action);
    if (reason) {
      return {
        success: false,
        error: reason,
      };
    }
    return { success: true };
  }

  async function resolveNonCriticalPath(
    rawPath: string,
    action: string,
    request?: Partial<ToolExecutionRequest>,
  ): Promise<{ safePath?: string; error?: string }> {
    const rawCheck = checkCriticalPath(rawPath, action);
    if (!rawCheck.success) {
      return { error: rawCheck.error };
    }

    const safePath = await context.resolveAllowedPath(rawPath, request);
    const resolvedCheck = checkCriticalPath(safePath, action);
    if (!resolvedCheck.success) {
      return { error: resolvedCheck.error };
    }

    return { safePath };
  }
  context.registry.register(
    {
      name: 'fs_list',
      description: 'List files and directories inside allowed workspace paths. Returns up to 500 entries with name and type. Security: path validated against allowedPaths roots. Requires read_files capability.',
      shortDescription: 'List files and directories. Returns entries with name and type.',
      risk: 'read_only',
      category: 'filesystem',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list.' },
        },
      },
    },
    async (args, request) => {
      const rawPath = asString(args.path, '.');
      const safePath = await context.resolveAllowedPath(rawPath, request);
      context.guardAction(request, 'read_file', { path: rawPath });
      const entries = await readdir(safePath, { withFileTypes: true });
      return {
        success: true,
        output: {
          path: safePath,
          entries: entries.slice(0, 500).map((entry) => {
            const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
            return `[${type}] ${entry.name}`;
          }),
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_search',
      description: 'Recursively search files by name or content within allowed paths. Modes: name, content, or auto. Configurable depth, file count, and result limits. Security: path validated against allowedPaths roots. Requires read_files capability.',
      shortDescription: 'Search files by name or content. Modes: name, content, auto.',
      risk: 'read_only',
      category: 'filesystem',
      examples: [
        { input: { query: 'config', mode: 'name' }, description: 'Find files with "config" in the name' },
        { input: { query: 'TODO', mode: 'content', maxResults: 10 }, description: 'Search file contents for TODO comments' },
      ],
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Root directory to search (default: current workspace root).' },
          query: { type: 'string', description: 'Search term for file names and/or content.' },
          mode: { type: 'string', description: "Search mode: 'name', 'content', or 'auto' (default: name)." },
          maxResults: { type: 'number', description: `Maximum matches to return (max ${maxSearchResults}).` },
          maxDepth: { type: 'number', description: 'Maximum directory recursion depth (max 40).' },
          maxFiles: { type: 'number', description: `Maximum files to scan before stopping (max ${maxSearchFiles}).` },
          maxFileBytes: { type: 'number', description: `Maximum bytes per file for content search (max ${maxSearchFileBytes}).` },
          caseSensitive: { type: 'boolean', description: 'Enable case-sensitive matching.' },
        },
        required: ['query'],
      },
    },
    async (args, request) => {
      const rawPath = asString(args.path, '.');
      const query = requireString(args.query, 'query').trim();
      const mode = asString(args.mode, 'name').trim().toLowerCase();
      if (!['name', 'content', 'auto'].includes(mode)) {
        return {
          success: false,
          error: "Invalid mode. Use 'name', 'content', or 'auto'.",
        };
      }

      const safeRoot = await context.resolveAllowedPath(rawPath, request);
      context.guardAction(request, 'read_file', { path: rawPath, query });

      const maxResults = Math.max(1, Math.min(maxSearchResults, asNumber(args.maxResults, 25)));
      const maxDepth = Math.max(0, Math.min(40, asNumber(args.maxDepth, 12)));
      const maxFiles = Math.max(50, Math.min(maxSearchFiles, asNumber(args.maxFiles, 20_000)));
      const maxFileBytes = Math.max(256, Math.min(maxSearchFileBytes, asNumber(args.maxFileBytes, 120_000)));
      const caseSensitive = !!args.caseSensitive;
      const normalizedQuery = caseSensitive ? query : query.toLowerCase();
      const searchNames = mode === 'name' || mode === 'auto';
      const searchContent = mode === 'content' || mode === 'auto';

      const matches: Array<{
        path: string;
        relativePath: string;
        matchType: 'name' | 'content';
        lineNumber?: number;
        snippet?: string;
      }> = [];

      const stack: Array<{ dir: string; depth: number }> = [{ dir: safeRoot, depth: 0 }];
      let scannedDirs = 0;
      let scannedFiles = 0;

      while (stack.length > 0 && matches.length < maxResults && scannedFiles < maxFiles) {
        const current = stack.pop();
        if (!current) break;

        let entries;
        try {
          entries = await readdir(current.dir, { withFileTypes: true });
        } catch {
          continue;
        }
        scannedDirs += 1;

        for (const entry of entries) {
          if (matches.length >= maxResults || scannedFiles >= maxFiles) break;

          const fullPath = resolve(current.dir, entry.name);
          if (entry.isDirectory()) {
            if (current.depth < maxDepth) {
              stack.push({ dir: fullPath, depth: current.depth + 1 });
            }
            continue;
          }

          if (!entry.isFile()) continue;
          scannedFiles += 1;

          const rel = relative(safeRoot, fullPath);
          const relativePath = rel ? rel.split(sep).join('/') : entry.name;
          const normalizedName = caseSensitive ? entry.name : entry.name.toLowerCase();
          const nameMatched = searchNames && normalizedName.includes(normalizedQuery);

          if (nameMatched) {
            matches.push({
              path: fullPath,
              relativePath,
              matchType: 'name',
            });
            continue;
          }

          if (!searchContent) continue;

          let content: Buffer;
          try {
            content = await readFile(fullPath);
          } catch {
            continue;
          }
          if (content.byteLength > maxFileBytes || looksBinary(content)) {
            continue;
          }

          const text = content.toString('utf-8');
          const haystack = caseSensitive ? text : text.toLowerCase();
          const idx = haystack.indexOf(normalizedQuery);
          if (idx >= 0) {
            matches.push({
              path: fullPath,
              relativePath,
              matchType: 'content',
              lineNumber: countLineNumberAtIndex(text, idx),
              snippet: makeContentSnippet(text, idx, query.length),
            });
          }
        }
      }

      const truncated = stack.length > 0 || scannedFiles >= maxFiles || matches.length >= maxResults;
      return {
        success: true,
        output: {
          root: safeRoot,
          query,
          mode,
          caseSensitive,
          maxResults,
          scannedDirs,
          scannedFiles,
          truncated,
          matches,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_read',
      description: 'Read a file within allowed workspace paths. Text files return raw UTF-8 content. Supported document formats such as PDF return extracted text. Max 1MB returned, truncated if over limit. Security: path validated against allowedPaths roots. Requires read_files capability.',
      shortDescription: 'Read a local file. Returns text content, byte count, truncation status, and MIME type.',
      risk: 'read_only',
      category: 'filesystem',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read.' },
            maxBytes: { type: 'number', description: `Maximum bytes to read (max ${maxReadBytes}).` },
        },
        required: ['path'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const safePath = await context.resolveAllowedPath(rawPath, request);
      context.guardAction(request, 'read_file', { path: rawPath });
      const maxBytes = Math.min(maxReadBytes, Math.max(256, asNumber(args.maxBytes, 256_000)));
      const mimeType = inferMimeType(safePath);

      if (FS_READ_EXTRACTED_MIME_TYPES.has(mimeType)) {
        const parsed = await parseDocument(safePath);
        const truncatedContent = truncateTextToUtf8Bytes(parsed.text, maxBytes);
        return {
          success: true,
          output: {
            path: safePath,
            bytes: (await stat(safePath)).size,
            truncated: truncatedContent.truncated,
            content: truncatedContent.content,
            mimeType,
            title: parsed.title,
          },
        };
      }

      const content = await readFile(safePath);
      const truncated = content.byteLength > maxBytes;
      const slice = truncated ? content.subarray(0, maxBytes) : content;
      return {
        success: true,
        output: {
          path: safePath,
          bytes: content.byteLength,
          truncated,
          content: slice.toString('utf-8'),
          mimeType,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_write',
      description: 'Write or append UTF-8 text to a file within allowed paths. Creates parent directories automatically. Security: path validated against allowedPaths roots. Mutating — requires approval in approve_by_policy mode. Requires write_files capability.',
      shortDescription: 'Write or append text to a file. Creates parent dirs automatically.',
      risk: 'mutating',
      category: 'filesystem',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Content to write.' },
          append: { type: 'boolean', description: 'Append content instead of overwriting.' },
        },
        required: ['path', 'content'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const resolved = await resolveNonCriticalPath(rawPath, 'fs_write', request);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      const content = requireStringAllowEmpty(args.content, 'content');
      const append = !!args.append;
      const contentScan = scanWriteContent(content);
      if (contentScan.secrets.length > 0 || contentScan.pii.length > 0) {
        const findings = [
          ...new Set(contentScan.secrets.map((match) => match.pattern)),
          ...new Set(contentScan.pii.map((match) => match.label)),
        ];
        return {
          success: false,
          error: `Write content rejected by security policy: ${findings.join(', ')}.`,
        };
      }
      const safePath = resolved.safePath!;
      context.guardAction(request, 'write_file', { path: rawPath, content });
      await mkdir(dirname(safePath), { recursive: true });
      if (append) {
        await appendFile(safePath, content, 'utf-8');
      } else {
        await writeFile(safePath, content, 'utf-8');
      }
      const details = await stat(safePath);
      return {
        success: true,
        output: {
          path: safePath,
          append,
          size: details.size,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_mkdir',
      description: 'Create a directory within allowed paths. Supports recursive creation and validates path allowlist. Mutating — requires approval in approve_by_policy mode. Requires write_files capability.',
      shortDescription: 'Create a directory. Supports recursive creation.',
      risk: 'mutating',
      category: 'filesystem',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create.' },
          recursive: { type: 'boolean', description: 'Create parent directories if missing (default true).' },
        },
        required: ['path'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const resolved = await resolveNonCriticalPath(rawPath, 'fs_mkdir', request);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      const recursive = args.recursive !== false;
      const safePath = resolved.safePath!;
      context.guardAction(request, 'write_file', { path: rawPath, content: '[mkdir]' });
      await mkdir(safePath, { recursive });
      return {
        success: true,
        output: {
          path: safePath,
          recursive,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_delete',
      description: 'Delete a file or empty directory within allowed paths. For non-empty directories, set recursive to true. Security: path validated against allowedPaths roots. Mutating — requires approval in approve_by_policy mode. Requires write_files capability.',
      shortDescription: 'Delete a file or empty directory within allowed paths.',
      risk: 'mutating',
      category: 'filesystem',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file or directory to delete.' },
          recursive: { type: 'boolean', description: 'Recursively delete directory contents (default false). Required for non-empty directories.' },
        },
        required: ['path'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const resolved = await resolveNonCriticalPath(rawPath, 'fs_delete', request);
      if (resolved.error) {
        return { success: false, error: resolved.error };
      }
      const recursive = !!args.recursive;
      const safePath = resolved.safePath!;
      context.guardAction(request, 'write_file', { path: rawPath, content: '[delete]' });
      const details = await stat(safePath);
      const isDir = details.isDirectory();
      if (isDir) {
        await rm(safePath, { recursive });
      } else {
        await unlink(safePath);
      }
      return {
        success: true,
        output: {
          path: safePath,
          type: isDir ? 'directory' : 'file',
          recursive,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_move',
      description: 'Move or rename a file or directory within allowed paths. Both source and destination must be inside allowed roots. Security: paths validated against allowedPaths roots. Mutating — requires approval in approve_by_policy mode. Requires write_files capability.',
      shortDescription: 'Move or rename a file or directory within allowed paths.',
      risk: 'mutating',
      category: 'filesystem',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file or directory path.' },
          destination: { type: 'string', description: 'Destination path (new name or new location).' },
        },
        required: ['source', 'destination'],
      },
    },
    async (args, request) => {
      const rawSource = requireString(args.source, 'source');
      const rawDest = requireString(args.destination, 'destination');
      const resolvedSource = await resolveNonCriticalPath(rawSource, 'fs_move', request);
      if (resolvedSource.error) return { success: false, error: resolvedSource.error };
      const resolvedDest = await resolveNonCriticalPath(rawDest, 'fs_move', request);
      if (resolvedDest.error) return { success: false, error: resolvedDest.error };
      const safeSource = resolvedSource.safePath!;
      const safeDest = resolvedDest.safePath!;
      context.guardAction(request, 'write_file', { path: rawSource, content: `[move → ${rawDest}]` });
      await mkdir(dirname(safeDest), { recursive: true });
      await rename(safeSource, safeDest);
      return {
        success: true,
        output: {
          source: safeSource,
          destination: safeDest,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'fs_copy',
      description: 'Copy a file within allowed paths. Both source and destination must be inside allowed roots. Security: paths validated against allowedPaths roots. Mutating — requires approval in approve_by_policy mode. Requires write_files capability.',
      shortDescription: 'Copy a file within allowed paths.',
      risk: 'mutating',
      category: 'filesystem',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source file path.' },
          destination: { type: 'string', description: 'Destination file path.' },
        },
        required: ['source', 'destination'],
      },
    },
    async (args, request) => {
      const rawSource = requireString(args.source, 'source');
      const rawDest = requireString(args.destination, 'destination');
      const resolvedSource = await resolveNonCriticalPath(rawSource, 'fs_copy', request);
      if (resolvedSource.error) return { success: false, error: resolvedSource.error };
      const resolvedDest = await resolveNonCriticalPath(rawDest, 'fs_copy', request);
      if (resolvedDest.error) return { success: false, error: resolvedDest.error };
      const safeSource = resolvedSource.safePath!;
      const safeDest = resolvedDest.safePath!;
      context.guardAction(request, 'write_file', { path: rawDest, content: `[copy from ${rawSource}]` });
      await mkdir(dirname(safeDest), { recursive: true });
      await copyFile(safeSource, safeDest);
      const details = await stat(safeDest);
      return {
        success: true,
        output: {
          source: safeSource,
          destination: safeDest,
          size: details.size,
        },
      };
    },
  );

  context.registry.register(
    {
      name: 'doc_create',
      description: 'Create a document file from plain text or markdown template. Supports markdown and plain formats. Security: path validated against allowedPaths roots. Mutating — requires approval. Requires write_files capability.',
      shortDescription: 'Create a document file from text or markdown content.',
      risk: 'mutating',
      category: 'filesystem',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target file path.' },
          title: { type: 'string', description: 'Document title.' },
          content: { type: 'string', description: 'Body content.' },
          template: { type: 'string', description: 'Template name: markdown or plain.' },
        },
        required: ['path'],
      },
    },
    async (args, request) => {
      const rawPath = requireString(args.path, 'path');
      const title = asString(args.title, 'Document');
      const content = asString(args.content, '');
      const template = asString(args.template, 'markdown').toLowerCase();
      const safePath = await context.resolveAllowedPath(rawPath, request);
      const finalBody = template === 'plain'
        ? `${title}\n\n${content}\n`
        : `# ${title}\n\n${content}\n`;
      const contentScan = scanWriteContent(finalBody);
      if (contentScan.secrets.length > 0 || contentScan.pii.length > 0) {
        const findings = [
          ...new Set(contentScan.secrets.map((match) => match.pattern)),
          ...new Set(contentScan.pii.map((match) => match.label)),
        ];
        return {
          success: false,
          error: `Document content rejected by security policy: ${findings.join(', ')}.`,
        };
      }
      context.guardAction(request, 'write_file', { path: rawPath, content: finalBody });
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, finalBody, 'utf-8');
      return {
        success: true,
        output: {
          path: safePath,
          template,
          bytes: Buffer.byteLength(finalBody, 'utf-8'),
        },
      };
    },
  );
}

const FS_READ_EXTRACTED_MIME_TYPES = new Set([
  'application/pdf',
]);

function truncateTextToUtf8Bytes(value: string, maxBytes: number): { content: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(value, 'utf-8');
  if (totalBytes <= maxBytes) {
    return { content: value, truncated: false };
  }

  let usedBytes = 0;
  const parts: string[] = [];
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (usedBytes + charBytes > maxBytes) break;
    parts.push(char);
    usedBytes += charBytes;
  }

  return {
    content: parts.join(''),
    truncated: true,
  };
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.byteLength, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function makeContentSnippet(text: string, matchIndex: number, queryLength: number): string {
  const radius = 80;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + queryLength + radius);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`;
}

function countLineNumberAtIndex(text: string, matchIndex: number): number {
  let lineNumber = 1;
  const end = Math.max(0, Math.min(matchIndex, text.length));
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}
