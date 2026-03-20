---
title: 'MCP Tool Injection Patterns for DorkOS Agent Manager'
date: 2026-02-17
type: implementation
status: archived
tags: [mcp, tool-injection, agent-manager, sdk, claude-agent-sdk]
feature_slug: dynamic-mcp-tools
---

# MCP Tool Injection Patterns for DorkOS Agent Manager

**Feature**: dynamic-mcp-tools
**Date**: 2026-02-17
**Research Mode**: Deep Research
**Sources**: Official Claude Agent SDK docs (custom-tools, mcp, typescript API reference), agent-manager.ts source

---

## Research Summary

The Claude Agent SDK provides a first-class `createSdkMcpServer()` + `tool()` API for defining in-process MCP tools. These tools are passed to `query()` via `mcpServers` and `allowedTools`. There is one hard constraint: **when `mcpServers` is provided, `prompt` must be an `AsyncIterable<SDKUserMessage>`, not a plain string**. This constraint requires changes to `agent-manager.ts`'s `sendMessage()` call site. The `resume` option is fully compatible with `mcpServers`, enabling session continuity with injected tools. The `canUseTool` handler fires for MCP tool calls just as it does for built-in tools, so existing approval flows are unaffected.

---

## Key Findings

### 1. The `prompt` AsyncIterable Constraint

**This is the most important architectural constraint.**

From the official docs:

> **Important:** Custom MCP tools require streaming input mode. You must use an async generator/iterable for the `prompt` parameter — a simple string will not work with MCP servers.

Current `agent-manager.ts` calls:

```typescript
const agentQuery = query({ prompt: content, options: sdkOptions });
```

Where `content` is a `string`. This must change to:

```typescript
async function* makePrompt(content: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
  };
}

const agentQuery = query({ prompt: makePrompt(content), options: sdkOptions });
```

This change is required **only when `mcpServers` is non-empty**. It can safely be applied unconditionally because the SDK accepts `AsyncIterable` for all query types — there is no regression risk from always using the generator form.

### 2. Tool Naming Convention

MCP tools in the SDK follow the pattern:

```
mcp__{server-name}__{tool-name}
```

Examples:

- Server `"dorkos-tools"`, tool `"ping"` → `mcp__dorkos-tools__ping`
- Server `"dorkos-tools"`, tool `"get_session_stats"` → `mcp__dorkos-tools__get_session_stats`

The `allowedTools` option must explicitly list these names or use wildcards:

```typescript
allowedTools: ['mcp__dorkos-tools__*']; // All tools from server
allowedTools: ['mcp__dorkos-tools__ping']; // Single tool
```

### 3. `resume` + `mcpServers` Compatibility

From TypeScript API reference and session docs: `resume` is a standard `Options` field that coexists with `mcpServers`. The SDK uses the session ID to reload conversation history, while `mcpServers` defines tools available in the new turn. There is no documented incompatibility. The existing `session.hasStarted` pattern in `agent-manager.ts` (`sdkOptions.resume = session.sdkSessionId`) works unchanged.

### 4. `canUseTool` Fires for MCP Tools

The existing `canUseTool` hook in `agent-manager.ts` receives tool names including `mcp__*` names. The current handler has two branches:

1. `toolName === 'AskUserQuestion'` → routes to question handler
2. `permissionMode === 'default'` → routes to approval handler
3. Otherwise → auto-allow

MCP tools named `mcp__dorkos-tools__ping` will hit branch 2 or 3 depending on permission mode. This is correct behavior: in `default` mode, the DorkOS approval UI will prompt the user before running a custom MCP tool. No changes needed to `canUseTool`.

### 5. `allowedTools` Interaction with Existing Tools

`allowedTools` is a whitelist. When specified, only listed tools are available. The existing `sendMessage()` does not set `allowedTools`, which means all tools are available by default. When injecting MCP servers, `allowedTools` for those servers must be added without blocking existing built-in tools. The correct pattern is to **merge** MCP tool names into the existing allowed set, not replace it.

### 6. `createSdkMcpServer()` Return Type

The function returns `McpSdkServerConfigWithInstance`:

```typescript
type McpSdkServerConfigWithInstance = {
  type: 'sdk';
  name: string;
  instance: McpServer;
};
```

This is passed into `mcpServers` as a value in the record object:

```typescript
mcpServers: {
  "dorkos-tools": createSdkMcpServer({ name: "dorkos-tools", tools: [...] })
}
```

### 7. Tool Handler Signature

```typescript
tool(
  name: string,
  description: string,
  inputSchema: ZodRawShape,  // Object of Zod validators
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
)
```

Return type must be `CallToolResult`:

