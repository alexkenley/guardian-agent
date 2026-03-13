import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inferMimeType, parseDocument } from './document-parser.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('inferMimeType', () => {
  it('maps known extensions', () => {
    expect(inferMimeType('test.md')).toBe('text/markdown');
    expect(inferMimeType('test.html')).toBe('text/html');
    expect(inferMimeType('test.txt')).toBe('text/plain');
    expect(inferMimeType('test.json')).toBe('application/json');
    expect(inferMimeType('test.py')).toBe('text/x-python');
    expect(inferMimeType('test.ts')).toBe('text/typescript');
    expect(inferMimeType('test.pdf')).toBe('application/pdf');
  });

  it('defaults to text/plain for unknown extensions', () => {
    expect(inferMimeType('test.xyz')).toBe('text/plain');
    expect(inferMimeType('test')).toBe('text/plain');
  });
});

describe('parseDocument', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `search-parser-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses plain text files', async () => {
    const path = join(tmpDir, 'test.txt');
    await writeFile(path, 'Hello world\nThis is a test.');
    const result = await parseDocument(path);
    expect(result.text).toBe('Hello world\nThis is a test.');
    expect(result.mimeType).toBe('text/plain');
    expect(result.title).toBe('Hello world');
  });

  it('parses markdown files and extracts title', async () => {
    const path = join(tmpDir, 'test.md');
    await writeFile(path, '# My Document\n\nSome content here.');
    const result = await parseDocument(path);
    expect(result.text).toContain('My Document');
    expect(result.title).toBe('My Document');
    expect(result.mimeType).toBe('text/markdown');
  });

  it('strips HTML tags from HTML files', async () => {
    const path = join(tmpDir, 'test.html');
    await writeFile(path, '<html><head><title>Page Title</title></head><body><p>Hello &amp; world</p></body></html>');
    const result = await parseDocument(path);
    expect(result.text).toContain('Hello & world');
    expect(result.text).not.toContain('<p>');
    expect(result.title).toBe('Page Title');
    expect(result.mimeType).toBe('text/html');
  });

  it('strips script and style tags from HTML', async () => {
    const path = join(tmpDir, 'test.html');
    await writeFile(path, '<html><script>alert("xss")</script><style>body{}</style><p>Content</p></html>');
    const result = await parseDocument(path);
    expect(result.text).toContain('Content');
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('body{}');
  });

  it('ignores HTML comments and decodes named and numeric entities once', async () => {
    const path = join(tmpDir, 'entities.html');
    await writeFile(
      path,
      '<html><head><title>Alpha &#x26; Beta</title></head><body><!--hidden--><p>&amp;lt;safe&amp;gt; &#39;quote&#39; &#x1F600;</p></body></html>',
    );
    const result = await parseDocument(path);
    expect(result.title).toBe('Alpha & Beta');
    expect(result.text).toContain('&lt;safe&gt;');
    expect(result.text).toContain('\'quote\'');
    expect(result.text).toContain('😀');
    expect(result.text).not.toContain('hidden');
    expect(result.text).not.toContain('<p>');
  });

  it('skips nested script and style content without dropping surrounding text', async () => {
    const path = join(tmpDir, 'nested.html');
    await writeFile(
      path,
      '<div>before<script>const tpl = "<script>ignore()</script>";</script><style>.x::before{content:"<b>bad</b>";}</style><span>after</span></div>',
    );
    const result = await parseDocument(path);
    expect(result.text).toBe('before after');
  });

  it('handles empty files', async () => {
    const path = join(tmpDir, 'empty.txt');
    await writeFile(path, '');
    const result = await parseDocument(path);
    expect(result.text).toBe('');
    expect(result.title).toBeNull();
  });

  it('parses code files as text', async () => {
    const path = join(tmpDir, 'test.ts');
    await writeFile(path, 'export function hello(): string { return "world"; }');
    const result = await parseDocument(path);
    expect(result.mimeType).toBe('text/typescript');
    expect(result.text).toContain('export function hello');
  });
});
