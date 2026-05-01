# Security Testing Results

This directory contains the current security verification artifacts for GuardianAgent.

## Contents

- [SECURITY-CLAIM-MATRIX.md](SECURITY-CLAIM-MATRIX.md) — claim-to-implementation-to-proof matrix for the highest-value security guarantees
- [SECURITY-TEST-RESULTS-2026-03-12.md](SECURITY-TEST-RESULTS-2026-03-12.md) — latest automated run summary and environment notes
- [RELATED-TEST-SCRIPTS.md](RELATED-TEST-SCRIPTS.md) — executable scripts and supporting harnesses used for runtime verification

## Primary Verification Command

```bash
node scripts/test-security-verification.mjs
```

## Artifact Hygiene

- Keep sanitized summaries, claim matrices, and rerun commands in the repo.
- Keep raw request captures, local config snapshots, host-specific logs, and blind eval sets out of the checked-in proof surface.
- If a security result needs deeper raw evidence, store it in a private artifact location and summarize the conclusion here.
