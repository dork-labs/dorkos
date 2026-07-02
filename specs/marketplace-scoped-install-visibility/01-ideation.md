---
slug: marketplace-scoped-install-visibility
number: 269
created: 2026-07-02
status: ideation
---

# Marketplace: Cross-Scope Install Visibility & Per-Agent Management

**Slug:** marketplace-scoped-install-visibility
**Author:** Claude (fast-tracked from live investigation with Dorian)
**Date:** 2026-07-02

> **Maturity note (IDEATE classification):** this arrived as a _detailed,
> partially-implemented design_, not rough notes. Per the `ideating-features`
> skill this document adapts the completed investigation rather than
> re-ideating. The core implementation exists on branch
> `worktree-marketplace-scoped-install-visibility` (commits `9c27905d`,
> `0d94b2f7`) and was browser-verified before this artifact was written.

---

## 1) Intent & Assumptions

- **Task brief:** After installing a plugin (e.g. `flow`) to a _specific agent_
  instead of globally, the Marketplace gives no indication the package is
  installed on that agent and no way to manage the per-agent installation
  (uninstall from one agent, reinstall on one agent). Deliver full visibility
  and management of installations across scopes, at 10/10 UI/UX and DX quality.
- **Assumptions:**
  - "Scope" means the two install roots that exist today: global
    (`<dorkHome>/plugins/<name>`) and agent-local
    (`<projectPath>/.dork/plugins/<name>`).
  - The registered-agent list (mesh registry, `meshCore.listWithPaths()`) is
    the authoritative enumeration of agent scopes.
  - The install/uninstall server flows already accept `projectPath`
    (boundary-validated) — verified true during discovery.
- **Out of scope:**
  - External-harness projection (standalone `claude` CLI / Cursor / Codex
    seeing DorkOS-installed plugins) — tracked as DOR-177.
  - Per-agent scoping of the _extensions_ subsystem (enable/disable state is
    global today; see Decision 7).
  - Cross-agent scanning of unregistered/orphaned agent directories.

## 2) Pre-reading Log

- `apps/server/src/services/marketplace/installed-scanner.ts`: merged
  single-project view only; global-only listing when no `projectPath`; the
  merge tags `global` / `agent-local` / `override`.
- `apps/server/src/routes/marketplace.ts`: `GET /installed` +
  `GET /installed/:name` accept optional `projectPath`; uninstall/install
  bodies accept `projectPath` with `validateBoundary`.
- `apps/client/src/layers/features/marketplace/ui/PackageDetailSheet.tsx`: code
  comment explicitly stated the drawer "reflects GLOBAL installs only … a
  deliberate follow-up" — this work is that follow-up.
