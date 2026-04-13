---
slug: marketplace-scoped-installs
number: 241
status: specified
created: 2026-04-13
authors: [Claude Code]
spec: marketplace-scoped-installs
ideation: specs/marketplace-scoped-installs/01-ideation.md
---

# Marketplace Scoped Installs & Skills-First Agent Toolkit

## Overview

Add per-agent marketplace package scoping and a skills-first "Toolkit" tab to the agent hub. Currently, all marketplace packages install globally to `~/.dork/plugins/` with no per-agent visibility or control. This spec introduces agent-local installs at `{agent.projectPath}/.dork/plugins/`, an additive cascade resolution model (global + agent-local, local wins on conflict), and a new "Toolkit" tab that surfaces an agent's effective skills and tools in one place.

## Background / Problem Statement

The marketplace installation system has several architectural gaps:

1. **No per-agent scoping** — The server supports `projectPath` in `InstallOptions` and the conflict detector uses it (line 100 of `conflict-detector.ts`), but the client never passes it. All packages install globally.
2. **No agent-level visibility** — Users cannot see what skills/packages are available to a specific agent. The only installed view is global (`InstalledPackagesView`).
3. **No skills-first UX** — Skills (SKILL.md files from skill-packs) are the primary capability users care about, but they're buried inside the package abstraction. Industry convergence on "skills" as the user-facing term (Codex CLI, GitHub Copilot, Microsoft Agent Framework) confirms this should be front-and-center.
4. **Tools & MCP lives in Config** — The "Tools & MCP" accordion in the Config tab is conceptually about "what can this agent do?" — the same question skills answer. These belong together.

## Goals

- Users can install packages globally (all agents) or locally to a specific agent
- The agent hub "Toolkit" tab shows the merged effective set of skills and tools for the selected agent
- Scope is visually clear via badges (Global / Local / Override)
- The install dialog defaults to the right scope based on context
- The existing global InstalledPackagesView gains scope badges
- Backward compatible — scanner without `projectPath` returns global-only (existing behavior)

## Non-Goals

- Exclusion mechanism (`excludedPackages` in agent manifest) — deferred to v2
- Per-skill enable/disable within a skill-pack — deferred to v2
- Cross-scope conflict detection beyond warn-level — deferred to v2
- Skill usage statistics / "last activated" metadata — deferred to v2
- Template type distinction in marketplace browse UI — separate concern
- Changes to marketplace source management — out of scope

## Technical Dependencies

- `@dorkos/marketplace` — Package types, manifest schema, validator (already exists)
- `@dorkos/shared` — Marketplace schemas, mesh schemas (already exists)
- TanStack Query v5 — Data fetching, cache invalidation (already in use)
- Zustand — Agent hub store (already in use)
- No new external dependencies required

## Detailed Design

### 1. Storage Model

```
~/.dork/
├── plugins/                              # Global scope
│   ├── typescript-expert/                # Available to ALL agents
│   │   └── .dork/manifest.json
│   └── github-adapter/
│       └── .dork/manifest.json
│
└── agents/
    └── backend-bot/                      # Agent workspace (default location)
        └── .dork/
            ├── agent.json
            └── plugins/                  # Agent-local scope
                └── api-testing/          # Available ONLY to backend-bot
                    └── .dork/manifest.json

~/projects/my-app/                        # Agent workspace (custom location)
└── .dork/
    ├── agent.json
    └── plugins/                          # Agent-local scope
        └── react-patterns/              # Available ONLY to my-app agent
            └── .dork/manifest.json
```

Agent-local packages live at `{agent.projectPath}/.dork/plugins/<pkg>/`. This follows the established convention where `.dork/extensions/` already lives inside agent workspaces (see `extension-discovery.ts`).

### 2. Resolution Algorithm

```
Given: dorkHome, agentProjectPath

1. globalPackages  = scan(dorkHome + '/plugins/')     → [{name, ..., scope: 'global'}]
2. localPackages   = scan(projectPath + '/.dork/plugins/') → [{name, ..., scope: 'agent-local'}]
3. merged = new Map()
4. for pkg of globalPackages:  merged.set(pkg.name, pkg)
5. for pkg of localPackages:
     if merged.has(pkg.name):
       pkg.scope = 'override'             // local replaces global
     merged.set(pkg.name, pkg)
6. return Array.from(merged.values())
```

