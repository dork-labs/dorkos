---
slug: settings-dialog-file-splits
number: 216
created: 2026-04-06
status: specified
---

# Settings Dialog File Splits

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-04-06

---

## 1. Overview

Refactor four oversized files in the Settings dialog feature to drop them under the 300-line ceiling defined in `.claude/rules/file-size.md`. The work is purely mechanical: extract self-contained sub-components, hooks, and config into focused files. **No behavior changes**, **no new abstractions**, **no UX or accessibility improvements** — those are deliberately scoped to follow-on specs.

| File                                                              |   Current |   Target |
| ----------------------------------------------------------------- | --------: | -------: |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`  |       491 |     ~140 |
| `apps/client/src/layers/features/settings/ui/ExternalMcpCard.tsx` |       540 |     ~150 |
| `apps/client/src/layers/features/settings/ui/ToolsTab.tsx`        |       436 |     ~120 |
| `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`    |       490 |     ~180 |
| **Total**                                                         | **1,957** | **~590** |

The remaining ~1,400 lines move to ~18 small, single-responsibility files inside the existing `features/settings` module (plus one promotion to `shared/ui`).

## 2. Background / Problem Statement

The Settings dialog system is one of the largest user-facing surfaces in DorkOS. Over the last several specs (`agents-first-class-entity`, `external-mcp-access`, `tunnel-remote-access-overhaul`, `agent-tools-elevation`, `tasks-system-redesign`) the four target files have steadily accumulated responsibilities and grown well past the project's file-size guidelines:

| File                  | Why it's big                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettingsDialog.tsx`  | Six panel bodies (Appearance, Preferences, StatusBar, Server, Tools, Channels, Agents, Advanced) inlined as JSX inside a single component, plus the `RemoteAccessAction` sidebar item, plus the deep-link sync `useEffect`, plus extension-tab loops |
| `ExternalMcpCard.tsx` | Card shell + collapsible header + 4-state API key lifecycle + rate limiting + multi-tab setup instructions for three clients + duplicate-tool warning + an inline `CopyButton` + a `buildSnippets` helper                                            |
| `ToolsTab.tsx`        | A 80-line `TOOL_INVENTORY` data block + `ToolGroupRow` + `ToolCountBadge` + `SchedulerSettings` sub-component, all inlined alongside the data fetching and override-counting logic                                                                   |
| `TunnelDialog.tsx`    | A 5-state state machine + 7 `useEffect`s (config sync, domain sync, passcode sync, showSetup reset, disconnect/reconnect toasts, stuck-state recovery, latency measurement) + 5 action handlers + the view router                                    |

The cost of leaving them this way:

- **`.claude/rules/file-size.md` violations** — the rule explicitly states files > 300 lines "must split"; the only exceptions listed are generated files, barrels, state machines tightly coupled to UI, and tests. None of these four files qualify.
- **Hard to navigate and review** — diffs touching these files force reviewers to load 500-line context windows for surgical changes.
- **Hard to playground in isolation** — `dev-playground-settings-page` (a follow-on spec) needs to import individual tabs as standalone components. Today they're inline JSX inside one big function.
- **Hard to formalize the system** — the planned `tabbed-dialog-primitive` spec needs `SettingsDialog` to be a thin shell that consumes a tab-config array. That refactor is hard to do _while also_ extracting tabs from a 491-line file in the same diff.
- **Duplication of `CopyButton`** — the same icon-with-feedback pattern is reimplemented in `ExternalMcpCard.tsx`, `ServerTab.tsx`, `AdvancedTab.tsx`, and `TunnelConnected.tsx`. The local definition in `ExternalMcpCard.tsx` is a 15-line component that should live in `shared/ui` and be consumed by all four.

This spec exists as a **prerequisite refactor** that unlocks both the playground spec and the tabbed-dialog-primitive spec without entangling them with low-risk file moves.

## 3. Goals

- All four target files land under 300 lines (target ~150)
- Public exports of `SettingsDialog`, `ExternalMcpCard`, `ToolsTab`, `TunnelDialog` are unchanged
- All extracted components, hooks, and config files have TSDoc per `.claude/rules/documentation.md`
- All new files respect the FSD layer hierarchy (`features/settings` may import from `entities/`, `shared/`, never from `widgets/` or other features)
- The shared `CopyButton` is promoted to `shared/ui` and exported via the barrel
- Existing tests pass with at most import-path updates
- Visual rendering is identical (verified by manual smoke test of every Settings tab + the Tunnel state machine + the External MCP API key flow)
- File-size compliance is verifiable via `wc -l` after the work lands

## 4. Non-Goals

- **No new shared abstractions** (`TabbedDialog` widget, `useDialogTabState` hook, `SwitchSettingRow` shorthand, `ExpandableSettingRow`) — those belong in spec `tabbed-dialog-primitive`
- **No URL-based deep linking** — that belongs in spec `dialog-url-deeplinks`
- **No dev playground additions** — that belongs in spec `dev-playground-settings-page`
- **No behavior changes** — same handlers, same effects, same data flows, same callbacks
- **No accessibility improvements** beyond what's already there (e.g., adding missing `aria-label`s is out of scope here even where obvious; track those separately)
- **No UX polish** — animations, copy, layout, spacing all stay identical
- **No test additions** — refactor does not change behavior, so tests should keep their current coverage
- **No promotion of `useCopyFeedback` to `shared/lib`** — leave it in `features/settings/lib/` for now; the next spec can promote it alongside other hook movements
- **No changes to `AgentDialog.tsx`** despite its similar shape — it's already 177 lines and within budget
- **No changes to other oversized client files** that aren't in the Settings feature

## 5. Technical Dependencies