```typescript
{
  content: [{ type: "text", text: "..." }],
  isError?: boolean
}
```

### 8. Error Handling in Tool Handlers

Handlers should catch internally and return an error result rather than throwing:

```typescript
try {
  // ...
  return { content: [{ type: 'text', text: result }] };
} catch (err) {
  return {
    content: [{ type: 'text', text: `Error: ${err.message}` }],
    isError: true,
  };
}
```

Throwing from a handler is undefined behavior — the SDK may surface it as an agent error, breaking the session.

---

## Detailed Analysis

### Architecture Option A: Single MCP Server with All DorkOS Tools

**Structure:**

```typescript
// services/mcp-tool-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export function createDorkOsToolServer(deps: { transcriptReader: TranscriptReader }) {
  return createSdkMcpServer({
    name: 'dorkos-tools',
    version: '1.0.0',
    tools: [
      tool('ping', 'Check server health', {}, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      })),
      tool('get_session_count', 'Return number of active SDK sessions', {}, async () => {
        const sessions = await deps.transcriptReader.listSessions();
        return { content: [{ type: 'text', text: `${sessions.length} sessions` }] };
      }),
    ],
  });
}
```

**Pros:**

- Single `mcpServers` entry, simple to manage
- All tools in one place, easy to discover
- One wildcard `allowedTools` covers everything: `mcp__dorkos-tools__*`
- Tool count visible at a glance
- Easy to test the server as a unit

**Cons:**

- Tools from unrelated domains (session info, file ops, git) share one server namespace
- Cannot enable/disable individual feature groups without listing individual tool names
- As tool count grows, the server file violates the 300-line limit

**Verdict:** Good for fewer than 10 tools. Start here for the PoC.

---

### Architecture Option B: Multiple Servers (One per Feature Domain)

**Structure:**

```typescript
mcpServers: {
  'dorkos-session': createSessionToolServer(deps),
  'dorkos-git':     createGitToolServer(deps),
  'dorkos-config':  createConfigToolServer(deps),
}
```

**Pros:**

- Clean domain separation, consistent with server's flat `services/` approach
- Can enable/disable entire domains: `allowedTools: ['mcp__dorkos-session__*']`
- Tools for a domain stay co-located with that domain's service code
- Smaller individual server files

**Cons:**

- More `mcpServers` entries to compose
- Tool naming is more verbose: `mcp__dorkos-session__get_count` vs `mcp__dorkos__get_session_count`
- Multi-server composition requires a registry/factory pattern

**Verdict:** Better at scale (10+ tools). Migrate to this as the tool set grows.

---

### Architecture Option C: Static Registration at Startup

**Structure:**

```typescript
// server/index.ts
const mcpServer = createDorkOsToolServer({ transcriptReader, configManager });
agentManager.setMcpServers({ 'dorkos-tools': mcpServer });
```

The `AgentManager` holds the server instance and injects it into every `query()` call.

**Pros:**

- Zero per-request setup cost
- Dependencies injected once at construction time
- Consistent tool availability across all sessions
- Simple to reason about: tools are always there

**Cons:**

- Cannot vary tools per session or per user
- Hot-reload of tool definitions requires server restart
- Dependencies captured at startup (fine for singletons like `transcriptReader`)

**Verdict:** Correct for DorkOS. Server services are singletons. Always use static registration.

---

### Architecture Option D: Dynamic Composition Per Session

**Structure:**

```typescript
// Per sendMessage() call, compose tools based on session context
const tools = buildToolsForSession(session, deps);
sdkOptions.mcpServers = tools.servers;
sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...tools.allowedNames];
```

**Pros:**

- Can customize tool availability based on session permissions
- Can inject session-specific context into tool closures
- Enables future per-user tool subsets

**Cons:**

- `createSdkMcpServer()` is called on every message — unclear if this is safe/cheap
- The SDK docs do not document whether creating a new MCP server instance per call is supported
- More complex, harder to debug
- Likely creates a new in-process MCP server subprocess per call (potential leak)

**Verdict:** Avoid. Use static registration with session context passed via dependency injection into the tool handlers instead.

---

### Dependency Injection into Tool Handlers

Tool handlers are closures. Dependencies are captured at server creation time:

```typescript
export function createDorkOsToolServer(deps: McpToolDeps) {
  return createSdkMcpServer({
    name: 'dorkos-tools',
    version: '1.0.0',
    tools: [
      tool('get_active_sessions', 'List active SDK sessions', {}, async () => {
        // deps.transcriptReader is captured from the outer scope
        const sessions = await deps.transcriptReader.listSessions();
        return {
          content: [{ type: 'text', text: JSON.stringify(sessions.map((s) => s.id)) }],
        };
      }),
    ],
  });
}

// In index.ts (startup):
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  configManager: getConfigManager(),
});
agentManager.setMcpServers({ 'dorkos-tools': mcpToolServer });
```

