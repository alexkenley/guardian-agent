# AWS Bedrock Provider — Implementation Plan

**Status:** Draft  
**Date:** 2026-03-27  
**Primary context:** [Private-By-Default Cloud Deployment Model for GuardianAgent](/mnt/s/Development/GuardianAgent/docs/proposals/PRIVATE-CLOUD-DEPLOYMENT-PROPOSAL.md)

## Objective

Add Amazon Bedrock as a first-party GuardianAgent LLM provider in a way that:

1. fits the existing built-in provider registry model
2. does not break the current `local` vs `external` routing system
3. supports AWS-native credentials safely
4. exposes Bedrock clearly in the Config Center and setup flows
5. leaves room for future managed-cloud providers without rewriting the provider system again

## Current Constraints

The current provider model is clean but opinionated:

- provider routing, tool-routing defaults, badges, and safety rules are built around a binary `local` vs `external` locality model
- the runtime currently assumes non-local providers authenticate like API-key services
- `LLMConfig` is flat and optimized for OpenAI-compatible providers
- runtime credential resolution only materializes `apiKey` for LLM providers today
- the provider registry only exposes `name`, `displayName`, and `compatible`

These assumptions are fine for Ollama and API-key providers, but Bedrock breaks the shape in two important ways:

- Bedrock is not local, but it is also not just another public API-key SaaS
- Bedrock authentication is AWS credential-chain based rather than single-token based

## Architectural Decision

### Keep routing locality binary in v1

Do **not** add a third routing tier such as `managed_cloud` to the current `local` / `external` routing system.

Bedrock should be treated as:

- `external` for routing
- `managed_cloud` for provider metadata and UI labeling

This is the right compromise because `local` vs `external` is deeply wired into:

- tool-routing defaults
- quality fallback
- output-guardian provider scope
- security triage provider selection
- web UI provider chips, badges, and selectors
- CLI and dashboard provider reporting

Trying to promote `managed_cloud` into the routing tier model immediately would create unnecessary churn across the runtime and UI for little practical gain.

### Add a second provider-classification axis

Introduce a second metadata axis for provider hosting model. Recommended enum:

- `self_hosted`
- `api_service`
- `managed_cloud`

Initial mapping:

- Ollama -> `self_hosted`
- OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI, Google -> `api_service`
- Bedrock -> `managed_cloud`

This gives the product a better categorization model without destabilizing routing.

### Use Bedrock Runtime, not Bedrock Agents

The Bedrock provider should implement the Guardian `LLMProvider` interface directly against:

- `Converse`
- `ConverseStream`

Do **not** use Bedrock Agents for the provider implementation. Guardian already has its own orchestration, tool routing, approvals, and safety model. Bedrock Agents would overlap with that architecture rather than fit into it.

### Prefer ambient AWS credentials first

The default Bedrock auth mode should be the AWS default credential chain.

That means Bedrock should work out of the box when Guardian is running under:

- an EC2 instance profile
- an ECS task role
- local `aws configure` / shared credentials
- explicit AWS environment variables

Explicit static credential refs should still be supported, but they should not be the primary recommended path.

## Recommended Provider Model

### Bedrock classification

Bedrock should be represented as:

- provider type: `bedrock`
- routing locality: `external`
- hosting model: `managed_cloud`

This is more accurate than calling Bedrock `local`, and more precise than lumping it into the same UX bucket as pure API-key SaaS providers.

### Why not call Bedrock `private_cloud`

`private_cloud` is too deployment-specific.

Bedrock is fundamentally an AWS-managed cloud service. It can be used in a more private architecture with IAM roles, VPC endpoints, and private subnets, but those are deployment choices rather than the provider type itself.

`managed_cloud` is the better product classification.

## Config Model

### v1 config direction

Extend `LLMConfig` with an optional `aws` block rather than trying to overload the current generic `credentialRef` field.

Recommended shape:

```yaml
llm:
  bedrock-main:
    provider: bedrock
    model: us.anthropic.claude-sonnet-4-20250514-v1:0
    aws:
      region: us-east-1
      authMode: default_chain
      # optional:
      # profile: guardian-bedrock
      # accessKeyIdCredentialRef: llm.bedrock.access
      # secretAccessKeyCredentialRef: llm.bedrock.secret
      # sessionTokenCredentialRef: llm.bedrock.session
      # endpointOverride: https://bedrock-runtime.us-east-1.amazonaws.com
```

Recommended TypeScript shape:

