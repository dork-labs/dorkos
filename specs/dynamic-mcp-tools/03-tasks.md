---
slug: dynamic-mcp-tools
number: 41
created: 2026-02-17
status: specified
last_decompose: 2026-02-17
---

# Dynamic MCP Tool Injection — Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Phase:** Core Plumbing (Phase 1 only — this spec)
**Total Tasks:** 7

---

## Phase 1: Core Plumbing — Foundation

### Task 1: Add `makeUserPrompt` helper and convert `query()` call

**Objective:** Add the `AsyncIterable<SDKUserMessage>` prompt wrapper to `agent-manager.ts` and update the `query()` call site to always use it.

**Files Modified:**

- `apps/server/src/services/agent-manager.ts`

**Implementation:**

1. Add the `makeUserPrompt` generator function (before the `AgentManager` class):

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

2. Update the `query()` call in `sendMessage()` (line 213) from:

```typescript
const agentQuery = query({ prompt: content, options: sdkOptions });
```

To:

```typescript
const agentQuery = query({ prompt: makeUserPrompt(content), options: sdkOptions });
```

**Acceptance Criteria:**

- [ ] `makeUserPrompt` is a module-level `async function*` in `agent-manager.ts`
- [ ] It yields a single `{ type: 'user', message: { role: 'user', content } }` object
- [ ] The `query()` call uses `makeUserPrompt(content)` instead of plain `content`
- [ ] The `AsyncIterable` form is used unconditionally (no conditional branch)
- [ ] All existing agent-manager tests still pass (`npx vitest run apps/server/src/services/__tests__/agent-manager.test.ts`)
- [ ] Build succeeds (`npm run build`)

---

### Task 2: Add `setMcpServers` method and MCP injection to `AgentManager`

**Objective:** Add the `mcpServers` private field and `setMcpServers()` public method to `AgentManager`, then inject `mcpServers` into `sdkOptions` before the `query()` call.

**Files Modified:**

- `apps/server/src/services/agent-manager.ts`

**Implementation:**

1. Add a private field to the `AgentManager` class (after existing fields like `claudeCliPath`):

```typescript
private mcpServers: Record<string, unknown> = {};
```

2. Add a public setter method:

```typescript
/**
 * Register MCP tool servers to be injected into every SDK query() call.
 * Called once at server startup after singleton services are initialized.
 */
setMcpServers(servers: Record<string, unknown>): void {
  this.mcpServers = servers;
}
```

3. In `sendMessage()`, inject `mcpServers` into `sdkOptions` AFTER the permission mode switch and model setting (after line 176), BEFORE the `canUseTool` callback (before line 178):

```typescript
// Inject MCP tool servers (if any registered)
if (Object.keys(this.mcpServers).length > 0) {
  (sdkOptions as Record<string, unknown>).mcpServers = this.mcpServers;
}
```

**Note:** The `Record<string, unknown>` cast follows the same pattern already used on line 175 for `model`.

**Acceptance Criteria:**

- [ ] `mcpServers` is a private field initialized to `{}`
- [ ] `setMcpServers()` is a public method that sets the field
- [ ] MCP servers are injected into `sdkOptions` only when non-empty
- [ ] The cast pattern matches the existing `model` cast on line 175
- [ ] Injection happens before `canUseTool` and before `query()` call
- [ ] All existing agent-manager tests still pass
- [ ] TypeScript compiles without errors

---

### Task 3: Create `mcp-tool-server.ts` with `McpToolDeps` interface and 3 tool handlers

**Objective:** Create the new MCP tool server module with the `McpToolDeps` dependency injection interface, 3 tool handler functions (`handlePing`, `handleGetServerInfo`, `createGetSessionCountHandler`), and the `createDorkOsToolServer` factory function.

**Files Created:**

- `apps/server/src/services/mcp-tool-server.ts`

**Implementation:**

Create the file `apps/server/src/services/mcp-tool-server.ts` with the following content:

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

