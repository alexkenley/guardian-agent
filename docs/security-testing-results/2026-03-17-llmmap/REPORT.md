# LLMMap Security Test Result

Date: 2026-03-17

## Scope

External `LLMMap` smoke test against GuardianAgent web chat surface:

- target: `POST /api/message`
- tool: local `LLMMap` checkout
- model: local Ollama `gpt-oss:latest`

## Commands Run

```bash
npm run test:llmmap -- --max-prompts 1
npx vitest run src/channels/channels.test.ts
```

## Result Summary

- `LLMMap` completed successfully in `live` mode
- discovered injection point count: `1`
- discovered injection point: `body:json:content`
- confirmed findings: `0`
- evidence records: `2`

The discovered injection point is the expected user-controlled chat prompt field in the JSON request body. It is an attack surface, not a confirmed vulnerability by itself.

## Security Behavior Observed

- Guardian preflight blocked obvious prompt-injection text before model execution
- `LLMMap` smoke scan did not confirm prompt injectability on the tested prompt
- the only callback-based technique was skipped because no OOB callback URL was configured

## Hardening Applied

- fixed a runtime wiring bug in [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts) that caused `/api/message` failures during the first harness run
- tightened [web.ts](/mnt/s/Development/GuardianAgent/src/channels/web.ts) so `/api/message` and `/api/message/stream` only accept non-empty string `content`
- added regression coverage in [channels.test.ts](/mnt/s/Development/GuardianAgent/src/channels/channels.test.ts)
- verified the web-channel test file passed: `108/108`

## Primary Artifacts

- [test-llmmap-security.mjs](/mnt/s/Development/GuardianAgent/scripts/test-llmmap-security.mjs)

Raw request captures, bridge configs, and host-local run artifacts were intentionally excluded from the checked-in docs tree. This repo keeps the sanitized result summary and rerun script, not the full local harness exhaust.