When no `projectPath` is provided, step 2 is skipped — preserving existing global-only behavior.

### 3. Server Changes

#### 3a. Installed Scanner (`installed-scanner.ts`)

**Current signature:**

```typescript
export async function scanInstalledPackages(dorkHome: string): Promise<InstalledPackage[]>;
```

**New signature:**

```typescript
export async function scanInstalledPackages(
  dorkHome: string,
  projectPath?: string
): Promise<InstalledPackage[]>;
```

**Implementation:**

- When `projectPath` is undefined: scan `${dorkHome}/plugins/` and `${dorkHome}/agents/` only (backward compatible)
- When `projectPath` is provided: additionally scan `${projectPath}/.dork/plugins/`
- Each package gets a `scope` field based on where it was found
- Name-collision resolution: agent-local wins, gets `scope: 'override'`

#### 3b. Marketplace Route (`routes/marketplace.ts`)

**Current:**

```typescript
router.get('/installed', async (_req, res) => {
  const packages = await scanInstalledPackages(dorkHome);
  res.json({ packages });
});
```

**Updated:**

```typescript
router.get('/installed', async (req, res) => {
  const projectPath = typeof req.query.projectPath === 'string' ? req.query.projectPath : undefined;
  const packages = await scanInstalledPackages(dorkHome, projectPath);
  res.json({ packages });
});
```

The `GET /installed/:name` endpoint follows the same pattern — accepts optional `projectPath` query param.

#### 3c. Conflict Detector Enhancement

The conflict detector already accepts `projectPath` in `ConflictDetectionContext` and uses it as `scopeRoot` (line 100). The enhancement is:

When installing a package agent-locally (`projectPath` provided) and a package with the same name exists globally (`${dorkHome}/plugins/<name>/`), return a **warning-level** conflict:

```typescript
{
  level: 'warning',
  type: 'package-name',
  description: `Package "${name}" is installed globally. The agent-local version will override it for this agent.`,
  conflictingPackage: name,
}
```

This is informational, not blocking — the install proceeds.

### 4. Shared Type Changes

#### 4a. InstalledPackage Extension (`marketplace-schemas.ts`)

**Current:**

```typescript
export interface InstalledPackage {
  name: string;
  version: string;
  type: MarketplacePackageType;
  installPath: string;
  installedFrom?: string;
  installedAt?: string;
}
```

**Updated:**

```typescript
export type PackageScope = 'global' | 'agent-local' | 'override';

export interface InstalledPackage {
  name: string;
  version: string;
  type: MarketplacePackageType;
  installPath: string;
  installedFrom?: string;
  installedAt?: string;
  scope?: PackageScope; // undefined = global (backward compat)
  agentPath?: string; // Set for agent-local packages
}
```

The `scope` field is optional to maintain backward compatibility — existing callers that don't pass `projectPath` get packages without `scope` set (implicitly global).

### 5. Client Changes

#### 5a. Agent Hub Store (`agent-hub-store.ts`)

```typescript
// Before
export type AgentHubTab = 'sessions' | 'config';

// After
export type AgentHubTab = 'sessions' | 'config' | 'toolkit';
```

#### 5b. AgentHubTabBar (`AgentHubTabBar.tsx`)

```typescript
const TABS: TabDef[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'config', label: 'Config' },
  { id: 'toolkit', label: 'Toolkit' },
];
```

#### 5c. AgentHubTabContent (`AgentHubTabContent.tsx`)

Add lazy import:

```typescript
const ToolkitTab = lazy(() => import('./tabs/ToolkitTab').then((m) => ({ default: m.ToolkitTab })));
```

Add to tab map:

```typescript
const ActiveTab = {
  sessions: SessionsTab,
  config: ConfigTab,
  toolkit: ToolkitTab,
}[activeTab];
```

#### 5d. ToolkitTab (new file: `tabs/ToolkitTab.tsx`)

Two-section layout using the existing `AccordionSection` pattern from ConfigTab:

**Section 1: Skills**

