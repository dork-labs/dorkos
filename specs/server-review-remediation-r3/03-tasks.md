# Task Breakdown: Server Code Review Remediation -- Round 3

**Spec:** `specs/server-review-remediation-r3/02-specification.md`
**Generated:** 2026-02-28
**Mode:** Full decomposition
**Total Tasks:** 16

---

## Phase 1: Security (C1, C2, I4)

All Phase 1 tasks are independent and can run in parallel.

### 1.1 -- Hide internal error messages in production (C1)

- **Size:** Small | **Priority:** High | **Dependencies:** None
- **File:** `apps/server/src/middleware/error-handler.ts`
- Modify `errorHandler` to check `NODE_ENV` and return generic `"Internal Server Error"` in production instead of the actual error message. Always include `code: 'INTERNAL_ERROR'`.

### 1.2 -- Add boundary checks to PATCH and stream routes (C2)

- **Size:** Small | **Priority:** High | **Dependencies:** None
- **File:** `apps/server/src/routes/sessions.ts`
- Add `assertBoundary(cwd, res)` calls to the PATCH `/:id` and GET `/:id/stream` routes before using the `cwd` query parameter. Make the stream handler async if needed.

### 1.3 -- Add prototype pollution guard to deepMerge (I4)

- **Size:** Small | **Priority:** High | **Dependencies:** None
- **File:** `apps/server/src/routes/config.ts`
- Add a `DANGEROUS_KEYS` set (`__proto__`, `constructor`, `prototype`) and skip those keys in the `deepMerge` loop.

---

## Phase 2: File Splits (C3, C4)

Phase 2 tasks are independent of Phase 1 and can run in parallel with each other.

### 2.1 -- Split mcp-tool-server.ts into domain modules (C3)

- **Size:** Large | **Priority:** High | **Dependencies:** None
- **Files:** `apps/server/src/services/core/mcp-tool-server.ts` -> `mcp-tools/` directory
- Split the 940-line file into 8 modules: `index.ts`, `types.ts`, `core-tools.ts`, `pulse-tools.ts`, `relay-tools.ts`, `binding-tools.ts`, `mesh-tools.ts`, `agent-tools.ts`. Each domain module exports a `register*Tools()` function. Composition root wires them together.

### 2.2 -- Extract adapter-error.ts and adapter-config.ts from adapter-manager.ts (C4)

- **Size:** Medium | **Priority:** High | **Dependencies:** None
- **Files:** `apps/server/src/services/relay/adapter-manager.ts` -> extract `adapter-error.ts` and `adapter-config.ts`
- Extract `AdapterError` class (~20 lines) and config loading/validation/merge/hot-reload logic (~200 lines). Target: main file under 450 lines.

---

## Phase 3: Performance & Reliability (I1, I2, I5, I6)

All Phase 3 tasks are independent and can run in parallel.

### 3.1 -- Add session map cap with MAX_CONCURRENT (I1)

- **Size:** Small | **Priority:** Medium | **Dependencies:** None
- **Files:** `config/constants.ts`, `services/core/agent-manager.ts`, `routes/sessions.ts`
- Add `MAX_CONCURRENT: 50` to SESSIONS constant. Guard `ensureSession()` with size check. Route handler returns 503 when limit reached.

### 3.2 -- Add reverse lookup index for findSession (I2)

- **Size:** Small | **Priority:** Medium | **Dependencies:** None
- **File:** `apps/server/src/services/core/agent-manager.ts`
- Add `sdkSessionIndex` Map for O(1) reverse lookup. Populate when SDK session ID is assigned. Clean up on session expiry.

### 3.3 -- Add SSE connection limits (I5)

- **Size:** Small | **Priority:** Medium | **Dependencies:** None
- **Files:** `config/constants.ts`, `services/session/session-broadcaster.ts`
- Add `SSE` constants (10 per session, 500 total). Enforce in `registerClient()` with 503 responses. Track count with increment/decrement on connect/close.

### 3.4 -- Fix SSE keepalive race condition (I6)

- **Size:** Small | **Priority:** Medium | **Dependencies:** None
- **File:** `apps/server/src/routes/relay.ts`
- Add `res.writableEnded` guard and try/catch around keepalive `res.write()`. Clear interval on either failure path.

---

## Phase 4: Code Quality (I7, M1-M4, M6, M7)

Task 4.1 should run before 4.2 (which touches the same files). Tasks 4.3, 4.4, 4.5 can run in parallel.

### 4.1 -- Centralize vault root resolution (I7 + M1)

