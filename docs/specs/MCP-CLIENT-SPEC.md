# MCP Client Specification

**Status:** Implemented
**File:** `src/tools/mcp-client.ts`
**Protocol Version:** 2024-11-05
**Depends on:** Guardian admission pipeline, ToolExecutor

---

## Overview

The MCP (Model Context Protocol) client enables GuardianAgent to consume tools from external MCP-compatible tool servers. This extends the tool ecosystem without requiring built-in tool implementations — any MCP server (filesystem, database, API, etc.) can be connected.

**Key principle:** MCP tools are treated as **untrusted external tools**. All MCP tool calls pass through the Guardian admission pipeline before execution. The MCP server process runs in a child process with no direct access to GuardianAgent's runtime.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  GuardianAgent Runtime                                  │
│                                                         │
│  ┌──────────────────────┐     ┌──────────────────────┐ │
│  │  MCPClientManager    │     │  ToolExecutor         │ │
│  │                      │     │                       │ │
│  │  ┌────────────────┐  │     │  ┌─────────────────┐  │ │
│  │  │ MCPClient (A)  │◄─┤◄────┤──│ Guardian check  │  │ │
│  │  │ stdio transport │  │     │  │ before MCP call │  │ │
│  │  └──────┬─────────┘  │     │  └─────────────────┘  │ │
│  │         │             │     │                       │ │
│  │  ┌────────────────┐  │     └──────────────────────┘ │
│  │  │ MCPClient (B)  │  │                               │
│  │  └──────┬─────────┘  │                               │
│  └─────────┼────────────┘                               │
└────────────┼────────────────────────────────────────────┘
             │ stdio (stdin/stdout)
             ▼
     ┌──────────────┐
     │ MCP Server   │ (separate process)
     │ Process      │
     │              │
     │ • Tools      │
     │ • Resources  │
     │ • Prompts    │
     └──────────────┘
```

---

## Protocol

### Transport: stdio

Communication with MCP servers uses stdin/stdout with Content-Length framing:

```
Content-Length: 42\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"..."}
```

This is the standard LSP/MCP framing protocol. stderr from the server process is captured for logging but not parsed as protocol messages.

### Lifecycle

```
MCPClient                         MCP Server
    │                                  │
    │──── spawn process ──────────────→│
    │                                  │
    │──── initialize ─────────────────→│
    │←─── capabilities + serverInfo ───│
    │                                  │
    │──── notifications/initialized ──→│
    │                                  │
    │──── tools/list ─────────────────→│
    │←─── tool schemas ────────────────│
    │                                  │
    │  ... ready for tool calls ...    │
    │                                  │
    │──── tools/call ─────────────────→│
    │←─── result content ──────────────│
    │                                  │
    │──── SIGTERM ────────────────────→│
    │                                  X
```

### JSON-RPC Methods

| Method | Direction | Purpose |
|--------|-----------|---------|
| `initialize` | Client → Server | Protocol handshake, capability exchange |
| `notifications/initialized` | Client → Server | Confirm handshake complete |
| `tools/list` | Client → Server | Discover available tools |
| `tools/call` | Client → Server | Execute a tool |

---

## Configuration

### MCPServerConfig

```typescript
interface MCPServerConfig {
  id: string;          // Unique server identifier
  name: string;        // Display name
  transport: 'stdio';  // Transport type (only stdio currently)
  command: string;      // Command to start server
  args?: string[];      // Command arguments
  env?: Record<string, string>;  // Environment variables
  cwd?: string;         // Working directory
  timeoutMs?: number;   // Request timeout (default: 30000)
}
```

### Example Configurations

```typescript
// Filesystem MCP server
const filesystemServer: MCPServerConfig = {
  id: 'filesystem',
  name: 'Filesystem Tools',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  timeoutMs: 10_000,
};

// SQLite MCP server
const sqliteServer: MCPServerConfig = {
  id: 'sqlite',
  name: 'SQLite Tools',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-sqlite', '--db', '/data/app.db'],
};
```

### Managed Providers

Some external integrations are better represented as **managed MCP providers** rather than raw user-authored server definitions.

Current foundation:

- Google Workspace via `gws mcp`

GuardianAgent now supports config-driven materialization of managed provider server definitions. This preserves the existing MCP runtime model while making complex provider bundles easier to secure and operate.

See `docs/specs/GOOGLE-WORKSPACE-INTEGRATION-SPEC.md`.

---

## Tool Name Resolution

MCP tool names are prefixed to prevent collisions when multiple servers are connected:

```
Format: mcp:<serverId>:<originalToolName>

Example: mcp:filesystem:read_file
         mcp:sqlite:query
         mcp:github:create_issue
```

The `MCPClientManager.parseToolName()` method extracts the server ID and original tool name for routing.

### Tool Definition Mapping

MCP tool schemas are converted to GuardianAgent's `ToolDefinition` format:

| MCP Field | ToolDefinition Field | Notes |
|-----------|---------------------|-------|
| `name` | `name` | Prefixed with `mcp:<serverId>:` |
| `description` | `description` | Fallback: "MCP tool from {serverName}" |
| `inputSchema.properties` | `parameters` | Direct mapping |
| (none) | `risk` | Always `'network'` (external process) |

All MCP tools are classified as `network` risk because they communicate with an external process.

---

## MCPClient API

### Connection Management

```typescript
const client = new MCPClient(config);
await client.connect();       // Spawn, initialize, discover tools
client.disconnect();           // Kill process, clean up
client.getState();            // 'disconnected' | 'connecting' | 'connected' | 'error'
```

### Tool Operations

```typescript
client.getTools();              // MCPToolSchema[] — raw MCP schemas
client.getToolDefinitions();    // ToolDefinition[] — GuardianAgent format
client.refreshTools();          // Re-discover tools from server

