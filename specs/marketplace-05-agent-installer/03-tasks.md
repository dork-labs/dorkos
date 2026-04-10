# Task Breakdown: Marketplace 05 — Agent Installer (MCP Server)

Generated: 2026-04-07
Source: specs/marketplace-05-agent-installer/02-specification.md

## Overview

Spec 05 of 5 in the DorkOS Marketplace project. Exposes the existing marketplace install pipeline as an external MCP server so any agent that speaks MCP (Claude Code, Cursor, Codex, Cline, ChatGPT, Gemini) can search, install, uninstall, recommend, and scaffold DorkOS packages on the user's behalf — gated by an explicit user confirmation flow.

The spec is **additive** — no changes to the existing `/mcp` server beyond registering 8 new tools and threading a new dependency bundle through `createExternalMcpServer()`. The marketplace install runtime in `apps/server/src/services/marketplace/` is reused as-is via the existing `InstallerLike` interface.

Major deliverables:

- 8 new MCP tools: `marketplace_search`, `marketplace_get`, `marketplace_list_marketplaces`, `marketplace_list_installed`, `marketplace_recommend`, `marketplace_install`, `marketplace_uninstall`, `marketplace_create_package`.
- New `apps/server/src/services/marketplace-mcp/` service module with handlers, confirmation provider, recommendation engine, and personal marketplace bootstrap.
- `~/.dork/personal-marketplace/` auto-created on first boot, registered as a marketplace source via a new `file://` URL scheme that the existing `PackageFetcher` learns to read.
- A `ConfirmationProvider` abstraction with three implementations (auto-approve for CI, in-app for the DorkOS UI, token-based for external agents) that gates every mutation tool.
- New HTTP route `POST /api/marketplace/confirmations/:token` so the DorkOS UI can resolve out-of-band confirmation tokens issued to external agents.
- New developer guide `contributing/external-agent-marketplace-access.md` explaining how users connect Claude Code / Cursor / Codex.

Critical safety: every test that touches the install runtime MUST follow the rollback safety pattern from `contributing/marketplace-installs.md#5-transaction-lifecycle` — mock `transactionInternal.isGitRepo` to return `false` to prevent the destructive `git reset --hard` path. This decomposition keeps every new test on stub installers / stub uninstall flows so the rollback path is unreachable.

## Phase 1: Foundation

### Task 1.1: Add file:// source support to PackageFetcher

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.3

Extend `apps/server/src/services/marketplace/package-fetcher.ts` so `fetchMarketplaceJson()` and `fetchFromGit()` recognise `file://` URLs and read directly from disk instead of making an HTTP/git call. This is the foundation for the personal marketplace source.

**Acceptance criteria**:

- [ ] `fetchMarketplaceJson()` reads `file://` sources via `fs.readFile`, parses with `parseMarketplaceJson`, caches the result.
- [ ] `fetchFromGit()` returns the local directory immediately when the gitUrl is `file://`, with `commitSha: 'local'` and `fromCache: true`.
- [ ] Errors when the file is missing return a clear `Failed to read local marketplace at <path>: ...` message.
- [ ] Existing HTTP/git path is unchanged for non-`file://` sources.
- [ ] Tests cover: missing file, invalid JSON, valid `file://`, `fetchFromGit` with `file://`.

### Task 1.2: Implement personal marketplace bootstrap

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: Task 1.3

Create `apps/server/src/services/marketplace-mcp/personal-marketplace.ts` with `ensurePersonalMarketplace(deps)` that creates `${dorkHome}/personal-marketplace/` with a default `marketplace.json`, README, .gitignore, and `packages/` directory. Idempotent. Registers the `personal` source with `MarketplaceSourceManager` using a `file://` URL when not already present.

**Acceptance criteria**:

- [ ] Creates the directory tree on first call.
- [ ] Idempotent: re-running on an existing directory does not throw or overwrite seeded files.
- [ ] Registers a `personal` source with `file://` URL when not already present.
- [ ] When the source is already registered, no `add()` call is made.
- [ ] `dorkHome` is a required parameter (no `os.homedir()` fallback per `.claude/rules/dork-home.md`).
- [ ] Tests cover: fresh install, idempotent re-run, marketplace.json shape, source registration.

### Task 1.3: Define ConfirmationProvider interface and providers

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

