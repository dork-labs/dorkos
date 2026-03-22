# Task Breakdown: A2A & Channels Interoperability Layer

Generated: 2026-03-22
Source: specs/a2a-channels-interoperability/02-specification.md
Last Decompose: 2026-03-22

## Overview

This breakdown covers the implementation of two integrated components for DorkOS external interoperability:

1. **A2A External Gateway** (`packages/a2a-gateway/`) -- Exposes DorkOS agents as A2A-compliant endpoints for cross-vendor agent communication via JSON-RPC 2.0
2. **Agent Card Generation** -- Maps Mesh `AgentManifest` to A2A Agent Cards for agent discovery at `/.well-known/agent.json`

Relay remains the internal backbone. A2A is an external gateway.

---

## Phase 1: Foundation

### Task 1.1: Add DORKOS_A2A_ENABLED feature flag and env configuration

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:

- Add `DORKOS_A2A_ENABLED` boolean flag to `apps/server/src/env.ts` using the existing `boolFlag` transform (defaults to `'false'`)
- Add to `turbo.json` `globalPassThroughEnv` array in alphabetical order
- Add to `.env.example` with descriptive comment

**Implementation Steps**:

1. Edit `serverEnvSchema` in `apps/server/src/env.ts` to add `DORKOS_A2A_ENABLED: boolFlag`
2. Edit `turbo.json` to add `"DORKOS_A2A_ENABLED"` to `globalPassThroughEnv`
3. Add to `.env.example` with comment about requiring Relay

**Acceptance Criteria**:

- [ ] `env.DORKOS_A2A_ENABLED` resolves to `false` by default
- [ ] Setting `DORKOS_A2A_ENABLED=true` in `.env` works correctly
- [ ] `turbo.json` includes the new env var
- [ ] Existing tests still pass

---

