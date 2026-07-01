# Marketplace Scoped Installs — Task Breakdown

> Generated from `specs/marketplace-scoped-installs/02-specification.md`
> Mode: Full | Date: 2026-04-13

---

## Phase 1: Server Scoping (Foundation)

### Task 1.1 — Extend InstalledPackage type with scope and agentPath fields

- **Size**: Small | **Priority**: High
- **Dependencies**: None

Add `PackageScope = 'global' | 'agent-local' | 'override'` type and optional `scope` / `agentPath` fields to `InstalledPackage` in both:

- Server: `apps/server/src/services/marketplace/installed-scanner.ts`
- Shared: `packages/shared/src/marketplace-schemas.ts`

Fields are optional to maintain backward compatibility. No behavioral changes — type-only.

---

### Task 1.2 — Update scanInstalledPackages to accept optional projectPath with merge resolution

- **Size**: Medium | **Priority**: High
- **Dependencies**: 1.1

Update `scanInstalledPackages(dorkHome, projectPath?)` to:

1. Scan global packages from `dorkHome/plugins/` and `dorkHome/agents/`
2. When `projectPath` provided, additionally scan `${projectPath}/.dork/plugins/`
3. Tag packages with `scope: 'global'`, `'agent-local'`, or `'override'`
4. Merge using Map — global first, local wins on name collision

Without `projectPath`, behavior is identical to current (backward compat).

**Tests**: 6 new tests in `installed-scanner.test.ts` covering backward compat, global tagging, agent-local scanning, override resolution, empty dir, and missing dir.

---

### Task 1.3 — Update marketplace route to accept projectPath query param with boundary validation

- **Size**: Medium | **Priority**: High
- **Dependencies**: 1.2

Update `GET /api/marketplace/installed` and `GET /api/marketplace/installed/:name` to:

1. Read optional `projectPath` query param
2. Validate against `validateBoundary()` (import from `../lib/boundary.js`)
3. Return 403 on `BoundaryError` (path traversal prevention)
4. Pass validated `projectPath` to `scanInstalledPackages`

**Tests**: Boundary validation returning 403, backward compat without param, scoped listing.

---

### Task 1.4 — Add cross-scope warning to conflict detector for agent-local installs

- **Size**: Small | **Priority**: Medium
- **Dependencies**: 1.1
- **Parallel with**: 1.2, 1.3

Enhance `ConflictDetector.#detectPackageNameConflict` to emit a warning-level `'package-name'` conflict when installing agent-locally and a global package with the same name exists. The warning is informational (not blocking) and mentions the override behavior.

**Tests**: 3 new tests — warns on cross-scope collision, no warn without collision, still errors on same-scope collision.

---

## Phase 2: Toolkit Tab (UI)

### Task 2.1 — Add toolkit tab to AgentHubTab union, tab bar, and tab content with lazy loading

- **Size**: Medium | **Priority**: High
- **Dependencies**: 1.1
- **Parallel with**: 2.2

Wire `'toolkit'` into:

1. `AgentHubTab` type union in `agent-hub-store.ts`
2. `TABS` array in `AgentHubTabBar.tsx`
3. Lazy import + content map in `AgentHubTabContent.tsx`
4. Deep link support: update `VALID_HUB_TABS`, `TAB_MIGRATION`, `LEGACY_TAB_MAP` in `use-agent-hub-deep-link.ts`
5. Create stub `ToolkitTab.tsx` so lazy import resolves

**Tests**: Store accepts `'toolkit'`, `openHub` with toolkit param works.

---

### Task 2.2 — Update query keys, useInstalledPackages hook, and transport to support projectPath

- **Size**: Medium | **Priority**: High
- **Dependencies**: 1.1
- **Parallel with**: 2.1

Thread `projectPath?` through the client data stack:

1. `marketplaceKeys.installed(projectPath?)` — adds `{ projectPath }` dimension to cache key
2. `useInstalledPackages(projectPath?)` — passes to transport
3. `listInstalledPackages(projectPath?)` in `marketplace-methods.ts` — appends `?projectPath=` query param
4. Update embedded mode stub signature

**Tests**: Different projectPaths produce different cache keys, hook passes param to transport.

