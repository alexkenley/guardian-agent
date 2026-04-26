import type { ChatMessage } from '../../llm/types.js';
import type { IntentGatewayDecision } from '../intent/types.js';
import {
  buildEvidenceLedgerArtifact,
  buildSynthesisDraftArtifact,
  buildWriteSpecArtifact,
  formatEvidenceArtifactsForSynthesis,
  validateSynthesisDraftArtifact,
  type EvidenceLedgerContent,
  type ExecutionArtifact,
  type SynthesisDraftContent,
  type SynthesisDraftValidationResult,
  type WriteSpecContent,
} from './graph-artifacts.js';

export interface GroundedSynthesisPromptInput {
  request: string;
  decision?: IntentGatewayDecision | null;
  workspaceRoot?: string;
  completedToolCalls?: number;
  sourceArtifacts: ExecutionArtifact[];
  ledgerArtifact?: ExecutionArtifact<EvidenceLedgerContent> | null;
  maxEvidenceChars?: number;
  purpose?: 'final_answer' | 'summary' | 'write_spec_candidate';
}

export interface GroundedSynthesisDraftResult {
  artifact: ExecutionArtifact<SynthesisDraftContent>;
  validation: SynthesisDraftValidationResult;
}

export interface GraphWriteSpecCandidate {
  path: string;
  content: string;
  append: boolean;
  summary?: string;
}

export interface GraphWriteSpecSynthesisResult {
  candidate: GraphWriteSpecCandidate;
  draft: GroundedSynthesisDraftResult;
  writeSpec: ExecutionArtifact<WriteSpecContent>;
}

const DEFAULT_SYNTHESIS_EVIDENCE_CHARS = 24_000;

export function buildGroundedSynthesisMessages(input: GroundedSynthesisPromptInput): ChatMessage[] {
  const purpose = input.purpose ?? 'final_answer';
  const evidenceText = input.ledgerArtifact && input.sourceArtifacts.length > 0
    ? formatEvidenceArtifactsForSynthesis({
        ledger: input.ledgerArtifact,
        sourceArtifacts: input.sourceArtifacts,
        maxChars: input.maxEvidenceChars ?? DEFAULT_SYNTHESIS_EVIDENCE_CHARS,
      })
    : '- No typed evidence artifacts were available.';
  return [
    {
      role: 'system',
      content: [
        'You are GuardianAgent grounded-synthesis execution.',
        'No tools are available for this node. Use only the typed evidence artifacts supplied below.',
        'Do not execute actions, approve actions, mark work complete, widen permissions, or infer facts outside the evidence.',
        'Cite concrete artifact ids and file/path/line refs when the evidence contains them.',
        'Respect artifact trust levels, taint reasons, and redaction policy; do not reproduce hidden or secret-like values.',
        purpose === 'write_spec_candidate'
          ? 'You may describe a candidate write specification, but you must not claim that any mutation has happened.'
          : 'Produce grounded prose only; deterministic graph state decides completion.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Original request:',
        input.request,
        '',
        'Routing:',
        `- route: ${input.decision?.route ?? 'unknown'}`,
        `- operation: ${input.decision?.operation ?? 'unknown'}`,
        `- executionClass: ${input.decision?.executionClass ?? 'unknown'}`,
        `- workspaceRoot: ${input.workspaceRoot ?? 'unknown'}`,
        `- completedToolCalls: ${input.completedToolCalls ?? 0}`,
        `- evidenceArtifactCount: ${input.sourceArtifacts.length}`,
        ...(input.ledgerArtifact ? [`- evidenceLedgerArtifactId: ${input.ledgerArtifact.artifactId}`] : []),
        `- synthesisPurpose: ${purpose}`,
        '',
        'Typed evidence:',
        evidenceText,
        '',
        'Produce the grounded synthesis now from these artifacts.',
      ].join('\n'),
    },
  ];
}

