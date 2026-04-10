# Implementation Summary: Agent Runtime Abstraction

**Created:** 2026-03-06
**Last Updated:** 2026-03-06
**Spec:** specs/agent-runtime-abstraction/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 20 / 20

## Tasks Completed

### Session 1 - 2026-03-06

- Task #1: [P1] Define AgentRuntime interface and RuntimeCapabilities type in shared package
- Task #4: [P1] Create runtimes/claude-code/ directory structure
- Task #2: [P1] Create RuntimeRegistry service with singleton export
- Task #3: [P1] Write RuntimeRegistry unit tests (20 test cases)
- Task #5: [P2] Move existing services to runtimes/claude-code/ directory (21 files moved, 13 re-export shims)
- Task #6: [P2] Create ClaudeCodeRuntime class implementing AgentRuntime (24KB, all interface methods)
- Task #7: [P2] Update existing tests — no modifications needed, re-export shims work transparently
- Task #8: [P3] Update server startup (index.ts) to create ClaudeCodeRuntime and register in RuntimeRegistry
- Task #9: [P3] Migrate sessions.ts route to use RuntimeRegistry (+ 4 test files updated)
- Task #10: [P3] Migrate models.ts route to use RuntimeRegistry (commands.ts already clean)
- Task #11: [P3] Add GET /api/capabilities endpoint with route, OpenAPI, and 4 tests
- Task #12: [P3] Update ClaudeCodeAdapter — verified structural compatibility, TSDoc updated
- Task #13: [P3] Route tests confirmed migrated to RuntimeRegistry mocks, cleaned stale mocks
- Task #16: [P5] Added getCapabilities() to Transport, HttpTransport, DirectTransport, mock factories
- Task #17: [P5] Renamed DirectTransport agentManager to runtime, updated CopilotView.tsx
- Task #18: [P5] Created useRuntimeCapabilities and useDefaultCapabilities hooks in entities/runtime/ (8 tests)
- Task #14: [P4] Removed all 14 re-export shims, updated 27+ test files to canonical paths, deleted dead mocks
- Task #15: [P4] SDK import verification — all `@anthropic-ai/claude-agent-sdk` imports contained to runtimes/claude-code/ + lib/sdk-utils.ts
- Task #19: [P6] Full verification suite — server: 67 files/1168 tests pass, relay: 25/736, mesh: 14/253, db: 1/11; typecheck 13/13; lint 0 errors; build 9/9
- Task #20: [P6] Updated AGENTS.md (RuntimeRegistry, runtimes/ directory, capabilities route, entities/runtime), architecture.md (new RuntimeRegistry section, module layout, data flow), api-reference.md (capabilities endpoint)

## Files Modified/Created

**Source files:**