This pattern:

- Keeps tool handlers pure (no global state access)
- Makes dependencies explicit and testable
- Allows mocking `deps` in unit tests

---

### Testing MCP Tools in Isolation

Since tool handlers are plain async functions that receive typed `args` and return `CallToolResult`, they can be tested without starting the SDK or any MCP infrastructure:

```typescript
// services/__tests__/mcp-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDorkOsToolServer } from '../mcp-tool-server';

describe('DorkOS MCP tools', () => {
  it('ping returns pong', async () => {
    const server = createDorkOsToolServer({ transcriptReader: mockReader });
    // Extract handler by name — requires exposing tool definitions for testing
    // OR: test by calling the handler function directly if exported
    const result = await pingHandler({}, {});
    expect(result.content[0].text).toBe('pong');
  });

  it('get_session_count returns count', async () => {
    const mockReader = { listSessions: vi.fn().mockResolvedValue([{}, {}, {}]) };
    const result = await getSessionCountHandler({}, {});
    expect(result.content[0].text).toContain('3');
  });
});
```

**Best practice:** Export tool handler functions separately from the `tool()` wrapper so they can be unit tested directly. The `tool()` wrapper is only needed at server construction time.

```typescript
// Testable
export async function handlePing(_args: Record<never, never>): Promise<CallToolResult> {
  return { content: [{ type: 'text', text: 'pong' }] };
}

// Server registration
export function createDorkOsToolServer(deps: McpToolDeps) {
  return createSdkMcpServer({
    name: 'dorkos-tools',
    tools: [
      tool('ping', 'Check server health', {}, handlePing),
      // ...
    ],
  });
}
```

---

### What Makes a Good Tool Description

Claude uses tool descriptions to decide when and whether to invoke a tool. Effective descriptions:

1. **State the capability concretely**: "Returns the number of active Claude sessions currently tracked in memory" — not "Gets sessions"
2. **Include when to use it**: "Use this when the user asks about session count, active agents, or running conversations"
3. **State what it returns**: "Returns a JSON array of session IDs"
4. **Include constraints**: "Does not return sessions that have expired due to 30-minute timeout"

Poor description → Claude ignores the tool or uses it incorrectly.

---

### Proof-of-Concept Tool Design: `ping`

The ideal PoC tool is `ping` because it:

- Has zero input schema (validates that empty Zod schemas work)
- Has a synchronous handler (no async complexity)
- Has a deterministic response (easy to assert in tests)
- Does not interact with any service (validates the injection plumbing, not the tool logic)
- Is named clearly so Claude will use it when asked "can you ping the server?"

```typescript
tool(
  'ping',
  'Check that the DorkOS server MCP integration is working. Returns "pong" with a timestamp. Use when asked to verify the server connection.',
  {},
  async (_args): Promise<CallToolResult> => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ status: 'pong', timestamp: new Date().toISOString() }),
      },
    ],
  })
);
```

A second good PoC tool is `get_server_info` with a simple Zod schema:

```typescript
tool(
  'get_server_info',
  'Returns DorkOS server metadata: version, uptime, and port. Use when asked about the server.',
  {
    include_uptime: z.boolean().optional().describe('Include uptime in seconds'),
  },
  async (args): Promise<CallToolResult> => {
    const info: Record<string, unknown> = {
      product: 'DorkOS',
      port: process.env.DORKOS_PORT ?? '4242',
    };
    if (args.include_uptime) {
      info.uptime_seconds = Math.floor(process.uptime());
    }
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
  }
);
```

This validates:

- Optional Zod fields work
- `args` is correctly typed
- Environment variable access works from handlers
- JSON response format

---

### Changes Required in `agent-manager.ts`

#### 1. Accept MCP server configuration

Add `mcpServers` field to `AgentManager`:

```typescript
private mcpServers: Record<string, McpServerConfig> = {};
private mcpAllowedTools: string[] = [];

setMcpServers(
  servers: Record<string, McpServerConfig>,
  allowedTools?: string[]
): void {
  this.mcpServers = servers;
  this.mcpAllowedTools = allowedTools ?? Object.keys(servers).map(name => `mcp__${name}__*`);
}
```

#### 2. Convert `prompt` to AsyncIterable when MCP servers are active

