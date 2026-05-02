import type { SearchMode } from '../../search/types.js';
import type { SearchService } from '../../search/search-service.js';
import { ToolRegistry } from '../registry.js';

interface SearchToolRegistrarContext {
  registry: ToolRegistry;
  getDocSearch: () => SearchService | undefined;
  asString: (value: unknown, fallback?: string) => string;
  asNumber: (value: unknown, fallback: number) => number;
}

export function registerBuiltinSearchTools(context: SearchToolRegistrarContext): void {
  context.registry.register(
    {
      name: 'doc_search',
      description: 'Search configured indexed document-source collections using hybrid search (BM25 keyword + vector similarity). Use the source ID as collection when the routed intent includes searchSourceId. Returns ranked results with file path, title, matched snippet, and surrounding context.',
      shortDescription: 'Search indexed document collections using hybrid search.',
      risk: 'read_only',
      category: 'search',
      deferLoading: true,
      examples: [
        { input: { query: 'deployment guide', mode: 'hybrid' }, description: 'Hybrid search for deployment documentation' },
        { input: { query: 'API authentication', collection: 'docs', limit: 5 }, description: 'Search within a specific collection' },
      ],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query text.' },
          mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], description: "Search mode: 'keyword' (BM25), 'semantic' (vector), 'hybrid' (both, merged via RRF). Default: hybrid." },
          collection: { type: 'string', description: 'Configured document source ID to search within. Omit to search all indexed sources.' },
          limit: { type: 'number', description: 'Maximum results (1-100, default 20).' },
          includeBody: { type: 'boolean', description: 'Include full document body in results.' },
        },
        required: ['query'],
      },
    },
    async (args) => {
      const docSearch = context.getDocSearch();
      if (!docSearch) return { success: false, error: 'Document search not configured.' };
      try {
        const result = await docSearch.search({
          query: context.asString(args.query).trim(),
          mode: args.mode ? context.asString(args.mode) as SearchMode : undefined,
          collection: args.collection ? context.asString(args.collection) : undefined,
          limit: args.limit ? context.asNumber(args.limit, 20) : undefined,
          includeBody: args.includeBody === true,
        });
        return { success: true, output: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  context.registry.register(
    {
      name: 'doc_search_status',
      description: 'Get document search engine status: availability, configured sources, collection statistics, and vector search availability.',
      shortDescription: 'Get document search engine status and source info.',
      risk: 'read_only',
      category: 'search',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    async () => {
      const docSearch = context.getDocSearch();
      if (!docSearch) return { success: false, output: { available: false } };
      try {
        const status = docSearch.status();
        return { success: true, output: status };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  context.registry.register(
    {
      name: 'doc_search_list',
      description: 'List indexed documents from configured document-source collections. Use this when the user asks which files are indexed, asks to list documents by type or extension, or asks for document-source file paths rather than searching inside file contents. Use the routed searchSourceId as collection when present.',
      shortDescription: 'List indexed document files and paths.',
      risk: 'read_only',
      category: 'search',
      deferLoading: true,
      examples: [
        { input: { collection: 'docs', extension: 'json', limit: 50 }, description: 'List indexed JSON files in a document collection' },
        { input: { extension: '.md' }, description: 'List indexed Markdown files across all collections' },
      ],
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Configured document source ID to list from. Omit to list all indexed sources.' },
          extension: { type: 'string', description: 'Optional file extension filter, such as json, .json, md, or txt.' },
          limit: { type: 'number', description: 'Maximum documents to return (1-1000, default 100).' },
        },
      },
    },
    async (args) => {
      const docSearch = context.getDocSearch();
      if (!docSearch) return { success: false, error: 'Document search not configured.' };
      try {
        const result = docSearch.listDocuments({
          collection: args.collection ? context.asString(args.collection) : undefined,
          extension: args.extension ? context.asString(args.extension) : undefined,
          limit: args.limit ? context.asNumber(args.limit, 100) : undefined,
        });
        return { success: true, output: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  context.registry.register(
    {
      name: 'doc_search_reindex',
      description: 'Trigger document indexing and embedding generation. Scans source files, parses content, chunks text, and generates vector embeddings for search.',
      shortDescription: 'Reindex document collections.',
      risk: 'mutating',
      category: 'search',
      deferLoading: true,
      parameters: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Source collection ID to reindex. Omit to reindex all enabled sources.' },
        },
      },
    },
    async (args) => {
      const docSearch = context.getDocSearch();
      if (!docSearch) return { success: false, error: 'Document search not configured.' };
      try {
        const result = await docSearch.reindex(args.collection ? context.asString(args.collection) : undefined);
        return { success: true, output: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