| Dependency               | Version                       | Notes                                             |
| ------------------------ | ----------------------------- | ------------------------------------------------- |
| React                    | ^19                           | Already installed; no new patterns                |
| TypeScript               | ^5.9                          | Already installed                                 |
| ESLint                   | (via `@dorkos/eslint-config`) | Will catch FSD layer violations and missing TSDoc |
| Vitest                   | ^3                            | Existing tests must continue to pass              |
| `@testing-library/react` | ^16                           | Used by existing component tests                  |

No new runtime dependencies. No new dev dependencies. No version bumps.

## 6. Detailed Design

### 6.1 Target directory structure

After this spec, the `features/settings` module looks like:

```
apps/client/src/layers/features/settings/
├── index.ts                                  (unchanged barrel)
├── __tests__/
│   └── SettingsDialog.test.tsx               (import paths only)
├── lib/
│   ├── tunnel-utils.ts                       (unchanged)
│   ├── use-copy-feedback.ts                  (unchanged)
│   └── external-mcp-snippets.ts              (NEW — pure helpers)
├── config/                                   (NEW directory)
│   └── tool-inventory.ts                     (NEW — TOOL_INVENTORY, TOOL_GROUPS, CONFIG_KEY_MAP)
├── model/                                    (NEW directory)
│   ├── tunnel-view-state.ts                  (NEW — state machine types + deriveViewState)
│   ├── use-tunnel-machine.ts                 (NEW — state + sync effects)
│   └── use-tunnel-actions.ts                 (NEW — action handlers)
└── ui/
    ├── SettingsDialog.tsx                    (491 → ~140)
    ├── RemoteAccessAction.tsx                (NEW — extracted from SettingsDialog)
    ├── ExternalMcpCard.tsx                   (re-export shim or thin delegate)
    ├── ToolsTab.tsx                          (436 → ~120)
    ├── TunnelDialog.tsx                      (490 → ~180)
    ├── AdvancedTab.tsx                       (unchanged)
    ├── AgentsTab.tsx                         (unchanged)
    ├── ChannelsTab.tsx                       (unchanged)
    ├── ServerTab.tsx                         (unchanged)
    ├── (existing Tunnel*.tsx siblings)       (unchanged)
    ├── tabs/                                 (NEW directory)
    │   ├── AppearanceTab.tsx                 (NEW)
    │   ├── PreferencesTab.tsx                (NEW)
    │   └── StatusBarTab.tsx                  (NEW)
    ├── tools/                                (NEW directory)
    │   ├── ToolGroupRow.tsx                  (NEW)
    │   ├── ToolCountBadge.tsx                (NEW)
    │   └── SchedulerSettings.tsx             (NEW)
    └── external-mcp/                         (NEW directory)
        ├── ExternalMcpCard.tsx               (NEW — replaces top-level)
        ├── ApiKeySection.tsx                 (NEW)
        ├── RateLimitSection.tsx              (NEW)
        ├── SetupInstructions.tsx             (NEW)
        ├── EndpointRow.tsx                   (NEW)
        └── DuplicateToolWarning.tsx          (NEW)
```

And `shared/ui/` gains:

```
apps/client/src/layers/shared/ui/
├── copy-button.tsx                           (NEW — promoted from settings)
└── index.ts                                  (export added)
```

> **Decision: relocation vs. shim for `ExternalMcpCard.tsx`.** The current `ui/ExternalMcpCard.tsx` is imported by `ToolsTab.tsx`. Two options: (a) delete the top-level file and update the import to `./external-mcp/ExternalMcpCard`; (b) leave a one-line re-export shim. We pick **(a)** — direct relocation — because it's the cleaner end state and `ToolsTab.tsx` is being touched in this same spec anyway.

### 6.2 SettingsDialog.tsx (491 → ~140)

**What stays:**

- The `SettingsDialog` function signature and props
- The `useState` for `activeTab` and the deep-link `useEffect` (lifted as-is)
- The `useQuery(['config'])` block (kept here because multiple tabs read from it via `config` prop)
- The `ResponsiveDialog` + `NavigationLayout` skeleton
- The sidebar item list (with extension tabs) and the panel loop (with extension tabs wrapped in `Suspense`)
- The `TunnelDialog` and `ServerRestartOverlay` siblings

**What moves:**

| Section                                         | Lines today | New file                    |  New size |
| ----------------------------------------------- | ----------: | --------------------------- | --------: |
| `StatusBarSettingRow` helper (`lines 63-70`)    |           8 | `tabs/StatusBarTab.tsx`     | folded in |
| `RemoteAccessAction` component (`lines 73-105`) |          33 | `ui/RemoteAccessAction.tsx` |       ~40 |
| Appearance panel body (`lines 212-292`)         |          81 | `tabs/AppearanceTab.tsx`    |       ~90 |
| Preferences panel body (`lines 294-377`)        |          84 | `tabs/PreferencesTab.tsx`   |      ~110 |
| Status Bar panel body (`lines 379-401`)         |          23 | `tabs/StatusBarTab.tsx`     |       ~35 |

**Tab component contracts.** Each extracted tab is a parameterless `default` export that reads its own state from `useAppStore` and `useTheme` directly — same as the inline code does today. No props, no prop drilling, no new abstractions:

```tsx
// tabs/AppearanceTab.tsx
export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const { fontFamily, setFontFamily, fontSize, setFontSize, resetPreferences } = useAppStore();

  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader
        actions={
          <button
            onClick={() => {
              resetPreferences();
              setTheme('system');
            }}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
          >
            Reset to defaults
          </button>
        }
      >
        Appearance
      </NavigationLayoutPanelHeader>
      <FieldCard>
        <FieldCardContent>
          {/* exact same Theme / Font family / Font size rows as today */}
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
```

`PreferencesTab` and `StatusBarTab` follow the same pattern.