```typescript
const hasMcpServers = Object.keys(this.mcpServers).length > 0;

if (hasMcpServers) {
  sdkOptions.mcpServers = this.mcpServers;
  // Merge MCP tool names with any existing allowedTools
  if (this.mcpAllowedTools.length > 0) {
    sdkOptions.allowedTools = [...(sdkOptions.allowedTools ?? []), ...this.mcpAllowedTools];
  }
}

async function* makePrompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
  };
}

// Use generator form always (safe, required when mcpServers present)
const agentQuery = query({
  prompt: hasMcpServers ? makePrompt() : content,
  options: sdkOptions,
});
```

Or more cleanly, always use the generator form:

```typescript
const agentQuery = query({ prompt: makePrompt(content), options: sdkOptions });
```

#### 3. No changes to `canUseTool`

MCP tool calls arrive with `mcp__*` names. The existing handler correctly routes them:

- `permissionMode === 'default'` → user sees approval prompt (correct — user should approve custom tools)
- `permissionMode === 'acceptEdits'` or `bypassPermissions'` → auto-allowed (correct)

No changes needed.

---

## Potential Solutions

### Solution 1: Minimal PoC (Recommended for First Iteration)

**What:** Add a `setMcpServers()` method to `AgentManager`. Create `services/mcp-tool-server.ts` with a `ping` tool and a `get_server_info` tool. Wire up in `index.ts`. Always use the `AsyncIterable` prompt form.

**Pros:**

- Minimal diff, low risk
- Validates the full plumbing end-to-end
- Single server, single `allowedTools` wildcard
- No new abstractions — stays within current flat `services/` structure (16 files, within the 15-20 range but borderline)

**Cons:**

- Does not handle per-session tool variation (not needed yet)
- Tool server creation is eager (acceptable for singletons)

**Risk:** Low. The only breaking change is the `prompt` type change, which is backward-compatible.

---

### Solution 2: MCP Tool Registry Service

**What:** A `McpToolRegistry` service that tools register themselves with. The registry assembles the `createSdkMcpServer()` call. Tools are declared as plain objects with a `handler` function and Zod schema.

**Pros:**

- Tools can be defined close to their domain service
- Registry provides a central inventory for debugging/logging
- Can add tool middleware (timing, error wrapping) in one place

**Cons:**

- Extra abstraction layer for 2-3 tools
- More complex than needed for a PoC
- Registry pattern risks becoming a service locator anti-pattern

**Verdict:** Premature for the PoC. Revisit when there are 10+ tools.

---

### Solution 3: Plugin-Based Tool Loading

**What:** Use the SDK's `plugins` option to load tool servers from plugin directories. Each plugin can export an MCP server.

**Pros:**

- Hot-reloadable tools
- Third-party tool extension points

**Cons:**

- Plugins require a local directory path, not in-process instances
- No benefit over `createSdkMcpServer()` for internal tools
- Adds filesystem coupling

**Verdict:** Not appropriate for DorkOS internal tools.

---

## Security Considerations

1. **Tool handlers run in the same process as the Express server.** A panicking or infinite-loop handler blocks the agent turn. Wrap all handlers in try/catch with timeouts if calling external services.

2. **MCP tool inputs are provided by Claude (the model).** Even though Claude constructs the inputs, they should still be validated with Zod schemas. The SDK validates against the schema before calling the handler, but defense in depth is good practice.

3. **`canUseTool` fires for MCP tools in `default` permission mode.** This means users must explicitly approve MCP tool calls in the standard DorkOS approval UI. This is the correct behavior — do not auto-allow MCP tools at the `agent-manager.ts` level; let the permission system handle it.

4. **Do not expose sensitive service internals via MCP tools.** Tools like `get_session_stats` that return internal metrics are fine. Tools that take arbitrary SQL queries or shell commands would be dangerous — those are exactly the kinds of tools that should stay in Claude's built-in `Bash`/`Grep` repertoire with the existing permission system.

5. **`allowedTools` wildcards (`mcp__dorkos-tools__*`)** are appropriate for trusted internal tools. For any future external/third-party MCP server added to DorkOS, enumerate tools explicitly rather than using wildcards.

---

## Performance Considerations

1. **`createSdkMcpServer()` should be called once at startup, not per request.** The SDK documentation implies the instance is long-lived. Creating a new instance per `sendMessage()` call would spawn unnecessary in-process infrastructure on every turn.

2. **The `AsyncIterable` prompt form** has negligible overhead vs a plain string — it's a single-item generator that yields immediately.

3. **MCP tool search** (`ENABLE_TOOL_SEARCH`) activates automatically when tools consume >10% of the context window. With 2-5 DorkOS internal tools, this threshold will not be reached. No configuration needed.