---

### Task 2.3 — Create ScopeBadge component and implement full ToolkitTab with Skills and Tools sections

- **Size**: Large | **Priority**: High
- **Dependencies**: 2.1, 2.2

Create:

1. `ScopeBadge.tsx` — pill component with scope-dependent colors (grey/blue/amber)
2. Full `ToolkitTab.tsx` with two AccordionSection areas:
   - **Skills**: Lists `type === 'skill-pack'` packages with name, version, type badge, scope badge. Empty state. "Browse skill-packs" button.
   - **Tools & MCP**: Renders `AgentToolsTab` from `@/layers/features/agent-settings`

**Tests**: Empty state, scope badges render, browse button present, hook called with projectPath.

---

### Task 2.4 — Remove Tools & MCP accordion from ConfigTab

- **Size**: Small | **Priority**: High
- **Dependencies**: 2.3

Remove the "Tools & MCP" `AccordionSection` from `ConfigTab.tsx`. Clean up unused imports (`Wrench`, `AgentToolsTab`). Renumber remaining section comments.

ConfigTab retains: Agent Metadata, Channels, Advanced.

**Tests**: Update any existing ConfigTab tests that assert "Tools & MCP" presence.

---

## Phase 3: Scoped Install Flow (User Interaction)

### Task 3.1 — Add installContext to marketplace-store and scope selector to InstallConfirmationDialog

- **Size**: Large | **Priority**: High
- **Dependencies**: 2.2
- **Parallel with**: 3.3

1. Add `InstallContext` interface (`agentPath`, `agentName`) and `installContext` state to `MarketplaceState`
2. Update `openInstallConfirm(pkg, context?)` to accept optional context
3. Add scope selector UI to `InstallConfirmationDialog.tsx`:
   - `<Select>` with "All agents (global)" and optional "{agentName} (local)"
   - Defaults to `'agent-local'` when context present, `'global'` otherwise
   - Passes `projectPath` to install mutation when agent-local selected

**Tests**: Default scope based on context presence, projectPath passed/omitted correctly.

---

### Task 3.2 — Wire Browse skill-packs CTA in ToolkitTab to pass agent install context

- **Size**: Medium | **Priority**: Medium
- **Dependencies**: 2.3, 3.1

Connect the "Browse skill-packs" button to:

1. Set Marketplace type filter to `'skill-pack'`
2. Set install context with agent's `projectPath` and `displayName`/`name`
3. Add `setInstallContext` action to Marketplace store

**Tests**: Click sets type filter and install context in store.

---

### Task 3.3 — Update mutation cache invalidation for both global and scoped query keys

- **Size**: Medium | **Priority**: High
- **Dependencies**: 2.2
- **Parallel with**: 3.1

Update `useInstallPackage`, `useUninstallPackage`, and `useUpdatePackage` `onSuccess` callbacks to:

1. Always invalidate `marketplaceKeys.installed()` (global)
2. When `options?.projectPath` present, also invalidate `marketplaceKeys.installed(projectPath)`

**Tests**: Global install invalidates global key only; scoped install invalidates both.

---

### Task 3.4 — Enhance InstalledPackagesView with scope badges and optional scope filter

- **Size**: Medium | **Priority**: Medium
- **Dependencies**: 2.3, 3.3

1. Add `scope` prop to `PackageRow` and render `ScopeBadge` for non-global packages
2. Add scope filter buttons (All / Global / Local / Override) — shown only when scoped packages exist
3. Global packages show no badge (clean default)

**Tests**: Badge rendering per scope, no badge for global/undefined, filter visibility and functionality.

---

## Dependency Graph

```
1.1 ──┬── 1.2 ── 1.3
      ├── 1.4
      ├── 2.1 ──┐
      └── 2.2 ──┤
                ├── 2.3 ── 2.4
                │    │
                │    ├── 3.2
                │    └── 3.4
                ├── 3.1
                └── 3.3
```

**Critical path**: 1.1 → 1.2 → 1.3 (server foundation), then 2.1+2.2 (parallel) → 2.3 → 2.4 (UI), then 3.1+3.3 (parallel) → 3.2+3.4 (interaction).