```ts
interface LLMConfig {
  provider: string;
  apiKey?: string;
  credentialRef?: string;
  baseUrl?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  priority?: number;
  aws?: {
    region: string;
    authMode?: 'default_chain' | 'profile' | 'static_keys';
    profile?: string;
    accessKeyIdCredentialRef?: string;
    secretAccessKeyCredentialRef?: string;
    sessionTokenCredentialRef?: string;
    endpointOverride?: string;
  };
}
```

### Why an `aws` block is better than overloading `credentialRef`

Bedrock needs structured provider-specific configuration:

- region is mandatory
- credentials can come from multiple sources
- the recommended auth path is not a single secret token
- optional endpoint override is AWS-specific

A structured `aws` block is the smallest clean extension that supports Bedrock without forcing an immediate fully generic provider-options redesign.

## Provider Registry Uplift

The built-in registry should carry richer metadata for all providers.

Recommended `ProviderTypeInfo` expansion:

```ts
interface ProviderTypeInfo {
  name: string;
  displayName: string;
  compatible: boolean;
  locality: 'local' | 'external';
  hostingModel: 'self_hosted' | 'api_service' | 'managed_cloud';
  authKind: 'none' | 'api_key' | 'aws';
}
```

This metadata should flow through:

- provider registry
- dashboard provider type API
- config page provider selectors
- runtime provider info reporting

## Phase 1: Provider Metadata And Classification Cleanup

### Goal

Make the provider model expressive enough for Bedrock without rewriting routing.

### Deliver

- extend provider registry metadata to include:
  - `locality`
  - `hostingModel`
  - `authKind`
- add `bedrock` as a registered built-in provider type
- keep `locality` binary and unchanged
- update provider status payloads and provider type payloads to expose `hostingModel`
- update Config Center UI labels so Bedrock appears under the external editor but with a `Managed Cloud` cue

### Likely implementation areas

- [src/llm/provider-registry.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-registry.ts)
- [src/llm/provider-registry.test.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-registry.test.ts)
- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [web/public/js/pages/config.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/config.js)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)

### Exit criteria

- Bedrock appears as a built-in provider type
- existing providers keep their current behavior
- routing still talks only in terms of `local` and `external`
- the UI can distinguish Bedrock from generic API-key providers

## Phase 2: Config And Credential Model

### Goal

Teach the config system and runtime credential resolver how to handle AWS-style provider auth.

### Deliver

- extend `LLMConfig` with `aws` provider options
- update config validation:
  - `bedrock` requires `aws.region`
  - `bedrock` does **not** require `credentialRef`
  - `bedrock` auth rules depend on `aws.authMode`
- extend runtime credential resolution for LLM providers:
  - leave normal API-key providers unchanged
  - resolve static AWS refs when `authMode=static_keys`
  - do not force secret resolution for `default_chain`
  - do not force secret resolution for `profile`
- add Bedrock-aware setup/save rules in the web config flow

### Recommended auth modes

#### `default_chain` (recommended default)

Use the AWS SDK default credential provider chain.

Best for:

- EC2 instance roles
- ECS task roles
- local AWS CLI/shared credentials
- deployments where operators do not want to copy long-lived AWS keys into Guardian config

#### `profile`

Use a named AWS shared profile.

Best for:

- local development
- operators testing Bedrock from a workstation with multiple AWS accounts

#### `static_keys`

Use explicit credential refs for:

- access key ID
- secret access key
- optional session token

Best for:

- narrow compatibility cases
- short-lived temporary credentials
- environments where ambient AWS credential chain is not available

### Likely implementation areas

- [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts)
- [src/config/loader.ts](/mnt/s/Development/GuardianAgent/src/config/loader.ts)
- [src/config/loader.test.ts](/mnt/s/Development/GuardianAgent/src/config/loader.test.ts)
- [src/runtime/credentials.ts](/mnt/s/Development/GuardianAgent/src/runtime/credentials.ts)
- [src/runtime/credentials.test.ts](/mnt/s/Development/GuardianAgent/src/runtime/credentials.test.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)

### Exit criteria

- Bedrock config validates correctly
- Guardian can start with Bedrock configured via default chain, profile, or static refs
- API-key providers are unaffected
- setup and config-save flows can persist a valid Bedrock profile

## Phase 3: Bedrock Provider Implementation

### Goal

Add a first-party Bedrock implementation of the `LLMProvider` interface.

### Deliver

- add dependencies:
  - `@aws-sdk/client-bedrock`
  - `@aws-sdk/client-bedrock-runtime`
  - `@aws-sdk/credential-providers`