4. **MCP server connection status** is visible in the `system` init message (`message.mcp_servers`). The current `mapSdkMessage` handler for `system/init` events extracts the model but discards `mcp_servers`. A future enhancement could emit a `session_status` event with MCP server health info.

---

## Recommendation

**Adopt Solution 1 (Minimal PoC)** with the following implementation plan:

### Step 1: Add `prompt` AsyncIterable support to `sendMessage()`

Change the `query()` call to always use the generator form. This is a safe, non-breaking change and unblocks all MCP functionality.

```typescript
// Helper (can be a local function or a module-level utility)
async function* makeUserPrompt(content: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
  };
}

// In sendMessage():
const agentQuery = query({ prompt: makeUserPrompt(content), options: sdkOptions });
```

### Step 2: Create `services/mcp-tool-server.ts`

New file with:

- `McpToolDeps` interface (explicit dependency types)
- Exported pure handler functions (for unit testing)
- `createDorkOsToolServer(deps)` factory function
- Initial tools: `ping`, `get_server_info`

### Step 3: Add `setMcpServers()` to `AgentManager`

Store `mcpServers` and `mcpAllowedTools` as instance fields. Inject into `sdkOptions` inside `sendMessage()` before the `query()` call.

### Step 4: Wire up in `index.ts`

After the server starts and singletons are initialized, call `agentManager.setMcpServers(...)`.

### Step 5: Write tests

- Unit test `handlePing` and `handleGetServerInfo` directly
- Integration test: send "ping the server" to an agent session, verify `tool_call_start` event with `mcp__dorkos-tools__ping` appears in the stream

### File Impact

| File                                                         | Change Type | Notes                                                  |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------------ |
| `apps/server/src/services/agent-manager.ts`                  | Modify      | Add `setMcpServers()`, convert prompt to AsyncIterable |
| `apps/server/src/services/mcp-tool-server.ts`                | New         | PoC tool definitions and factory                       |
| `apps/server/src/index.ts`                                   | Modify      | Wire up tool server after startup                      |
| `apps/server/src/services/__tests__/mcp-tool-server.test.ts` | New         | Unit tests for tool handlers                           |

Service count after: 17 files — within the "consider domain grouping" advisory range (15-20) per server-structure rules.

---

## Research Gaps and Limitations

1. **Does `createSdkMcpServer()` support hot-reload?** Not documented. Assumed static for now.
2. **What happens if a tool handler throws vs returns `isError: true`?** The docs show the error return pattern but do not document throw behavior. Safe to assume throwing is undefined behavior.
3. **Can `allowedTools` accept wildcard patterns for built-in tools?** The docs show `mcp__server__*` wildcards but do not document wildcards for built-in tools (e.g., `Bash*`). Not relevant for this feature.
4. **Does the SDK emit an event when an MCP tool is called?** Based on the stream event pattern in `mapSdkMessage`, MCP tool calls appear as `tool_use` content blocks with name `mcp__server__tool`. This should work with the existing `tool_call_start`/`tool_call_end` mapping without changes.
5. **Maximum tool handler execution time before the SDK times out?** Not documented. The SDK's default MCP connection timeout is 60 seconds — tool execution timeout is separate and not documented.

---

## Contradictions and Disputes

None found. The official docs and TypeScript types are consistent. The only potentially ambiguous point is whether `resume` + `mcpServers` is fully supported — the TypeScript `Options` type shows both as independent optional fields with no mutual exclusivity constraint, and the sessions docs show `resume` used with any other option, making compatibility the safe assumption.

---

## Sources and Evidence

- "Custom MCP tools require streaming input mode. You must use an async generator/iterable for the `prompt` parameter" — [Custom Tools Guide](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- `tool()` function signature with Zod `ZodRawShape` schema — [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- `McpSdkServerConfigWithInstance` type definition — [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- `allowedTools` wildcard syntax: `"mcp__claude-code-docs__*"` — [MCP Guide](https://platform.claude.com/docs/en/agent-sdk/mcp)
- Tool naming pattern `mcp__{server-name}__{tool-name}` — [MCP Guide](https://platform.claude.com/docs/en/agent-sdk/mcp) and [Custom Tools Guide](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- `canUseTool` signature compatible with MCP tool names — [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) (`CanUseTool` type receives `toolName: string`)
- `resume` option is an independent `Options` field — [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)

---

## Search Methodology

- Searches performed: 3 web fetches (custom-tools, mcp, typescript API reference)
- Primary sources: Official Anthropic Agent SDK documentation
- Cross-referenced against current `agent-manager.ts` source (549 lines)
- Cross-referenced against `interactive-handlers.ts` to confirm `canUseTool` compatibility
