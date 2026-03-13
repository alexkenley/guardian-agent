/**
 * Document parser — extracts plain text from various file formats.
 *
 * Supports: plain text, markdown, HTML, PDF (optional), DOCX (optional).
 * PDF and DOCX parsing require optional peer dependencies (pdf-parse, mammoth).
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface ParsedDocument {
  text: string;
  title: string | null;
  mimeType: string;
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/xml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.log': 'text/plain',
  '.rst': 'text/x-rst',
  '.tex': 'text/x-tex',
  '.ts': 'text/typescript',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.sh': 'text/x-shellscript',
};

/** Infer MIME type from file extension. */
export function inferMimeType(filepath: string): string {
  return MIME_MAP[extname(filepath).toLowerCase()] ?? 'text/plain';
}

/** Extract a title from the first heading or first line of text. */
function extractTitle(text: string, mimeType: string): string | null {
  if (mimeType === 'text/markdown' || mimeType === 'text/x-rst') {
    const match = text.match(/^#{1,3}\s+(.+)/m);
    if (match) return match[1].trim();
  }
  if (mimeType === 'text/html') {
    const title = findFirstElementInnerHtml(text, 'title');
    if (title) return htmlToText(title).trim() || null;
  }
  // Fall back to first non-empty line
  const firstLine = text.split('\n').find(l => l.trim().length > 0);
  return firstLine ? firstLine.trim().slice(0, 200) : null;
}

/** Strip HTML tags, decode common entities, collapse whitespace. */
function stripHtml(html: string): string {
  return htmlToText(html, { skipTagContent: new Set(['script', 'style']) });
}

/** Try to dynamically import an optional dependency. */
async function tryImport<T>(pkg: string): Promise<T | null> {
  try {
    return (await import(pkg)) as T;
  } catch {
    return null;
  }
}

/** Parse a document file into plain text. */
export async function parseDocument(filepath: string): Promise<ParsedDocument> {
  const mimeType = inferMimeType(filepath);

  if (mimeType === 'application/pdf') {
    return parsePdf(filepath, mimeType);
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return parseDocx(filepath, mimeType);
  }

  // All text-based formats: read as UTF-8
  const raw = await readFile(filepath, 'utf-8');
  let text = raw;

  // Extract title before stripping (HTML title tag is lost after strip)
  const title = extractTitle(raw, mimeType);

  if (mimeType === 'text/html') {
    text = stripHtml(raw);
  }

  return {
    text,
    title: title ?? extractTitle(text, mimeType),
    mimeType,
  };
}

/** Parse PDF using optional pdf-parse dependency. */
async function parsePdf(filepath: string, mimeType: string): Promise<ParsedDocument> {
  const pdfParse = await tryImport<{ default: (buf: Buffer) => Promise<{ text: string; info?: { Title?: string } }> }>('pdf-parse');
  if (!pdfParse) {
    throw new Error('PDF parsing requires the "pdf-parse" package. Install it with: npm install pdf-parse');
  }
  const buf = await readFile(filepath);
  const result = await pdfParse.default(buf);
  return {
    text: result.text,
    title: result.info?.Title ?? extractTitle(result.text, mimeType),
    mimeType,
  };
}

/** Parse DOCX using optional mammoth dependency. */
async function parseDocx(filepath: string, mimeType: string): Promise<ParsedDocument> {
  const mammoth = await tryImport<{ extractRawText: (opts: { path: string }) => Promise<{ value: string }> }>('mammoth');
  if (!mammoth) {
    throw new Error('DOCX parsing requires the "mammoth" package. Install it with: npm install mammoth');
  }
  const result = await mammoth.extractRawText({ path: filepath });
  return {
    text: result.value,
    title: extractTitle(result.value, mimeType),
    mimeType,
  };
}

type HtmlTextOptions = {
  skipTagContent?: ReadonlySet<string>;
};

type ParsedHtmlElement = {
  innerHtml: string;
};

type ParsedHtmlStartTag = {
  tagName: string;
  attributes: Record<string, string>;
  startTagEnd: number;
  isClosing: boolean;
};

const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function htmlToText(value: string, options: HtmlTextOptions = {}): string {
  if (!value) return '';
  const skipTagContent = options.skipTagContent ?? new Set<string>();
  let text = '';
  let index = 0;
  while (index < value.length) {
    const ch = value[index];
    if (ch !== '<') {
      text += ch;
      index += 1;
      continue;
    }

    if (value.startsWith('<!--', index)) {
      const commentEnd = value.indexOf('-->', index + 4);
      index = commentEnd === -1 ? value.length : commentEnd + 3;
      text += ' ';
      continue;
    }

    const tag = parseHtmlStartTag(value, index);
    if (!tag) {
      text += ch;
      index += 1;
      continue;
    }

    const tagName = tag.tagName.toLowerCase();
    if (!tag.isClosing && skipTagContent.has(tagName) && !VOID_HTML_TAGS.has(tagName)) {
      const close = findMatchingClosingTag(value, tagName, tag.startTagEnd + 1);
      index = close === -1 ? value.length : close + (`</${tagName}>`).length;
      text += ' ';
      continue;
    }

    index = tag.startTagEnd + 1;
    text += ' ';
  }

  return decodeHtmlEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
}

function findFirstElementInnerHtml(html: string, tagName: string): string | undefined {
  return findHtmlElementsByTagName(html, tagName)[0]?.innerHtml;
}

function findHtmlElementsByTagName(html: string, tagName: string): ParsedHtmlElement[] {
  const normalizedTag = tagName.toLowerCase();
  const matches: ParsedHtmlElement[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) break;
    const tag = parseHtmlStartTag(html, open);
    if (!tag) {
      index = open + 1;
      continue;
    }
    index = tag.startTagEnd + 1;
    if (tag.isClosing || tag.tagName !== normalizedTag || VOID_HTML_TAGS.has(tag.tagName)) continue;
    const close = findMatchingClosingTag(html, tag.tagName, tag.startTagEnd + 1);
    if (close === -1) continue;
    matches.push({
      innerHtml: html.slice(tag.startTagEnd + 1, close),
    });
  }
  return matches;
}