- add new provider implementation:
  - [src/llm/bedrock.ts](/mnt/s/Development/GuardianAgent/src/llm/bedrock.ts)
- implement:
  - `chat()` via `Converse`
  - `stream()` via `ConverseStream`
  - `listModels()` via Bedrock control-plane model listing
- map Guardian tool definitions to Bedrock tool specs
- map Bedrock tool-use responses back into Guardian `ToolCall[]`
- normalize Bedrock errors into Guardian-friendly messages

### Bedrock response mapping requirements

The provider must handle:

- plain assistant text responses
- tool-call responses
- streamed deltas
- usage accounting where returned by the API

The provider must also handle Bedrock-specific operator errors clearly:

- region missing
- IAM auth failure
- account/model access not enabled
- chosen model not available in the selected region
- chosen model lacking required conversation/tool-use support

### Model listing behavior

`listModels()` should be best-effort and conservative:

- list text-capable foundation models the account/region can see
- do not pretend all listed models are equal in tool-use support
- allow the operator to enter a model ID manually if discovery is incomplete

For v1, manual model entry is acceptable as long as test/save surfaces a clear error when the model cannot be invoked.

### Likely implementation areas

- [src/llm/bedrock.ts](/mnt/s/Development/GuardianAgent/src/llm/bedrock.ts)
- [src/llm/types.ts](/mnt/s/Development/GuardianAgent/src/llm/types.ts)
- [src/llm/provider-registry.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-registry.ts)
- [src/llm/provider.ts](/mnt/s/Development/GuardianAgent/src/llm/provider.ts)
- [src/llm/provider-registry.test.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-registry.test.ts)
- new tests under [src/llm/](/mnt/s/Development/GuardianAgent/src/llm)

### Exit criteria

- Bedrock can answer plain chat requests
- Bedrock can stream
- Bedrock can participate in Guardian tool-calling flows where the selected model supports it
- Bedrock model discovery works well enough for operator setup

## Phase 4: Config Center And Setup UX

### Goal

Make Bedrock operable from the existing setup and configuration surfaces.

### Deliver

- add `bedrock` to the provider type dropdown
- external-provider editor shows Bedrock-specific fields:
  - region
  - auth mode
  - profile name when `profile`
  - credential-ref inputs when `static_keys`
  - model
- update model-load/test actions:
  - Bedrock does not use API key fields
  - model discovery should use the selected region and auth mode
- update configured-provider cards to show:
  - locality: `External`
  - hosting model: `Managed Cloud`
  - region

### UX rules

- Bedrock should live in the external-side editor because routing locality remains external
- Bedrock should not be mislabeled as "API key" provider
- the setup flow should recommend `default_chain` first
- inline help should explain that EC2/ECS IAM roles are preferred over long-lived keys

### Likely implementation areas

- [web/public/js/pages/config.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/config.js)
- [web/public/js/api.js](/mnt/s/Development/GuardianAgent/web/public/js/api.js)
- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)

### Exit criteria

- an operator can create, test, save, and inspect a Bedrock provider from the web UI
- the UI does not ask for an API key for Bedrock
- Bedrock profiles hot-reload like other providers

## Phase 5: Routing, Guardrails, And Runtime Behavior

### Goal

Make sure Bedrock fits the existing Guardian runtime semantics cleanly.

### Deliver

- keep Bedrock in the `external` lane for:
  - smart provider routing
  - per-tool routing
  - security triage `external` selection
  - quality fallback targeting
  - output-guardian external-provider scope
- ensure final response-source metadata can still report:
  - locality
  - provider name
  - hosting model
- confirm tool-definition shortening behavior still treats Bedrock as external

### Important rule

Do **not** change:

- `assistant.tools.preferredProviders.local`
- `assistant.tools.preferredProviders.external`
- `providerRouting` values
- `llmProvider: 'local' | 'external' | 'auto'`

Bedrock must fit the current routing contract rather than forcing a cross-cutting routing redesign.

### Likely implementation areas

- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)
- [src/runtime/message-router.ts](/mnt/s/Development/GuardianAgent/src/runtime/message-router.ts)
- [src/runtime/sentinel.ts](/mnt/s/Development/GuardianAgent/src/runtime/sentinel.ts)
- [src/guardian/output-guardian.ts](/mnt/s/Development/GuardianAgent/src/guardian/output-guardian.ts)
- [src/worker/worker-session.ts](/mnt/s/Development/GuardianAgent/src/worker/worker-session.ts)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)

### Exit criteria

- Bedrock can be selected as the preferred external provider
- tool-routing and fallback behavior remain stable
- no existing `local` / `external` UX contracts regress

