import { describe, expect, it } from 'vitest';
import {
  buildFileReadSetArtifact,
  buildSearchResultSetArtifact,
  type ExecutionArtifact,
  type SynthesisDraftContent,
} from './graph-artifacts.js';
import {
  buildGraphWriteSpecSynthesisMessages,
  buildGroundedSynthesisLedgerArtifact,
  buildGroundedSynthesisMessages,
  completeGraphWriteSpecSynthesisNode,
  createGroundedSynthesisDraftArtifact,
  parseGraphWriteSpecCandidate,
  validateGroundedSynthesisDraft,
} from './synthesis-node.js';

describe('grounded synthesis node', () => {
  it('builds a no-tools synthesis prompt from typed artifacts', () => {
    const search = buildSearchArtifact();
    const read = buildReadArtifact();
    const ledger = buildGroundedSynthesisLedgerArtifact({
      graphId: 'graph-1',
      nodeId: 'node-1',
      artifactId: 'ledger-1',
      sourceArtifacts: [search, read],
      createdAt: 120,
    });

    expect(ledger?.artifactType).toBe('EvidenceLedger');

    const messages = buildGroundedSynthesisMessages({
      request: 'Where is direct reasoning timeline ingestion implemented?',
      sourceArtifacts: [search, read],
      ledgerArtifact: ledger,
      completedToolCalls: 2,
      workspaceRoot: 'S:/Development/GuardianAgent',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('No tools are available for this node');
    expect(messages[0].content).toContain('deterministic graph state decides completion');
    expect(messages[1].content).toContain('evidenceLedgerArtifactId: ledger-1');
    expect(messages[1].content).toContain('[artifact:search-1] SearchResultSet');
    expect(messages[1].content).toContain('src/runtime/run-timeline.ts:585');
  });

  it('validates synthesis draft citations against artifact ids and refs', () => {
    const search = buildSearchArtifact();
    const read = buildReadArtifact();
    const draft = createGroundedSynthesisDraftArtifact({
      graphId: 'graph-1',
      nodeId: 'node-2',
      artifactId: 'draft-1',
      content: 'RunTimelineStore ingests execution graph events.',
      sourceArtifacts: [search, read],
      createdAt: 130,
    });

    expect(draft.validation).toEqual({
      valid: true,
      missingArtifactIds: [],
      invalidRefs: [],
    });

    const invalidDraft: ExecutionArtifact<SynthesisDraftContent> = {
      ...draft.artifact,
      content: {
        ...draft.artifact.content,
        citedArtifactIds: ['search-1', 'missing-artifact'],
        citations: [
          { artifactId: 'search-1', refs: ['src/runtime/run-timeline.ts:585', 'src/runtime/other.ts:1'] },
          { artifactId: 'missing-artifact', refs: ['src/runtime/direct-reasoning-mode.ts:1'] },
        ],
      },
    };

    expect(validateGroundedSynthesisDraft({
      draft: invalidDraft,
      sourceArtifacts: [search, read],
    })).toEqual({
      valid: false,
      missingArtifactIds: ['missing-artifact'],
      invalidRefs: [{ artifactId: 'search-1', refs: ['src/runtime/other.ts:1'] }],
    });
  });

  it('builds write-spec synthesis prompts and artifacts from typed evidence', () => {
    const search = buildSearchArtifact();
    const read = buildReadArtifact();
    const ledger = buildGroundedSynthesisLedgerArtifact({
      graphId: 'graph-1',
      nodeId: 'node-synthesize',
      artifactId: 'ledger-1',
      sourceArtifacts: [search, read],
      createdAt: 120,
    });
    const messages = buildGraphWriteSpecSynthesisMessages({
      request: 'Update the target file.',
      sourceArtifacts: [search, read],
      ledgerArtifact: ledger,
      workspaceRoot: 'S:/Development/GuardianAgent',
    });

    expect(messages[messages.length - 1].content).toContain('Return only a JSON object with this exact shape');
    expect(parseGraphWriteSpecCandidate(JSON.stringify({
      path: 'tmp/example.txt',
      content: 'hello',
      append: false,
      summary: 'Write the example file.',
    }))).toEqual({
      path: 'tmp/example.txt',
      content: 'hello',
      append: false,
      summary: 'Write the example file.',
    });

    const completed = completeGraphWriteSpecSynthesisNode({
      graphId: 'graph-1',
      nodeId: 'node-synthesize',
      candidateContent: JSON.stringify({
        path: 'tmp/example.txt',
        content: 'hello',
        append: false,
        summary: 'Write the example file.',
      }),
      sourceArtifacts: [search, read],
      ledgerArtifact: ledger,
      createdAt: 140,
    });

    expect(completed?.draft.artifact.artifactId).toBe('graph-1:node-synthesize:draft');
    expect(completed?.writeSpec.artifactId).toBe('graph-1:node-synthesize:write-spec');
    expect(completed?.writeSpec.content).toMatchObject({
      operation: 'write_file',
      path: 'tmp/example.txt',
      content: 'hello',
      append: false,
    });
    expect(completed?.writeSpec.content.sourceArtifactIds).toContain('ledger-1');
    expect(completeGraphWriteSpecSynthesisNode({
      graphId: 'graph-1',
      nodeId: 'node-synthesize',
      candidateContent: '{"path":"","content":"","append":false}',
      sourceArtifacts: [search],
      createdAt: 140,
    })).toBeNull();
  });
});

function buildSearchArtifact(): ExecutionArtifact {
  return buildSearchResultSetArtifact({
    graphId: 'graph-1',
    nodeId: 'node-1',
    artifactId: 'search-1',
    query: 'ingestExecutionGraphEvent',
    matches: [{
      relativePath: 'src/runtime/run-timeline.ts',
      line: 585,
      snippet: 'ingestExecutionGraphEvent(event)',
    }],
    createdAt: 100,
  });
}

function buildReadArtifact(): ExecutionArtifact {
  return buildFileReadSetArtifact({
    graphId: 'graph-1',
    nodeId: 'node-1',
    artifactId: 'read-1',
    path: 'src/runtime/run-timeline.ts',
    content: 'export class RunTimelineStore {\n  ingestExecutionGraphEvent() {}\n}',
    createdAt: 110,
  });
}
