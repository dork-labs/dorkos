# Implementation Summary: Dynamic MCP Tool Injection

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Spec:** specs/dynamic-mcp-tools/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 7 / 7

## Tasks Completed

### Session 1 - 2026-02-17

1. Add `makeUserPrompt` async generator + convert `query()` to `AsyncIterable`
2. Add `setMcpServers()` + MCP injection to `AgentManager`
3. Create `mcp-tool-server.ts` with 3 handlers + factory
4. Wire MCP tool server in `index.ts`
5. Write unit tests for handlers and factory (16 tests)
6. Verify build + full test suite (342 server tests pass, typecheck clean)
7. Update AGENTS.md documentation (17th service entry)

## Files Modified/Created

**Source files:**

- `apps/server/src/services/agent-manager.ts` (modified) - Added `makeUserPrompt`, `setMcpServers()`, MCP injection into sdkOptions
- `apps/server/src/services/mcp-tool-server.ts` (created) - MCP tool server with `ping`, `get_server_info`, `get_session_count` tools
- `apps/server/src/index.ts` (modified) - Wired `createDorkOsToolServer` and injected into AgentManager at startup
- `AGENTS.md` (modified) - Updated service count to 17, added `mcp-tool-server.ts` entry

**Test files:**

- `apps/server/src/services/__tests__/mcp-tool-server.test.ts` (created) - 16 unit tests covering all handlers and factory

## Known Issues

- `SDKUserMessage` requires `parent_tool_use_id: string | null` and `session_id: string` fields - discovered during implementation and documented for future tool development

## Implementation Notes

### Session 1

- The SDK requires `prompt` to be `AsyncIterable<SDKUserMessage>` when `mcpServers` is present in options. A `makeUserPrompt()` async generator wraps the plain string content.
- MCP servers are injected via `(sdkOptions as Record<string, unknown>).mcpServers` to avoid SDK type conflicts.
- The `canUseTool` callback already handles `mcp__*` tool names transparently - no changes needed.
- Three PoC tools validate the full pipeline: simple handler (ping), Zod schema with optional fields (get_server_info), and dependency-injected handler (get_session_count).