Create `apps/server/src/services/marketplace-mcp/confirmation-provider.ts` defining the `ConfirmationProvider` interface plus three implementations:

1. `AutoApproveConfirmationProvider` — always returns `approved`. Selected when `MARKETPLACE_AUTO_APPROVE=1`.
2. `TokenConfirmationProvider` — issues short-lived (5 min), single-use, scoped tokens for out-of-band approval. Used for external MCP clients.
3. `InAppConfirmationProvider` — delegates to a callback (the DorkOS UI dialog). Returns synchronously.

**Acceptance criteria**:

- [ ] Interface defined with `requestInstallConfirmation()` and `resolveToken()`.
- [ ] All three providers implement the interface and pass tests.
- [ ] Tokens expire after 5 minutes; expired tokens return declined with reason `Token expired`.
- [ ] Single-use enforcement: a token resolved to approved/declined is removed from the store.
- [ ] Tests cover: token issuance, expiry, approve+resolve, decline+resolve, unknown token, single-use.

### Task 1.4: Define MarketplaceMcpDeps and tool registration helper

**Size**: Small
**Priority**: High
**Dependencies**: 1.3
**Can run parallel with**: None

Create `apps/server/src/services/marketplace-mcp/marketplace-mcp-tools.ts` exporting the `MarketplaceMcpDeps` interface (the dependency bundle every marketplace tool consumes) and a `registerMarketplaceTools(server, deps)` helper. Phase 1 ships only the scaffold — handlers are appended in phases 2/3.

**Acceptance criteria**:

- [ ] `MarketplaceMcpDeps` type exported and constructable at the call site.
- [ ] `registerMarketplaceTools()` callable, type-checks, no-op until later phases plug in handlers.
- [ ] Tests assert the helper does not throw with stub server + deps.
- [ ] No imports from `@anthropic-ai/claude-agent-sdk`.

## Phase 2: Read-only MCP Tools

All four phase 2 tasks can run in parallel — they create independent files and only modify the registration site in `marketplace-mcp-tools.ts`.

### Task 2.1: Implement marketplace_search MCP tool

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4
**Can run parallel with**: Task 2.2, 2.3, 2.4

Create `tool-search.ts` with a Zod input schema (`query`, `type`, `category`, `tags`, `marketplace`, `limit`) and a handler that aggregates entries across every enabled marketplace, applies filters, and returns a structured result with `results` and `total`.

**Acceptance criteria**:

- [ ] Filters apply in order: type → category → tags → query.
- [ ] Honors `enabled: true` flag (skips disabled marketplaces unless explicit `marketplace` arg).
- [ ] Marketplace fetch failures log a warning and do not throw.
- [ ] Tests cover: empty list, single source, multiple sources, type/query/tag filters, limit, fetch error fallback.

### Task 2.2: Implement marketplace_get MCP tool

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4
**Can run parallel with**: Task 2.1, 2.3, 2.4

Create `tool-get.ts` returning full package details including the parsed manifest (via `installer.preview()`) and the README content read from the staged package directory.

**Acceptance criteria**:

- [ ] Searches all enabled marketplaces unless `marketplace` arg supplied.
- [ ] Returns `{ error, code: 'PACKAGE_NOT_FOUND', isError: true }` on miss.
- [ ] Calls `installer.preview()` for the manifest; falls back to marketplace.json entry if preview fails.
- [ ] README is best-effort (returns `undefined` when missing).
- [ ] Tests cover: hit, miss, preview-failure-fallback, README present, README missing.

### Task 2.3: Implement marketplace_list_marketplaces MCP tool

**Size**: Small
**Priority**: High
**Dependencies**: 1.4
**Can run parallel with**: Task 2.1, 2.2, 2.4

Create `tool-list-marketplaces.ts` returning every configured source with a package count from `marketplace.json#plugins.length`.

**Acceptance criteria**:

- [ ] Returns every source (enabled + disabled).
- [ ] `packageCount` reflects fetched marketplace.json plugin array length.
- [ ] On fetch failure, returns `packageCount: 0` and logs a warning.
- [ ] Tests cover: zero/one/many sources, fetch error fallback, personal marketplace appears alongside community after task 1.2 ships.

### Task 2.4: Implement marketplace_list_installed MCP tool

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4
**Can run parallel with**: Task 2.1, 2.2, 2.3