> **Note on `<NavigationLayoutPanel value="appearance">` wrapper:** the wrapper stays in `SettingsDialog.tsx`, _not_ inside `AppearanceTab.tsx`. Reason: the panel-conditional rendering (`if value !== panelValue return null`) is part of the navigation framework, not the tab content. Keeping the panel wrapper at the dialog level preserves the right separation and means the tab components are reusable from the playground without needing a `NavigationLayout` parent.

**Resulting `SettingsDialog.tsx` shape** (~140 lines):

```tsx
export function SettingsDialog({ open, onOpenChange }) {
  const settingsInitialTab = useAppStore((s) => s.settingsInitialTab);
  const [activeTab, setActiveTab] = useState(settingsInitialTab ?? 'appearance');
  const extensionTabs = useSlotContributions('settings.tabs');
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);
  const [restartOverlayOpen, setRestartOverlayOpen] = useState(false);

  useEffect(() => {
    if (open && settingsInitialTab) setActiveTab(settingsInitialTab);
  }, [open, settingsInitialTab]);

  const transport = useTransport();
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
    enabled: open,
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        data-testid="settings-dialog"
        className="max-h-[85vh] max-w-2xl gap-0 p-0"
      >
        <NavigationLayout value={activeTab} onValueChange={setActiveTab}>
          <ResponsiveDialogFullscreenToggle />
          <NavigationLayoutDialogHeader>
            <ResponsiveDialogTitle className="text-sm font-medium">Settings</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="sr-only">
              Application settings
            </ResponsiveDialogDescription>
          </NavigationLayoutDialogHeader>

          <NavigationLayoutBody>
            <NavigationLayoutSidebar>
              <NavigationLayoutItem value="appearance" icon={Palette}>
                Appearance
              </NavigationLayoutItem>
              <NavigationLayoutItem value="preferences" icon={Settings2}>
                Preferences
              </NavigationLayoutItem>
              <NavigationLayoutItem value="statusBar" icon={LayoutList}>
                Status Bar
              </NavigationLayoutItem>
              <NavigationLayoutItem value="server" icon={Server}>
                Server
              </NavigationLayoutItem>
              <RemoteAccessAction onClick={() => setTunnelDialogOpen(true)} />
              <NavigationLayoutItem value="tools" icon={Wrench}>
                Tools
              </NavigationLayoutItem>
              <NavigationLayoutItem value="channels" icon={Radio}>
                Channels
              </NavigationLayoutItem>
              <NavigationLayoutItem value="agents" icon={Bot}>
                Agents
              </NavigationLayoutItem>
              <NavigationLayoutItem value="advanced" icon={Cog}>
                Advanced
              </NavigationLayoutItem>
              {extensionTabs.map((tab) => (
                <NavigationLayoutItem key={tab.id} value={tab.id} icon={tab.icon}>
                  {tab.label}
                </NavigationLayoutItem>
              ))}
            </NavigationLayoutSidebar>

            <NavigationLayoutContent className="min-h-[280px] p-4">
              <NavigationLayoutPanel value="appearance">
                <AppearanceTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="preferences">
                <PreferencesTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="statusBar">
                <StatusBarTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="server">
                <div className="space-y-3">
                  <NavigationLayoutPanelHeader>Server</NavigationLayoutPanelHeader>
                  <ServerTab config={config} isLoading={isLoading} />
                </div>
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="tools">
                <ToolsTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="channels">
                <ChannelsTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="agents">
                <AgentsTab />
              </NavigationLayoutPanel>
              <NavigationLayoutPanel value="advanced">
                <AdvancedTab
                  onResetComplete={() => setRestartOverlayOpen(true)}
                  onRestartComplete={() => setRestartOverlayOpen(true)}
                />
              </NavigationLayoutPanel>
              {extensionTabs.map((tab) => {
                const TabComponent = tab.component;
                return (
                  <NavigationLayoutPanel key={tab.id} value={tab.id}>
                    <Suspense
                      fallback={
                        <div className="text-muted-foreground py-8 text-center text-sm">
                          Loading…
                        </div>
                      }
                    >
                      <TabComponent />
                    </Suspense>
                  </NavigationLayoutPanel>
                );
              })}
            </NavigationLayoutContent>
          </NavigationLayoutBody>
        </NavigationLayout>
      </ResponsiveDialogContent>
      <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
      <ServerRestartOverlay
        open={restartOverlayOpen}
        onDismiss={() => setRestartOverlayOpen(false)}
      />
    </ResponsiveDialog>
  );
}
```

> **Why server/tools/channels/agents/advanced still have inlined `<NavigationLayoutPanelHeader>` blocks:** because their existing tab components (`ServerTab`, `ToolsTab`, etc.) already return _content only_ without their own header. Wrapping the panel header outside is consistent with current behavior. The header normalization is the `tabbed-dialog-primitive` spec's job.

> **Note on the Tools panel "Reset to defaults" action button** (`SettingsDialog.tsx:411-433`): this currently lives inside the SettingsDialog file but actually belongs in `ToolsTab.tsx` because it operates on its data. We move it inside `ToolsTab.tsx` as part of section 6.4. This is a pure relocation — same handler, same UI.

### 6.3 ExternalMcpCard.tsx (540 → ~150)

The file already has section divider comments. Each section becomes its own file under `ui/external-mcp/`. The directory naming reflects the bounded context of "the External MCP card and all its parts."

**Extraction map:**