- `apps/client/src/layers/features/marketplace/ui/InstallConfirmationDialog.tsx`:
  scope picker (global vs specific agent) with `installContext` pre-selection
  already existed — reusable for per-row Reinstall.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` +
  `messaging/plugin-activation.ts`: `activatedPlugins` is ONE global array
  (scanned from `<dorkHome>/plugins` only) applied to every session.
- `apps/server/src/services/harness/auto-project.ts`: project-scoped installs
  auto-project skills/hooks to the project's _other_ harnesses; the
  claude-code harness is deliberately skipped ("the SDK owns the runtime
  half") — an assumption that only holds inside DorkOS sessions.
- `apps/server/src/routes/mesh.ts` + `packages/mesh/src/mesh-core.ts`:
  `GET /mesh/agents/paths` → `meshCore.listWithPaths()` returns
  `{id, name, displayName?, projectPath}` — the server-side agent enumeration
  seam.

## 3) Codebase Map

- **Primary components:**
  - Server: `services/marketplace/installed-scanner.ts` (scan),
    `routes/marketplace.ts` (HTTP), `services/runtimes/claude-code/`
    (activation, warm probe, command cache), `index.ts` (wiring).
  - Client: `features/marketplace/ui/PackageDetailSheet.tsx` (drawer),
    `InstallConfirmationDialog.tsx` (scope picker),
    `InstalledPackagesView.tsx` (manage list, dev-playground-only today),
    `entities/marketplace` (hooks + query keys), shared `transport.ts`.
- **Shared dependencies:** `@dorkos/shared/marketplace-schemas`
  (`InstalledPackage`, `PackageScope`), mesh registry, TanStack Query cache
  keys (`marketplaceKeys.installed*`).
- **Data flow:** disk (`.dork/plugins` trees) → scanner → route → transport →
  entity hooks → drawer/grid; installs mutate disk → `onPluginsChanged` →
  runtime plugin refresh + harness auto-projection + `commands_changed`
  broadcast → palette re-fetch (UX-12).
- **Potential blast radius:** every consumer of `GET /installed` (grid badge,
  drawer, manage view, install dialog reinstall detection, MCP
  `marketplace_list_installed`), plugin activation for ALL sessions, warm
  probe lifecycle.

## 4) Root Cause Analysis

Two distinct defects, both empirically reproduced (dev:dogfood, 2026-07-01):

- **Repro steps:**
  1. Marketplace → search `flow` → open drawer → Reinstall → scope "Specific
     agent" → E2E Test Agent → Install (succeeds; files land at
     `~/tmp/dorkos-e2e-agent/.dork/plugins/flow`).
  2. Refresh page, reopen drawer.
  3. Separately: uninstall the global copy, then query
     `GET /api/commands?cwd=~/tmp/dorkos-e2e-agent`.
- **Observed vs Expected:**
  - Drawer shows only "Installed globally"; the agent installation is
    invisible and unmanageable. Expected: both installations visible with
    per-scope management.
  - With an agent-only install, the agent's cwd reported **0 flow commands**.
    Expected: the plugin functions for the agent it was installed on.
- **Evidence:**
  - `scanInstalledPackages(dorkHome)` (no `projectPath`) never walks any
    agent directory; drawer/grid call `useInstalledPackages()` with no path.
  - `refreshActivatedPlugins()` → `listEnabledPluginNames(dorkHome)` →
    global-only; `sendMessage` passed `plugins: this.activatedPlugins`
    unconditionally; `warmCommands` gated on `activatedPlugins.length > 0`.
  - Auto-projection wrote `.agents/skills/flow__*` and `.codex/hooks.json`
    into the agent dir but no `.claude/` assets (claude-code harness skipped),
    so nothing compensated inside DorkOS sessions.
- **Root-cause hypotheses:** (confirmed, not hypothetical)
  1. Visibility: single-project merged scan model cannot represent
     "installed in N places" (confidence: proven).
  2. Function: plugin activation has no per-cwd dimension (confidence: proven
     via the 0-commands isolation test).
- **Decision:** fix both; showing "Installed for this agent" while the plugin
  is inert for that agent would violate Honest-by-Design.

## 5) Research

- **Potential solutions (visibility):**
  1. _Client-side fan-out_ — drawer queries `GET /installed?projectPath=X` per
     registered agent. Pros: no server change. Cons: N round-trips per drawer
     open, no MCP parity, pushes the enumeration problem to every client.
  2. _Cross-scope scan server-side, one entry per installation_ — scanner
     walks global roots + every registered agent's `.dork/plugins`, tags each
     entry with scope + agent identity. Pros: one request, self-describing
     API (agentName travels with the record), MCP/UI parity possible, grid
     badge correct for free. Cons: scan cost scales with agent count
     (readdir + two small JSON reads per agent — negligible at 20 agents).
  3. _DB-backed install registry_ — mirror installs into SQLite. Pros: fast
     queries. Cons: second source of truth vs file-first convention
     (ADR-0043 spirit), reconciliation burden. Rejected.
- **Potential solutions (function):**
  1. _Per-cwd activation at dispatch_ — merge global set with the session
     cwd's `.dork/plugins/*` on every send/warm; local wins on name
     collision. Pros: always fresh (no cache invalidation), works for any
     directory, matches install semantics. Cons: one readdir per message
     (negligible; dispatch is not a hot path).
  2. _Registry-driven activation_ — consult mesh registry to decide plugin
     sets per agent. Cons: breaks for unregistered dirs; couples runtime to
     mesh. Rejected.
  3. _Project `.claude/` assets for claude-code harness_ — make auto-projection
     write commands/skills into the agent's `.claude/`. Pros: also fixes
     external CLI. Cons: duplicates what SDK plugin activation already does
     inside DorkOS; belongs to the DOR-177 harness-sync track. Deferred.
- **Recommendation:** visibility #2 + function #1 (both implemented).

## 6) Decisions

| #   | Decision                                  | Choice                                                                                                                              | Rationale                                                                                                      |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Where agent-local plugins activate        | Per-cwd resolution at dispatch: global ∪ `<cwd>/.dork/plugins/*`, dedupe by name, local wins                                        | Fresh scan per message needs no invalidation; install-dir name IS the package name so basename dedupe is exact |
| 2   | Installed-list API shape                  | One entry PER INSTALLATION across global + registered agents; `projectPath` param keeps merged view                                 | UI/MCP can show and manage each scope independently; merged view still serves reinstall detection              |
| 3   | Agent identity in API                     | Server enriches entries with `agentId`/`agentName` (displayName preferred)                                                          | Clients never re-derive display names from paths                                                               |
| 4   | Detail endpoint shape                     | `GET /installed/:name` → `{ installations: [...] }`, each with `provides`                                                           | Clean break; all consumers owned in-repo; 404 preserved                                                        |
| 5   | Drawer UX for installed packages          | Installations panel: row per scope with Reinstall (pre-scoped dialog) + two-click-confirm Uninstall; footer "Install…" adds a scope | Mirrors Manage-Installed's confirm pattern; reuses existing `installContext` dialog machinery                  |
| 6   | "Manage Installed" surface (was dead UI)  | Mount at `?view=installed` on the Marketplace page                                                                                  | User decision 2026-07-02; consistent with PR #71 URL-driven browse state; no-dead-code rule forces the call    |
| 7   | Extension-bearing packages at agent scope | Warning-level conflict ("extensions are global; they will affect all agents"), install proceeds                                     | User decision 2026-07-02; extension enable state has no per-agent dimension; block would forbid legitimate use |
| 8   | Spec scope                                | Core (shipped) + Phase-2 follow-ups in ONE spec; DOR-177 external-harness stays separate; polish captured as tracker items          | User decision 2026-07-02; Phase-2 items are cohesive and small                                                 |
| 9   | Stale preview in scope dialog             | Suppress preview + reinstall framing while "Specific agent" has no agent picked                                                     | Previewing the GLOBAL scope's effects for a non-global install is dishonest                                    |
| 10  | Uninstall toast copy                      | Scope label in feature-layer wrapper (`where`), e.g. "Uninstalled flow from E2E Test Agent"                                         | Display-only concern stays out of entity args                                                                  |

**Recommended next step:** SPECIFY (`02-specification.md`) — fast-track, since
design and core implementation are already validated.