- **Size:** Medium | **Priority:** Medium | **Dependencies:** None
- **Files:** New `lib/resolve-root.ts`, update `routes/sessions.ts`, `routes/relay.ts`, `routes/commands.ts`, `services/core/agent-manager.ts`
- Create single `DEFAULT_CWD` export. Replace all inline vault root computations. Remove manual `__dirname` polyfill from sessions.ts (M1).

### 4.2 -- Add UUID validation and sendError helpers (M2 + M3)

- **Size:** Medium | **Priority:** Low | **Dependencies:** 4.1
- **Files:** `lib/route-utils.ts`, `routes/sessions.ts`
- Add `parseSessionId()` and `sendError()` to route-utils. Apply UUID validation to all 7 session routes with `:id` param. Incrementally adopt `sendError` in sessions.ts.

### 4.3 -- Replace unsafe type assertions in index.ts (M4)

- **Size:** Small | **Priority:** Low | **Dependencies:** None
- **File:** `apps/server/src/index.ts`
- Add `SchedulerConfigSchema`, `RelayConfigSchema`, `MeshConfigSchema` Zod schemas. Replace `as` casts with `.parse()` calls.

### 4.4 -- Add API 404 catch-all before SPA (M6)

- **Size:** Small | **Priority:** Low | **Dependencies:** None
- **File:** `apps/server/src/app.ts`
- Add `app.use('/api', ...)` 404 handler after all API routes but before production SPA catch-all. Returns JSON `{ error, code: 'API_NOT_FOUND' }`.

### 4.5 -- Replace Record<string, unknown> casts in agent-manager.ts (M7)

- **Size:** Small | **Priority:** Low | **Dependencies:** None
- **File:** `apps/server/src/services/core/agent-manager.ts`
- Define `ExtendedQueryOptions` interface. Build options object with type-safe property assignment instead of `as Record<string, unknown>` casts.

---

## Phase 5: Testing (M8)

All Phase 5 tasks can run in parallel. Each depends on its corresponding implementation task.

### 5.1 -- Error handler production mode test (M8-C1)

- **Size:** Small | **Priority:** Low | **Dependencies:** 1.1
- **File:** `apps/server/src/middleware/__tests__/error-handler-prod.test.ts`
- Test that production mode returns `"Internal Server Error"` and development mode returns the actual error message.

### 5.2 -- Boundary validation tests for session routes (M8-C2)

- **Size:** Small | **Priority:** Low | **Dependencies:** 1.2
- **File:** `apps/server/src/routes/__tests__/sessions-boundary.test.ts`
- Test that PATCH and stream routes reject `cwd=/etc/passwd` with 403.

### 5.3 -- Prototype pollution prevention test (M8-I4)

- **Size:** Small | **Priority:** Low | **Dependencies:** 1.3
- **File:** `apps/server/src/routes/__tests__/config-deepmerge.test.ts`
- Test that `deepMerge` filters `__proto__`, `constructor`, `prototype` keys while preserving normal keys.

### 5.4 -- UUID validation test (M8-M2)

- **Size:** Small | **Priority:** Low | **Dependencies:** 4.2
- **File:** `apps/server/src/lib/__tests__/route-utils.test.ts`
- Test `parseSessionId` accepts valid UUIDs, rejects path traversal, empty strings, and numeric strings with 400.

---

## Dependency Graph

```
Phase 1 (parallel):  1.1  1.2  1.3
                      |    |    |
Phase 2 (parallel):  2.1  2.2  |   (independent of Phase 1)
                      |    |    |
Phase 3 (parallel):  3.1  3.2  3.3  3.4  (independent)
                      |    |    |    |
Phase 4:             4.1 ──> 4.2         (sequential)
                     4.3  4.4  4.5       (parallel, independent of 4.1/4.2)
                      |    |    |
Phase 5 (parallel):  5.1  5.2  5.3  5.4
                      ^    ^    ^    ^
                      |    |    |    |
                     1.1  1.2  1.3  4.2  (depends on implementation tasks)
```

## Summary

| Phase           | Tasks  | Size Breakdown                  |
| --------------- | ------ | ------------------------------- |
| 1. Security     | 3      | 3 small                         |
| 2. File Splits  | 2      | 1 large, 1 medium               |
| 3. Performance  | 4      | 4 small                         |
| 4. Code Quality | 5      | 2 medium, 3 small               |
| 5. Testing      | 4      | 4 small                         |
| **Total**       | **16** | **1 large, 3 medium, 12 small** |