| Current section                                            | Lines | New file                                    | New size |
| ---------------------------------------------------------- | ----: | ------------------------------------------- | -------: |
| `CopyButton` (`lines 35-49`)                               |    15 | **promoted to** `shared/ui/copy-button.tsx` |      ~30 |
| `buildSnippets` (`lines 55-102`)                           |    48 | `lib/external-mcp-snippets.ts`              |      ~55 |
| Card shell + state + handlers (`lines 105-200`, `202-235`) |   130 | `external-mcp/ExternalMcpCard.tsx`          |     ~150 |
| Duplicate-tool warning (`lines 240-254`)                   |    15 | `external-mcp/DuplicateToolWarning.tsx`     |      ~25 |
| Endpoint row (`lines 256-268`)                             |    13 | `external-mcp/EndpointRow.tsx`              |      ~30 |
| `ApiKeySection` (`lines 416-540`)                          |   125 | `external-mcp/ApiKeySection.tsx`            |     ~125 |
| Rate Limiting block (`lines 281-336`)                      |    56 | `external-mcp/RateLimitSection.tsx`         |      ~70 |
| Setup Instructions block (`lines 338-408`)                 |    71 | `external-mcp/SetupInstructions.tsx`        |     ~110 |

**Sub-component contracts:**

```ts
// external-mcp/ExternalMcpCard.tsx
interface ExternalMcpCardProps {
  mcp: McpConfig;
}

// external-mcp/ApiKeySection.tsx (extracted; same props as today)
interface ApiKeySectionProps {
  authConfigured: boolean;
  authSource: 'config' | 'env' | 'none';
  generatedKey: string | null;
  keyError: string | null;
  onGenerate: () => void;
  onRotate: () => void;
  onRemove: () => void;
}

// external-mcp/RateLimitSection.tsx
interface RateLimitSectionProps {
  rateLimit: McpConfig['rateLimit'];
  onUpdate: (patch: Partial<McpConfig['rateLimit']>) => void;
}

// external-mcp/SetupInstructions.tsx
interface SetupInstructionsProps {
  endpoint: string;
  apiKey: string | null;
}

// external-mcp/EndpointRow.tsx
interface EndpointRowProps {
  endpoint: string;
}

// external-mcp/DuplicateToolWarning.tsx — no props
```

`SetupInstructions` calls `buildSnippets(endpoint, apiKey)` from the new `lib/external-mcp-snippets.ts` and renders the same Claude Code/Cursor/Windsurf tab UI as today.

**`shared/ui/copy-button.tsx` API.** The promoted `CopyButton` keeps the simple shape used in `ExternalMcpCard` today:

```tsx
interface CopyButtonProps {
  /** Text copied to clipboard on click. */
  value: string;
  /** Optional aria-label override. Default: "Copy to clipboard". */
  label?: string;
  /** Override className for the button wrapper. */
  className?: string;
  /** Icon size — defaults to size-3.5 to match current usage. */
  size?: 'sm' | 'md';
}
```

`useCopyFeedback` stays in `features/settings/lib/` for now (non-goal §4). The shared `CopyButton` imports from `'@/layers/features/settings/lib'`, which is **a layer violation** (`shared` cannot import from `features`). To avoid that, **`useCopyFeedback` must move with the button**:

> **Decision: promote `useCopyFeedback` to `shared/lib/use-copy-feedback.ts` as part of this spec.** The non-goal in §4 was originally written assuming we could leave it behind, but the FSD layer rule forbids `shared/ui` importing from `features/`. Promoting both is the only legal option. The promotion is one file move + one barrel export update + one import-path update across `ServerTab.tsx`/`ExternalMcpCard.tsx`/(test file). Low risk, included here.

### 6.4 ToolsTab.tsx (436 → ~120)

| Current section                                                                               | Lines | New file                               | New size |
| --------------------------------------------------------------------------------------------- | ----: | -------------------------------------- | -------: |
| `TOOL_INVENTORY` constants (`lines 36-71`)                                                    |    36 | `config/tool-inventory.ts`             |      ~40 |
| `ToolDomainKey` / `GlobalConfigKey` types + `CONFIG_KEY_MAP` + `TOOL_GROUPS` (`lines 73-118`) |    46 | `config/tool-inventory.ts` (same file) |   folded |
| `ToolGroupRow` (`lines 137-222`)                                                              |    86 | `tools/ToolGroupRow.tsx`               |      ~95 |
| `ToolCountBadge` (`lines 234-251`)                                                            |    18 | `tools/ToolCountBadge.tsx`             |      ~30 |
| `SchedulerSettings` (`lines 263-321`)                                                         |    59 | `tools/SchedulerSettings.tsx`          |      ~75 |

**`config/tool-inventory.ts`.** Pure data file, no React imports. Exports `TOOL_INVENTORY`, `TOOL_GROUPS`, `CONFIG_KEY_MAP`, `ToolDomainKey`, `GlobalConfigKey`, and `ToolGroupDef`. Becomes the source of truth referenced by both `ToolsTab.tsx` and (eventually) `services/runtimes/claude-code/tool-filter.ts` — though synchronizing those is out of scope here.

**`ToolsTab.tsx` resulting shape (~120 lines):**