const result = await client.callTool('read_file', { path: '/a.txt' });
// { success: true, output: 'file contents...', metadata: { server, tool } }
```

---

## MCPClientManager API

### Multi-Server Management

```typescript
const manager = new MCPClientManager();
await manager.addServer(filesystemConfig);
await manager.addServer(sqliteConfig);

manager.getAllToolDefinitions();  // Combined list from all servers
manager.getStatus();             // Connection status for all servers

const result = await manager.callTool('mcp:filesystem:read_file', { path: '/a.txt' });

manager.removeServer('filesystem');
await manager.disconnectAll();
```

---

## Security Analysis

### Threat: Malicious MCP Server Process

**Risk:** An MCP server could be a malicious or compromised binary that:
- Reads environment variables (API keys)
- Accesses the filesystem
- Opens network connections
- Sends data to external endpoints

**Current mitigation:**
- MCP servers are configured by the developer (not auto-discovered)
- Environment variables can be explicitly scoped via `config.env`
- Tool calls are validated by Guardian before reaching the MCP client
- MCP tool results are returned through the OutputGuardian (secret scanning)

**Residual risk:** The spawned process has the same OS-level permissions as the GuardianAgent process. It can access anything the Node.js process can access.

**Recommendations:**
1. Run MCP servers in containers or sandboxed environments for production
2. Only use trusted, audited MCP server implementations
3. Scope `config.env` to the minimum required variables
4. Consider adding a process sandbox (e.g., seccomp, landlock) in future iterations
5. Never pass `ANTHROPIC_API_KEY` or other platform secrets to MCP server env

### Threat: Tool Name Collisions / Spoofing

**Risk:** An MCP server could register tools with names that shadow built-in GuardianAgent tools (e.g., `read_file`, `shell_command`).

**Current mitigation:**
- All MCP tool names are prefixed with `mcp:<serverId>:` — they cannot collide with built-in tools
- The server ID is set by the developer at configuration time

**Residual risk:** None with current namespacing. If the prefix convention is bypassed, collisions could occur.

### Threat: stdin/stdout Injection

**Risk:** A malicious response from the MCP server could contain crafted JSON-RPC messages that confuse the client parser.

**Current mitigation:**
- Content-Length framing prevents message boundary confusion
- JSON.parse is used for strict parsing — malformed JSON is logged and dropped
- Each response is correlated to a pending request by ID
- Timeouts prevent hanging on missing responses

**Residual risk:** Low. The framing protocol is well-established (same as LSP).

### Threat: Resource Exhaustion via MCP

**Risk:** An MCP tool call could hang indefinitely or return extremely large responses.

**Current mitigation:**
- Per-request timeout (`config.timeoutMs`, default 30s)
- Pending request tracking with automatic timeout cleanup
- Process exit handling rejects all pending requests

**Recommendation:** Add response size limits (max Content-Length) in future iterations.

### Threat: MCP Server Crash / Restart

**Risk:** The MCP server process could crash mid-operation, leaving the client in an inconsistent state.

**Current mitigation:**
- Process exit handler transitions state to `'disconnected'`
- All pending requests are rejected on process exit
- Connection state is queryable via `getState()`

**Recommendation:** Add automatic reconnection with exponential backoff in future iterations.

### Threat: Secrets in MCP Tool Arguments

**Risk:** An agent could pass secret material as arguments to an MCP tool, exfiltrating it through the external process.

**Mitigation path:** MCP tool calls should be routed through the ToolExecutor, which calls `ctx.checkAction()` with the arguments. The Guardian pipeline's SecretScanController will scan the arguments for credentials.

**Implementation note:** This integration is the responsibility of the caller (ToolExecutor or agent code), not the MCPClient itself. The MCPClient is a low-level transport — security enforcement happens at the Guardian layer above it.

---

## Connection States

```
                    ┌──────────────┐
                    │ disconnected │
                    └──────┬───────┘
                           │ connect()
                           ▼
                    ┌──────────────┐
                    │  connecting  │
                    └──────┬───────┘
                           │
                ┌──────────┴──────────┐
                │ success             │ failure
                ▼                     ▼
         ┌──────────────┐     ┌──────────────┐
         │  connected   │     │    error      │
         └──────┬───────┘     └──────┬───────┘
                │ disconnect()        │ disconnect()
                │ / process exit      │
                ▼                     ▼
         ┌──────────────┐     ┌──────────────┐
         │ disconnected │     │ disconnected │
         └──────────────┘     └──────────────┘
```

---

## Future Enhancements

1. **SSE transport** — Support HTTP Server-Sent Events transport for remote MCP servers
2. **Automatic reconnection** — Exponential backoff reconnection on process crash
3. **Response size limits** — Max Content-Length enforcement
4. **Process sandboxing** — Container or seccomp isolation for server processes
5. **Resource/Prompt support** — MCP resources and prompt templates (currently tools only)
6. **MCP Server mode** — Expose GuardianAgent's tools as an MCP server for other clients
7. **Tool capability mapping** — Map MCP tool risk levels based on server-declared capabilities
8. **Health monitoring** — Periodic ping/list calls to detect stale connections