function parseHtmlStartTag(html: string, start: number): ParsedHtmlStartTag | null {
  if (html[start] !== '<') return null;
  const next = html[start + 1];
  if (!next || next === '!' || next === '?') return null;
  const isClosing = next === '/';
  let cursor = start + (isClosing ? 2 : 1);
  while (cursor < html.length && /\s/.test(html[cursor])) cursor += 1;
  const nameStart = cursor;
  while (cursor < html.length && /[A-Za-z0-9:-]/.test(html[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const tagName = html.slice(nameStart, cursor).toLowerCase();
  const startTagEnd = findTagEnd(html, cursor);
  if (startTagEnd === -1) return null;
  if (isClosing) {
    return { tagName, attributes: {}, startTagEnd, isClosing: true };
  }
  return {
    tagName,
    attributes: parseHtmlAttributes(html.slice(cursor, startTagEnd)),
    startTagEnd,
    isClosing: false,
  };
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const ch = html[index];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '>') return index;
  }
  return -1;
}

function parseHtmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /[\s/]/.test(source[index])) index += 1;
    if (index >= source.length) break;
    const nameStart = index;
    while (index < source.length && /[^\s=/>]/.test(source[index])) index += 1;
    const rawName = source.slice(nameStart, index).trim().toLowerCase();
    if (!rawName) {
      index += 1;
      continue;
    }
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (source[index] !== '=') {
      attributes[rawName] = '';
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) {
      attributes[rawName] = '';
      break;
    }
    const quote = source[index];
    if (quote === '"' || quote === '\'') {
      index += 1;
      const valueStart = index;
      while (index < source.length && source[index] !== quote) index += 1;
      attributes[rawName] = decodeHtmlEntities(source.slice(valueStart, index));
      if (index < source.length) index += 1;
      continue;
    }
    const valueStart = index;
    while (index < source.length && /[^\s>]/.test(source[index])) index += 1;
    attributes[rawName] = decodeHtmlEntities(source.slice(valueStart, index));
  }
  return attributes;
}

function findMatchingClosingTag(html: string, tagName: string, fromIndex: number): number {
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}`;
  let depth = 0;
  let index = fromIndex;
  while (index < html.length) {
    const nextOpen = html.indexOf(openNeedle, index);
    const nextClose = html.indexOf(closeNeedle, index);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const nested = parseHtmlStartTag(html, nextOpen);
      if (nested && !nested.isClosing && nested.tagName === tagName && !VOID_HTML_TAGS.has(tagName)) {
        depth += 1;
        index = nested.startTagEnd + 1;
        continue;
      }
      index = nextOpen + openNeedle.length;
      continue;
    }
    const closing = parseHtmlStartTag(html, nextClose);
    if (!closing || !closing.isClosing || closing.tagName !== tagName) {
      index = nextClose + closeNeedle.length;
      continue;
    }
    if (depth === 0) return nextClose;
    depth -= 1;
    index = closing.startTagEnd + 1;
  }
  return -1;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-fA-F]+|\d+)|[a-zA-Z]+);/g, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'nbsp') return ' ';
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === '#39' || normalized === 'apos') return '\'';
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}