```tsx
export function ToolsTab() {
  const relayEnabled = useRelayEnabled();
  const tasksEnabled = useTasksEnabled();
  const { config, updateConfig } = useAgentContextConfig();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });
  const { data: agentsData } = useRegisteredAgents();
  const scheduler = serverConfig?.scheduler;

  const overrideCounts = useMemo(() => {
    /* unchanged */
  }, [agentsData]);
  const availabilityMap = {
    tasks: tasksEnabled,
    relay: relayEnabled,
    mesh: true,
    adapter: relayEnabled,
  };
  const initErrorMap = {
    /* unchanged */
  };

  const handleToggle = useCallback(
    (key, value) => updateConfig({ [CONFIG_KEY_MAP[key]]: value }),
    [updateConfig]
  );
  const updateScheduler = useCallback(
    async (patch) => {
      /* unchanged */
    },
    [transport, queryClient, scheduler]
  );

  const handleResetTools = useCallback(async () => {
    await transport.updateConfig({
      agentContext: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
    });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  }, [transport, queryClient]);

  return (
    <div className="space-y-4">
      <NavigationLayoutPanelHeader actions={<ResetButton onClick={handleResetTools} />}>
        Tools
      </NavigationLayoutPanelHeader>
      <p className="text-muted-foreground text-sm">Control which MCP tool groups…</p>
      <FieldCard>
        <FieldCardContent>
          <SettingRow label="Core Tools" description="Server info, agent identity, UI control">
            <div className="flex items-center gap-2">
              <ToolCountBadge tools={TOOL_INVENTORY.core} />
              <span className="text-muted-foreground text-xs">Always enabled</span>
            </div>
          </SettingRow>
          {TOOL_GROUPS.map((group) => (
            <ToolGroupRow
              key={group.key}
              group={group}
              enabled={config[CONFIG_KEY_MAP[group.key]]}
              available={availabilityMap[group.key]}
              initError={initErrorMap[group.key]}
              overrideCount={overrideCounts[group.key]}
              onToggle={handleToggle}
              expandContent={
                group.key === 'tasks' && scheduler ? (
                  <SchedulerSettings scheduler={scheduler} onUpdate={updateScheduler} />
                ) : undefined
              }
            />
          ))}
        </FieldCardContent>
      </FieldCard>
      {serverConfig?.mcp && <ExternalMcpCard mcp={serverConfig.mcp} />}
    </div>
  );
}
```

The `<ResetButton>` here is an inline ~6-line component, not promoted — repeated promotions to a shared system are deferred to the formalization spec.

> **The "Reset to defaults" button moves from `SettingsDialog.tsx:412-433` into `ToolsTab.tsx`** because the action operates on data the tab owns and currently lives in the wrong file. The handler is identical (`transport.updateConfig({ agentContext: { ... } })` + `queryClient.invalidateQueries`).

### 6.5 TunnelDialog.tsx (490 → ~180)

This file is the trickiest because it owns a state machine with intertwined effects. The split must preserve the _exact_ effect ordering and dependency arrays — these are load-bearing.

**`model/tunnel-view-state.ts`** — pure types and constants:

```ts
export type TunnelState = 'off' | 'starting' | 'connected' | 'stopping' | 'error';
export type ViewState = 'landing' | 'setup' | 'ready' | 'connecting' | 'connected' | 'error';

export const START_TIMEOUT_MS = 15_000;
export const STUCK_STATE_TIMEOUT_MS = 30_000;
export const LATENCY_INTERVAL_MS = 30_000;

export function deriveViewState(
  tokenConfigured: boolean,
  showSetup: boolean,
  tunnelState: TunnelState
): ViewState {
  if (!tokenConfigured && !showSetup) return 'landing';
  if (!tokenConfigured && showSetup) return 'setup';
  if (showSetup) return 'setup';
  if (tunnelState === 'error') return 'error';
  if (tunnelState === 'starting') return 'connecting';
  if (tunnelState === 'connected' || tunnelState === 'stopping') return 'connected';
  return 'ready';
}
```

**`model/use-tunnel-machine.ts`** — owns local state and the seven `useEffect`s. Returns a single object the dialog reads from:

```ts
interface TunnelMachine {
  // State
  state: TunnelState;
  setState: (s: TunnelState) => void;
  url: string | null;
  setUrl: (u: string | null) => void;
  error: string | null;
  setError: (e: string | null) => void;
  showSetup: boolean;
  setShowSetup: (v: boolean) => void;
  authToken: string;
  setAuthToken: (t: string) => void;
  tokenError: string | null;
  setTokenError: (e: string | null) => void;
  showTokenInput: boolean;
  setShowTokenInput: (v: boolean) => void;
  domain: string;
  setDomain: (d: string) => void;
  latencyMs: number | null;
  passcodeEnabled: boolean;
  setPasscodeEnabled: (v: boolean) => void;
  passcodeInput: string;
  setPasscodeInput: (v: string) => void;
  // Derived
  tunnel: ServerConfig['tunnel'] | undefined;
  tokenConfigured: boolean;
  viewState: ViewState;
  isTransitioning: boolean;
  isChecked: boolean;
}

export function useTunnelMachine({ open }: { open: boolean }): TunnelMachine;
```

The hook contains `lines 79-176` of the current file verbatim, including the seven `useEffect`s and the same `eslint-disable` comments (which exist for legitimate reasons documented in their adjacent code).

**`model/use-tunnel-actions.ts`** — owns the five action handlers. Takes the relevant pieces of state from the machine + closures over `transport`/`queryClient`:

```ts
interface UseTunnelActionsArgs {
  machine: TunnelMachine;
  transport: Transport;
  queryClient: QueryClient;
}

interface TunnelActions {
  handleToggle: (checked: boolean) => Promise<void>;
  handleSaveToken: () => Promise<void>;
  handleSaveDomain: () => Promise<void>;
  handlePasscodeToggle: (checked: boolean) => Promise<void>;
  handleSavePasscode: () => Promise<void>;
}

export function useTunnelActions(args: UseTunnelActionsArgs): TunnelActions;
```

**Resulting `TunnelDialog.tsx` (~180 lines):**

