---
slug: server-review-remediation-r3
number: 76
created: 2026-02-28
status: ideation
---

# Server Code Review Remediation — Round 3

**Slug:** server-review-remediation-r3
**Author:** Claude Code
**Date:** 2026-02-28
**Branch:** fix/server-review-r3
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Fix all 20 findings from the comprehensive server code review (4 Critical, 8 Important, 8 Minor) covering security, performance, code quality, and architecture concerns.
- **Assumptions:**
  - Security fixes (C1, C2, I4) are highest priority
  - File splits (C3, C4) are refactors — existing behavior must be preserved
  - Auth/rate limiting (I3) is deferred to a separate feature spec — too large for a remediation pass
  - I8 (server internals exposure) is also deferred since it requires auth infrastructure
  - No new npm dependencies needed (simple Map check for I1 instead of lru-cache)
- **Out of scope:**
  - Authentication middleware (I3 — separate spec)
  - Server internals redaction (I8 — depends on I3)
  - Client-side changes (unless needed for API contract changes)
  - New feature development

## 2) Pre-reading Log

- `apps/server/src/middleware/error-handler.ts`: 10-line file, leaks `err.message` to clients in all environments
- `apps/server/src/routes/sessions.ts`: ~330 lines, PATCH and SSE stream routes missing `assertBoundary()` on cwd
- `apps/server/src/routes/config.ts`: `deepMerge()` at lines 20-47 has no prototype pollution guard
- `apps/server/src/routes/relay.ts`: SSE keepalive at line 358 has no try-catch on write
- `apps/server/src/services/core/mcp-tool-server.ts`: 940 lines — registers tools across 7 domains
- `apps/server/src/services/relay/adapter-manager.ts`: 957 lines — CRUD, hot-reload, plugin loading, catalogs
- `apps/server/src/services/core/agent-manager.ts`: Unbounded sessions Map (line 31), linear findSession scan (line 286)
- `apps/server/src/services/session/session-broadcaster.ts`: registerClient has no connection limit
- `apps/server/src/app.ts`: SPA catch-all intercepts API 404s in production
- `apps/server/src/index.ts`: Multiple unsafe `as` type assertions on configManager.get()
- `apps/server/src/lib/boundary.ts`: assertBoundary signature is `(dirPath: string, res: Response) => Promise<boolean>`
- `apps/server/src/config/constants.ts`: Already has SESSIONS section (lines 29-36), no MAX_SESSIONS constant

## 3) Codebase Map

**Primary components/modules:**

- `middleware/error-handler.ts` — Global Express error handler (C1)
- `routes/sessions.ts` — Session CRUD + SSE streaming (C2, I5, M1, M2)
- `routes/config.ts` — Config GET/PATCH with deepMerge (I4)
- `routes/relay.ts` — Relay SSE stream with keepalive (I6, I7)
- `routes/commands.ts` — Slash command discovery (I7 vault root)
- `services/core/mcp-tool-server.ts` — MCP tool registration (C3)
- `services/relay/adapter-manager.ts` — Adapter lifecycle (C4)
- `services/core/agent-manager.ts` — SDK session management (I1, I2, M7)
- `services/session/session-broadcaster.ts` — SSE client management (I5)
- `app.ts` — Express app setup with SPA catch-all (M6)
- `index.ts` — Server bootstrap with config reading (M4)

**Shared dependencies:**

- `lib/boundary.ts` — assertBoundary() used by routes
- `config/constants.ts` — Shared constants
- `@dorkos/shared/types` — Zod schemas and types

**Data flow:**
Client request → Express route → assertBoundary → service → response

**Feature flags/config:**

- `env.NODE_ENV` — controls error handler behavior (C1)
- `env.DORKOS_DEFAULT_CWD` — vault root fallback (I7)

**Potential blast radius:**

- Direct: 11 files modified, 8+ new files created (C3/C4 splits)
- Indirect: Client may need to handle new 400/429 responses from M2/I5
- Tests: 4+ new test files for security-critical paths

## 4) Root Cause Analysis

This is a remediation of accumulated technical debt, not a single bug. Root causes:

- **Security gaps**: Routes added incrementally without consistent boundary validation
- **Growth without refactoring**: mcp-tool-server.ts and adapter-manager.ts grew organically as features were added
- **Missing production hardening**: Error handler, deepMerge, SSE limits were written for development convenience

## 5) Research

### Potential Solutions

**1. Inline fixes (per-finding targeted changes)**

- Description: Fix each finding individually with minimal code changes
- Pros: Minimal blast radius, easy to review, fast
- Cons: Doesn't address structural patterns that led to the issues
- Complexity: Low
- Maintenance: Low

**2. Extract shared utilities + inline fixes**

- Description: Create lib/resolve-root.ts, lib/route-utils.ts, standardize patterns, then fix findings
- Pros: Prevents future recurrence, DRY, establishes patterns
- Cons: Slightly more files to review
- Complexity: Medium
- Maintenance: Low (patterns prevent recurrence)

**Recommendation:** Approach 2 — extract shared utilities to prevent the same patterns from recurring, then apply targeted fixes.

### Key Research Findings

- **Error handlers**: Use `NODE_ENV` conditional — no package needed
- **Prototype pollution**: OWASP recommends key filtering (`__proto__`, `constructor`, `prototype`). Avoid `@75lb/deep-merge` (CVE-2024-38986). Simple Set-based check is sufficient
- **File splitting**: Domain registration pattern — each module exports `registerXxxTools(server, deps)`, composition root calls all
- **Session cap**: Simple `Map.size >= MAX` check is sufficient when 30-min health check handles cleanup
- **SSE limits**: Enforce in broadcaster (resource budgeting), not middleware (rate limiting)
- **API 404**: Mount `/api` catch-all before SPA catch-all, works in all environments
- **Path resolution**: Export `REPO_ROOT` constant from `lib/resolve-root.ts`, prefer `env.DORKOS_DEFAULT_CWD` at runtime
- **UUID validation**: Zod `z.string().uuid()` via shared `parseUuidParam()` helper

## 6) Decisions

| #   | Decision                   | Choice                              | Rationale                                                                                                                     |
| --- | -------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Auth/rate limiting scope   | Defer to separate spec              | I3 is a feature, not a bugfix. This spec focuses on 18 actionable fixes. I8 also deferred since it depends on auth.           |
| 2   | Test scope for refactors   | Existing tests + new security tests | Write tests for C1, C2, I4, M2 (security-critical). Skip tests for pure refactors (C3, C4) — just ensure existing tests pass. |
| 3   | Session cap implementation | Simple Map size check               | No new dependency. MAX_SESSIONS constant + check in ensureSession(). 30-min health check already handles cleanup.             |