Create `tool-list-installed.ts` that walks `${dorkHome}/plugins/` and `${dorkHome}/agents/` and reads the install-metadata sidecar via `readInstallMetadata()`. Includes a refactor: extract the scan helper from `routes/marketplace.ts` into a new `services/marketplace/installed-scanner.ts` so the tool and the existing route share one implementation.

**Acceptance criteria**:

- [ ] `scanInstalledPackages(dorkHome)` extracted into shared module; route file no longer duplicates the scan.
- [ ] Walks both `plugins/` and `agents/` directories.
- [ ] Filters by type when arg supplied.
- [ ] Tests cover: unfiltered list, type filter, missing sidecar (returns entry without provenance), empty dorkHome.

## Phase 3: Recommendation + Mutation MCP Tools

### Task 3.1: Implement keyword + tag recommendation engine

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1, 2.2, 2.3, 2.4

Create `recommend-engine.ts` with a pure `recommend(entries, context, limit)` function that scores entries by keyword/tag matching and returns the top N. Weights: name +10, description +3, tag +5, featured +2.

**Acceptance criteria**:

- [ ] Returns entries sorted by score descending.
- [ ] Filters out score-0 entries.
- [ ] Caps at `limit`.
- [ ] Featured packages get a +2 boost.
- [ ] `tokenize()` strips punctuation, lowercases, drops stopwords + tokens shorter than 3 chars.
- [ ] Realistic scenario: `'I need to track errors in my Next.js app'` matches a sentry-monitor entry.

### Task 3.2: Implement marketplace_recommend MCP tool

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4, 3.1
**Can run parallel with**: None

Create `tool-recommend.ts` that aggregates entries across enabled marketplaces, applies an optional `type` filter, and delegates to `recommend()` from task 3.1.

**Acceptance criteria**:

- [ ] Input validates `context` (1-500 chars), `type` (optional enum), `limit` (1-20, default 5).
- [ ] Returns recommendation array shape from spec.
- [ ] Tests cover: empty context, type filter, limit truncation, fetch failure on one source does not block others.

### Task 3.3: Implement marketplace_install MCP tool with confirmation gating

**Size**: Large
**Priority**: High
**Dependencies**: 1.4, 1.3, 2.2
**Can run parallel with**: Task 3.4

Create `tool-install.ts` that:

1. Always builds `installer.preview()` first.
2. Requests confirmation via the injected `ConfirmationProvider` (or resolves a token if the caller passed one).
3. Returns `requires_confirmation` + token for external clients.
4. Returns `declined` + reason when the user declines.
5. Calls `installer.install()` only after `approved`.
6. Catches `ConflictError` (code `CONFLICT`) and `InvalidPackageError` (code `INVALID_PACKAGE`).

**Acceptance criteria**:

- [ ] Preview built BEFORE confirmation request.
- [ ] Token issuance + resume cycle works end-to-end.
- [ ] Decline path returns reason.
- [ ] All error cases caught and surfaced with code.
- [ ] Tests use `FakeConfirmationProvider` + stub `InstallerLike`. **No test exercises the real `transaction.ts` rollback path.** Any future test that does MUST mock `transactionInternal.isGitRepo` to return false per `contributing/marketplace-installs.md`.

### Task 3.4: Implement marketplace_uninstall MCP tool with confirmation gating

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4, 1.3
**Can run parallel with**: Task 3.3

Create `tool-uninstall.ts` mirroring the install flow with the same confirmation gate. Catches `PackageNotInstalledError` (code `NOT_INSTALLED`).

**Acceptance criteria**:

- [ ] Token issuance + resume happy path works.
- [ ] Returns `purgedPaths` and `preservedPaths` from the uninstall flow result.
- [ ] Tests cover: in-app approve, token resume, decline, package not installed, purge true vs false.
- [ ] No test exercises the real transaction rollback path.

### Task 3.5: Implement marketplace_create_package MCP tool

**Size**: Large
**Priority**: High
**Dependencies**: 1.2, 1.4, 1.3
**Can run parallel with**: None

Create `tool-create-package.ts` that gates on confirmation, then delegates to `createPackage()` from `@dorkos/marketplace/scaffolder` to scaffold a new package under `${dorkHome}/personal-marketplace/packages/<name>/`. Auto-appends an entry to the personal `marketplace.json` so `marketplace_search` and `marketplace_list_installed` see the new package.