```tsx
export function TunnelDialog({ open, onOpenChange }: TunnelDialogProps) {
  const transport = useTransport();
  const isDesktop = !useIsMobile();
  const queryClient = useQueryClient();
  const [activeSessionId] = useSessionId();

  const machine = useTunnelMachine({ open });
  const actions = useTunnelActions({ machine, transport, queryClient });

  if (getPlatform().isEmbedded) return null;

  const dotColor = {
    off: 'bg-gray-400',
    starting: 'bg-amber-400',
    connected: 'bg-green-500',
    stopping: 'bg-gray-400',
    error: 'bg-red-500',
  }[machine.state];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-md')}>
        <ResponsiveDialogHeader>{/* unchanged title + dot + description */}</ResponsiveDialogHeader>

        <div className="space-y-4 overflow-y-auto px-4 pb-4">
          <AnimatePresence mode="wait">
            {machine.viewState === 'landing' && (
              <motion.div key="landing" {...viewMotion}>
                <TunnelLanding onGetStarted={() => machine.setShowSetup(true)} />
              </motion.div>
            )}
            {machine.viewState === 'setup' && (
              <motion.div key="setup" {...viewMotion}>
                <TunnelSetup
                  authToken={machine.authToken}
                  tokenError={machine.tokenError}
                  onAuthTokenChange={machine.setAuthToken}
                  onSaveToken={actions.handleSaveToken}
                />
              </motion.div>
            )}
            {/* … ready, connecting, connected, error views unchanged … */}
          </AnimatePresence>

          {machine.tokenConfigured &&
            machine.viewState !== 'setup' &&
            machine.viewState !== 'landing' && (
              <TunnelSecurity
                passcodeEnabled={machine.passcodeEnabled}
                passcodeAlreadySet={machine.tunnel?.passcodeEnabled ?? false}
                passcodeInput={machine.passcodeInput}
                onPasscodeToggle={actions.handlePasscodeToggle}
                onPasscodeInputChange={machine.setPasscodeInput}
                onPasscodeSave={actions.handleSavePasscode}
              />
            )}

          {/* … TunnelSettings + bottom toggle blocks unchanged … */}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

`viewMotion` is a local const holding the existing `variants` + `initial` + `animate` + `exit` + `transition` props to deduplicate the six near-identical `<motion.div>` wrappers.

> **Hook layer placement.** `use-tunnel-machine.ts` and `use-tunnel-actions.ts` go in `features/settings/model/`, **not** `features/settings/lib/`, because per `.claude/rules/fsd-layers.md` the convention is `model/` for hooks/state/business logic and `lib/` for pure utilities. The `tunnel-utils.ts` file already in `lib/` is correctly placed (pure functions).

### 6.6 Files modified outside the four target files

Required because of import-path changes and the `CopyButton` promotion:

| File                                                                               | Change                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/index.ts`                                        | Add `export { CopyButton } from './copy-button';`                                                                          |
| `apps/client/src/layers/shared/lib/index.ts`                                       | Add `export { useCopyFeedback } from './use-copy-feedback';`                                                               |
| `apps/client/src/layers/features/settings/index.ts`                                | Unchanged (only exports `SettingsDialog`, `TunnelDialog`)                                                                  |
| `apps/client/src/layers/features/settings/lib/use-copy-feedback.ts`                | **Move to** `apps/client/src/layers/shared/lib/use-copy-feedback.ts`                                                       |
| `apps/client/src/layers/features/settings/lib/__tests__/use-copy-feedback.test.ts` | **Move with the file**, update imports                                                                                     |
| `apps/client/src/layers/features/settings/ui/ServerTab.tsx`                        | Update import: `useCopyFeedback` from `'@/layers/shared/lib'`. Inline `useCopy` helper deleted in favor of shared version. |
| `apps/client/src/layers/features/settings/ui/__tests__/ExternalMcpCard.test.tsx`   | Update import paths to new `external-mcp/` subdirectory                                                                    |
| `apps/client/src/layers/features/settings/__tests__/SettingsDialog.test.tsx`       | Update mock paths if any reference inline panel components (none currently)                                                |

### 6.7 Test inventory

Existing tests under `apps/client/src/layers/features/settings/ui/__tests__/`:

| Test                             | Affected by this spec?                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AdapterRuntimeCard.test.tsx`    | No                                                                                              |
| `AdvancedTab.test.tsx`           | No                                                                                              |
| `AgentsTab.test.tsx`             | No                                                                                              |
| `ChannelSettingRow.test.tsx`     | No                                                                                              |
| `ChannelsTab.test.tsx`           | No                                                                                              |
| `ExternalMcpCard.test.tsx`       | **Yes** — update import path from `'../ExternalMcpCard'` to `'../external-mcp/ExternalMcpCard'` |
| `ResetDialog.test.tsx`           | No                                                                                              |
| `RestartDialog.test.tsx`         | No                                                                                              |
| `ServerRestartOverlay.test.tsx`  | No                                                                                              |
| `TunnelConnected.test.tsx`       | No                                                                                              |
| `TunnelConnecting.test.tsx`      | No                                                                                              |
| `TunnelDialog.test.tsx`          | **Maybe** — depends on whether tests reach into private state (they shouldn't, but verify)      |
| `TunnelError.test.tsx`           | No                                                                                              |
| `TunnelSettings.test.tsx`        | No                                                                                              |
| `tunnel-utils.test.ts`           | No                                                                                              |
| `use-copy-feedback.test.ts`      | **Yes** — moves to `shared/lib/__tests__/`                                                      |
| (root) `SettingsDialog.test.tsx` | **Maybe** — verify no panel-body assertions break                                               |

Pre-flight: run `pnpm test -- --run` before starting and capture the baseline. Re-run after each file refactor to catch regressions immediately.

## 7. User Experience

**No user-visible changes.** Same dialog, same tabs, same handlers, same animations, same keyboard navigation, same accessibility, same loading states, same empty states. The "User Experience" deliverable for this spec is _invisibility_ — if users notice anything, the refactor failed.

## 8. Testing Strategy

### 8.1 Test types

- **No new tests** (per non-goal §4)
- **All existing tests must continue to pass** with at most import-path updates
- **Manual smoke test** before merge:
  - Open Settings → Appearance: change theme/font/size, click Reset
  - Open Settings → Preferences: toggle each switch
  - Open Settings → Status Bar: toggle items, click Reset
  - Open Settings → Server: verify config rows render
  - Open Settings → Tools: toggle each group, expand Tasks scheduler, click Reset
  - Open Settings → Channels: verify catalog renders
  - Open Settings → Agents: verify default agent dropdown + runtime cards
  - Open Settings → Advanced: verify logging rows + Reset/Restart buttons
  - Open Remote Access: verify state machine progresses through landing → setup → ready → connecting → connected → off without console errors
  - Open Tools → External MCP card: expand, generate API key, rotate, verify rate-limit changes save, verify setup snippet tabs switch correctly, copy each snippet
  - Test on mobile viewport (375px): verify drill-in works on every tab
  - Test deep-link: from any page, call `useAppStore.getState().openSettingsToTab('tools')` in console — settings should open to Tools tab

### 8.2 Why existing tests are sufficient

These tests already cover:

| File                        | Coverage                                                    |
| --------------------------- | ----------------------------------------------------------- |
| `ExternalMcpCard.test.tsx`  | API key states, rate limiting, snippet rendering            |
| `SettingsDialog.test.tsx`   | Tab switching, deep-link, panel rendering                   |
| `TunnelDialog.test.tsx`     | View state derivation, action handlers, latency measurement |
| `use-copy-feedback.test.ts` | Copy timer behavior                                         |

If a test breaks during the refactor, it indicates either (a) an import path that needs updating or (b) a behavior change — which means the refactor is incorrect and must be fixed, not the test.

### 8.3 Verification commands

```bash
# Type-check the whole monorepo
pnpm typecheck

