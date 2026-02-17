---
slug: directory-boundary-enforcement
number: 34
created: 2026-02-16
status: ideation
---

# Centralized Directory Boundary Enforcement

**Slug:** directory-boundary-enforcement
**Author:** Claude Code
**Date:** 2026-02-16
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Centralize the directory boundary check (currently hardcoded to `~/` in `routes/directory.ts` only) into a shared utility function, enforce it across all API endpoints that accept a `cwd` or `path` parameter, and make the boundary configurable via `~/.dork/config.json`.
- **Assumptions:**
  - The boundary applies to both directory browsing and session `cwd` parameters
  - The default boundary remains `~/` (home directory)
  - Enforcement happens at the route layer (services trust validated input)
  - This is a security hardening + configurability improvement
- **Out of scope:**
  - Full Windows compatibility (noted for awareness, not addressed)
  - Authentication/authorization (DorkOS is a local tool)
  - DirectTransport (Obsidian plugin) changes (follow-up spec)
  - Per-user boundary scoping (future multi-user feature)

## 2) Pre-reading Log

- `apps/server/src/routes/directory.ts`: The ONLY existing boundary check. Hardcoded `const HOME = os.homedir()` at line 8, `startsWith(HOME)` check at line 36. Also controls parent navigation visibility at line 62.
- `apps/server/src/routes/sessions.ts`: Accepts `cwd` in 5 endpoints (POST create, GET list, GET detail, GET messages, GET tasks). Zero boundary validation. Falls back to `vaultRoot` (repo root).
- `apps/server/src/routes/files.ts`: Accepts required `cwd` query param. Passes directly to `fileLister.listFiles()`. No boundary check.
- `apps/server/src/routes/commands.ts`: Accepts optional `cwd` query param. Creates `CommandRegistryService` at arbitrary path. No boundary check.
- `apps/server/src/routes/git.ts`: Accepts optional `dir` query param. Passes to `getGitStatus()` which calls `execFile({ cwd })`. No boundary check.
- `apps/server/src/services/agent-manager.ts`: Constructor fallback chain: `cwd` param > `DORKOS_DEFAULT_CWD` > repo root. `ensureSession()` stores arbitrary `cwd`. No validation.
- `apps/server/src/services/transcript-reader.ts`: `listSessions(vaultRoot)` builds SDK project slug from arbitrary path. No boundary check.
- `apps/server/src/services/file-lister.ts`: `listFiles(cwd)` runs `git ls-files` or `readdir` on arbitrary path. No validation.
- `apps/server/src/services/git-status.ts`: `getGitStatus(cwd)` passes directly to `execFile({ cwd })`. No validation.
- `apps/server/src/services/command-registry.ts`: Constructor joins `vaultRoot` with `.claude/commands`. No boundary check.
- `apps/client/src/layers/shared/lib/direct-transport.ts`: Duplicates HOME boundary logic from server at lines 152-157. Hardcoded.
- `packages/shared/src/config-schema.ts`: `UserConfigSchema` has `server.port` and `server.cwd`. No boundary field.
- `packages/shared/src/schemas.ts`: `BrowseDirectoryQuerySchema`, `CreateSessionRequestSchema`, `SendMessageRequestSchema`, `ListSessionsQuerySchema`, `FileListQuerySchema`, `CommandsQuerySchema` all accept cwd/path without boundary validation.
- `packages/cli/src/cli.ts`: Sets `DORKOS_DEFAULT_CWD` from CLI flag > env > config > `process.cwd()`. No boundary validation at startup.
- `guides/configuration.md`: Documents `server.cwd` config field. No mention of boundary.
- `apps/server/src/routes/__tests__/directory.test.ts`: 179 lines testing hardcoded HOME boundary extensively.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/routes/directory.ts` - Directory browse endpoint (only existing boundary check)
- `apps/server/src/routes/sessions.ts` - Session CRUD + messaging (5 cwd-accepting endpoints)
- `apps/server/src/routes/files.ts` - File listing endpoint (required cwd)
- `apps/server/src/routes/commands.ts` - Command registry endpoint (optional cwd)
- `apps/server/src/routes/git.ts` - Git status endpoint (optional dir)
- `packages/shared/src/config-schema.ts` - Config schema definition (needs boundary field)
- `packages/shared/src/schemas.ts` - Request/response Zod schemas (cwd fields)

**Shared Dependencies:**

- `apps/server/src/services/config-manager.ts` - ConfigManager singleton, reads `~/.dork/config.json`
- `packages/shared/src/config-schema.ts` - UserConfigSchema Zod definition
- `packages/cli/src/cli.ts` - CLI entry, sets env vars including `DORKOS_DEFAULT_CWD`

**Data Flow:**

```
Client UI (DirectoryPicker / URL ?dir=)
  → HTTP Transport (browseDirectory / listSessions / sendMessage)
    → Express route handler (parses cwd from body/query)
      → [MISSING: boundary validation]
        → Service layer (AgentManager / TranscriptReader / FileLister / etc.)
          → Filesystem / SDK operations
