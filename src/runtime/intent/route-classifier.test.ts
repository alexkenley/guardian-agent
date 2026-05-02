import { describe, expect, it } from 'vitest';
import { buildIntentGatewayContextSections } from './route-classifier.js';

describe('buildIntentGatewayContextSections', () => {
  it('includes configured document source routing context without raw paths', () => {
    const context = buildIntentGatewayContextSections({
      content: 'Search product-docs for billing JSON files.',
      channel: 'web',
      configuredSearchSources: [
        {
          id: 'product-docs',
          name: 'Product Docs',
          type: 'directory',
          enabled: true,
          indexedSearchAvailable: true,
          documentCount: 12,
          chunkCount: 44,
        },
        {
          id: 'guardian-repo',
          name: 'Guardian Repo',
          type: 'git',
          enabled: true,
          indexedSearchAvailable: false,
        },
      ],
    }).join('\n');

    expect(context).toContain('Configured document search sources:');
    expect(context).toContain('id=product-docs; name=Product Docs; type=directory; enabled=true; indexedSearchAvailable=true; documents=12; chunks=44');
    expect(context).toContain('id=guardian-repo; name=Guardian Repo; type=git; enabled=true; indexedSearchAvailable=false');
    expect(context).not.toContain('C:\\');
    expect(context).not.toContain('https://');
  });
});
