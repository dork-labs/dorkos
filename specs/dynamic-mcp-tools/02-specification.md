---
slug: dynamic-mcp-tools
number: 41
created: 2026-02-17
status: specified
---

# Dynamic MCP Tool Injection Architecture

**Status:** Specified
**Authors:** Claude Code, 2026-02-17
**Spec:** #41
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [mcp-tool-injection-patterns.md](../../research/mcp-tool-injection-patterns.md), [claude-code-sdk-agent-capabilities.md](../../research/claude-code-sdk-agent-capabilities.md)

---

## Overview

Add the server-side architecture to dynamically inject in-process MCP tools into Claude Code SDK `query()` calls from `AgentManager`. This is the foundational plumbing that makes Claude Code agents _aware_ of DorkOS — enabling future features like scheduler management, session introspection, and configuration access to be exposed as tools the agent can call.

The implementation uses the SDK's `createSdkMcpServer()` + `tool()` API to define tools with Zod schemas, registers them once at server startup, and injects them into every `query()` call via the `mcpServers` option. A proof-of-concept with 3 tools validates all patterns needed for subsequent features.

## Background / Problem Statement

Claude Code agents running through DorkOS have **no awareness of DorkOS itself**. The API sits between the web client and the Claude Code SDK, but the agent subprocess has no way to query DorkOS services, read server state, or perform DorkOS-specific operations. The agent can only use its built-in tools (Read, Edit, Bash, Glob, Grep) and any MCP servers configured in `.mcp.json`.

This creates a fundamental gap: features like a job scheduler, configuration management, or session introspection cannot be exposed to the agent without a bridge. The Claude Code SDK provides exactly this bridge via in-process MCP tools — but DorkOS does not currently use this capability.

The `AgentManager.sendMessage()` method currently passes `prompt` as a plain string and does not set the `mcpServers` option. This spec adds both capabilities.

## Goals

- Inject custom in-process MCP tools into every SDK `query()` call
- Convert the prompt form from plain `string` to `AsyncIterable<SDKUserMessage>` (SDK requirement for MCP)
- Validate the full end-to-end pipeline with 3 proof-of-concept tools
- Establish the `McpToolDeps` dependency injection pattern for tool handlers
- Maintain backward compatibility with all existing functionality
- Keep server-only scope — no client UI changes

## Non-Goals

- Client UI for MCP tool management or visibility
- Scheduler implementation (future feature that consumes this plumbing)
- System prompt modifications
- CLI subcommands for tool management
- Per-session or per-user tool variation
- External MCP server support (stdio/HTTP/SSE) — only in-process SDK servers
- Auto-allowing MCP tools (they go through the existing permission system)
- `allowedTools` filtering (all tools are available by default; MCP tools follow this)

## Technical Dependencies

| Dependency                       | Version | Purpose                                                |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `@anthropic-ai/claude-agent-sdk` | latest  | `createSdkMcpServer`, `tool`, `query`, `Options` types |
| `zod`                            | ^4.3.6  | Tool input schema validation                           |
| `@dorkos/shared`                 | \*      | `StreamEvent`, `PermissionMode` types (unchanged)      |

All dependencies are already present in `apps/server/package.json`. No new packages are introduced.

**SDK API surface used:**

```typescript
import {
  createSdkMcpServer,
  tool,
  query,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
```

## Detailed Design

### 1. Prompt Form Conversion

**The critical SDK constraint:** When `mcpServers` is provided in `Options`, the `prompt` parameter MUST be `AsyncIterable<SDKUserMessage>`, not a plain string. This is documented in the SDK's custom tools guide.

Add a helper function to `agent-manager.ts`:

```typescript
/**
 * Wrap a plain-text user message in the AsyncIterable form required by the SDK
 * when mcpServers is provided. Safe to use unconditionally — the SDK accepts
 * AsyncIterable for all query types.
 */
async function* makeUserPrompt(content: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
  };
}
```

The existing call site changes from:

```typescript
const agentQuery = query({ prompt: content, options: sdkOptions });
```

To:

```typescript
const agentQuery = query({ prompt: makeUserPrompt(content), options: sdkOptions });
```

**Decision:** Always use the `AsyncIterable` form, not conditionally. This eliminates a code path branch and is backward-compatible (the SDK accepts `AsyncIterable` regardless of whether `mcpServers` is set).

### 2. AgentManager MCP Server Injection

Add two private fields and a setter method to `AgentManager`:

```typescript
export class AgentManager {
  // ... existing fields ...
  private mcpServers: Record<string, unknown> = {};

  /**
   * Register MCP tool servers to be injected into every SDK query() call.
   * Called once at server startup after singleton services are initialized.
   */
  setMcpServers(servers: Record<string, unknown>): void {
    this.mcpServers = servers;
  }
```

In `sendMessage()`, inject `mcpServers` into `sdkOptions` before the `query()` call:

```typescript
// Inject MCP tool servers (if any registered)
if (Object.keys(this.mcpServers).length > 0) {
  (sdkOptions as Record<string, unknown>).mcpServers = this.mcpServers;
}
```

**Note:** The `Options` type from the SDK may not include `mcpServers` in its public type definition depending on the SDK version. The cast to `Record<string, unknown>` is the same pattern already used for `model` on line 175 of the current code.

### 3. MCP Tool Server Factory

New file: `apps/server/src/services/mcp-tool-server.ts`

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TranscriptReader } from './transcript-reader.js';

/**
 * Explicit dependency interface for MCP tool handlers.
 * All service dependencies are typed here and injected at server startup.
 */
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  /** The default working directory for the server */
  defaultCwd: string;
}
```

#### Tool 1: `ping`

Validates basic MCP injection plumbing with zero-input schema and synchronous handler.

```typescript
/**
 * Ping handler — validates the MCP tool injection pipeline is working.
 * Returns a pong response with timestamp and server identifier.
 */
export async function handlePing() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'pong',
          timestamp: new Date().toISOString(),
          server: 'dorkos',
        }),
      },
    ],
  };
}
```

- **Description:** `"Check that the DorkOS server MCP integration is working. Returns pong with a timestamp."`
- **Input:** empty Zod object `{}`
- **Output:** `{ status: "pong", timestamp: "<ISO>", server: "dorkos" }`
- **Validates:** Basic end-to-end plumbing, empty schema, tool naming convention

#### Tool 2: `get_server_info`

Validates Zod schema with optional fields, environment variable access, and typed arguments.

```typescript
/**
 * Server info handler — returns DorkOS server metadata.
 * Validates Zod optional fields and env var access from tool handlers.
 */
export async function handleGetServerInfo(args: { include_uptime?: boolean }) {
  const info: Record<string, unknown> = {
    product: 'DorkOS',
    port: process.env.DORKOS_PORT ?? '4242',
    version: process.env.DORKOS_VERSION ?? 'development',
  };
  if (args.include_uptime) {
    info.uptime_seconds = Math.floor(process.uptime());
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(info, null, 2),
      },
    ],
  };
}
```

- **Description:** `"Returns DorkOS server metadata including version, port, and optionally uptime."`
- **Input:** `{ include_uptime: z.boolean().optional().describe('Include server uptime in seconds') }`
- **Output:** `{ product: "DorkOS", port: "<number>", version: "<string>", uptime_seconds?: <number> }`
- **Validates:** Zod optional fields, typed args, env var access, JSON response format

#### Tool 3: `get_session_count`

Validates the dependency injection pattern — handler captures `TranscriptReader` in closure.

```typescript
/**
 * Session count handler — returns the number of sessions from SDK transcripts.
 * Validates the dependency injection pattern needed for future service-dependent tools.
 */