**Acceptance criteria**:

- [ ] Confirmation gate fires before any disk write.
- [ ] Scaffolder called with `parentDir = ${dorkHome}/personal-marketplace/packages`.
- [ ] Personal marketplace.json updated idempotently.
- [ ] Returns code `CREATE_FAILED` on scaffolder error.
- [ ] Tests use `mkdtemp` + initialized personal marketplace; cover confirmation flow, scaffolded files exist, marketplace.json updated, duplicate name handling.

## Phase 4: Server Wiring

### Task 4.1: Wire marketplace MCP tools into createExternalMcpServer and server bootstrap

**Size**: Large
**Priority**: High
**Dependencies**: 1.2, 1.4, 2.1, 2.2, 2.3, 2.4, 3.2, 3.3, 3.4, 3.5
**Can run parallel with**: None

The integration task. Adds:

1. `ensurePersonalMarketplace()` call in `apps/server/src/index.ts` after `ensureBuiltinMarketplaceExtension()`.
2. `confirmationProvider` selection (`AutoApproveConfirmationProvider` if `MARKETPLACE_AUTO_APPROVE=1`, else `TokenConfirmationProvider`).
3. `MarketplaceMcpDeps` bundle construction.
4. New optional `marketplaceDeps` parameter to `createExternalMcpServer()`.
5. `confirmation-registry.ts` singleton so the HTTP route layer can reach the provider.

**Acceptance criteria**:

- [ ] `ensurePersonalMarketplace()` runs in a try/catch (non-fatal failure).
- [ ] `MARKETPLACE_AUTO_APPROVE=1` env var swaps in `AutoApproveConfirmationProvider`.
- [ ] All 8 marketplace tools appear in MCP `tools/list` after this task lands.
- [ ] No regression in existing MCP tools.
- [ ] If marketplace services are not available (relay disabled), the server still boots with `marketplaceMcpDeps = undefined`.

### Task 4.2: Add HTTP route for out-of-band confirmation token approval

**Size**: Small
**Priority**: Medium
**Dependencies**: 4.1
**Can run parallel with**: None

Add `POST /api/marketplace/confirmations/:token` accepting `{ action: 'approve' | 'decline', reason?: string }`. The route reads the singleton confirmation provider from the registry and calls `approve(token)` / `decline(token, reason)` on the `TokenConfirmationProvider`. Returns 503 when no provider, 409 when provider is not token-based.

**Acceptance criteria**:

- [ ] Returns 400 on schema failure, 503 when no provider, 409 when wrong provider type, 200 `{ ok: true }` on success.
- [ ] Tests use supertest with stub deps + real `TokenConfirmationProvider`; cover approve, decline, unknown token.
- [ ] No test touches the real install transaction path.

## Phase 5: Integration Testing & Documentation

### Task 5.1: End-to-end integration test for marketplace MCP tools

**Size**: Large
**Priority**: High
**Dependencies**: 4.1, 4.2
**Can run parallel with**: Task 5.2, 5.3, 5.4

Create `integration.test.ts` that stands up a real `McpServer` with `registerMarketplaceTools()` against a real `MarketplaceSourceManager` + `MarketplaceCache` + `PackageFetcher` (with `file://` support) and a stub `InstallerLike`. Exercises the full search → recommend → get → install (token flow) → list_installed → uninstall (token flow) → create_package sequence.

**Acceptance criteria**:

- [ ] Covers all 8 scenarios listed in the JSON description.
- [ ] Uses real `TokenConfirmationProvider` to test the issue/resume cycle.
- [ ] Does NOT touch the real install transaction path. Any future iteration that wires the real installer in MUST mock `transactionInternal.isGitRepo` to return false.

### Task 5.2: Author contributing/external-agent-marketplace-access.md

**Size**: Medium
**Priority**: High
**Dependencies**: 4.1
**Can run parallel with**: Task 5.1, 5.3, 5.4

Create `contributing/external-agent-marketplace-access.md` with: endpoint info, auth model, Claude Code / Cursor / Codex setup snippets, full tool table, confirmation flow walkthrough, CI/automation note (`MARKETPLACE_AUTO_APPROVE=1`).

**Acceptance criteria**:

- [ ] File written at the new path.
- [ ] All three external agent setups documented.
- [ ] Tool table covers all 8 tools with auth requirements.
- [ ] Confirmation flow walkthrough explains the token round-trip.
- [ ] Cross-linked from `contributing/marketplace-installs.md`.

### Task 5.3: Update AGENTS.md and CHANGELOG with marketplace MCP capability

**Size**: Small
**Priority**: Medium
**Dependencies**: 5.2
**Can run parallel with**: Task 5.1, 5.4

Add a one-liner about `services/marketplace-mcp/` in the AGENTS.md service domains list, add the new contributing guide to the guide table, extend the `/mcp` blurb to mention marketplace tools, add an Unreleased section in CHANGELOG.md describing the new capability.

**Acceptance criteria**:

- [ ] AGENTS.md service domain bullet mentions `services/marketplace-mcp/`.
- [ ] AGENTS.md guide table includes the new doc.
- [ ] AGENTS.md /mcp blurb mentions marketplace tools.
- [ ] CHANGELOG Unreleased entry under Added covers the three bullets from the task.

### Task 5.4: Verify tools/list discovery and acceptance criteria

**Size**: Small
**Priority**: High
**Dependencies**: 4.1, 5.1, 5.2, 5.3
**Can run parallel with**: None

Final gate. Adds a smoke test asserting all 8 marketplace tools are registered in an `McpServer` after `registerMarketplaceTools()` runs. Walks every spec acceptance criterion against the implementation. Runs `pnpm vitest`, `pnpm typecheck`, `pnpm lint` and confirms green.

**Acceptance criteria**:

- [ ] Smoke test confirms 8 tools registered.
- [ ] Every spec acceptance criterion verified or filed as a follow-up.
- [ ] `pnpm vitest run apps/server/src/services/marketplace-mcp` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.

## Critical Path

```
1.1 ─┐
     ├─ 1.2 ─┐
1.3 ─┤      │
     └─ 1.4 ┴─ 2.1, 2.2, 2.3, 2.4 ─┐
                3.1 ───────── 3.2 ┤
                      3.3, 3.4   ┤
                      3.5 ───────┴─ 4.1 ─ 4.2 ─ 5.1 ─ 5.4
                                          └─ 5.2 ─ 5.3 ──┘
```

The longest critical path runs: 1.3 → 1.4 → 2.2 → 3.3 → 4.1 → 5.1 → 5.4 (7 tasks, mixed sizes).

## Parallel Opportunities

- **Phase 1**: Tasks 1.1, 1.2, 1.3 are mostly independent (1.2 only needs 1.1 conceptually, but the modules are separate). Run 1.1 + 1.3 in parallel; 1.2 can start once 1.1 is in flight.
- **Phase 2**: Tasks 2.1, 2.2, 2.3, 2.4 all depend only on 1.4 and create independent files — perfect for parallel execution. The shared edit to `marketplace-mcp-tools.ts` is small (one registration line per task) and conflict-merge friendly.
- **Phase 3**: Tasks 3.3 and 3.4 are parallel (separate files, both depend on 1.3 + 1.4). Task 3.5 depends on 1.2 which gates it slightly.
- **Phase 5**: Tasks 5.1, 5.2 can run in parallel after 4.1/4.2. Task 5.3 depends on 5.2 (AGENTS.md references the new doc).

## Testing notes (from AGENTS.md, .claude/rules/testing.md, contributing/marketplace-installs.md)

Every test in this spec must follow the rollback safety pattern documented in `contributing/marketplace-installs.md#5-transaction-lifecycle` and ADR-0231:

> **Every Vitest test that exercises `runTransaction({ rollbackBranch: true })` MUST mock `transactionInternal.isGitRepo` to return `false` in `beforeEach`.**

This decomposition deliberately avoids exercising the real install flows from the new MCP tool tests — every test uses a stub `InstallerLike` / stub `UninstallFlow` so the rollback path is structurally unreachable. The integration test in task 5.1 reinforces this by also stubbing the installer. If a future iteration of these tests instantiates the real `MarketplaceInstaller` with real flows, the `isGitRepo` stub becomes mandatory.

Server tests use real `McpServer` instances (no Claude Agent SDK imports — those are confined to `services/runtimes/claude-code/`). Marketplace MCP tools live in `services/marketplace-mcp/`, NOT in `services/runtimes/claude-code/mcp-tools/`, so they never touch the SDK.
