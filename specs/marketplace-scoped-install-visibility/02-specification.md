---
slug: marketplace-scoped-install-visibility
number: 268
created: 2026-07-02
status: specified
---

# Marketplace: Cross-Scope Install Visibility & Per-Agent Management

**Status:** Approved <!-- core phases implemented on worktree branch; Phase 2 pending -->
**Author:** Claude (with Dorian)
**Date:** 2026-07-02

## Overview

Make every installation of a marketplace package visible and manageable, per
scope: a package installed globally and on two agents shows three
installations, each with its own Reinstall and Uninstall. Underneath the UI,
make agent-scoped installs actually _function_ for their agent's sessions —
previously they never activated at all.

## Background / Problem Statement

Two verified defects (see `01-ideation.md` §4 for the full root-cause trail):

1. **Invisible:** the installed-package pipeline (`scanInstalledPackages` →
   `GET /installed` → drawer/grid) only saw `<dorkHome>/plugins` +
   `<dorkHome>/agents`. Installing to a specific agent
   (`<projectPath>/.dork/plugins/<name>`) succeeded on disk but the UI showed
   nothing — no scope, no management, "Installed globally" or a bare Install
   button.
2. **Inert:** Claude runtime plugin activation used one global
   `activatedPlugins` array for every session. With flow installed _only_ on
   the E2E Test Agent, that agent's cwd reported **0 flow commands**
   (empirically isolated). Harness auto-projection deliberately skips the
   claude-code harness, so nothing compensated.

## Goals

- One entry **per installation** across all scopes in the installed API, each
  tagged with scope and agent identity.
- Drawer shows every installation with per-row Reinstall (pre-scoped confirm
  dialog) and Uninstall (two-click confirm, scoped toast).
- Agent-local plugins activate for that agent's sessions: commands, skills,
  hooks live from the next message / palette warm.
- Scope dialog never shows another scope's preview or conflicts.
- A reachable Manage-Installed surface listing all installations.
- MCP parity: external agents see the same cross-scope truth.

## Non-Goals