export function createGetSessionCountHandler(deps: McpToolDeps) {
  return async function handleGetSessionCount() {
    try {
      const sessions = await deps.transcriptReader.listSessions(deps.defaultCwd);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              count: sessions.length,
              cwd: deps.defaultCwd,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : 'Failed to list sessions',
            }),
          },
        ],
        isError: true,
      };
    }
  };
}
```

- **Description:** `"Returns the number of sessions visible in the SDK transcript directory."`
- **Input:** empty Zod object `{}`
- **Output:** `{ count: <number>, cwd: "<path>" }`
- **Validates:** Dependency injection via closure, async service access, error handling pattern
- **Dependencies:** `McpToolDeps.transcriptReader`, `McpToolDeps.defaultCwd`

#### Factory Function

```typescript
/**
 * Create the DorkOS MCP tool server with all registered tools.
 * Called once at server startup. The returned server instance is injected
 * into AgentManager and passed to every SDK query() call.
 */
export function createDorkOsToolServer(deps: McpToolDeps) {
  const handleGetSessionCount = createGetSessionCountHandler(deps);

  return createSdkMcpServer({
    name: 'dorkos',
    version: '1.0.0',
    tools: [
      tool(
        'ping',
        'Check that the DorkOS server MCP integration is working. Returns pong with a timestamp.',
        {},
        handlePing
      ),
      tool(
        'get_server_info',
        'Returns DorkOS server metadata including version, port, and optionally uptime.',
        { include_uptime: z.boolean().optional().describe('Include server uptime in seconds') },
        handleGetServerInfo
      ),
      tool(
        'get_session_count',
        'Returns the number of sessions visible in the SDK transcript directory.',
        {},
        handleGetSessionCount
      ),
    ],
  });
}
```

**Error handling pattern:** All tool handlers wrap their logic in try/catch and return `{ isError: true }` on failure rather than throwing. Throwing from a handler is undefined SDK behavior. The `ping` and `get_server_info` handlers are simple enough to not need try/catch. The `get_session_count` handler demonstrates the error wrapping pattern because it calls an external service.

### 4. Server Startup Wiring

In `apps/server/src/index.ts`, after singletons are initialized:

```typescript
import { createDorkOsToolServer } from './services/mcp-tool-server.js';

async function start() {
  // ... existing initialization (logger, configManager, boundary) ...

  // Create MCP tool server and inject into AgentManager
  const mcpToolServer = createDorkOsToolServer({
    transcriptReader,
    defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? path.resolve(__dirname, '../../../'),
  });
  agentManager.setMcpServers({ dorkos: mcpToolServer });

  // ... rest of existing startup (app, sessionBroadcaster, listen, tunnel) ...
}
```

### 5. Data Flow

```
User types message in DorkOS UI
  → POST /api/sessions/:id/messages
  → agentManager.sendMessage(sessionId, content, { cwd })
  → sdkOptions.mcpServers = { dorkos: mcpToolServer }    ← NEW
  → prompt wrapped as AsyncIterable<SDKUserMessage>       ← NEW
  → query({ prompt: makeUserPrompt(content), options: sdkOptions })
  → SDK subprocess runs WITH MCP tools available
  → Agent can call mcp__dorkos__ping, mcp__dorkos__get_server_info, mcp__dorkos__get_session_count
  → Tool call appears as content_block_start with type: 'tool_use', name: 'mcp__dorkos__ping'
  → canUseTool callback fires for MCP tools (existing approval flow, NO changes)
  → mapSdkMessage() → tool_call_start/delta/end StreamEvents (NO changes)
  → SSE response to client
  → Client renders tool call card (existing generic rendering)
