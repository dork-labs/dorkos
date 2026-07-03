# Tasks — Marketplace: Cross-Scope Install Visibility & Per-Agent Management

**Spec:** `specs/marketplace-scoped-install-visibility/02-specification.md` (spec #269, DOR-178)
**Generated:** 2026-07-02T12:54:23Z · mode: full
**Canonical source:** `03-tasks.json` (this file is the human-readable mirror — regenerate, don't hand-edit)

Phase 1 ships the already-implemented, browser-verified core (branch
`worktree-marketplace-scoped-install-visibility`, commits `9c27905d`,
`0d94b2f7`, `da7310da`). Phase 2 is the four specified follow-ups; all four are
independent of each other and can run in parallel once Phase 1 lands.

```
1.1 docs ──► 1.2 gates + PR ──► { 2.1 · 2.2 · 2.3 · 2.4 } (parallel)
```

## Phase 1 — Ship the implemented core

### Task 1.1: Write cross-scope install docs (contributing + user docs)

- **Size:** small · **Priority:** high · **Deps:** none
- `contributing/marketplace-installs.md`: cross-scope scan semantics
  (`scanInstallationsAcrossScopes` — one entry per installation, override /
  agent-local tagging, agent identity via `listAgentScopes()`), the API shape
  changes (`GET /installed` cross-scope, `GET /installed/:name` →
  `{ installations }` with `provides`), and the runtime half
  (`buildPluginsForCwd` merge semantics, warm probe, `clearSdkCommands` on
  scoped install/uninstall). Link ADR-0305 / ADR-0306.
- `docs/marketplace.mdx`: installing to a specific agent; the drawer's
  installations panel (row per scope, pre-scoped Reinstall, two-click
  Uninstall, "Overrides global" badge, footer Install…); activation timing
  note (next message / palette warm).
- Acceptance: prose verified against the branch, lint/format clean, brand
  voice (no hype).

### Task 1.2: Run verification gates and open the Phase 1 PR

- **Size:** small · **Priority:** high · **Deps:** 1.1
- `pnpm typecheck && pnpm lint && pnpm test -- --run` in the worktree; verify
  any failure in isolation first (known pre-existing:
  `session-list-watcher.integration` load flake, `extension-proxy` wildcard
  case red on origin/main).
- **HARD GATE:** pushing + opening the PR requires the user's explicit
  go-ahead (repo rule).
- PR per the `creating-pull-requests` skill (draft-first), base `origin/main`:
  two root-caused defects, fix architecture (ADR-0305/0306), browser
  verification notes, spec + ADR pointers.

## Phase 2 — Specified follow-ups (parallel after 1.2)

### Task 2.1: Mount Manage Installed at ?view=installed

- **Size:** medium · **Priority:** high · **Deps:** 1.2 · **Parallel:** 2.2–2.4
- Extend `marketplace-search.ts` schema with
  `view: 'browse' | 'installed'` (router already merges it), extend
  `use-marketplace-params.ts` (stay route-agnostic), render
  `InstalledPackagesView` in `MarketplacePage.tsx` with a header view
  switcher (match the /agents page pattern). Drawer deep-link (`?pkg=`) works
  from both views. Removes the dead-UI violation.
- Tests: default browse, `?view=installed` renders, URL round-trip, drawer
  from installed view.

### Task 2.2: MCP parity: cross-scope installed list for external agents

- **Size:** medium · **Priority:** medium · **Deps:** 1.2 · **Parallel:** 2.1, 2.3, 2.4
- `tool-list-installed.ts:53` → `scanInstallationsAcrossScopes`; thread
  `listAgentScopes` through marketplace-mcp wiring as the router receives it
  (extract the shared mapping in `index.ts`); update tool description + TSDoc
  for the per-installation fields.
- Tests: global-only / agent-only / override fixtures + parity with the HTTP
  route.

### Task 2.3: Surface orphaned installs when an agent is unregistered

- **Size:** medium · **Priority:** medium · **Deps:** 1.2 · **Parallel:** 2.1, 2.2, 2.4
- Server-side scan of `<projectPath>/.dork/plugins/*` before
  `meshCore.unregister` (routes/mesh.ts call sites, or the `onUnregister`
  callback wired from index.ts) → warn-level log naming each orphaned
  package. `packages/mesh` must not import the marketplace scanner.
- Tests: 2 installs → both named in the warn log; no plugins dir → silent.

### Task 2.4: Warn on extension-bearing packages installed at agent scope

- **Size:** small · **Priority:** medium · **Deps:** 1.2 · **Parallel:** 2.1, 2.2, 2.3
- `conflict-detector.ts`: agent-local target + staged `.dork/extensions/*` →
  `level: 'warning'` conflict ("extensions are enabled globally — they will
  affect all agents…"); install proceeds (installer blocks only on error).
  Dialog already renders warnings once an agent is picked.
- Tests: warning fires only for agent-scope + extensions; never blocks.

## Not promoted to sub-issues

All tasks are ≤ medium (threshold: xl) — everything stays checklist-only on
DOR-178.