```

**Feature Flags/Config:**

- `DORKOS_DEFAULT_CWD` env var (startup default)
- `server.cwd` in `~/.dork/config.json` (persistent default)
- No boundary config exists yet

**Potential Blast Radius:**

- Direct: 5 route files, 1 config schema, 1 new utility file
- Indirect: 5 service files receive validated input (no changes if validation is route-level only)
- Tests: 1 existing test file updated, 1 new test file for utility, boundary tests added to route tests
- Config: Schema migration (version stays at 1, new field with default)

## 4) Root Cause Analysis

N/A — this is a feature/hardening task, not a bug fix.

## 5) Research

**Security findings** (from 40+ authoritative sources):

The canonical secure path validation pattern uses a multi-layer defense:

1. Null byte rejection (`\0` in path)
2. Path resolution (`path.resolve()` normalizes `..` segments)
3. Symlink resolution (`fs.realpath()` follows symlinks to actual targets)
4. Boundary verification (`startsWith(root + path.sep)` — the `+ path.sep` is critical to prevent `/uploads` matching `/uploads-backup`)
5. Pre-resolve the boundary root at startup (macOS: `/var` symlinks to `/private/var`)

**Critical detail**: The `+ path.sep` suffix prevents a path like `/home/user-evil` from passing validation against boundary `/home/user`. Current DorkOS code uses `startsWith(HOME)` without the separator suffix — this is a latent bug.

**Potential Solutions:**

**1. Shared Utility Function (Recommended)**

- Description: Extract boundary check into a pure async function in `apps/server/src/lib/`. Call explicitly in each route handler that accepts cwd/path.
- Pros:
  - Framework-agnostic (usable in routes, services, CLI)
  - Easy to unit test (pure function, no Express dependency)
  - Explicit — reading a route handler shows the validation happening
  - Matches DorkOS pattern of thin route handlers delegating to services/utils
- Cons:
  - Must remember to call it in each new route (no auto-application)
  - Slightly more code per route handler
- Complexity: Low
- Maintenance: Low

**2. Express Middleware**

- Description: Create middleware that auto-validates `cwd`/`path`/`dir` params on matched routes.
- Pros:
  - Apply once per route group, no per-handler boilerplate
  - Can't forget to add it to a route (if applied to router)
- Cons:
  - Coupled to Express (can't reuse in DirectTransport or CLI)
  - Harder to test (needs Express test setup)
  - DorkOS has inconsistent param names (`cwd`, `path`, `dir`) making generic middleware awkward
  - Implicit — reading a route handler doesn't show the validation
- Complexity: Medium
- Maintenance: Medium

**3. Zod Schema Refinement (Validation at Parse Time)**

- Description: Add `.refine()` to Zod schemas that contain cwd/path fields to validate against boundary.
- Pros:
  - Validation happens automatically during `safeParse()`
  - Consistent with existing validation pattern
  - Single place to define the rule per schema
- Cons:
  - Async refinements complicate Zod schemas
  - Boundary config must be available at schema parse time (breaks schema purity)
  - Zod schemas are in `packages/shared` which shouldn't depend on server config
  - `fs.realpath()` in shared package introduces Node.js filesystem dependency
- Complexity: High
- Maintenance: High

**Recommendation:** Approach 1 (Shared Utility Function). It's the simplest, most testable, and most aligned with DorkOS's existing patterns. The inconsistent param names across routes (`cwd`, `path`, `dir`) make middleware awkward. The shared package dependency issue rules out Zod refinement.

**Configuration recommendation:** Single root path (`server.boundary`) defaulting to `os.homedir()`. This matches FileBrowser's well-established pattern. A whitelist of paths adds complexity without clear benefit for a local dev tool.

**Startup validation:** Resolve the boundary with `fs.realpath()` at server startup and store the resolved value. Validate that `DORKOS_DEFAULT_CWD` falls within it. Warn (don't crash) if it doesn't — fall back to the boundary root.

## 6) Clarification

1. **Config field placement**: Should the boundary live under `server.boundary` (consistent with existing `server.port`, `server.cwd`) or under a new `fileSystem.boundaryRoot` section (more descriptive but adds a new config group)? Recommendation: `server.boundary` for consistency.

2. **Boundary above home directory**: Should users be allowed to set boundary to `/` or `/Users`? This would expand access beyond the current `~/` default. Options: (a) allow any valid directory, (b) require boundary to be within `~/` (most restrictive), (c) allow any directory but warn if above `~/`. Recommendation: (a) allow any valid directory — users who configure this explicitly should get what they ask for.

3. **Startup behavior when default CWD is outside boundary**: If `DORKOS_DEFAULT_CWD=/tmp/project` and `server.boundary=~/`, should the server (a) warn and fall back to boundary root, (b) crash with an error, or (c) auto-expand boundary to include the CWD? Recommendation: (a) warn and fall back.

4. **Enforcement depth**: Should boundary validation happen (a) only at route handlers (services trust validated input), or (b) also at the service layer as defense-in-depth? Recommendation: (a) route-level only — services are internal, and double-validation adds complexity without meaningful security benefit for a local tool.

5. **`path.sep` suffix fix**: The existing `startsWith(HOME)` check in `directory.ts` is missing `+ path.sep`, meaning a home directory of `/home/user` would incorrectly allow `/home/username`. Should we fix this as part of this spec? Recommendation: Yes, it's a one-character fix that belongs with this work.

6. **Environment variable**: Should we add `DORKOS_BOUNDARY` as an env var override (matching the precedence pattern: CLI flag > env var > config > default)? Or is config-only sufficient? Recommendation: Add it for consistency with `DORKOS_DEFAULT_CWD` and `DORKOS_PORT`.
