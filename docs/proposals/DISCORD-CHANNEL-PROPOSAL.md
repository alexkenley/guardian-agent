# Discord Channel Proposal

**Status:** Draft
**Date:** 2026-03-08

## Purpose

This proposal evaluates Discord as a new GuardianAgent communication channel and recommends a practical path to support both:

- normal single-agent chat, similar to today's Telegram flow
- a multi-agent "mission control" layout with dedicated channels, status reporting, and agent-specific routing

The goal is to add Discord without weakening the existing Runtime security model or overcomplicating v1.

## Current State

GuardianAgent already has the right high-level shape for Discord:

- `src/channels/types.ts` defines a thin channel adapter contract
- `src/channels/telegram.ts` shows the current bot-channel pattern
- `src/index.ts` wires channels into the Runtime dispatch path
- `src/runtime/identity.ts` already supports cross-channel identity aliasing

Current limitations matter for Discord:

- `src/config/types.ts` only defines `cli`, `telegram`, and `web`
- `src/agent/types.ts` only carries `userId`, `channel`, `content`, and `timestamp`
- `src/runtime/conversation.ts` keys memory by `agentId + userId + channel`

That is acceptable for Telegram, but it is too coarse for Discord. A Discord message has guild, channel, thread, and user context. Without carrying that context, conversations from different Discord channels would collapse into the same memory/session bucket.

## Research Summary

### What Discord supports now

From Discord's current developer docs:

- App installation is configured from the Developer Portal `Installation` page.
- Guild installs use the `bot` scope plus `applications.commands`.
- User installs are `applications.commands` only.
- Application commands do not depend on a bot user, but proactive posting and channel-based reporting do.
- If GuardianAgent uses an Interactions endpoint instead of gateway-only handling, Discord signs requests and the app must verify them with the application's public key.

### Intents and the main design constraint

Discord's current gateway model creates the key product choice:

- `GUILDS`, `GUILD_MESSAGES`, and `DIRECT_MESSAGES` are normal bot intents.
- `MESSAGE_CONTENT` is privileged.
- Without `MESSAGE_CONTENT`, bots still receive content for DMs, messages they send, messages that mention the bot, and message context menu interactions.
- Discord's current policy treats message-content access as a reviewed privileged capability for larger verified apps, so it is better treated as an optional expansion path than as a v1 dependency.

This means GuardianAgent can ship a good Discord v1 without privileged message-content access if it is designed around:

- slash commands
- mentions
- explicit channel bindings

If GuardianAgent wants dedicated channels where a bot reads normal freeform text from the whole channel, it will need `MESSAGE_CONTENT`.

### Pattern relevance

The multi-channel Discord pattern is useful as product inspiration, not as a drop-in implementation:

- it uses Discord as a multi-agent operations surface
- it supports server-specific routing and role-aware bindings
- it treats Discord sessions as more granular than a simple "user on channel type"

That maps well to GuardianAgent's orchestration model, but it does not mean GuardianAgent should start with one Discord bot per agent.

## Recommendation

### Recommended v1

Implement Discord as **one Discord application with one bot user**, with:

- guild install
- slash commands
- optional mention-based chat
- channel-to-agent bindings
- scheduled reports to configured channels

This gives GuardianAgent the important parts of the intended workflow:

- a `#mission-control` channel
- dedicated channels per agent if desired
- alerts and summaries posted automatically
- explicit routing instead of a single default bot chat

It also keeps the first implementation aligned with the existing architecture.

### Not recommended for v1

Do not start with **one Discord bot per agent**.

Reasons:

- each agent bot would need its own Discord application, token, install flow, and permissions
- startup, reload, and config management become multi-client rather than single-client
- the current channel adapter abstraction is built around one adapter instance per channel type
- most of the user value comes from channel routing, not from separate bot identities

Multi-bot support can remain a later option if separate bot personas become important.

## Product Shape

### Primary use cases

1. Single-agent chat from Discord
2. Mission-control channel for the main assistant
3. Dedicated channels bound to specialist agents
4. Scheduled or event-driven reports into alert/report channels
5. Approval and deny actions from Discord for governed tools

### Proposed Discord UX

Recommended initial commands:

- `/chat` - send a message to the bound or selected agent
- `/agent` - show or change the current bound agent for the channel
- `/status` - runtime and provider status
- `/reset` - reset conversation for the current scope
- `/approve` and `/deny` - tool approval controls
- `/intel` - parity with the Telegram threat-intel flow

Recommended channel layout:

- `#mission-control` - default assistant and operator coordination
- `#agent-sentinel` - security and audit summaries
- `#agent-research` - research-oriented workflows
- `#alerts` - outbound-only security or runtime alerts
- `#handoffs` - optional channel for explicit cross-agent summaries

Threads are a better long-term fit than a flat channel explosion for per-task work, but channel bindings are the simpler v1.

## Technical Proposal

### 1. Add a Discord channel adapter

Add `src/channels/discord.ts` and model it after `src/channels/telegram.ts`.

Recommended approach:

- use a mature third-party Node library such as `discord.js`
- keep the adapter thin
- translate Discord events into Guardian `UserMessage`
- route everything through existing Runtime dispatch and Guardian controls

Discord does not provide an official SDK, so a third-party library is the pragmatic choice.

### 2. Add Discord config

Add a new `channels.discord` section in `src/config/types.ts`.

Suggested shape:

```yaml
channels:
  discord:
    enabled: true
    applicationId: ${DISCORD_APPLICATION_ID}
    publicKey: ${DISCORD_PUBLIC_KEY}
    botToken: ${DISCORD_BOT_TOKEN}
    defaultAgent: default
    allowedGuildIds: ["123456789012345678"]
    allowDMs: false
    listenMode: mentions
    syncCommands: guild
    bindings:
      - guildId: "123456789012345678"
        channelId: "223456789012345678"
        agentId: default
      - guildId: "123456789012345678"
        channelId: "323456789012345678"
        agentId: sentinel
    reports:
      alertsChannelId: "423456789012345678"
      summaryChannelId: "523456789012345678"
```

Suggested fields:

- `applicationId`
- `publicKey`
- `botToken`
- `allowedGuildIds`
- `allowDMs`
- `defaultAgent`
- `listenMode: slash_only | mentions | bound_channels`
- `syncCommands: guild | global | off`
- `bindings[]` for channel-to-agent routing
- `reports.*ChannelId` for proactive posting targets

### 3. Fix the message/session model

This is the most important architectural change.

Current message and memory types are too coarse for Discord:

- `UserMessage` does not carry guild/channel/thread identifiers
- `ConversationKey` only distinguishes `channel: 'discord'`

Proposed change:

- extend message metadata with Discord context:
  - `guildId`
  - `channelId`
  - `threadId`
  - `messageId`
  - `isDM`
- extend memory/session scoping so Discord conversations can be isolated by surface

Recommended session scope:

- canonical identity remains user-centric, for example `discord:<userId>`
- conversation scope becomes `discord:<guildId or dm>:<channelId or threadId>`

That preserves cross-channel identity while preventing channel cross-talk in memory.

### 4. Add routing by Discord surface

Telegram today is mostly a single default-agent channel. Discord needs explicit surface-aware routing.

Recommended routing order:

1. explicit slash-command target
2. bound thread
3. bound channel
4. Discord channel default agent
5. existing tier router
6. global fallback agent

This preserves current Runtime behavior while adding deterministic Discord routing.

### 5. Support proactive reports cleanly

The current `ChannelAdapter.send(userId, text)` shape is user-centric.

Discord mission control needs channel-targeted delivery for:

- scheduled summaries
- Sentinel alerts
- orchestration handoffs
- approval notifications

Recommended change:

- generalize send targets so adapters can send to a user, DM, channel, or thread

If that refactor is considered too large for the first Discord PR, Discord can temporarily interpret `userId` as a generic destination ID internally, but that is not the better long-term contract.

## Permissions and Intents

### Recommended minimum bot permissions

Start narrow and avoid `Administrator`.

Recommended initial permissions:

- `View Channels`
- `Send Messages`
- `Send Messages in Threads`
- `Read Message History`
- `Embed Links`
- `Attach Files`
- `Use Slash Commands`

Optional later permissions:

- `Manage Threads` if GuardianAgent starts auto-creating task threads
- `Manage Channels` only if GuardianAgent is allowed to provision channels itself

### Recommended intents by phase

Phase 1:

- `GUILDS`
- `GUILD_MESSAGES`
- `DIRECT_MESSAGES` only if DM mode is enabled
- no `MESSAGE_CONTENT` if `listenMode` is `slash_only` or `mentions`

Phase 2 optional:

- add `MESSAGE_CONTENT` only when bound-channel freeform chat is required

Avoid `GUILD_MEMBERS` in v1 unless role-based routing is explicitly in scope.

## Security Position

Discord fits the existing Guardian security model well if the adapter stays thin.