- External-harness projection (standalone `claude` CLI, Cursor, Codex seeing
  DorkOS-installed plugins) — **DOR-177**, including the agent-scope
  dimension this work exposed (auto-projection skips `.claude/`; the "SDK owns
  the runtime half" assumption only holds inside DorkOS).
- Per-agent scoping of the extensions subsystem (enable state stays global;
  this spec only _warns_ — see Phase 2.4).
- Scanning unregistered agent directories (orphaned installs are handled at
  unregister time, Phase 2.3, not by directory discovery).
- Update-available indicators, cross-direction install notes, subdirectory
  cwd walk-up, e2e Playwright coverage — captured as polish tracker items.

## Technical Dependencies

- Mesh registry (`meshCore.listWithPaths()`) for agent-scope enumeration.
- Claude Agent SDK `options.plugins` (`{type:'local', path}` entries) and the
  idle-probe warm machinery from PR #70.
- `@dorkos/marketplace` `PACKAGE_MANIFEST_PATH` for install-dir validation.

## Detailed Design

### Implemented (commits `9c27905d`, `0d94b2f7` on `worktree-marketplace-scoped-install-visibility`)

- **Per-cwd plugin activation** (`ADR-0305`):
  `buildPluginsForCwd({cwd, globalPlugins, logger})` in
  `services/runtimes/claude-code/messaging/plugin-activation.ts` merges the
  global set with `<cwd>/.dork/plugins/*` (directories bearing a package
  manifest), deduped by basename with local winning. Wired into:
  - `sendMessage` (`plugins: await this.resolvePluginsForCwd(cwdKey)`),
  - `warmCommands` (probe skips when the merged set is empty; idle prompt
    created lazily),
  - `refreshActivatedPlugins(changedProjectPath?)` — a project-scoped
    install/uninstall drops that cwd's SDK command cache
    (`RuntimeCache.clearSdkCommands`) _after_ the live-session reload, so the
    next palette fetch re-warms with the new merged set.
  - `index.ts` `onPluginsChanged` forwards `ctx.projectPath`.
    Fresh scan per dispatch: no cache to invalidate, works for any directory.
- **Cross-scope installations API** (`ADR-0306`):
  `scanInstallationsAcrossScopes(dorkHome, agents)` returns global entries
  (scan order) then agent entries (sorted by display name), one entry per
  installation. Agent entries carry `agentPath`/`agentId`/`agentName` and are
  tagged `override` when the name also exists globally, else `agent-local`.
  Agents deduped by `projectPath`; unreadable dirs skipped.
  - `GET /installed` (no `projectPath`) → cross-scope list;
    `?projectPath=` keeps the merged single-project view (scope-accurate
    reinstall detection in the dialog).
  - `GET /installed/:name` → `{ installations: [...] }`, each enriched with
    `provides` (commands/skills/hooks counts); 404 when absent everywhere.
  - Router dep `listAgentScopes?: () => AgentScopeRef[]`, wired to
    `meshCore.listWithPaths()` (displayName preferred), resolved per request.
  - OpenAPI schemas updated; `docs/api/openapi.json` regenerated.
- **Client:**
  - Transport: `getInstalledPackage` → `listPackageInstallations(name)`;
    entity hook `usePackageInstallations`.
  - `PackageDetailSheet`: `InstallationsPanel` — heading "Installed" /
    "Installed in N locations"; row per installation (Globe "All agents
    (global)" / Bot + agent name, version, date, amber "Overrides global"
    badge); row actions Reinstall (opens `openInstallConfirm(pkg,
{agentPath, agentName})`) and two-click-confirm Uninstall; provenance +
    provides lines beneath; footer `Close` + `Install…` (add another scope).
    Panel renders from the cross-scope list immediately, upgrades to enriched
    installations without flicker.
  - `InstallConfirmationDialog`: `needsAgent` (agent-local scope, no agent
    picked) suppresses the preview, conflicts, and reinstall framing;
    body prompts "Select an agent to preview what this install will do."
  - `InstalledPackagesView`: rows keyed by `installPath`, agent identity in
    metadata, uninstall/update mutations scoped to the row's project.
  - `useUninstallWithToast` accepts display-only `where` for scoped copy.

### Phase 2 (specified here, not yet implemented)

- **2.1 Mount Manage Installed** — add `?view=installed` to the Marketplace
  page's URL-driven state (`use-marketplace-params.ts` + `Marketplace.tsx`),
  rendering `InstalledPackagesView`; header affordance to switch views.
  Removes the dead-UI violation (component is playground-only today).
- **2.2 MCP parity** — `marketplace_list_installed`
  (`services/marketplace-mcp/tool-list-installed.ts:53`) switches to
  `scanInstallationsAcrossScopes`; thread a `listAgentScopes` dep through
  marketplace-mcp tool wiring exactly as the router received it; document the
  new fields in the tool description.
- **2.3 Orphaned installs on unregister** — agent unregistration surfaces the
  agent's `.dork/plugins` contents: log what is being orphaned and (UI path)
  offer uninstall. Minimum bar: a warn-level log listing orphaned packages.
- **2.4 Extension-bearing packages at agent scope** — conflict-detector emits
  a **warning-level** conflict on agent-scoped installs of packages shipping
  `.dork/extensions/`: "This package's extensions are enabled globally — they
  will affect all agents, and uninstalling from one agent disables them
  everywhere." Install proceeds (user decision 2026-07-02).

## User Experience

1. Open a package drawer → if installed anywhere, see every installation as a
   row with scope identity, version, and date; manage each row in place.
2. Row Reinstall opens the confirm dialog already scoped to that row's agent
   (or global); title/button read Reinstall only when that exact slot is
   occupied.
3. Row Uninstall arms a 3-second red Confirm; completion toast names the
   scope ("Uninstalled flow from E2E Test Agent"); the list re-tags live
   (override badge appears/disappears as the global copy comes and goes).
4. Footer "Install…" adds the package to another scope via the same dialog.
5. Choosing "Specific agent" without picking one shows a selection prompt,
   never another scope's preview.
6. `?view=installed` (Phase 2.1) lists every installation across packages.

## Testing Strategy

- **Unit (shipped):** `buildPluginsForCwd` (pass-through, append, override,
  junk-dir skip, empty-dir); `scanInstallationsAcrossScopes` (per-installation
  fan-out, agent sort, override tagging, dedupe, unreadable dirs); route
  tests for both endpoints incl. agent identity + provides; drawer tests
  (rows, two-click confirm, scoped uninstall args, pre-scoped reinstall,
  fallback rendering, pending-row disable); dialog `needsAgent` suppression.
- **Integration (shipped):** install-flow integration updated for renamed
  hooks; interactive-runtime fake-timer choreography fixed (microtask flush
  before mock restore).
- **Phase 2:** route/tool tests for MCP parity; conflict-detector warning for
  extension-bearing scoped installs; Marketplace view-switch test.
- **Mocking:** entity-hook-level mocks in drawer tests; temp-dir real-fs for
  scanner/route tests (no fs mocks); `FakeAgentRuntime` untouched.

## Performance Considerations

- Cross-scope scan = readdir + two small JSON reads per registered agent per
  request; ~20 agents is negligible. Kept off the SDK-activation path
  (`listEnabledPluginNames` unchanged).
- Per-cwd resolution = one readdir per message dispatch / warm probe;
  dispatch is not a hot path. Cold-cache `getCommands` for pluginless cwds
  costs one ENOENT readdir per palette fetch.

## Security Considerations

- Agent paths come from the mesh registry (server-side), not user input;
  uninstall/install `projectPath` keeps `validateBoundary`.
- Local plugin dirs must bear a package manifest to activate — a stray
  directory in `.dork/plugins/` never reaches the SDK.

## Documentation

- `contributing/marketplace-installs.md`: cross-scope scan semantics +
  per-installation API (pre-PR).
- `docs/marketplace.mdx`: installing per agent, managing installations from
  the drawer (pre-PR).
- `refreshActivatedPlugins` TSDoc overpromise ("live sessions instant" — a
  newly installed plugin only arrives on next message) — polish item.

## Implementation Phases

- **Phase 1 — core (DONE, on branch):** per-cwd activation, cross-scope API,
  installations panel, dialog fix, scoped Manage rows, docs regen.
- **Phase 2 — follow-ups (this spec, pending):** 2.1 mount `?view=installed`;
  2.2 MCP parity; 2.3 orphaned-install surfacing on unregister; 2.4
  extension-warning conflict.
- **Phase 3 — external harness (out of scope):** DOR-177.
- **Phase 4 — polish (captured as tracker items):** update-available per row,
  cross-direction install note, subdirectory cwd walk-up, TSDoc truthfulness,
  e2e Playwright flow.

## Open Questions

- ~~Mount vs remove the dead Manage-Installed view?~~ **(RESOLVED)**
  Answer: mount at `?view=installed`. Rationale: consistent with PR #71
  URL-driven browse state; one place to manage everything; no-dead-code rule.
- ~~Warn vs block extension-bearing packages at agent scope?~~ **(RESOLVED)**
  Answer: warning-level conflict, install proceeds. Rationale: extension
  state is global; honesty over prohibition; blocking forbids legitimate use.
- ~~One spec or several?~~ **(RESOLVED)** Answer: core + Phase 2 in this
  spec; DOR-177 separate; polish as captured tracker items. Rationale:
  Phase-2 items are cohesive and individually small.

## Related ADRs

- ADR-0305 — Per-cwd plugin activation for project-scoped installs (draft,
  this spec).
- ADR-0306 — One entry per installation: cross-scope installed API (draft,
  this spec).
- ADR-0304 — File-scoped install transactions (context: reinstall safety).
- ADR-0239 — DorkOS owns the install half, SDK owns the runtime half
  (context: the assumption Phase 3 revisits).
- ADR-0043 — File-first agent storage (context: rejected DB-backed registry).

## References

- `specs/marketplace-scoped-install-visibility/01-ideation.md` (root cause,
  research, decision log).
- Branch `worktree-marketplace-scoped-install-visibility`, commits
  `9c27905d` (runtime), `0d94b2f7` (API + UI).
- PR #70 (installed-aware drawer + warm probe), PR #71 (Marketplace rename +
  deep links) — the substrate this builds on.
- DOR-177 (global harness sync), Linear team DOR.