- Calls `useInstalledPackages(projectPath)` with the agent's `projectPath` from `useAgentHubContext()`
- Filters to `type === 'skill-pack'` packages
- Groups by source skill-pack name
- Each package row shows: name, version, scope badge, type badge
- Scope badges:
  - **Global** — `bg-muted text-muted-foreground` grey pill
  - **Local** — `bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300` blue pill
  - **Override** — `bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300` amber pill
- "Browse skill-packs" button at bottom opens marketplace with `type: 'skill-pack'` filter
- If no skills installed, show empty state: "No skills installed. Browse the marketplace to add skills to this agent."

**Section 2: Tools & MCP**

- Renders `AgentToolsTab` component (imported from `@/layers/features/agent-settings`)
- Passes `agent`, `projectPath`, `onUpdate` from `useAgentHubContext()`
- This is the same content currently in the Config tab's "Tools & MCP" accordion

#### 5e. Config Tab Update (`ConfigTab.tsx`)

Remove the "Tools & MCP" accordion section (lines 282-285):

```typescript
// REMOVE:
<AccordionSection title="Tools & MCP" icon={Wrench}>
  <AgentToolsTab agent={agent} projectPath={projectPath} onUpdate={onUpdate} />
</AccordionSection>
```

Config tab retains: agent metadata, Channels accordion, Advanced accordion.

#### 5f. Query Keys (`query-keys.ts`)

```typescript
// Before
installed: () => [...marketplaceKeys.all, 'installed'] as const,

// After
installed: (projectPath?: string) =>
  [...marketplaceKeys.all, 'installed', { projectPath: projectPath ?? null }] as const,
```

#### 5g. useInstalledPackages Hook

```typescript
// Before
export function useInstalledPackages() {
  const transport = useTransport();
  return useQuery<InstalledPackage[]>({
    queryKey: marketplaceKeys.installed(),
    queryFn: () => transport.listInstalledPackages(),
    staleTime: 60_000,
  });
}

// After
export function useInstalledPackages(projectPath?: string) {
  const transport = useTransport();
  return useQuery<InstalledPackage[]>({
    queryKey: marketplaceKeys.installed(projectPath),
    queryFn: () => transport.listInstalledPackages(projectPath),
    staleTime: 60_000,
  });
}
```

#### 5h. Transport Layer (`marketplace-methods.ts`)

```typescript
// Before
listInstalledPackages(): Promise<InstalledPackage[]> {
  return fetchJSON<{ packages: InstalledPackage[] }>(baseUrl, '/marketplace/installed')
    .then((r) => r.packages);
}

// After
listInstalledPackages(projectPath?: string): Promise<InstalledPackage[]> {
  const params = projectPath
    ? `?projectPath=${encodeURIComponent(projectPath)}`
    : '';
  return fetchJSON<{ packages: InstalledPackage[] }>(
    baseUrl,
    `/marketplace/installed${params}`
  ).then((r) => r.packages);
}
```

#### 5i. Install Confirmation Dialog Scope Selector

Add a scope selector to `InstallConfirmationDialog.tsx`:

```typescript
// New state
const [installScope, setInstallScope] = useState<'global' | 'agent-local'>(
  defaultScope // 'global' from marketplace, 'agent-local' from agent hub
);

// In the dialog body, before the Install button:
<div className="space-y-1">
  <div className="text-muted-foreground text-[10px] font-medium uppercase">
    Install for
  </div>
  <Select value={installScope} onValueChange={setInstallScope}>
    <SelectTrigger className="h-8 text-sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="global">All agents (global)</SelectItem>
      {agentName && (
        <SelectItem value="agent-local">{agentName} (local)</SelectItem>
      )}
    </SelectContent>
  </Select>
</div>
```

The dialog needs to receive context about which agent triggered the install (if any). This is passed through the Zustand store:

```typescript
// In dork-hub-store.ts, extend the install confirm state:
interface DorkHubState {
  installConfirmPackage: AggregatedPackage | null;
  installContext?: {
    agentPath: string;
    agentName: string;
  };
  openInstallConfirm: (
    pkg: AggregatedPackage,
    context?: { agentPath: string; agentName: string }
  ) => void;
}
```

When "Browse skill-packs" is clicked from the Toolkit tab, it passes the agent context. When browsing from the marketplace directly, no context is passed (defaults to global).

