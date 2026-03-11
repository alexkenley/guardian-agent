# Proposal: OpenClaw Capability Adoption for GuardianAgent

**Date:** 2026-03-11
**Status:** Draft
**Author:** Analysis of openclaw/openclaw (MIT License)

---

## Executive Summary

OpenClaw is a mature personal AI assistant platform (~8,100 files, ~400K+ LOC) with extensive tool, channel, and media capabilities. This document catalogs capabilities from OpenClaw that GuardianAgent could adopt, grouped by priority and implementation complexity.

GuardianAgent already has **80+ tools** across security, networking, filesystem, web, memory, automation, and workspace categories. OpenClaw complements this with strengths in **browser automation, media processing, voice/TTS, document understanding, vector memory, and channel breadth**.

---

## Capability Comparison Matrix

### What GuardianAgent Already Has (no action needed)

| Category | GuardianAgent | OpenClaw Equivalent |
|----------|--------------|-------------------|
| Filesystem (CRUD) | `fs_read/write/list/search/mkdir/delete/move/copy` | Similar file tools |
| Shell execution | `shell_safe` with Guardian gating | `bash-tools` with sandbox |
| Web search | `web_search` (SearXNG/DuckDuckGo) | `web_search` (multiple providers) |
| Web fetch | `web_fetch` with readability | `web_fetch` with Cloudflare bypass |
| Network scanning | 14 net tools (`arp_scan`, `port_check`, `fingerprint`, etc.) | None — **GA is stronger here** |
| Threat intel | `intel_*` tools (watchlist, scan, findings) | None — **GA unique** |
| Memory (FTS5) | `memory_search/recall/save` + SQLite FTS5 | `memory-core` extension |
| Document search | `qmd_search/status/reindex` (QMD hybrid) | `link-understanding` (vector) |
| Cron/scheduling | `ScheduledTaskService` + cron tools | `cron-tool` + service |
| Automation | `workflow_*` + `task_*` (8 tools) | Lobster pipelines |
| Guardian security | 4-layer defense, policy engine | Security audit module |
| Multi-agent | `SequentialAgent/ParallelAgent/LoopAgent` | Sub-agent spawning |
| Channels | CLI, Telegram, Web | 22+ channels |
| Google Workspace | `gws` + `gws_schema` tools | `gog` skill (CLI wrapper) |
| Browser (basic) | `browser_open/action/snapshot/close/task` | Full Playwright-based browser |
| Email | `gmail_send`, campaigns | Via `himalaya` skill |
| Contacts | `contacts_*` tools | None built-in |
| Forum | `forum_post` | Discord/Slack actions |

---

## Tier 1: High-Value, Moderate Complexity (Recommended)

### 1. Enhanced Browser Automation (Playwright-based)

**OpenClaw:** Full Playwright browser control with CDP proxy, profile management, screenshot capture, AI-powered page interaction, form filling, file upload/download, tab management, and navigation guards.

**Source:** `src/browser/` (~22,700 LOC), `src/agents/tools/browser-tool.ts` (659 LOC)

**Key features missing from GA:**
- Playwright session management with persistent browser profiles
- CDP (Chrome DevTools Protocol) direct control
- AI-powered element selection (`pw-ai.ts` — accessibility tree snapshot → LLM decides action)
- Screenshot-to-action workflow
- Multi-tab management
- File download/upload handling
- Navigation guards and SSRF protection

**Dependencies:** `playwright-core`

**Complexity:** HIGH — 22K+ LOC in browser subsystem. However, GA already has basic browser tools. The upgrade path would be:
1. Replace Puppeteer-based `chrome_job` with Playwright session (~500 LOC)
2. Add AI snapshot/act pattern from `pw-ai.ts` (~200 LOC)
3. Add persistent profiles (~300 LOC)
4. Port navigation guards and SSRF checks (~200 LOC)

**Estimated effort:** 1,200-1,500 LOC new code
**Value:** HIGH — browser automation is the #1 most-requested capability gap

---

### 2. Vector Memory with LanceDB

**OpenClaw:** `memory-lancedb` extension provides vector-backed long-term memory with auto-recall (context injection) and auto-capture (fact extraction), using LanceDB for local vector storage and OpenAI embeddings.

**Source:** `extensions/memory-lancedb/` (extension package)

