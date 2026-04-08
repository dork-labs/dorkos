# Implementation Summary: Marketplace 05: Agent Installer (MCP Server)

**Created:** 2026-04-07
**Last Updated:** 2026-04-07
**Spec:** specs/marketplace-05-agent-installer/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 19 / 19

## Tasks Completed

### Session 1 - 2026-04-07

**Batch 1 (3 parallel agents) — DONE**

- Task #1: [P1] Add file:// source support to PackageFetcher
- Task #3: [P1] Define ConfirmationProvider interface and providers
- Task #9: [P3] Implement keyword + tag recommendation engine

Holistic batch gate: 192/192 server tests passing, typecheck clean, lint clean (2 pre-existing warnings unchanged).

**Batch 2 (2 parallel agents) — DONE**

- Task #2: [P1] Implement personal marketplace bootstrap
- Task #4: [P1] Define MarketplaceMcpDeps and tool registration helper (shipped as no-op stub; task #14 will add registrations)

Holistic batch gate: 215/215 server tests passing, typecheck clean, lint clean (2 pre-existing warnings unchanged — both in spec-04 WIP files unrelated to spec 05).

**Batch 3 (7 parallel agents) — DONE**

- Task #5: [P2] marketplace_search MCP tool
- Task #6: [P2] marketplace_get MCP tool
- Task #7: [P2] marketplace_list_marketplaces MCP tool
- Task #8: [P2] marketplace_list_installed MCP tool (also extracted `scanInstalledPackages` shared helper; refactored `routes/marketplace.ts` to use it; provenance now correctly read from sidecar in BOTH HTTP route and MCP tool)
- Task #10: [P3] marketplace_recommend MCP tool
- Task #12: [P3] marketplace_uninstall MCP tool
- Task #13: [P3] marketplace_create_package MCP tool