#### 5j. Mutation Cache Invalidation

Install/uninstall mutations must invalidate both global and scoped caches:

```typescript
onSuccess: (_result, { name }) => {
  // Invalidate global installed cache
  void queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
  // Invalidate scoped installed cache (if projectPath was used)
  if (projectPath) {
    void queryClient.invalidateQueries({
      queryKey: marketplaceKeys.installed(projectPath),
    });
  }
  void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packages() });
  void queryClient.invalidateQueries({ queryKey: marketplaceKeys.packageDetail(name) });
};
```

#### 5k. InstalledPackagesView Enhancement

Add scope badges to `PackageRow` in `InstalledPackagesView.tsx`:

```typescript
// After the type badge, add scope badge
{pkg.scope === 'agent-local' && (
  <span className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
    Local
  </span>
)}
{pkg.scope === 'override' && (
  <span className="bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
    Override
  </span>
)}
```

Add optional scope filter above the list for quick filtering.

### 6. Deep Link Support

The agent hub deep link system (`use-agent-hub-deep-link.ts`) should support navigating directly to the toolkit tab:

```
?dialog=agent-hub&agent=<path>&tab=toolkit
```

This requires no structural changes — the existing deep link handler reads the `tab` param and calls `setActiveTab()`.

## User Experience

### Installing from the Marketplace (Global Default)

1. User opens DorkHub marketplace
2. Browses/searches for a skill-pack
3. Clicks "Install" → confirmation dialog appears
4. Scope selector shows "All agents (global)" as default
5. User can switch to a specific agent if desired
6. Confirms → package installs to `~/.dork/plugins/<name>/`

### Installing from Agent Hub (Agent-Local Default)

1. User opens an agent in the agent hub
2. Clicks "Toolkit" tab
3. Sees current skills and tools
4. Clicks "Browse skill-packs" → marketplace opens with skill-pack filter
5. Clicks "Install" → confirmation dialog appears
6. Scope selector shows "[Agent Name] (local)" as default
7. User can switch to "All agents (global)" if desired
8. Confirms → package installs to `{agent.projectPath}/.dork/plugins/<name>/`

### Viewing Agent Toolkit

1. User selects an agent in the sidebar
2. Agent hub right panel opens
3. Clicks "Toolkit" tab
4. **Skills section** shows:
   - Global skill-packs with grey "Global" badges
   - Agent-local skill-packs with blue "Local" badges
   - Override skill-packs with amber "Override" badges
   - "Browse skill-packs" CTA at bottom
5. **Tools & MCP section** shows:
   - Tool group toggles (tasks, relay, mesh, adapter)
   - MCP server configuration

## Testing Strategy

### Server Unit Tests

**installed-scanner.test.ts:**

- `scanInstalledPackages(dorkHome)` without projectPath returns global-only packages (backward compat)
- `scanInstalledPackages(dorkHome, projectPath)` returns merged global + agent-local packages
- Agent-local package with same name as global gets `scope: 'override'`
- Agent-local packages get `scope: 'agent-local'`
- Global packages get `scope: 'global'` when projectPath is provided
- Empty agent-local directory returns only global packages
- Non-existent agent-local plugins directory returns only global packages (no error)

**conflict-detector.test.ts:**

- Installing agent-locally when same name exists globally returns warning (not error)
- Warning description mentions the override behavior
- No warning when the names don't collide

### Client Component Tests

**ToolkitTab.test.tsx:**

- Renders skills section with packages grouped by type
- Shows scope badges correctly (Global/Local/Override)
- "Browse skill-packs" button links to marketplace with filter
- Renders Tools & MCP section with AgentToolsTab
- Empty state when no packages installed

**AgentHubTabBar.test.tsx:**

- Renders three tabs: Sessions, Config, Toolkit
- Toolkit tab click updates store

**InstallConfirmationDialog.test.tsx:**

- Scope selector defaults to "global" when no agent context
- Scope selector defaults to "agent-local" when agent context provided
- Install mutation receives projectPath when agent-local selected
- Install mutation omits projectPath when global selected

**InstalledPackagesView.test.tsx:**