/**
 * Session count handler factory — returns the number of sessions from SDK transcripts.
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

**Error handling pattern:** All tool handlers that call external services wrap logic in try/catch and return `{ isError: true }` on failure rather than throwing. `ping` and `get_server_info` are simple enough to skip try/catch. `get_session_count` demonstrates the error wrapping pattern.

**Acceptance Criteria:**

- [ ] File exists at `apps/server/src/services/mcp-tool-server.ts`
- [ ] `McpToolDeps` interface exports `transcriptReader` and `defaultCwd` fields
- [ ] `handlePing` is exported, takes no args, returns `{ content: [{ type: 'text', text }] }`
- [ ] `handleGetServerInfo` is exported, accepts `{ include_uptime?: boolean }`, reads env vars
- [ ] `createGetSessionCountHandler` is exported, captures deps in closure, returns async handler
- [ ] `createDorkOsToolServer` is exported, creates server with `name: 'dorkos'`, `version: '1.0.0'`, and 3 tools
- [ ] Error handler in `get_session_count` returns `{ isError: true }` instead of throwing
- [ ] TypeScript compiles without errors

---

### Task 4: Wire MCP tool server in `index.ts` startup

**Objective:** Import and initialize the MCP tool server in the server startup function, then inject it into the `agentManager` singleton.

**Files Modified:**

- `apps/server/src/index.ts`

**Implementation:**

1. Add the import at the top of `index.ts`:

```typescript
import { createDorkOsToolServer } from './services/mcp-tool-server.js';
```

2. In the `start()` function, after the existing initialization (`initLogger`, `initConfigManager`, `initBoundary`) and BEFORE `createApp()`, add the MCP server creation and injection:

```typescript
// Create MCP tool server and inject into AgentManager
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? path.resolve(__dirname, '../../../'),
});
agentManager.setMcpServers({ dorkos: mcpToolServer });
```

Note: You'll also need to add `import path from 'path'` and `import { fileURLToPath } from 'url'` if not already present, plus:

```typescript
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

Check if `path` and `__dirname` are already available in the file. The `index.ts` currently does NOT have `path` or `__dirname` — they need to be added. The `defaultCwd` fallback should use the same resolution logic as `AgentManager`'s constructor: `path.resolve(__dirname, '../../../')` resolves from `apps/server/src/` to the repo root.

Alternatively, if `DORKOS_DEFAULT_CWD` is reliably set (it is in CLI mode and dev mode), the path import may not be needed. Use the `process.env.DORKOS_DEFAULT_CWD ?? process.cwd()` pattern instead to avoid the import:

```typescript
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? process.cwd(),
});
agentManager.setMcpServers({ dorkos: mcpToolServer });
```

The placement should be after `initBoundary` and before `createApp()`:

```typescript
async function start() {
  // ... existing: initLogger, initConfigManager, initBoundary ...

  // Create MCP tool server and inject into AgentManager
  const mcpToolServer = createDorkOsToolServer({
    transcriptReader,
    defaultCwd: process.env.DORKOS_DEFAULT_CWD ?? process.cwd(),
  });
  agentManager.setMcpServers({ dorkos: mcpToolServer });

  const app = createApp();
  // ... rest unchanged ...
}
```

**Acceptance Criteria:**

- [ ] `createDorkOsToolServer` is imported from `./services/mcp-tool-server.js`
- [ ] MCP server is created with `transcriptReader` and `defaultCwd` deps
- [ ] `agentManager.setMcpServers({ dorkos: mcpToolServer })` is called before `createApp()`
- [ ] `defaultCwd` uses `process.env.DORKOS_DEFAULT_CWD` with sensible fallback
- [ ] Server starts without errors: `dotenv -- turbo dev --filter=@dorkos/server`
- [ ] Build succeeds: `npm run build`

---

### Task 5: Write unit tests for all 3 tool handlers and the factory

**Objective:** Create comprehensive unit tests for `handlePing`, `handleGetServerInfo`, `createGetSessionCountHandler`, and `createDorkOsToolServer` in a new test file.

**Files Created:**

- `apps/server/src/services/__tests__/mcp-tool-server.test.ts`

**Implementation:**

Create the file `apps/server/src/services/__tests__/mcp-tool-server.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createDorkOsToolServer,
} from '../mcp-tool-server.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config) => config),
  tool: vi.fn((name, desc, schema, handler) => ({ name, description: desc, schema, handler })),
}));

describe('MCP Tool Handlers', () => {
  describe('handlePing', () => {
    it('returns pong status with timestamp', async () => {
      const result = await handlePing();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('pong');
      expect(parsed.server).toBe('dorkos');
      expect(parsed.timestamp).toBeDefined();
    });

    it('returns valid ISO timestamp', async () => {
      const result = await handlePing();
      const parsed = JSON.parse(result.content[0].text);
      expect(() => new Date(parsed.timestamp)).not.toThrow();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('returns single content block with type text', async () => {
      const result = await handlePing();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetServerInfo', () => {
    it('returns server info without uptime by default', async () => {
      const result = await handleGetServerInfo({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.product).toBe('DorkOS');
      expect(parsed.port).toBeDefined();
      expect(parsed.uptime_seconds).toBeUndefined();
    });

    it('includes uptime when requested', async () => {
      const result = await handleGetServerInfo({ include_uptime: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.uptime_seconds).toBeTypeOf('number');
      expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it('uses DORKOS_PORT env var when set', async () => {
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

    it('uses DORKOS_VERSION env var when set', async () => {
      const original = process.env.DORKOS_VERSION;
      process.env.DORKOS_VERSION = '2.0.0';
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.version).toBe('2.0.0');
      } finally {
        if (original !== undefined) process.env.DORKOS_VERSION = original;
        else delete process.env.DORKOS_VERSION;
      }
    });

    it('defaults port to 4242 when env var unset', async () => {
      const original = process.env.DORKOS_PORT;
      delete process.env.DORKOS_PORT;
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.port).toBe('4242');
      } finally {
        if (original !== undefined) process.env.DORKOS_PORT = original;
      }
    });

    it('defaults version to development when env var unset', async () => {
      const original = process.env.DORKOS_VERSION;
      delete process.env.DORKOS_VERSION;
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.version).toBe('development');
      } finally {
        if (original !== undefined) process.env.DORKOS_VERSION = original;
      }
    });
  });

  describe('createGetSessionCountHandler', () => {
    it('returns session count from transcript reader', async () => {
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

    it('handles non-Error exceptions gracefully', async () => {
      const mockReader = {
        listSessions: vi.fn().mockRejectedValue('string error'),
      };
      const handler = createGetSessionCountHandler({
        transcriptReader: mockReader as any,
        defaultCwd: '/test/cwd',
      });
      const result = await handler();
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('Failed to list sessions');
    });
  });

  describe('createDorkOsToolServer', () => {
    it('creates server with name dorkos and version 1.0.0', () => {
      const server = createDorkOsToolServer({
        transcriptReader: {} as any,
        defaultCwd: '/test',
      });
      expect(server).toBeDefined();
      expect(server.name).toBe('dorkos');
      expect(server.version).toBe('1.0.0');
    });

    it('registers 3 tools', () => {
      const server = createDorkOsToolServer({
        transcriptReader: {} as any,
        defaultCwd: '/test',
      });
      expect(server.tools).toHaveLength(3);
    });

    it('registers tools with correct names', () => {
      const server = createDorkOsToolServer({
        transcriptReader: {} as any,
        defaultCwd: '/test',
      });
      const toolNames = server.tools.map((t: any) => t.name);
      expect(toolNames).toContain('ping');
      expect(toolNames).toContain('get_server_info');
      expect(toolNames).toContain('get_session_count');
    });
  });
});
```

**Mocking Strategy:**

- SDK `createSdkMcpServer` and `tool` are mocked to return passthrough objects — avoids needing SDK subprocess
- `TranscriptReader` is mocked via partial interface matching: `{ listSessions: vi.fn() }`
- `process.env` is set/restored in try/finally blocks per test
- `process.uptime()` is not mocked — testing `>= 0` is sufficient

**Acceptance Criteria:**

- [ ] Test file exists at `apps/server/src/services/__tests__/mcp-tool-server.test.ts`
- [ ] All `handlePing` tests pass (pong status, ISO timestamp, content block structure)
- [ ] All `handleGetServerInfo` tests pass (default values, optional uptime, env var overrides)
- [ ] All `createGetSessionCountHandler` tests pass (count, error handling, zero sessions, non-Error exceptions)
- [ ] All `createDorkOsToolServer` tests pass (server name, version, tool count, tool names)
- [ ] All tests run successfully: `npx vitest run apps/server/src/services/__tests__/mcp-tool-server.test.ts`
- [ ] No existing tests broken: `npm test -- --run`

---

### Task 6: Verify build and full test suite pass

**Objective:** Run the full build and test suite to verify no regressions and all new code compiles and passes.

**Commands to Run:**

```bash
# 1. Type-check all packages
npm run typecheck

# 2. Build all apps
npm run build

# 3. Run all tests
npm test -- --run

# 4. Run the new test file specifically
npx vitest run apps/server/src/services/__tests__/mcp-tool-server.test.ts
```

**What to Check:**

- TypeScript compilation succeeds across all packages
- Server build produces output without errors
- Client build is unaffected (no changes to client)
- All existing tests pass (no regressions)
- New mcp-tool-server tests pass
- Service count in `services/` is 17 (within advisory range, no restructuring needed)

**Acceptance Criteria:**

- [ ] `npm run typecheck` succeeds
- [ ] `npm run build` succeeds
- [ ] `npm test -- --run` passes all tests
- [ ] No changes to `apps/client/`, `packages/shared/`, `apps/web/`, or `apps/obsidian-plugin/`
- [ ] New service file brings count to 17 in `services/`

---

### Task 7: Update `CLAUDE.md` documentation

**Objective:** Update the project documentation to reflect the new MCP tool server service.

**Files Modified:**

- `CLAUDE.md` (root)

**Implementation:**

1. In the **Server services list** (the "Sixteen services" section), update the count to "Seventeen services" and add the new service entry:

```markdown
- **`services/mcp-tool-server.ts`** - MCP tool server factory for in-process SDK tools. Creates a `dorkos` MCP server with `createSdkMcpServer()` + `tool()` API. Registers 3 proof-of-concept tools: `ping` (health check), `get_server_info` (server metadata), `get_session_count` (transcript count via `TranscriptReader`). Uses `McpToolDeps` interface for dependency injection. Injected into `AgentManager` at startup via `setMcpServers()`.
```

2. In the **Architecture section**, note that `AgentManager.sendMessage()` now uses `AsyncIterable` prompt form and injects MCP servers into `query()` calls.

3. In the **File Organization** or architecture section, mention that MCP tool calls flow through the existing `canUseTool` callback and `mapSdkMessage()` pipeline with no changes — they appear as standard `tool_call_start/delta/end` events.

**Acceptance Criteria:**

- [ ] Service count updated from 16 to 17 in CLAUDE.md
- [ ] New service description added to the services list
- [ ] No documentation files created (updates only)