**Key features missing from GA:**
- Vector similarity search (vs GA's keyword-only FTS5)
- Auto-recall: automatically injects relevant memories into LLM context
- Auto-capture: automatically extracts and stores facts from conversations
- Hybrid search: combines vector + keyword results

**Dependencies:** `@lancedb/lancedb`, `openai` (for embeddings)

**Complexity:** MODERATE — GA already has `AgentMemoryStore` and FTS5 search. Adding vector search is an overlay:
1. Add LanceDB or sqlite-vec for vector storage (~200 LOC)
2. Add embedding generation via existing LLM providers (~150 LOC)
3. Hybrid search combining FTS5 + vector similarity (~200 LOC)
4. Auto-capture hook in conversation flow (~150 LOC)

**Estimated effort:** 700-900 LOC
**Value:** HIGH — dramatically improves memory recall quality

---

### 3. Text-to-Speech (TTS)

**OpenClaw:** Full TTS pipeline supporting ElevenLabs, system TTS (macOS `say`), and local Sherpa-ONNX. Used for voice responses across channels.

**Source:** `src/tts/` (~2,400 LOC), `skills/sag/` (ElevenLabs), `skills/sherpa-onnx-tts/` (local)

**Key features:**
- ElevenLabs API integration (high-quality voices)
- System TTS fallback (`say` on macOS, `espeak` on Linux)
- Local offline TTS via Sherpa-ONNX
- Voice selection and configuration

**Dependencies:** ElevenLabs API key (optional), `sherpa-onnx` binary (optional)

**Complexity:** MODERATE
1. ElevenLabs API wrapper (~200 LOC)
2. System TTS fallback (espeak/piper) (~100 LOC)
3. TTS tool registration with Guardian gating (~100 LOC)
4. Audio output handling in channels (~150 LOC)

**Estimated effort:** 550-700 LOC
**Value:** MEDIUM-HIGH — enables voice alerts, audio notifications, accessibility

---

### 4. Media Understanding Pipeline

**OpenClaw:** Processes images, audio, video, and PDFs. Supports vision models for image analysis, audio transcription (Whisper API + local), video frame extraction, and PDF text extraction.

**Source:** `src/media/` (~4,700 LOC), `src/media-understanding/` (~800 LOC)

**Key features missing from GA:**
- Image analysis via vision-capable LLMs (GPT-4V, Claude vision)
- Audio transcription (OpenAI Whisper API)
- Video frame extraction + analysis
- PDF text extraction and analysis
- MIME type detection and routing

**Dependencies:** `ffmpeg` (for video/audio), OpenAI Whisper API (optional)

**Complexity:** MODERATE — can be built incrementally:
1. Image analysis tool using existing Anthropic provider's vision (`~200 LOC`)
2. Audio transcription via Whisper API (`~250 LOC`)
3. PDF text extraction tool (`~200 LOC`)
4. Video frame extraction via ffmpeg (`~200 LOC`)

**Estimated effort:** 850-1,000 LOC
**Value:** HIGH — enables camera feed analysis (security), audio monitoring, document processing

---

### 5. PDF Tools

**OpenClaw:** Native PDF handling with text extraction, page manipulation, and LLM-powered analysis.

**Source:** `src/agents/tools/pdf-tool.ts` (558 LOC), `skills/nano-pdf/`

**Key features:**
- PDF text extraction (per-page or full)
- PDF metadata reading
- Natural-language PDF editing (via nano-pdf CLI)
- PDF creation from content

**Dependencies:** `pdf-parse` or similar, `nano-pdf` CLI (optional)

**Complexity:** LOW-MODERATE
1. PDF text extraction tool (~200 LOC)
2. PDF metadata reading (~50 LOC)
3. Integration with existing `doc_create` for PDF output (~100 LOC)

**Estimated effort:** 350-450 LOC
**Value:** MEDIUM — useful for document processing workflows

---

## Tier 2: Medium-Value, Low-Moderate Complexity

### 6. Image Generation

**OpenClaw:** `openai-image-gen` skill for batch image generation via OpenAI DALL-E API, with gallery output.

**Source:** `skills/openai-image-gen/`

**Complexity:** LOW
1. OpenAI Images API wrapper (~150 LOC)
2. Image tool with Guardian gating (~100 LOC)

**Estimated effort:** 250-300 LOC
**Value:** MEDIUM — useful for report generation, alert visualization

---

### 7. Smart Home: Philips Hue Control

**OpenClaw:** `openhue` skill wraps the OpenHue CLI for Philips Hue light/scene control.

**Source:** `skills/openhue/`

**Key features:**
- Light on/off/brightness/color
- Scene activation
- Room/zone control
- Status queries

**Complexity:** LOW — wraps existing CLI or HTTP API
1. Hue Bridge discovery and auth (~150 LOC)
2. Light control tools (on/off/brightness/color) (~200 LOC)
3. Scene management (~100 LOC)

**Estimated effort:** 450-550 LOC
**Value:** MEDIUM-HIGH for home automation use case — directly aligns with GuardianAgent's home security mission

---

### 8. Eight Sleep Pod Control

**OpenClaw:** `eightctl` skill for Eight Sleep smart mattress control.

**Source:** `skills/eightctl/`

**Key features:**
- Temperature control
- Alarm management
- Sleep schedule configuration
- Pod status queries

**Complexity:** LOW — API wrapper
**Estimated effort:** 200-300 LOC
**Value:** LOW-MEDIUM — niche but fits home automation

---

### 9. Sonos/BluOS Speaker Control

**OpenClaw:** `sonoscli` and `blucli` skills for speaker control.

**Source:** `skills/sonoscli/`, `skills/blucli/`

**Key features:**
- Speaker discovery (SSDP/mDNS)
- Playback control (play/pause/skip/volume)
- Speaker grouping
- Queue management

**Complexity:** LOW — CLI wrapper or direct SOAP/HTTP API
**Estimated effort:** 300-400 LOC
**Value:** MEDIUM — useful for audio alerts, home automation integration

---

### 10. RTSP/ONVIF Camera Integration

**OpenClaw:** `camsnap` skill captures frames/clips from RTSP/ONVIF cameras.

**Source:** `skills/camsnap/`

**Key features:**
- RTSP stream frame capture
- ONVIF camera discovery
- Clip recording
- Snapshot scheduling

**Complexity:** MODERATE — requires ffmpeg and ONVIF protocol handling
1. ONVIF device discovery (~200 LOC)
2. RTSP frame capture via ffmpeg (~150 LOC)
3. Camera management tools (~200 LOC)

**Estimated effort:** 550-650 LOC
**Value:** HIGH for security — camera monitoring is core to GuardianAgent's security mission

---

### 11. RSS/Blog Monitoring

**OpenClaw:** `blogwatcher` skill monitors RSS/Atom feeds for updates.

**Source:** `skills/blogwatcher/`

**Key features:**
- RSS/Atom feed parsing
- Update detection with diff
- Scheduled monitoring via cron

**Complexity:** LOW
**Estimated effort:** 200-300 LOC
**Value:** MEDIUM — useful for threat intel feed monitoring, CVE tracking

---

### 12. URL/Link Summarization

**OpenClaw:** `summarize` skill extracts text/transcripts from URLs, podcasts, YouTube videos.

**Source:** `skills/summarize/`

**Key features:**
- Web page summarization
- YouTube transcript extraction
- Podcast transcript extraction

**Complexity:** LOW — uses existing `web_fetch` + LLM summarization
**Estimated effort:** 150-250 LOC
**Value:** MEDIUM — useful for security briefing generation

---

### 13. OpenTelemetry Diagnostics

**OpenClaw:** `diagnostics-otel` extension exports metrics, traces, and logs to OTLP endpoints.

**Source:** `extensions/diagnostics-otel/` (685 LOC service)

**Key features:**
- Structured trace export (tool calls, LLM requests)
- Metrics export (latency, token usage, error rates)
- Log export with context
- OTLP protocol support

**Dependencies:** `@opentelemetry/*` packages

**Complexity:** MODERATE
**Estimated effort:** 500-700 LOC
**Value:** MEDIUM — excellent for production observability, aligns with enterprise security monitoring

---

### 14. Lobster Workflow Pipelines

**OpenClaw:** Typed pipeline engine with resumable approvals, step composition, and error handling.

**Source:** `extensions/lobster/src/lobster-tool.ts` (266 LOC)

**Key features:**
- Typed pipeline definitions
- Resumable execution with approval gates
- Step-by-step execution with rollback

**Complexity:** LOW — GA already has workflow infrastructure
**Estimated effort:** 200-300 LOC to enhance existing workflows with typed pipelines
**Value:** MEDIUM — improves automation reliability

---

## Tier 3: Nice-to-Have, Variable Complexity

### 15. Voice Call Integration

**OpenClaw:** Full telephony integration via WebSocket audio streaming, webhook security, and TTS response generation.

**Source:** `extensions/voice-call/` (~5,800 LOC)

**Complexity:** HIGH — requires telephony provider (Twilio/etc), WebSocket audio streaming
**Estimated effort:** 2,000+ LOC
**Value:** MEDIUM — voice alerts via phone call

---

### 16. Additional Channel Adapters

**OpenClaw channels not in GA:**
- Discord (`extensions/discord/`)
- Slack (`extensions/slack/`)
- WhatsApp (`extensions/whatsapp/` — Baileys)
- Signal (`extensions/signal/` — signal-cli)
- iMessage (`extensions/imessage/`)
- Matrix (`extensions/matrix/`)
- IRC (`extensions/irc/`)
- Microsoft Teams (`extensions/msteams/`)
- Google Chat (`extensions/googlechat/`)
- Nostr (`extensions/nostr/`)
- And 10+ more

**Complexity:** MODERATE each (200-500 LOC per channel)
**Priority channels for GA:**
- **Discord** — community/team alerts
- **Signal** — secure messaging for security alerts
- **Matrix** — self-hosted secure comms

**Estimated effort:** 300-500 LOC per channel
**Value:** MEDIUM — broader alert delivery surface

---

### 17. Notion Integration

**OpenClaw:** `notion` skill for Notion API (pages, databases, blocks).

**Source:** `skills/notion/`

**Complexity:** LOW-MODERATE
**Estimated effort:** 300-400 LOC
**Value:** LOW-MEDIUM — documentation/knowledge base integration

---

### 18. Trello Integration

**OpenClaw:** `trello` skill for board/list/card management.

**Source:** `skills/trello/`

**Complexity:** LOW
**Estimated effort:** 200-300 LOC
**Value:** LOW — task tracking

---

### 19. GitHub Issues Automation

**OpenClaw:** `gh-issues` skill for automated issue triage, fix implementation, and PR creation.

**Source:** `skills/gh-issues/`

**Complexity:** MODERATE
**Estimated effort:** 400-600 LOC
**Value:** LOW-MEDIUM — useful for GuardianAgent's own development

---

### 20. Weather Integration

**OpenClaw:** `weather` skill via wttr.in or Open-Meteo (no API key needed).

**Source:** `skills/weather/`

**Complexity:** LOW
**Estimated effort:** 100-150 LOC
**Value:** LOW — contextual info for home automation

---

### 21. Tmux Session Control

**OpenClaw:** `tmux` skill for remote-controlling interactive CLIs via keystroke injection and pane scraping.

**Source:** `skills/tmux/`

**Complexity:** LOW
**Estimated effort:** 150-250 LOC
**Value:** LOW-MEDIUM — useful for managing remote services

---

### 22. Spotify/Music Control

**OpenClaw:** `spotify-player` skill for terminal Spotify playback/search.

**Source:** `skills/spotify-player/`

**Complexity:** LOW
**Estimated effort:** 200-300 LOC
**Value:** LOW — entertainment/comfort automation

---

### 23. X (Twitter) API Integration

**OpenClaw:** `xurl` skill for authenticated X API requests (post, search, DMs, media).

**Source:** `skills/xurl/`

**Complexity:** MODERATE — OAuth 2.0 flow
**Estimated effort:** 400-500 LOC
**Value:** LOW-MEDIUM — social media monitoring for threat intel

---

## Implementation Roadmap

### Phase 1: Security & Monitoring Core (Weeks 1-3)
| # | Capability | Est. LOC | Value |
|---|-----------|---------|-------|
| 10 | RTSP/ONVIF Camera Integration | 550-650 | HIGH |
| 4 | Media Understanding (image analysis) | 400 (partial) | HIGH |
| 7 | Philips Hue Control | 450-550 | MEDIUM-HIGH |
| 11 | RSS/Blog Feed Monitoring | 200-300 | MEDIUM |

### Phase 2: Intelligence & Memory (Weeks 3-5)
| # | Capability | Est. LOC | Value |
|---|-----------|---------|-------|
| 2 | Vector Memory (LanceDB) | 700-900 | HIGH |
| 5 | PDF Tools | 350-450 | MEDIUM |
| 12 | URL/Link Summarization | 150-250 | MEDIUM |
| 13 | OpenTelemetry Diagnostics | 500-700 | MEDIUM |

### Phase 3: Interaction & Automation (Weeks 5-8)
| # | Capability | Est. LOC | Value |
|---|-----------|---------|-------|
| 1 | Enhanced Browser (Playwright) | 1,200-1,500 | HIGH |
| 3 | Text-to-Speech | 550-700 | MEDIUM-HIGH |
| 6 | Image Generation | 250-300 | MEDIUM |
| 9 | Sonos/Speaker Control | 300-400 | MEDIUM |

### Phase 4: Channels & Integration (Weeks 8-12)
| # | Capability | Est. LOC | Value |
|---|-----------|---------|-------|
| 16 | Discord Channel | 300-500 | MEDIUM |
| 16 | Signal Channel | 300-500 | MEDIUM |
| 14 | Lobster-style Typed Pipelines | 200-300 | MEDIUM |
| 15 | Voice Call (stretch) | 2,000+ | MEDIUM |

---

## Total Estimated New Code

| Phase | LOC Range | Capabilities |
|-------|----------|-------------|
| Phase 1 | 1,600-1,900 | Camera, image analysis, Hue, RSS |
| Phase 2 | 1,700-2,300 | Vector memory, PDF, summarization, OTel |
| Phase 3 | 2,300-2,900 | Browser, TTS, image gen, speakers |
| Phase 4 | 2,800-3,300 | Channels, pipelines, voice |
| **Total** | **8,400-10,400** | **22 capabilities** |

---

## What NOT to Adopt

These OpenClaw features don't align with GuardianAgent's architecture or mission:

| Feature | Reason to Skip |
|---------|---------------|
| macOS/iOS/Android apps | GA is server-side only |
| Canvas/A2UI | Visual workspace not needed for security agent |
| WhatsApp via Baileys | Unofficial API, fragile, legal gray area |
| iMessage integration | macOS-only, Apple-specific |
| Apple Notes/Reminders/Things | macOS-only |
| Bear Notes, Obsidian | Note-taking app integrations — GA has its own memory |
| Spotify/Music | Low priority for security agent |
| Food ordering (ordercli) | Not relevant |
| GIF search (gifgrep) | Not relevant |
| Peekaboo (macOS UI automation) | macOS-only |
| 1Password integration | GA has its own secret scanning; users manage their own vaults |
| Coding agent delegation | GA is not a coding assistant |
| ClawHub skill marketplace | GA has its own tool/automation system |

---

## Licensing & Attribution

OpenClaw is MIT-licensed. All adopted code should include attribution in source file headers:

```typescript
// Adapted from OpenClaw (https://github.com/openclaw/openclaw)
// Original work copyright OpenClaw contributors, MIT License
```

---

## Architecture Considerations

### Skill vs Tool Pattern

OpenClaw uses a **skill pattern** (markdown prompt files loaded at runtime that teach the LLM how to use external CLIs) vs GuardianAgent's **tool pattern** (programmatic tool definitions with JSON schema, handlers, and Guardian gating).

**Recommendation:** Continue using GA's tool pattern for built-in capabilities (stronger security guarantees via Guardian pipeline). Consider adding a lightweight skill-loader for optional CLI-wrapper integrations that don't need tight security controls (e.g., weather, music).

### Extension/Plugin Architecture

OpenClaw has a mature plugin system (`extensions/`) with package isolation, dependency management, and runtime loading. GA currently registers all tools in `executor.ts`.

**Recommendation:** Consider extracting tool categories into plugin packages in a later phase. Not required for the capabilities listed above.

### Memory Architecture Upgrade Path

```
Current GA Memory Stack:
  SQLite FTS5 → keyword search → memory tools → Guardian gating

Proposed Upgraded Stack:
  SQLite FTS5 → keyword search ─────────┐
  LanceDB/sqlite-vec → vector search ───┤→ hybrid ranker → memory tools → Guardian gating
  Auto-capture hook ─────────────────────┘
```

---

## Decision Log

| Question | Decision | Rationale |
|----------|---------|-----------|
| Playwright vs Puppeteer? | Playwright | Better API, multi-browser, OpenClaw battle-tested |
| LanceDB vs sqlite-vec? | sqlite-vec | Lighter, keeps single SQLite stack, GA already uses SQLite |
| ElevenLabs vs local TTS? | Both (fallback chain) | Quality vs offline availability |
| Which channels first? | Discord + Signal | Security community + secure messaging |
| Adopt skill pattern? | No (keep tool pattern) | Guardian security pipeline requires programmatic tools |