### Task 1.2: Add a2a_tasks table to database schema

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Create `packages/db/src/schema/a2a.ts` with `a2aTasks` table definition using Drizzle ORM
- Table columns: `id` (PK), `contextId`, `agentId`, `status` (enum), `historyJson`, `artifactsJson`, `metadataJson`, `createdAt`, `updatedAt`
- Status enum: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`
- Re-export from `packages/db/src/schema/index.ts`

**Implementation Steps**:

1. Create the schema file following the pattern of `relay.ts` and `mesh.ts`
2. Update `index.ts` barrel export
3. Generate Drizzle migration via `pnpm turbo db:generate --filter=@dorkos/db`

**Acceptance Criteria**:

- [ ] Schema file exists and is properly typed
- [ ] Re-exported from schema barrel
- [ ] Drizzle migration generated
- [ ] In-memory DB creation + migration works
- [ ] Build and typecheck pass

---

### Task 1.3: Scaffold packages/a2a-gateway with package.json, tsconfig, vitest config, and types

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:

- New package at `packages/a2a-gateway/`
- Pin `@a2a-js/sdk` to exact version `0.3.13`
- Workspace dependencies on `@dorkos/db`, `@dorkos/shared`
- TypeScript config extending `@dorkos/typescript-config/node.json`
- Vitest config following `@dorkos/relay` pattern
- Types module with `CardGeneratorConfig` and `ExecutorDeps` interfaces

**Implementation Steps**:

1. Create `package.json` with correct dependencies and scripts
2. Create `tsconfig.json` extending shared config
3. Create `vitest.config.ts` for node environment tests
4. Create `src/types.ts` with shared interfaces
5. Create `src/index.ts` barrel with type exports
6. Run `pnpm install` and verify build

**Acceptance Criteria**:

- [ ] Package scaffolding complete with all config files
- [ ] `@a2a-js/sdk` pinned to `0.3.13` (no caret)
- [ ] `pnpm install`, build, and typecheck succeed

---

## Phase 2: Agent Card Generation

### Task 2.1: Implement per-agent Agent Card generation from AgentManifest

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Technical Requirements**:

- `generateAgentCard()`: Maps AgentManifest to A2A AgentCard v0.3.0 format
- `generateFleetCard()`: Aggregates all registered agents into a fleet-level card
- Capabilities become A2A skills with human-readable names (hyphen/underscore to title case)
- Protocol version: `0.3.0`, streaming: true, pushNotifications: false
- Security scheme: apiKey in Authorization header

**Implementation Steps**:

1. Create `packages/a2a-gateway/src/agent-card-generator.ts` with both functions
2. Update barrel exports
3. Write comprehensive unit tests covering: valid card structure, capabilities-to-skills mapping, empty capabilities, empty description fallback, fleet aggregation, empty fleet, agents without namespace

**Acceptance Criteria**:

- [ ] Both functions produce valid A2A Agent Card JSON
- [ ] Capabilities correctly map to skills with readable names
- [ ] Edge cases handled (empty caps, empty description, no namespace)
- [ ] All 8+ unit tests pass

---

## Phase 3: A2A Gateway Core

### Task 3.1: Implement schema translator for A2A-Relay bidirectional mapping

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- `a2aMessageToRelayPayload()`: A2A Message -> Relay StandardPayload
  - Text parts concatenated with newlines
  - `senderName: 'a2a-client'`, `channelType: 'dm'`, `performative: 'request'`
  - contextId -> conversationId, taskId -> correlationId
- `relayPayloadToA2aMessage()`: Relay StandardPayload -> A2A Message
  - Role: 'agent', random messageId, text parts
- `relayStatusToTaskState()`: sent->working, delivered->completed, failed/timeout->failed

**Implementation Steps**:

1. Create `packages/a2a-gateway/src/schema-translator.ts` with three functions
2. Update barrel exports
3. Write unit tests for each function including multi-part messages and edge cases

**Acceptance Criteria**:

- [ ] Bidirectional translation preserves content and metadata
- [ ] Multi-part messages concatenated correctly
- [ ] All four Relay status values mapped
- [ ] All unit tests pass

---

### Task 3.2: Implement SQLite-backed TaskStore for A2A task persistence

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2, 1.3
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- `SqliteTaskStore` implements `@a2a-js/sdk` `TaskStore` interface
- Methods: `get(params: TaskQueryParams)`, `save(task: Task)`
- Uses Drizzle ORM against `a2aTasks` table
- Upsert semantics (ON CONFLICT DO UPDATE)
- JSON serialization for history, artifacts, metadata fields

**Implementation Steps**:

1. Create `packages/a2a-gateway/src/task-store.ts`
2. Update barrel exports
3. Write unit tests with in-memory SQLite: save/get, upsert, null task, JSON round-trip

**Acceptance Criteria**:

- [ ] Implements TaskStore interface
- [ ] Upsert works correctly
- [ ] JSON fields survive round-trip serialization
- [ ] Returns null for missing tasks
- [ ] All unit tests pass with in-memory SQLite

---

### Task 3.3: Implement DorkOSAgentExecutor bridging A2A requests to Relay

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3, 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Implements `@a2a-js/sdk` `AgentExecutor` interface
- Flow: resolve agent -> translate message -> publish to Relay -> subscribe for response -> emit completion
- Agent targeting: `metadata.agentId` or first registered agent
- Relay subject: `relay.agent.{namespace}.{id}`
- 2-minute response timeout
- Cancellation support via `cancelTask()`
- Status transitions: working -> completed/failed/canceled

**Implementation Steps**:

1. Create `packages/a2a-gateway/src/dorkos-executor.ts`
2. Update barrel exports
3. Write unit tests mocking RelayCore and AgentRegistry: correct subject, state transitions, failure cases, cancellation, default agent fallback

**Acceptance Criteria**:

- [ ] Implements AgentExecutor interface
- [ ] Publishes to correct Relay subject
- [ ] All state transitions work correctly
- [ ] Timeout and error handling work
- [ ] All unit tests pass with mocked dependencies

---

## Phase 4: A2A Server Routes

### Task 4.1: Create A2A Express routes with Agent Card endpoints and JSON-RPC handler

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 2.1, 3.1, 3.2, 3.3
**Can run parallel with**: None

**Technical Requirements**:

- `createA2aRouter()` factory function following `createMcpRouter()` pattern
- Endpoints:
  - `GET /.well-known/agent.json` -- Fleet Agent Card
  - `GET /a2a/agents/:id/card` -- Per-agent Agent Card (404 for unknown)
  - `POST /a2a` -- JSON-RPC via SDK's A2AExpressApp + DefaultRequestHandler
- Conditional mounting in `apps/server/src/index.ts` when `DORKOS_A2A_ENABLED=true` AND Relay AND Mesh active
- Auth: reuse `mcpApiKeyAuth` middleware

**Implementation Steps**:

1. Create `apps/server/src/routes/a2a.ts` with route factory
2. Add `@dorkos/a2a-gateway` and `@a2a-js/sdk` dependencies to server
3. Wire conditional mounting in `apps/server/src/index.ts` after Mesh routes
4. Verify build and typecheck

**Acceptance Criteria**:

- [ ] All three endpoints work correctly
- [ ] Routes only mounted when feature flag is enabled
- [ ] Auth middleware applied
- [ ] Build and typecheck pass

---

### Task 4.2: Write integration tests for A2A route endpoints

**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Test fleet card returns valid structure with registered agents
- Test per-agent card returns agent-specific skills
- Test 404 for unknown agent ID
- Test empty fleet returns empty skills
- Use in-memory SQLite, mock AgentRegistry and RelayCore

**Implementation Steps**:

1. Create `apps/server/src/__tests__/a2a-routes.test.ts`
2. Set up Express app with mocked dependencies
3. Use supertest for HTTP assertions

**Acceptance Criteria**:

- [ ] Fleet card endpoint tested
- [ ] Per-agent card endpoint tested (valid and 404)
- [ ] Empty fleet edge case tested
- [ ] All tests pass

---

## Phase 5: Integration & Polish

### Task 5.1: Update barrel exports, turbo config, and cross-package wiring

**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.1, 4.2
**Can run parallel with**: Task 5.2

**Technical Requirements**:

- Complete barrel exports in the a2a-gateway package
- Server package.json dependency on `@dorkos/a2a-gateway`
- Full pipeline verification: install, build, typecheck, test, lint

**Implementation Steps**:

1. Verify all barrel exports are complete
2. Verify turbo build pipeline works with the new package
3. Run full CI-equivalent pipeline locally

**Acceptance Criteria**:

- [ ] `pnpm install` succeeds
- [ ] `pnpm build` includes a2a-gateway
- [ ] `pnpm typecheck` passes everywhere
- [ ] `pnpm test -- --run` all tests pass

---

### Task 5.2: Update environment variables documentation and architecture contributing guide

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 4.1
**Can run parallel with**: Task 5.1

**Technical Requirements**:

- Document `DORKOS_A2A_ENABLED` in `contributing/environment-variables.md`
- Add A2A gateway to `contributing/architecture.md`
- Add new endpoints to `contributing/api-reference.md`

**Implementation Steps**:

1. Update environment-variables.md with new feature flag
2. Update architecture.md with new package and data flow
3. Update api-reference.md with three new endpoints

**Acceptance Criteria**:

- [ ] All three contributing docs updated
- [ ] No broken links

---

## Summary

| Phase                          | Tasks         | Description                                |
| ------------------------------ | ------------- | ------------------------------------------ |
| Phase 1: Foundation            | 1.1, 1.2, 1.3 | Env config, DB schema, package scaffolding |
| Phase 2: Agent Card Generation | 2.1           | AgentManifest to A2A AgentCard mapping     |
| Phase 3: A2A Gateway Core      | 3.1, 3.2, 3.3 | Schema translator, task store, executor    |
| Phase 4: A2A Server Routes     | 4.1, 4.2      | Express routes, integration tests          |
| Phase 5: Integration & Polish  | 5.1, 5.2      | Cross-package wiring, documentation        |

**Total Tasks**: 11

## Parallel Opportunities

- **Phase 1**: All three tasks (1.1, 1.2, 1.3) can run in parallel
- **Phase 3**: Tasks 3.1 and 3.2 can run in parallel
- **Phase 5**: Tasks 5.1 and 5.2 can run in parallel

## Critical Path

1.3 -> 2.1 -> 3.3 -> 4.1 -> 4.2 -> 5.1

The longest dependency chain runs through package scaffolding, Agent Card generation, executor implementation, route creation, integration tests, and final wiring.
