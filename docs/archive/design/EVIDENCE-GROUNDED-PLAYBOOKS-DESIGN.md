# Evidence-Grounded Playbooks Design

**Status:** Implemented baseline  
**Primary Files:** `src/config/types.ts`, `src/config/loader.ts`, `src/runtime/connectors.ts`, `src/tools/executor.ts`

## Goal

Allow deterministic playbook instruction steps to require evidence-backed synthesis from prior tool results, with a stricter mode for high-stakes reporting flows.

## Config Surface

Instruction steps now support:
- `evidenceMode: none | grounded | strict`
- `citationStyle: sources_list | inline_markers`

Validation guarantees:
- both fields are only legal on `instruction` steps
- enum values are restricted to supported modes

## Runtime Behavior

### Evidence Collection

Prior step outputs are scanned for:
- explicit `citations`
- `results` arrays with URL-backed search results
- structured `evidence` arrays

Collected evidence is normalized into:
- `PlaybookCitation[]`
- `PlaybookEvidenceItem[]`

### Prompting

When grounding is enabled, instruction prompts include a structured evidence section and explicit response rules.

`grounded` mode:
- asks for evidence-backed wording
- tolerates partial coverage when uncertainty is stated

`strict` mode:
- fails early if no prior evidence exists
- fails if the generated response omits the required citation markers or source section

### Run History

Instruction step results now carry:
- `citations`
- `evidence`

This makes run inspection and later eval assertions much more useful.

## Tooling Support

`web_search` responses now expose normalized citation/evidence data so downstream playbook steps can reuse them without custom parsing.

## Benefits

- Better grounded summaries and reports in deterministic automations
- Lower unsupported-claim risk for research and security workflows
- Structured evidence available in run history and evals

## Current Boundaries

- Grounding is limited to playbook instruction steps, not all chat replies
- Citation presence is enforced structurally, not with a full semantic verifier
- Claim-to-passage validation remains future work

## Verification

- `src/runtime/connectors.test.ts`
- `src/config/loader.test.ts`