## Phase 6: Verification And Documentation

### Goal

Ship Bedrock with strong mocked coverage and clear operator docs before any real-cost smoke work.

### Deliver

- unit tests for:
  - registry metadata
  - config validation
  - credential resolution
  - provider request/response mapping
  - Bedrock tool-use mapping
  - error normalization
- UI/config tests for:
  - provider type rendering
  - Bedrock-specific config fields
  - save/test flows
- documentation updates:
  - README provider list
  - configuration docs
  - reference guide
  - cloud deployment guidance where relevant

### Manual verification lane

After mocked coverage is green, add a manual Bedrock verification checklist:

1. configure a Bedrock provider with `default_chain`
2. list models for a known region
3. send a plain chat request
4. send a streamed chat request
5. run a tool-calling path with a model known to support Converse tool use
6. verify source badges, routing, and fallback metadata

Real Bedrock smoke runs should remain opt-in because they incur cost and require account setup.

### Recommended commands when implementation lands

- `npm run check`
- `npx vitest run src/llm/*.test.ts`
- `npx vitest run src/config/loader.test.ts src/runtime/credentials.test.ts`
- `npm test`

## Suggested File Changes

### Core runtime

- [src/config/types.ts](/mnt/s/Development/GuardianAgent/src/config/types.ts)
- [src/config/loader.ts](/mnt/s/Development/GuardianAgent/src/config/loader.ts)
- [src/runtime/credentials.ts](/mnt/s/Development/GuardianAgent/src/runtime/credentials.ts)
- [src/index.ts](/mnt/s/Development/GuardianAgent/src/index.ts)

### LLM provider layer

- [src/llm/provider-registry.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-registry.ts)
- [src/llm/provider.ts](/mnt/s/Development/GuardianAgent/src/llm/provider.ts)
- [src/llm/types.ts](/mnt/s/Development/GuardianAgent/src/llm/types.ts)
- [src/llm/bedrock.ts](/mnt/s/Development/GuardianAgent/src/llm/bedrock.ts)

### Web and config surfaces

- [src/channels/web-types.ts](/mnt/s/Development/GuardianAgent/src/channels/web-types.ts)
- [web/public/js/pages/config.js](/mnt/s/Development/GuardianAgent/web/public/js/pages/config.js)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)
- [web/public/js/chat-panel.js](/mnt/s/Development/GuardianAgent/web/public/js/chat-panel.js)

### Tests

- [src/llm/provider-registry.test.ts](/mnt/s/Development/GuardianAgent/src/llm/provider-registry.test.ts)
- [src/config/loader.test.ts](/mnt/s/Development/GuardianAgent/src/config/loader.test.ts)
- [src/runtime/credentials.test.ts](/mnt/s/Development/GuardianAgent/src/runtime/credentials.test.ts)
- new tests under [src/llm/](/mnt/s/Development/GuardianAgent/src/llm)

### Docs

- [README.md](/mnt/s/Development/GuardianAgent/README.md)
- [src/reference-guide.ts](/mnt/s/Development/GuardianAgent/src/reference-guide.ts)
- [docs/proposals/PRIVATE-CLOUD-DEPLOYMENT-PROPOSAL.md](/mnt/s/Development/GuardianAgent/docs/proposals/PRIVATE-CLOUD-DEPLOYMENT-PROPOSAL.md)

## Deferred Items

Do not include these in the first Bedrock implementation:

- Bedrock Agents integration
- model capability benchmarking matrix across every Bedrock model family
- full role-assumption orchestration in provider config
- VPC endpoint configuration automation inside Guardian itself
- new routing tiers beyond `local` and `external`
- generic provider plugin architecture

These can come later if Bedrock lands cleanly and the provider model proves too narrow for future managed-cloud providers.

## Success Criteria

- Guardian can register and use a `bedrock` provider without hacks
- Bedrock works with the existing provider registry, config center, and runtime hot-reload flow
- Bedrock fits the `external` routing lane without destabilizing routing logic
- operators can authenticate using IAM-native patterns instead of being forced into static API-key semantics
- the product can describe providers using both locality and hosting model
- the implementation leaves the door open for future managed-cloud providers without needing another provider-model rewrite

## Sources

- Amazon Bedrock pricing: <https://aws.amazon.com/bedrock/pricing/>
- Amazon Bedrock Converse API: <https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html>
- Amazon Bedrock model access: <https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html>
- AWS SDK for JavaScript v3 code examples: <https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_code_examples.html>