- Renders scope badges for agent-local and override packages
- No scope badge for global packages (clean default)

### Client Hook Tests

**use-installed-packages.test.ts:**

- Hook without projectPath uses global query key
- Hook with projectPath uses scoped query key
- Different projectPaths produce different cache entries

### Integration Tests

- Install a package globally → appears in global InstalledPackagesView
- Install a package agent-locally → appears in agent's Toolkit tab with "Local" badge
- Install same package both globally and agent-locally → agent's Toolkit shows "Override" badge
- Uninstall agent-local package → agent falls back to global version
- Scanner backward compat → no projectPath returns same results as before

## Performance Considerations

- **Scanner overhead**: Adding a second directory scan when `projectPath` is provided adds ~1-5ms (single `readdir` + manifest reads). Negligible compared to the existing global scan.
- **Cache key explosion**: Each unique `projectPath` creates a separate TanStack Query cache entry. With typical agent counts (5-20), this is well within reasonable memory bounds. `staleTime: 60_000` prevents excessive refetching.
- **No N+1 risk**: The scanner reads manifests in parallel within each scope directory, then merges in memory.

## Security Considerations

- **Path traversal**: The `projectPath` query parameter is user-controlled. The server should validate it against the existing boundary check (`validateBoundary()` from agent creation flow) to prevent reading arbitrary directories. The marketplace routes should apply the same validation used by `apps/server/src/routes/agents.ts`.
- **Filesystem permissions**: Agent-local plugins directory (`{projectPath}/.dork/plugins/`) inherits the workspace's filesystem permissions. No elevation required.

## Documentation

- Update `contributing/marketplace.md` (if it exists) to document the scoped install model
- Add inline TSDoc to new/modified functions explaining the scope resolution algorithm
- The Toolkit tab is self-documenting via its UI

## Implementation Phases

### Phase 1: Server Scoping (foundation)

1. Extend `InstalledPackage` type with `scope` and `agentPath` fields
2. Update `scanInstalledPackages()` to accept optional `projectPath`
3. Update `GET /api/marketplace/installed` route with `projectPath` query param
4. Add cross-scope warning to conflict detector
5. Add path validation for `projectPath` parameter
6. Write server unit tests

### Phase 2: Toolkit Tab (UI)

1. Add `'toolkit'` to `AgentHubTab` union
2. Add Toolkit tab to `AgentHubTabBar` and `AgentHubTabContent`
3. Create `ToolkitTab.tsx` with Skills section and Tools & MCP section
4. Create `ScopeBadge` component for Global/Local/Override pills
5. Remove "Tools & MCP" accordion from `ConfigTab.tsx`
6. Update `useInstalledPackages` hook to accept `projectPath`
7. Update transport `listInstalledPackages` to pass `projectPath`
8. Update query keys with `projectPath` dimension
9. Write component and hook tests

### Phase 3: Scoped Install Flow (user interaction)

1. Add `installContext` to `dork-hub-store.ts`
2. Add scope selector to `InstallConfirmationDialog`
3. Wire "Browse skill-packs" CTA in Toolkit tab to pass agent context
4. Update mutation cache invalidation for both global and scoped keys
5. Enhance `InstalledPackagesView` with scope badges
6. Write dialog and integration tests

## Open Questions

None — all decisions were resolved during ideation (see `01-ideation.md` Section 5).

## Related ADRs

- **ADR-0231**: Atomic Transaction Engine for Marketplace Installs — stage/activate/rollback pattern applies to both global and agent-local installs
- **ADR-0230**: Use `agent` (not `agent-template`) as Package Type — relevant context for marketplace package types

## References

- Ideation document: `specs/marketplace-scoped-installs/01-ideation.md`
- Prior marketplace specs: `specs/marketplace-01-foundation/`, `specs/marketplace-02-install/`, `specs/marketplace-05-agent-installer/`
- Extension discovery pattern (reference model): `apps/server/src/services/extensions/extension-discovery.ts`
- Research on scoped install patterns: npm, VS Code, mise/asdf, Codex CLI (see ideation Section 4)
- Research on agent skills UX: Copilot Studio, VS Code Copilot, CrewAI, AutoGen Studio (see ideation Section 4)
- Agent skills open standard: agentskills.io