Required safeguards:

- keep all Discord-originated messages on the normal Runtime dispatch path
- keep OutputGuardian scanning on all Discord responses
- store tokens through env vars or credential references, not inline literals
- allowlist guild IDs and optionally channel IDs
- do not request privileged intents unless the product mode really needs them
- do not request wide permissions for convenience

If GuardianAgent ever accepts Discord interactions over an HTTP endpoint instead of the gateway-only bot flow, it must verify Discord's signed requests with the app public key before accepting them.

## Option Comparison

### Option A: Single bot, channel bindings

Pros:

- best fit with current architecture
- one token and one install flow
- easiest config, reload, and support story
- enough to model mission control and specialist channels

Cons:

- all Discord-visible agent interactions share one bot identity

### Option B: One bot per agent

Pros:

- closest to the multi-bot mission-control workflow
- clear bot identity separation per specialist

Cons:

- multiple application records, tokens, and install links
- more startup and config complexity
- more permission-management surface
- not required to deliver most of the product value

### Option C: Interactions-only, no bot-first channel model

Pros:

- lowest intent footprint
- clean slash-command flow

Cons:

- weaker ambient collaboration model
- poor fit for proactive reporting and dedicated freeform agent channels

## Delivery Plan

### WS1 - Config and types

Files:

- `src/config/types.ts`
- `src/config/loader.ts`
- `src/channels/web-types.ts`
- `src/runtime/setup.ts`

Deliverables:

- `channels.discord` schema
- redacted config output for web/CLI
- setup status and validation rules

### WS2 - Discord adapter

Files:

- `src/channels/discord.ts`
- `src/channels/discord.test.ts`
- `package.json`

Deliverables:

- bot login/start/stop
- slash command handling
- mention handling
- outbound send to channel or DM

### WS3 - Routing and session scoping

Files:

- `src/agent/types.ts`
- `src/runtime/conversation.ts`
- `src/runtime/identity.ts`
- `src/index.ts`

Deliverables:

- Discord message metadata
- channel/thread-aware memory scope
- channel binding resolution

### WS4 - UX parity

Files:

- `README.md`
- web config UI files
- tooltips and setup flows

Deliverables:

- Discord setup section
- config center support
- operator guidance for permissions, intents, and bindings

### WS5 - Optional advanced mode

Deliverables:

- `MESSAGE_CONTENT`-backed bound-channel listening
- optional role-based routing
- optional auto-provisioned task threads or agent channels

## Risks and Open Questions

### Key risks

- If conversation scoping is not fixed first, Discord channels will contaminate each other's memory.
- If v1 depends on `MESSAGE_CONTENT`, onboarding becomes heavier and the product couples itself to a privileged-intent path too early.
- If Discord targets stay user-centric in the adapter contract, proactive reporting will remain awkward.

### Open questions

- Should v1 support DMs at all, or only guild installs?
- Should Discord bindings live under `channels.discord.bindings` or under a more general top-level routing section?
- Do we want thread-per-task support in v1.5, or stay with channel-per-agent first?
- Is separate bot identity actually a product requirement, or just a UI preference?

## Final Recommendation

Build Discord in two steps:

1. **Discord v1**
   One bot, guild install, slash commands, mentions, channel bindings, and proactive reports to fixed channels.

2. **Discord v2**
   Optional privileged message-content mode for bound channels, then consider multi-bot only if separate bot identities are still clearly worth the operational cost.

This delivers the useful part of that Discord workflow while staying consistent with GuardianAgent's current Runtime, security posture, and code structure.

## References

Local code and docs:

- `README.md`
- `src/channels/types.ts`
- `src/channels/telegram.ts`
- `src/agent/types.ts`
- `src/runtime/conversation.ts`
- `src/config/types.ts`
- `docs/specs/ORCHESTRATION-SPEC.md`

External sources:

- Discord Developer Docs - Getting Started: https://discord.com/developers/docs/quick-start/getting-started
- Discord Developer Docs - OAuth2 and installation scopes: https://discord.com/developers/docs/topics/oauth2
- Discord Developer Docs - Gateway intents: https://discord.com/developers/docs/events/gateway
- Discord Developer Docs - Interactions overview: https://discord.com/developers/docs/interactions/overview
- Discord support article - Message Content Intent policy: https://support-dev.discord.com/hc/en-us/articles/5324827539479-Message-Content-Intent-Review-Policy
- User-provided video reference: https://www.youtube.com/watch?v=GwSYhTrWWuA