# Run all tests once (no watch)
pnpm test -- --run

# Run only settings tests
pnpm vitest run apps/client/src/layers/features/settings

# Lint the changed files
pnpm lint

# Verify file sizes
wc -l apps/client/src/layers/features/settings/ui/{SettingsDialog,ToolsTab,TunnelDialog}.tsx \
      apps/client/src/layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx
```

All four numbers should be < 300 (target ~150).

## 9. Performance Considerations

Negligible. The refactor:

- **Adds ~18 small components** rather than one giant function. React reconciliation cost is identical because the rendered tree is the same.
- **Does not change render frequency** — the same `useState`s, `useQuery`s, and `useEffect`s exist; they just live in different files.
- **Potential micro-improvement**: extracting `tabs/AppearanceTab`, `PreferencesTab`, `StatusBarTab` as separate components means React may skip re-renders of the _inactive_ panels when state changes (today, the entire `SettingsDialog` re-renders any time any preference changes — even though `NavigationLayoutPanel` returns null for inactive panels, the JSX still evaluates). This is a side benefit, not a goal.
- **Bundle size**: identical. Tree-shaking already removes unused code; the file boundaries don't change what's reachable.

No code-splitting or lazy-loading is added in this spec.

## 10. Security Considerations

None. The refactor:

- Does not change any auth flow
- Does not change how API keys are generated, displayed, or transmitted
- Does not change tunnel passcode handling
- Does not introduce new network calls
- Does not change CORS or CSP behavior
- Does not log or expose new data

The `ExternalMcpCard` API key one-time-reveal flow is preserved exactly: `generatedKey` stays in component state and is cleared on remove/error.

## 11. Documentation

- All new files must have TSDoc on exports per `.claude/rules/documentation.md`
- The new `config/tool-inventory.ts` file should reference `services/runtimes/claude-code/tool-filter.ts` in a comment so future maintainers know about the parallel source
- No changes to `contributing/` guides — those describe layer rules and patterns that are unchanged
- No changes to user-facing docs in `docs/` — refactor is invisible to users
- A short ADR is **not** required because this is a pure refactor satisfying an existing rule, not a new architectural decision

## 12. Implementation Phases

**Phase 1 — `ToolsTab.tsx`** (smallest blast radius, no shared deps)

1. Create `config/tool-inventory.ts` with all data exports
2. Create `tools/ToolCountBadge.tsx`
3. Create `tools/SchedulerSettings.tsx`
4. Create `tools/ToolGroupRow.tsx`
5. Slim `ToolsTab.tsx` to consume the new files; move the "Reset to defaults" button into the component
6. Run `pnpm typecheck && pnpm vitest run apps/client/src/layers/features/settings/ui/__tests__/SettingsDialog.test.tsx`
7. Visual smoke test of the Tools tab
8. Commit: `refactor(settings): split ToolsTab under 300 lines`

**Phase 2 — `ExternalMcpCard.tsx`** (consumed by ToolsTab)

1. Move `useCopyFeedback` from `features/settings/lib/` to `shared/lib/use-copy-feedback.ts` (and its test)
2. Update `shared/lib/index.ts` to export it
3. Create `shared/ui/copy-button.tsx` and add to `shared/ui/index.ts`
4. Update `ServerTab.tsx` to use the shared `useCopyFeedback`
5. Create `lib/external-mcp-snippets.ts`
6. Create the six files under `external-mcp/`: `DuplicateToolWarning`, `EndpointRow`, `ApiKeySection`, `RateLimitSection`, `SetupInstructions`, `ExternalMcpCard`
7. Delete the top-level `ui/ExternalMcpCard.tsx`
8. Update `ToolsTab.tsx` import to `./external-mcp/ExternalMcpCard`
9. Update `ExternalMcpCard.test.tsx` import path
10. Run typecheck + tests
11. Visual smoke: open Tools tab, expand External MCP, generate key, rotate, verify all snippets render
12. Commit: `refactor(settings): split ExternalMcpCard into external-mcp/ subdirectory`

**Phase 3 — `TunnelDialog.tsx`** (independent of phases 1 and 2)

1. Create `model/tunnel-view-state.ts`
2. Create `model/use-tunnel-machine.ts` — copy state + effects verbatim
3. Create `model/use-tunnel-actions.ts` — copy handlers verbatim
4. Slim `TunnelDialog.tsx` to consume the hooks
5. Run typecheck + `vitest run TunnelDialog.test.tsx TunnelConnected.test.tsx TunnelConnecting.test.tsx`
6. Visual smoke: open Remote Access from sidebar, run through full state machine (off → starting → connected → off, then off → starting → error → retry → off)
7. Commit: `refactor(settings): split TunnelDialog state machine into hooks`

**Phase 4 — `SettingsDialog.tsx`** (last because tabs need to exist first)

1. Create `ui/RemoteAccessAction.tsx`
2. Create `ui/tabs/AppearanceTab.tsx`
3. Create `ui/tabs/PreferencesTab.tsx`
4. Create `ui/tabs/StatusBarTab.tsx` (folding in `StatusBarSettingRow`)
5. Slim `SettingsDialog.tsx` to consume the new components; move the Tools "Reset to defaults" button out of `SettingsDialog.tsx` (already moved into `ToolsTab.tsx` in Phase 1)
6. Run typecheck + full test suite
7. Visual smoke: open Settings, click through all tabs, verify deep-link still works (`openSettingsToTab` from store)
8. Commit: `refactor(settings): extract panel tabs from SettingsDialog`

**Phase 5 — verification gate**

1. `pnpm typecheck` — green
2. `pnpm test -- --run` — green
3. `pnpm lint` — green
4. `wc -l` on the four target files — all < 300
5. Manual smoke test of every tab and the Tunnel state machine
6. Squash if desired or keep four atomic commits per phase

## 13. Open Questions

**Q1. Should `useCopyFeedback` move to `shared/lib` in this spec or the next?**

Resolved (§6.3): **Move it now**, because the shared `CopyButton` cannot legally import from `features/settings`. It's a one-file move + barrel update.

**Q2. Should the "Reset to defaults" button for Tools live in `ToolsTab.tsx` or stay in `SettingsDialog.tsx`?**

Resolved (§6.4): **Move it into `ToolsTab.tsx`** because the action operates on data the tab owns. The current placement in `SettingsDialog.tsx` is a historical accident.

**Q3. Should `tab/` panels render their own `<NavigationLayoutPanel>` wrapper?**

Resolved (§6.2): **No** — the panel wrapper stays in `SettingsDialog.tsx`. Reasons: (a) it preserves separation between navigation framework and content, (b) it makes the tab components reusable from the playground without needing a `NavigationLayout` parent, (c) it matches how `ServerTab`/`ChannelsTab`/`AgentsTab`/`AdvancedTab` already work today.

**Q4. Should `ExternalMcpCard` tests move to a `external-mcp/__tests__/` subdirectory?**

**Open**. Recommendation: leave them in the existing `ui/__tests__/` directory and only update import paths. Rationale: the test file is currently named `ExternalMcpCard.test.tsx` (one file for the whole card), and splitting it to mirror the new structure adds churn that this spec is trying to avoid. If, after the refactor, individual sub-component tests are wanted, they can be added in a follow-up.

**Q5. Do any extension consumers depend on internal symbols of these files?**

**Confirmed no.** The barrel `apps/client/src/layers/features/settings/index.ts` only exports `SettingsDialog` and `TunnelDialog`. No other module imports from internal paths under `features/settings/ui/` (verified by grep). The `ExternalMcpCard` is only imported by `ToolsTab.tsx`, which is changed in this spec.

## 14. Related ADRs

- **ADR 0002 — Adopt Feature-Sliced Design** (`decisions/0002-adopt-feature-sliced-design.md`) — Defines the layer hierarchy and barrel-export rules this spec must respect. New files must be placed in segments according to the layer-rules table.
- **ADR 0008 — Promote shared components for cross-feature reuse** (`decisions/0008-promote-shared-components-for-cross-feature-reuse.md`) — Justifies the `CopyButton` and `useCopyFeedback` promotion to `shared/`.
- **ADR 0089 — SDK import confinement via lint rule** (`decisions/0089-sdk-import-confinement-via-lint-rule.md`) — Not directly relevant but reinforces the "lint catches violations" philosophy this spec relies on.

## 15. References

### Internal

- `.claude/rules/file-size.md` — the constraint being satisfied
- `.claude/rules/fsd-layers.md` — FSD layer import rules
- `.claude/rules/components.md` — component patterns (variants, slots, ref forwarding)
- `.claude/rules/documentation.md` — TSDoc requirements
- `.claude/rules/testing.md` — test placement and patterns
- `contributing/project-structure.md` — file organization guidance
- `contributing/architecture.md` — hexagonal architecture context
- `contributing/design-system.md` — Calm Tech design language

### Related specs

- `specs/form-field-standardization/` — pattern reference for `SettingRow`/`FieldCard` (already consumed by all settings tabs)
- `specs/tunnel-remote-access-overhaul/` — created the state machine being split here
- `specs/agent-tools-elevation/` — created the tool-group system in `ToolsTab.tsx`
- `specs/external-mcp-access/` — created `ExternalMcpCard.tsx`
- `specs/agents-first-class-entity/` — created `AgentDialog.tsx` (parallel structure, out of scope for this spec)

### Follow-on specs (depend on this one)

- `specs/tabbed-dialog-primitive/` (planned) — extracts `TabbedDialog` widget; consumes the slim `SettingsDialog` and `AgentDialog` shells this spec produces
- `specs/dev-playground-settings-page/` (planned) — adds Settings page to dev playground; depends on the tab components extracted here

### Independent

- `specs/dialog-url-deeplinks/` (planned) — URL search-param deep linking for dialogs; independent of this refactor