```

### 6. Tool Naming Convention

Tools appear as `mcp__{server-name}__{tool-name}`:

| Server   | Tool                | Full Name                        |
| -------- | ------------------- | -------------------------------- |
| `dorkos` | `ping`              | `mcp__dorkos__ping`              |
| `dorkos` | `get_server_info`   | `mcp__dorkos__get_server_info`   |
| `dorkos` | `get_session_count` | `mcp__dorkos__get_session_count` |

These names flow through:

- `canUseTool` callback — hit the `default` mode approval path or auto-allow path
- `content_block_start` → `tool_call_start` event mapping in `mapSdkMessage()`
- `content_block_delta` → `tool_call_delta` event mapping
- `content_block_stop` → `tool_call_end` event mapping
- Client `ToolCallCard` component — renders generically by tool name

### 7. File Organization

```
apps/server/src/
├── services/
│   ├── agent-manager.ts          ← MODIFIED (setMcpServers, makeUserPrompt)
│   ├── mcp-tool-server.ts        ← NEW (factory + handlers)
│   ├── transcript-reader.ts      (unchanged)
│   ├── config-manager.ts         (unchanged)
│   └── __tests__/
│       ├── agent-manager.test.ts (unchanged)
│       └── mcp-tool-server.test.ts ← NEW (handler unit tests)
├── index.ts                      ← MODIFIED (wire up MCP server)
└── ...                           (unchanged)
```

Service count after: 17 files in `services/`. Within the advisory range per `server-structure.md` (domain grouping threshold at 15-20). No structural reorganization needed.

## User Experience

### Agent Interaction

When MCP tools are injected, the agent gains three new capabilities:

1. **"Can you ping the DorkOS server?"** → Agent calls `mcp__dorkos__ping` → Returns pong with timestamp
2. **"What version of DorkOS is running?"** → Agent calls `mcp__dorkos__get_server_info` with `include_uptime: true` → Returns version, port, uptime
3. **"How many sessions are active?"** → Agent calls `mcp__dorkos__get_session_count` → Returns count and cwd

### Permission Flow

In `default` permission mode, the DorkOS approval UI will show a tool approval prompt for each MCP tool call — identical to how it handles `Read`, `Edit`, `Bash`, etc. The user sees the tool name (e.g., `mcp__dorkos__ping`) and the input arguments, then approves or denies.

In `acceptEdits` and `bypassPermissions` modes, MCP tool calls are auto-approved — identical to built-in tools.

### No Client Changes

Tool calls from MCP tools appear as standard `tool_call_start/delta/end` stream events. The existing `ToolCallCard` component renders them generically using the tool name and input. No client-side awareness of MCP tools is needed.

## Testing Strategy

### Unit Tests: Tool Handlers

File: `apps/server/src/services/__tests__/mcp-tool-server.test.ts`

Tool handlers are exported as pure functions that take typed args and return `CallToolResult`. They can be tested without the SDK, MCP infrastructure, or any server setup.

```typescript
describe('MCP Tool Handlers', () => {
  describe('handlePing', () => {
    it('returns pong status with timestamp', async () => {
      // Purpose: Validates basic handler return shape and required fields
      const result = await handlePing();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('pong');
      expect(parsed.server).toBe('dorkos');
      expect(parsed.timestamp).toBeDefined();
    });

    it('returns valid ISO timestamp', async () => {
      // Purpose: Ensures timestamp is parseable, not just present
      const result = await handlePing();
      const parsed = JSON.parse(result.content[0].text);
      expect(() => new Date(parsed.timestamp)).not.toThrow();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });
  });

  describe('handleGetServerInfo', () => {
    it('returns server info without uptime by default', async () => {
      // Purpose: Validates optional field is absent when not requested
      const result = await handleGetServerInfo({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.product).toBe('DorkOS');
      expect(parsed.port).toBeDefined();
      expect(parsed.uptime_seconds).toBeUndefined();
    });

    it('includes uptime when requested', async () => {
      // Purpose: Validates Zod optional boolean field handling
      const result = await handleGetServerInfo({ include_uptime: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.uptime_seconds).toBeTypeOf('number');
      expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it('uses DORKOS_PORT env var when set', async () => {
      // Purpose: Validates environment variable access from tool handler
      const original = process.env.DORKOS_PORT;
      process.env.DORKOS_PORT = '9999';
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.port).toBe('9999');
      } finally {
        if (original !== undefined) process.env.DORKOS_PORT = original;
        else delete process.env.DORKOS_PORT;
      }
    });
  });

  describe('createGetSessionCountHandler', () => {
    it('returns session count from transcript reader', async () => {
      // Purpose: Validates dependency injection pattern works correctly
      const mockReader = {
        listSessions: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]),
      };
      const handler = createGetSessionCountHandler({
        transcriptReader: mockReader as any,
        defaultCwd: '/test/cwd',
      });
      const result = await handler();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(3);
      expect(parsed.cwd).toBe('/test/cwd');
      expect(mockReader.listSessions).toHaveBeenCalledWith('/test/cwd');
    });

    it('returns isError when transcript reader fails', async () => {
      // Purpose: Validates error handling pattern (return isError, don't throw)
      const mockReader = {
        listSessions: vi.fn().mockRejectedValue(new Error('ENOENT')),
      };
      const handler = createGetSessionCountHandler({
        transcriptReader: mockReader as any,
        defaultCwd: '/test/cwd',
      });
      const result = await handler();
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('ENOENT');
    });

    it('returns zero for empty session directory', async () => {
      // Purpose: Validates edge case — no sessions is a valid state
      const mockReader = {
        listSessions: vi.fn().mockResolvedValue([]),
      };
      const handler = createGetSessionCountHandler({
        transcriptReader: mockReader as any,
        defaultCwd: '/test/cwd',
      });
      const result = await handler();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
    });
  });
});
```

### Unit Tests: createDorkOsToolServer Factory

```typescript
describe('createDorkOsToolServer', () => {
  it('returns a server config with name "dorkos"', () => {
    // Purpose: Validates factory output shape matches SDK expectations
    const server = createDorkOsToolServer({
      transcriptReader: {} as any,
      defaultCwd: '/test',
    });
    expect(server).toBeDefined();
    // The exact shape depends on createSdkMcpServer return type
  });
});
```

### Mocking Strategy

- **Tool handler tests:** No mocking of SDK needed — handlers are plain async functions
- **`TranscriptReader`:** Mocked via partial interface matching (`{ listSessions: vi.fn() }`)
- **`process.env`:** Set/restore in individual tests with try/finally
- **`process.uptime()`:** Can be spied on if needed, but testing against `>= 0` is sufficient
- **SDK `createSdkMcpServer`:** Mocked in factory tests with `vi.mock('@anthropic-ai/claude-agent-sdk')`

### What Is NOT Tested

- **Integration with actual SDK subprocess:** The SDK spawns a Claude Code subprocess — integration testing requires a running API key and model access. This is validated manually.
- **Client rendering of MCP tool calls:** The client generically renders all `tool_call_start/end` events — existing client tests cover this.
- **Permission mode interaction:** Existing `agent-manager.test.ts` covers `canUseTool` routing. MCP tools hit the same code path with `mcp__*` names.

## Performance Considerations

| Consideration                             | Impact                                        | Mitigation                                                                                          |
| ----------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `createSdkMcpServer()` called per-request | Would create MCP infrastructure every message | Called **once at startup**, stored as instance field                                                |
| `AsyncIterable` prompt overhead           | Extra generator wrapper per message           | Negligible — single-item generator yields immediately                                               |
| MCP tool search (`ENABLE_TOOL_SEARCH`)    | Large tool sets consume context window        | 3 tools is far below the 10% context threshold                                                      |
| Tool handler execution time               | Blocks agent turn while handler runs          | `ping` is instant; `get_server_info` reads env vars; `get_session_count` does filesystem I/O (fast) |
| MCP server in `mcpServers` record         | Serialized in init message metadata           | Minimal overhead — server name + tool count                                                         |

## Security Considerations

1. **Tool handlers run in-process.** An infinite loop or panic in a handler blocks the entire agent turn. All handlers that call external services (like `TranscriptReader`) are wrapped in try/catch.

2. **Tool inputs are model-generated.** Zod schema validation (enforced by the SDK before calling the handler) provides defense in depth. Never trust tool inputs without validation.

3. **Permission mode applies.** In `default` permission mode, users must approve MCP tool calls via the existing DorkOS approval UI. This is intentional — users should see and approve custom tool calls. The `canUseTool` callback handles this transparently with no special-casing for `mcp__dorkos__*` tools.

4. **No dangerous operations exposed.** The PoC tools return read-only server metadata. No tool executes shell commands, writes files, or modifies state. Future tools that modify state (e.g., scheduler job creation) should be carefully designed with input validation and audit logging.

5. **`allowedTools` not restricted.** The current implementation does not set `allowedTools`, following the existing pattern in `sendMessage()`. All tools (built-in and MCP) are available. If selective tool availability is needed later, `allowedTools` can be set with wildcards like `mcp__dorkos__*`.

## Documentation

### Updates Required

| Document                        | Change                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `CLAUDE.md`                     | Add `mcp-tool-server.ts` to server services list (17th service) |
| `contributing/architecture.md`  | Add MCP tool injection section under "Server Architecture"      |
| `contributing/api-reference.md` | Note that MCP tool calls appear as standard tool events in SSE  |

### No New Documentation Files

This is server-internal architecture. No external user-facing documentation is needed. The tools are discoverable by the agent via the SDK's tool listing mechanism.

## Implementation Phases

### Phase 1: Core Plumbing (This Spec)

1. Add `makeUserPrompt()` helper to `agent-manager.ts`
2. Convert `query()` call to use `AsyncIterable` prompt form
3. Add `setMcpServers()` method to `AgentManager`
4. Create `services/mcp-tool-server.ts` with 3 tools
5. Wire up in `index.ts`
6. Write unit tests for all 3 handlers
7. Manual E2E validation: send "ping the server" in DorkOS UI

### Phase 2: Future Enhancements (Not This Spec)

- Scheduler management tools (`create_job`, `list_jobs`, `delete_job`)
- Configuration access tools (`get_config`, `set_config`)
- Session introspection tools (`get_session_details`, `list_active_sessions`)
- System prompt append with tool usage hints
- Multi-server architecture (one per domain) when tool count exceeds 10
- MCP server health reporting in `session_status` events

## Open Questions

All questions have been resolved during ideation. No open questions remain.

## Related ADRs

| ADR                                                                                                       | Relevance                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [0001 — Use Hexagonal Architecture](../../decisions/0001-use-hexagonal-architecture.md)                   | MCP tool server is a new adapter in the hexagonal architecture. The `McpToolDeps` interface follows the ports/adapters pattern.       |
| [0003 — SDK JSONL as Single Source of Truth](../../decisions/0003-sdk-jsonl-as-single-source-of-truth.md) | The `get_session_count` tool reads from SDK transcripts via `TranscriptReader`, maintaining JSONL as the authoritative session store. |

## Acceptance Criteria

1. Agent can call `mcp__dorkos__ping` and receive a pong response with timestamp
2. Agent can call `mcp__dorkos__get_server_info` with and without `include_uptime` flag
3. Agent can call `mcp__dorkos__get_session_count` and get a real count from TranscriptReader
4. Tool calls show up in the DorkOS UI as normal `tool_call_start`/`tool_call_end` events
5. In `default` permission mode, MCP tool calls trigger the approval prompt
6. In `acceptEdits` and `bypassPermissions` modes, MCP tool calls auto-approve
7. Session continuity (`resume`) works with MCP tools injected
8. All 3 tool handler functions have unit tests with meaningful assertions
9. Existing tests continue to pass (no regressions)
10. No changes to routes, client, or shared packages

## References

- [Claude Agent SDK — Custom Tools Guide](https://platform.claude.com/docs/en/agent-sdk/custom-tools) — `createSdkMcpServer`, `tool`, AsyncIterable constraint
- [Claude Agent SDK — MCP Guide](https://platform.claude.com/docs/en/agent-sdk/mcp) — `mcpServers` option, tool naming convention, `allowedTools` wildcards
- [Claude Agent SDK — TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — `Options`, `SDKMessage`, `CallToolResult` types
- [research/mcp-tool-injection-patterns.md](../../research/mcp-tool-injection-patterns.md) — Architecture options analysis, PoC tool design, security/performance considerations
- [research/claude-code-sdk-agent-capabilities.md](../../research/claude-code-sdk-agent-capabilities.md) — Full SDK Options reference, unused capabilities inventory
- [research/scheduler-comparison.md](../../research/scheduler-comparison.md) — Three-layer architecture recommendation that motivates this foundational plumbing