export function buildGraphWriteSpecSynthesisMessages(input: {
  request: string;
  decision?: IntentGatewayDecision | null;
  workspaceRoot?: string;
  sourceArtifacts: ExecutionArtifact[];
  ledgerArtifact?: ExecutionArtifact<EvidenceLedgerContent> | null;
}): ChatMessage[] {
  const messages = buildGroundedSynthesisMessages({
    request: input.request,
    decision: input.decision ?? null,
    workspaceRoot: input.workspaceRoot,
    completedToolCalls: input.sourceArtifacts.length,
    sourceArtifacts: input.sourceArtifacts,
    ledgerArtifact: input.ledgerArtifact ?? null,
    purpose: 'write_spec_candidate',
  });
  const finalMessage = messages[messages.length - 1];
  if (finalMessage?.role === 'user') {
    finalMessage.content = [
      finalMessage.content,
      '',
      'Return only a JSON object with this exact shape:',
      '{ "path": "relative/path", "content": "complete file contents to write", "append": false, "summary": "brief grounded rationale" }',
      'The JSON must describe the mutation candidate only. Do not say the write has happened.',
    ].join('\n');
  }
  return messages;
}

export function buildGroundedSynthesisLedgerArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  sourceArtifacts: ExecutionArtifact[];
  createdAt: number;
}): ExecutionArtifact<EvidenceLedgerContent> | null {
  const sourceArtifacts = input.sourceArtifacts.filter((artifact) => (
    artifact.artifactType !== 'EvidenceLedger' && artifact.artifactType !== 'SynthesisDraft'
  ));
  if (sourceArtifacts.length === 0) {
    return null;
  }
  return buildEvidenceLedgerArtifact({
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactId: input.artifactId,
    artifacts: sourceArtifacts,
    createdAt: input.createdAt,
  });
}

export function createGroundedSynthesisDraftArtifact(input: {
  graphId: string;
  nodeId: string;
  artifactId?: string;
  content: string;
  sourceArtifacts: ExecutionArtifact[];
  createdAt: number;
}): GroundedSynthesisDraftResult {
  const artifact = buildSynthesisDraftArtifact({
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactId: input.artifactId,
    content: input.content,
    sourceArtifacts: input.sourceArtifacts,
    createdAt: input.createdAt,
  });
  return {
    artifact,
    validation: validateSynthesisDraftArtifact({
      draft: artifact,
      sourceArtifacts: input.sourceArtifacts,
    }),
  };
}

export function validateGroundedSynthesisDraft(input: {
  draft: ExecutionArtifact<SynthesisDraftContent>;
  sourceArtifacts: ExecutionArtifact[];
}): SynthesisDraftValidationResult {
  return validateSynthesisDraftArtifact(input);
}

export function parseGraphWriteSpecCandidate(content: string): GraphWriteSpecCandidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path.trim() : '';
  const writeContent = typeof record.content === 'string' ? record.content : '';
  const append = record.append === true;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : undefined;
  if (!path || !writeContent) {
    return null;
  }
  return {
    path,
    content: writeContent,
    append,
    ...(summary ? { summary } : {}),
  };
}

export function completeGraphWriteSpecSynthesisNode(input: {
  graphId: string;
  nodeId: string;
  candidateContent: string;
  sourceArtifacts: ExecutionArtifact[];
  ledgerArtifact?: ExecutionArtifact<EvidenceLedgerContent> | null;
  createdAt: number;
}): GraphWriteSpecSynthesisResult | null {
  const candidate = parseGraphWriteSpecCandidate(input.candidateContent);
  if (!candidate) {
    return null;
  }
  const draftSourceArtifacts = [
    ...input.sourceArtifacts,
    ...(input.ledgerArtifact ? [input.ledgerArtifact] : []),
  ];
  const draft = createGroundedSynthesisDraftArtifact({
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactId: `${input.graphId}:${input.nodeId}:draft`,
    content: candidate.summary ?? `Write ${candidate.path}.`,
    sourceArtifacts: draftSourceArtifacts,
    createdAt: input.createdAt,
  });
  const writeSpec = buildWriteSpecArtifact({
    graphId: input.graphId,
    nodeId: input.nodeId,
    artifactId: `${input.graphId}:${input.nodeId}:write-spec`,
    path: candidate.path,
    content: candidate.content,
    append: candidate.append,
    sourceArtifacts: [
      ...draftSourceArtifacts,
      draft.artifact,
    ],
    redactionPolicy: 'no_secret_values',
    createdAt: input.createdAt,
  });
  return {
    candidate,
    draft,
    writeSpec,
  };
}
