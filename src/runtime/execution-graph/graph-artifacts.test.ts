import { describe, expect, it } from 'vitest';
import {
  ExecutionArtifactStore,
  artifactRefFromArtifact,
  buildEvidenceLedgerArtifact,
  buildFileReadSetArtifact,
  buildSearchResultSetArtifact,
  buildSynthesisDraftArtifact,
  formatEvidenceArtifactsForSynthesis,
  validateSynthesisDraftArtifact,
} from './graph-artifacts.js';

describe('execution graph artifacts', () => {
  it('stores immutable bounded search and file-read artifacts', () => {
    const store = new ExecutionArtifactStore({ maxArtifacts: 2 });
    const search = buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'artifact-search',
      query: 'RunTimelineStore',
      matches: [{
        relativePath: 'src/runtime/run-timeline.ts',
        line: 585,
        matchType: 'content',
        snippet: 'ingestExecutionGraphEvent(event)',
      }],
      createdAt: 100,
    });
    const read = buildFileReadSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'artifact-read',
      path: 'src/runtime/run-timeline.ts',
      content: 'export class RunTimelineStore {\n  ingestExecutionGraphEvent() {}\n}',
      bytes: 64,
      createdAt: 110,
    });

    store.writeArtifact(search);
    store.writeArtifact(read);

    expect(() => store.writeArtifact(search)).toThrow('Artifact already exists');
    expect(store.getArtifact('artifact-search')?.refs).toEqual(['src/runtime/run-timeline.ts:585']);
    expect(store.getArtifact('artifact-read')?.refs).toEqual(['src/runtime/run-timeline.ts']);
    expect(artifactRefFromArtifact(search)).toMatchObject({
      artifactId: 'artifact-search',
      artifactType: 'SearchResultSet',
      preview: 'Search "RunTimelineStore" returned 1 matches.',
      redactionPolicy: 'bounded_snippet_preview',
    });
  });

  it('formats typed evidence ledgers for no-tools synthesis and validates draft citations', () => {
    const search = buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'artifact-search',
      query: 'direct reasoning',
      matches: [{
        relativePath: 'src/runtime/direct-reasoning-mode.ts',
        line: 577,
        snippet: "input.graphEmitter?.emit('tool_call_started'",
      }],
      createdAt: 100,
    });
    const read = buildFileReadSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'artifact-read',
      path: 'src/runtime/direct-reasoning-mode.ts',
      content: 'export async function executeDirectReasoningToolCall() {}',
      createdAt: 110,
    });
    const ledger = buildEvidenceLedgerArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'artifact-ledger',
      artifacts: [search, read],
      createdAt: 120,
    });
    const promptEvidence = formatEvidenceArtifactsForSynthesis({
      ledger,
      sourceArtifacts: [search, read],
    });

    expect(promptEvidence).toContain('EvidenceLedger artifact: artifact-ledger');
    expect(promptEvidence).toContain('[artifact:artifact-search] SearchResultSet');
    expect(promptEvidence).toContain('src/runtime/direct-reasoning-mode.ts:577');
    expect(promptEvidence).toContain('Excerpt from src/runtime/direct-reasoning-mode.ts:1-1');

    const draft = buildSynthesisDraftArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'artifact-draft',
      content: 'Direct reasoning is implemented in `src/runtime/direct-reasoning-mode.ts`.',
      sourceArtifacts: [search, read, ledger],
      createdAt: 130,
    });

    expect(validateSynthesisDraftArtifact({
      draft,
      sourceArtifacts: [search, read, ledger],
    })).toEqual({ valid: true, missingArtifactIds: [], invalidRefs: [] });
    expect(draft.content.citedArtifactIds).toEqual(['artifact-search', 'artifact-read', 'artifact-ledger']);
  });

  it('bounds retention in the artifact store', () => {
    const store = new ExecutionArtifactStore({ maxArtifacts: 1 });
    store.writeArtifact(buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'old-artifact',
      matches: [],
      createdAt: 100,
    }));
    store.writeArtifact(buildSearchResultSetArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'new-artifact',
      matches: [],
      createdAt: 200,
    }));

    expect(store.getArtifact('old-artifact')).toBeNull();
    expect(store.listArtifacts().map((artifact) => artifact.artifactId)).toEqual(['new-artifact']);
  });
});
