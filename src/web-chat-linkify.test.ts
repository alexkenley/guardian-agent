import { describe, expect, it } from 'vitest';

import { parseSafeTextLinks } from '../web/public/js/chat-linkify.js';

describe('parseSafeTextLinks', () => {
  it('turns plain HTTPS URLs into link tokens without trailing punctuation', () => {
    expect(parseSafeTextLinks('Open https://example.com/docs.')).toEqual([
      { type: 'text', text: 'Open ' },
      { type: 'link', text: 'https://example.com/docs', href: 'https://example.com/docs' },
      { type: 'text', text: '.' },
    ]);
  });

  it('turns markdown links into safe anchor tokens', () => {
    expect(parseSafeTextLinks('Read [the docs](https://example.com/guide?q=1).')).toEqual([
      { type: 'text', text: 'Read ' },
      { type: 'link', text: 'the docs', href: 'https://example.com/guide?q=1' },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves unsafe markdown links as plain text', () => {
    expect(parseSafeTextLinks('Do not [run this](javascript:alert(1)).')).toEqual([
      { type: 'text', text: 'Do not [run this](javascript:alert(1)).' },
    ]);
  });

  it('handles multiple links in list-style assistant output', () => {
    expect(parseSafeTextLinks('- https://example.com\n- [HN](https://news.ycombinator.com)')).toEqual([
      { type: 'text', text: '- ' },
      { type: 'link', text: 'https://example.com', href: 'https://example.com/' },
      { type: 'text', text: '\n- ' },
      { type: 'link', text: 'HN', href: 'https://news.ycombinator.com/' },
    ]);
  });
});
