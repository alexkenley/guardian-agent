---
name: mcp-builder
description: Guide for building high-quality MCP (Model Context Protocol) servers and tool suites. Use this whenever the user asks to build, design, refactor, review, or evaluate an MCP server, expose an API through MCP, or improve tool naming, schemas, pagination, auth, or error handling.
---

# MCP Builder

Build MCP servers so they are easy for agents to discover, reason about, and use safely.

## Workflow

1. Understand the target API or system first.
2. Choose the transport intentionally.
3. Design the tool surface for agent discoverability, not just endpoint parity.
4. Implement shared auth, error handling, formatting, and pagination helpers before adding many tools.
5. Test the server with realistic multi-step prompts, not only unit tests.

## Design Principles

- Prefer clear verb-first or provider-prefixed tool names.
- Make tool descriptions concrete and concise.
- Use structured schemas with field constraints and examples.
- Return structured data whenever the SDK supports it.
- Keep read-only and mutating tools clearly separated.
- Write actionable errors that tell the agent what to do next.

## Implementation Guidance

- Prefer TypeScript unless the repo already has a strong Python MCP pattern.
- Start with the most common read-only tools, then add mutating operations.
- Add pagination, filtering, and scoping so tools do not dump oversized payloads.
- Model auth once in a shared client layer.
- Use annotations and metadata that help approval and policy systems classify risk.

## Review Checklist

- Can an agent find the right tool from the name alone?
- Are input and output schemas specific enough to prevent ambiguous calls?
- Do error messages explain the likely fix?
- Are mutating tools obviously distinct from inspection tools?
- Can common user tasks be solved without custom scripting around the server?

Read [references/mcp-server-checklist.md](./references/mcp-server-checklist.md) when you need a compact implementation checklist.

## Gotchas

- Do not mirror raw endpoint naming when it makes tool discovery worse for agents.
- Do not expose large unfiltered list endpoints without pagination, filters, or scoping.
- Do not mix read-only and mutating behavior behind one ambiguous tool.