- `packages/shared/src/agent-runtime.ts` - AgentRuntime interface, RuntimeCapabilities, SessionOpts, MessageOpts, SseResponse
- `packages/shared/package.json` - Added `./agent-runtime` export path
- `apps/server/src/services/runtimes/claude-code/index.ts` - Barrel file for Claude Code runtime
- `apps/server/src/services/runtimes/index.ts` - Top-level runtimes barrel file
- `apps/server/src/services/core/runtime-registry.ts` - RuntimeRegistry class with singleton export
- `apps/server/src/services/runtimes/claude-code/agent-types.ts` - Moved from services/core/
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` - Moved from services/core/
- `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts` - Moved from services/core/
- `apps/server/src/services/runtimes/claude-code/context-builder.ts` - Moved from services/core/
- `apps/server/src/services/runtimes/claude-code/tool-filter.ts` - Moved from services/core/
- `apps/server/src/services/runtimes/claude-code/command-registry.ts` - Moved from services/core/
- `apps/server/src/services/runtimes/claude-code/session-lock.ts` - Moved from services/session/
- `apps/server/src/services/runtimes/claude-code/transcript-reader.ts` - Moved from services/session/
- `apps/server/src/services/runtimes/claude-code/transcript-parser.ts` - Moved from services/session/
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` - Moved from services/session/
- `apps/server/src/services/runtimes/claude-code/build-task-event.ts` - Moved from services/session/
- `apps/server/src/services/runtimes/claude-code/task-reader.ts` - Moved from services/session/
- `apps/server/src/services/runtimes/claude-code/mcp-tools/` - Entire directory moved from services/core/
- ~~13 re-export shims at old paths~~ (removed in Task #14)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` - ClaudeCodeRuntime implementing AgentRuntime
- ~~`apps/server/src/services/core/agent-manager.ts`~~ - Deleted (was re-export shim)
- `apps/server/src/index.ts` - Updated to create ClaudeCodeRuntime and register in RuntimeRegistry
- `apps/server/src/routes/sessions.ts` - Migrated from agentManager/transcriptReader to runtimeRegistry
- `apps/server/src/routes/models.ts` - Migrated from agentManager to runtimeRegistry
- `apps/server/src/routes/capabilities.ts` - New GET /api/capabilities endpoint
- `apps/server/src/app.ts` - Added capabilities route mount
- `apps/server/src/services/core/openapi-registry.ts` - Added /api/capabilities OpenAPI registration
- `packages/relay/src/adapters/claude-code-adapter.ts` - Updated TSDoc for AgentRuntime compatibility
- `apps/client/src/layers/shared/lib/direct-transport.ts` - Renamed agentManager to runtime in DirectTransportServices
- `apps/obsidian-plugin/src/views/CopilotView.tsx` - Updated for runtime rename
- `apps/client/src/layers/entities/runtime/model/use-runtime-capabilities.ts` - useRuntimeCapabilities and useDefaultCapabilities hooks
- `apps/client/src/layers/entities/runtime/index.ts` - Barrel file for runtime entity
- `apps/server/src/services/core/index.ts` - Updated barrel to use canonical paths
- `apps/server/src/services/session/index.ts` - Updated barrel to use canonical paths
- 14 re-export shim files deleted (agent-manager, agent-types, sdk-event-mapper, interactive-handlers, context-builder, tool-filter, command-registry, mcp-tools/, session-lock, transcript-reader, transcript-parser, session-broadcaster, build-task-event, task-reader)

**Documentation files:**

- `AGENTS.md` - Updated for RuntimeRegistry, runtimes/ directory, capabilities route, entities/runtime FSD layer
- `contributing/architecture.md` - Added RuntimeRegistry section, updated module layout, data flow diagrams, route listing
- `contributing/api-reference.md` - Added GET /api/capabilities endpoint documentation

**Test files:**

- `apps/server/src/services/core/__tests__/runtime-registry.test.ts` - 20 test cases covering all RuntimeRegistry methods
- `apps/server/src/services/core/__tests__/sdk-event-mapper.test.ts` - Fixed vi.hoisted() mock pattern for new paths
- `apps/server/src/services/core/__tests__/agent-manager.test.ts` - Dual-path mocking for context-builder/tool-filter
- `apps/server/src/services/core/__tests__/agent-manager-interactive.test.ts` - Dual-path mocking
- `apps/server/src/services/core/__tests__/agent-manager-models.test.ts` - Dual-path mocking
- `apps/server/src/routes/__tests__/sessions.test.ts` - Migrated to mock runtimeRegistry
- `apps/server/src/routes/__tests__/sessions-relay.test.ts` - Migrated to mock runtimeRegistry
- `apps/server/src/routes/__tests__/sessions-interactive.test.ts` - Migrated to mock runtimeRegistry
- `apps/server/src/routes/__tests__/sessions-boundary.test.ts` - Migrated to mock runtimeRegistry
- `apps/server/src/routes/__tests__/capabilities.test.ts` - New test file (4 tests)
- `apps/client/src/layers/entities/runtime/__tests__/runtime-hooks.test.tsx` - 8 tests for runtime hooks
- 27+ test files updated to canonical import paths and dead mocks removed (see Task #14 report)

**Notes:**

- Naming conflict note: existing `AgentRuntime` Zod enum in `mesh-schemas.ts` is at separate export path, no conflict
- `SseResponse` minimal interface used instead of express `Response` to avoid runtime dependency in shared package
- Pre-existing client test failures in SessionSidebar.test.tsx (branding text from commit 7d80b98, unrelated)

## Known Issues

- Pre-existing: 5 client test failures in SessionSidebar.test.tsx looking for old branding text (unrelated to this spec)

## Implementation Notes

### Session 1

- All 66 server test files pass (1164 tests) after file moves
- Typecheck: 13/13 tasks successful
- vi.hoisted() pattern required for Vitest mocks referencing variables before initialization
- After shim removal: 67 test files, 1168 tests all passing, typecheck clean
- No remaining imports reference deleted shim paths
- Final verification: all quality gates pass (tests, typecheck, lint, build)
- SDK containment verified: 13 production files import SDK, all in runtimes/claude-code/ or lib/sdk-utils.ts
- Documentation updated: AGENTS.md, architecture.md, api-reference.md reflect new architecture