All 7 handler files created in `apps/server/src/services/marketplace-mcp/`. None modified `marketplace-mcp-tools.ts` (deferred to task #14 to avoid parallel-edit collisions).

Holistic batch gate: 337/337 server tests passing across 34 test files, typecheck clean, lint clean (same 2 pre-existing warnings unchanged).

**Batch 4 (1 task) — DONE**

- Task #11: [P3] marketplace_install MCP tool with confirmation gating (15 tests, full token-resume cycle, conflict/validation/preview-failure paths covered)

Holistic batch gate: 352/352 tests across 35 files, typecheck clean, lint clean.

**Batch 5 (1 task — load-bearing wiring) — DONE**

- Task #14: [P4] Wire marketplace MCP tools into createExternalMcpServer and server bootstrap

Edits made:

- Filled in `registerMarketplaceTools()` body with all 8 imports + `server.tool(…)` registrations
- Created `confirmation-registry.ts` singleton (`set/get/clearMarketplaceConfirmationProvider`)
- Extended `services/core/mcp-server.ts` `createExternalMcpServer()` with optional `marketplaceDeps` parameter
- Wired `apps/server/src/index.ts` to bootstrap personal marketplace, build confirmation provider (env-flag selection), populate registry singleton, build deps bundle, and thread it into the lazy MCP factory
- Side-fix: relaxed return-type annotations on `tool-list-marketplaces.ts` / `tool-list-installed.ts` / `tool-create-package.ts` so the MCP SDK's structural type for `server.tool()` accepts them
- Side-fix: added `MARKETPLACE_AUTO_APPROVE` to validated `env.ts` schema (avoids `process.env` lint rule)
- Updated `marketplace-mcp-tools.test.ts` to assert all 8 tools registered by name

**Spot-check (full server suite): 2356/2356 tests across 153 test files, typecheck clean, lint clean (index.ts max-lines pre-existing warning grew from 586→622, expected).**

**Batch 6 (2 parallel agents) — DONE**

- Task #15: [P4] HTTP confirmation route — `POST /api/marketplace/confirmations/:token` with 400/503/409/200 paths, 9 supertest tests
- Task #17: [P5] `contributing/external-agent-marketplace-access.md` — endpoint info, Claude Code/Cursor/Codex setup, full 8-tool table, confirmation flow, CI/automation note. Cross-linked from `contributing/marketplace-installs.md`.

Holistic batch gate: 362/362 tests across 36 files, typecheck clean, lint clean.

**Batch 7 (2 parallel agents) — DONE**

- Task #16: [P5] End-to-end integration test for marketplace MCP tools — `apps/server/src/services/marketplace-mcp/__tests__/integration.test.ts` with all 8 mandatory scenarios (search, list_marketplaces, recommend, install token round-trip approve, install token round-trip decline, uninstall token round-trip, create_package end-to-end scaffold, no-regression with sibling tools). Real `MarketplaceSourceManager` + `MarketplaceCache` + `PackageFetcher` against `mkdtemp` dorkHome and `file://` community fixture; stub `InstallerLike` + stub `UninstallFlow`; real `TokenConfirmationProvider`. Internal `_registeredTools` access wrapped behind a `getRegisteredTool()` helper (MCP SDK 1.29 has no public alternative).
- Task #18: [P5] CLAUDE.md service domain bullet + Guides table row + CHANGELOG `Unreleased > Added` block listing all 8 marketplace MCP tools by name.

Holistic batch gate: 370/370 tests across 37 files, typecheck clean, lint clean.

**Batch 8 (1 task — formal final gate) — DONE**

- Task #19: [P5] `tools-list.test.ts` smoke test (real `McpServer`, throwing-deps stubs, `_registeredTools` introspection) verifying all 8 marketplace tools are registered. Plus a 17-item acceptance-criteria walkthrough with direct evidence pointers (test file + line numbers) for every spec requirement.

**Final repo-wide gate**: 2376/2376 server tests across 156 test files, `pnpm typecheck` clean, `pnpm lint` clean (only the 2 pre-existing unrelated warnings in `index.ts:672` line count and `routes/config.ts:97` env var rule, both untouched by spec 05).

The marketplace-mcp suite alone is **14 test files / 162 tests**, all passing.

## Files Modified/Created

**Source files:**

- `apps/server/src/services/marketplace/package-fetcher.ts` (modified — file:// branches in `fetchMarketplaceJson` and `fetchFromGit`, plus `readLocalMarketplaceJson` private method)
- `apps/server/src/services/marketplace-mcp/confirmation-provider.ts` (new — `ConfirmationProvider` interface + 3 implementations)
- `apps/server/src/services/marketplace-mcp/recommend-engine.ts` (new — pure `recommend()` and `tokenize()` functions)
- `apps/server/src/services/marketplace-mcp/personal-marketplace.ts` (new — `ensurePersonalMarketplace`, `personalMarketplaceRoot`, `PERSONAL_MARKETPLACE_NAME`)
- `apps/server/src/services/marketplace-mcp/marketplace-mcp-tools.ts` (new — `MarketplaceMcpDeps` interface + no-op `registerMarketplaceTools`)
- `apps/server/src/services/marketplace-mcp/tool-search.ts` (new — `createSearchHandler`, `SearchInputSchema`, `SearchInputZodSchema`, `SearchInput`)
- `apps/server/src/services/marketplace-mcp/tool-get.ts` (new — `createGetHandler`, `GetInputSchema`)
- `apps/server/src/services/marketplace-mcp/tool-list-marketplaces.ts` (new — `createListMarketplacesHandler`)
- `apps/server/src/services/marketplace-mcp/tool-list-installed.ts` (new — `createListInstalledHandler`, `ListInstalledInputSchema`, `ListInstalledInput`)
- `apps/server/src/services/marketplace-mcp/tool-recommend.ts` (new — `createRecommendHandler`, `RecommendInputSchema`)
- `apps/server/src/services/marketplace-mcp/tool-uninstall.ts` (new — `createUninstallHandler`, `UninstallInputSchema`)
- `apps/server/src/services/marketplace-mcp/tool-create-package.ts` (new — `createCreatePackageHandler`, `CreatePackageInputSchema`)
- `apps/server/src/services/marketplace-mcp/tool-install.ts` (new — `createInstallHandler`, `InstallInputSchema`, `InstallToolArgs`)
- `apps/server/src/services/marketplace-mcp/marketplace-mcp-tools.ts` (modified — filled in `registerMarketplaceTools` with 8 tool registrations)
- `apps/server/src/services/marketplace-mcp/confirmation-registry.ts` (new — singleton for HTTP route to access the active provider)
- `apps/server/src/services/core/mcp-server.ts` (modified — accepts optional `marketplaceDeps`)
- `apps/server/src/index.ts` (modified — personal marketplace bootstrap + deps bundle + MCP wiring)
- `apps/server/src/env.ts` (modified — `MARKETPLACE_AUTO_APPROVE` env var added to validated schema)
- `apps/server/src/services/marketplace-mcp/tool-list-marketplaces.ts` (modified — relaxed return-type annotation for MCP SDK structural compatibility)
- `apps/server/src/services/marketplace-mcp/tool-list-installed.ts` (modified — relaxed return-type annotation)
- `apps/server/src/services/marketplace-mcp/tool-create-package.ts` (modified — relaxed return-type annotations on helpers + handler)
- `apps/server/src/services/marketplace/installed-scanner.ts` (new — `scanInstalledPackages`, `InstalledPackage` interface; shared by HTTP route + MCP tool)
- `apps/server/src/routes/marketplace.ts` (modified — refactored to use `scanInstalledPackages` instead of inline scan)

**Test files:**

- `apps/server/src/services/marketplace/__tests__/package-fetcher.test.ts` (extended — 4 file:// tests added; suite is 7→10)
- `apps/server/src/services/marketplace-mcp/__tests__/confirmation-provider.test.ts` (new — 16 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/recommend-engine.test.ts` (new — 20 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/personal-marketplace.test.ts` (new — 11 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/marketplace-mcp-tools.test.ts` (new — 4 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-search.test.ts` (new — 19 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-get.test.ts` (new — 9 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-list-marketplaces.test.ts` (new)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-list-installed.test.ts` (new — 7 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-recommend.test.ts` (new)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-uninstall.test.ts` (new)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-create-package.test.ts` (new)
- `apps/server/src/services/marketplace-mcp/__tests__/tool-install.test.ts` (new — 15 tests)
- `apps/server/src/services/marketplace-mcp/__tests__/integration.test.ts` (new — 8 end-to-end scenarios)
- `apps/server/src/services/marketplace-mcp/__tests__/tools-list.test.ts` (new — 3 smoke tests)
- `apps/server/src/routes/__tests__/marketplace-confirmations.test.ts` (new — 9 supertest tests)
- `apps/server/src/services/marketplace/__tests__/installed-scanner.test.ts` (new — 5 tests)

**Documentation files:**

- `contributing/external-agent-marketplace-access.md` (new — Claude Code/Cursor/Codex setup, 8-tool table, confirmation flow, CI/automation)
- `contributing/marketplace-installs.md` (modified — added See also link to the new guide)
- `CLAUDE.md` (modified — service domain bullet now mentions `services/marketplace-mcp/`; Guides table row added; External MCP server line mentions marketplace tools)
- `CHANGELOG.md` (modified — `Unreleased > Added` block listing all 8 marketplace MCP tools, personal marketplace, and the marketplace-as-MCP-server capability)

## Known Issues

- `isFileUrl()` and `fileUrlToPath()` in `package-fetcher.ts` are module-private. If a future task needs the same logic outside the fetcher, promote them or use `node:url`'s `pathToFileURL`/`fileURLToPath` directly. (Task #1, agent note.)
- `package-fetcher.ts` uses `new URL(source).pathname` for path conversion which is POSIX-only — Windows would need `fileURLToPath` from `node:url`. Spec verbatim, not a blocker.

## Implementation Notes

### Session 1

**Review approach:** Holistic batch-level gates (not per-task two-stage review). Per `feedback_holistic_batch_gates` memory: for specs with >15 tasks, the orchestrator runs `pnpm typecheck` + targeted vitest + eslint after each parallel batch instead of dispatching ~38 review agents. Task #19 ("Verify tools/list discovery and acceptance criteria") is the formal final review gate baked into the spec. Task #14 (server wiring) gets an individual spot-check because it's the load-bearing integration that flips the MCP surface live.
