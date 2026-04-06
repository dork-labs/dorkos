---
slug: settings-dialog-04-playground
number: 223
created: 2026-04-06
status: specified
---

# Dev Playground Settings Page

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-04-06

---

## 1. Overview

Add a `Settings` page to the dev playground at `/dev/settings` that comprehensively showcases the Settings dialog system. The page demonstrates:

- The full `SettingsDialog` and `AgentDialog` (responsive viewport toggle)
- Every individual settings tab in isolation (`AppearanceTab`, `PreferencesTab`, `StatusBarTab`, `ServerTab`, `ToolsTab`, `ChannelsTab`, `AgentsTab`, `AdvancedTab`)
- The mobile drill-in stack pattern
- Loading and empty states for data-driven tabs
- The underlying primitives that the settings system uses (`FieldCard`, `SettingRow`, `SwitchSettingRow`)

The page follows the existing playground patterns exactly — `PlaygroundPageLayout` + `PlaygroundSection` + `ShowcaseDemo` + section registry — and adds 15 new searchable entries to the playground's `Cmd+K` index.

## 2. Background / Problem Statement

The Settings dialog is one of the largest, most-touched UI surfaces in DorkOS — eight built-in tabs, extension tab support, two responsive layouts, multiple loading and empty states, and ~17 different row types. Despite its size, it has **almost no playground coverage**. The only existing entry is `apps/client/src/dev/showcases/NavigationShowcases.tsx`, which demonstrates the underlying `NavigationLayout` primitive with **placeholder panels** — none of the actual settings content is shown.

This costs us:

| Friction                                                                                                                       | Impact                     |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Iterating on a single tab requires opening the full app, navigating to Settings, picking the tab, and finding the specific row | Slow design iteration      |
| Loading and empty states are nearly impossible to test deterministically (depend on real network state)                        | Visual regressions slip in |
| Mobile drill-in behavior requires resizing the entire app window                                                               | Frustrating to verify      |
| New contributors have no visual catalog of the settings system                                                                 | Hard to onboard            |
| Catching visual regressions in settings tabs has no automated path                                                             | Drift accumulates          |

The dev playground was specifically built to solve exactly this kind of problem (see `specs/dev-playground-navigation-overhaul`), and the omission of the settings system is conspicuous given how prominent it is in the actual product.

A second motivation: the underlying primitives `FieldCard` and `SettingRow` appear in **every single settings tab** but have **no playground entries** today. They're invisible to designers and developers browsing the gallery. Adding them is a small lift with disproportionate value.

## 3. Goals

- New `/dev/settings` page renders all 15 sections without crashing
- Full `SettingsDialog` and `AgentDialog` demos with responsive viewport toggle
- Every individual settings tab importable and rendered in isolation
- Mobile drill-in pattern visible at the 375px viewport
- Loading and empty state showcases for data-driven tabs (`ServerTab`, `ChannelsTab`, etc.)
- New showcases for `FieldCard` and `SettingRow` primitives
- `Cmd+K` palette finds new sections (e.g., search "appearance" → jumps to Appearance Tab section)
- TOC sidebar lists all sections grouped by category (Dialogs / Tabs / Responsive / States / Primitives)
- All new files follow existing playground patterns exactly
- `pnpm typecheck`, `pnpm test -- --run`, `pnpm lint` all pass
- No existing tests need modification

## 4. Non-Goals

- **No real network or persistence in the playground** — the playground is offline by design (`createPlaygroundTransport` returns `null` for everything)
- **No deep `TunnelDialog` showcase** — it has timers, fetch calls, and a 5-state machine that don't translate to a static demo. Stub it with a placeholder card pointing at the in-app version.
- **No `ExternalMcpCard` nested wizard or per-tab sub-dialog showcases** — those are intra-tab implementation details
- **No Playwright E2E tests** for the playground page — it's a dev surface, not a user-facing feature
- **No URL deep-link demos** — those depend on `settings-dialog-03-url-deeplinks` and would tangle this spec with that one
- **No new shared primitive promotions** (`CopyButton`, `useCopyFeedback`, etc.) — those are handled by `settings-dialog-01-file-splits` or `settings-dialog-02-tabbed-primitive`
- **No changes to the global `playground-transport.ts`** — per-showcase mock query data is the right scope, not a richer global mock
- **No changes to the existing `NavigationShowcases.tsx`** — it stays as the abstract `NavigationLayout` primitive demo. The new Settings page complements it, doesn't replace it.
- **No new ADRs** — this is purely additive playground content
- **No changes to the user-facing app** — the playground lives at `/dev` only

## 5. Technical Dependencies

| Dependency                        | Version                | Notes                                           |
| --------------------------------- | ---------------------- | ----------------------------------------------- |
| React                             | ^19                    | No new patterns                                 |
| `@tanstack/react-query`           | already installed      | `setQueryData` for prepopulating mock data      |
| `lucide-react`                    | latest                 | `Settings` icon for the page nav entry          |
| Vitest + `@testing-library/react` | ^3 / ^16               | Existing playground tests must continue to pass |
| `@dorkos/shared/types`            | (in repo)              | `ServerConfig`, `MeshAgent` types for mock data |
| `@dorkos/shared/mesh-schemas`     | (in repo)              | `AgentManifest` type for mock agent             |
| The settings feature components   | (in repo, post-spec-1) | The components being showcased                  |

No new runtime dependencies. No new dev dependencies. No version bumps.

## 6. Detailed Design

### 6.1 File layout

```
apps/client/src/dev/
├── pages/
│   └── SettingsPage.tsx                    (NEW — 30 lines)
├── showcases/
│   ├── SettingsShowcases.tsx               (NEW — main showcase file, ~250 lines)
│   └── settings-mock-data.ts               (NEW — mock ServerConfig, AgentManifest, etc.)
├── sections/
│   └── settings-sections.ts                (NEW — registry entries)
├── playground-config.ts                    (MODIFIED — add page entry)
├── playground-registry.ts                  (MODIFIED — add 'settings' to Page union, export SETTINGS_SECTIONS)
└── DevPlayground.tsx                       (MODIFIED — add to PAGE_COMPONENTS map)
```

### 6.2 `SettingsPage.tsx` — page wrapper

Follows the `ComponentsPage` pattern exactly:

```tsx
import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { SETTINGS_SECTIONS } from '../playground-registry';
import { SettingsShowcases } from '../showcases/SettingsShowcases';

/** Settings dialog system gallery for the dev playground. */
export function SettingsPage() {
  return (
    <PlaygroundPageLayout
      title="Settings"
      description="Settings dialogs, individual tabs, loading and empty states, and primitives."
      sections={SETTINGS_SECTIONS}
    >
      <SettingsShowcases />
    </PlaygroundPageLayout>
  );
}
```

### 6.3 `SettingsShowcases.tsx` — main showcase file

Six sections, each wrapped in `<PlaygroundSection>`:

```tsx
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { Button, FieldCard, FieldCardContent, SettingRow, Switch } from '@/layers/shared/ui';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SettingsDialog } from '@/layers/features/settings';
import { AgentDialog } from '@/layers/features/agent-settings';
import { AppearanceTab } from '@/layers/features/settings/ui/tabs/AppearanceTab';
import { PreferencesTab } from '@/layers/features/settings/ui/tabs/PreferencesTab';
import { StatusBarTab } from '@/layers/features/settings/ui/tabs/StatusBarTab';
import { ServerTab } from '@/layers/features/settings/ui/ServerTab';
import { ToolsTab } from '@/layers/features/settings/ui/ToolsTab';
import { ChannelsTab } from '@/layers/features/settings/ui/ChannelsTab';
import { AgentsTab } from '@/layers/features/settings/ui/AgentsTab';
import { AdvancedTab } from '@/layers/features/settings/ui/AdvancedTab';

import { MOCK_SERVER_CONFIG, MOCK_AGENT_MANIFEST, MOCK_MESH_AGENTS } from './settings-mock-data';

/** Comprehensive showcase for the Settings dialog system. */
export function SettingsShowcases() {
  return (
    <>
      <FullSettingsDialogSection />
      <FullAgentDialogSection />
      <IndividualTabsSection />
      <MobileDrillInSection />
      <LoadingEmptyStatesSection />
      <PrimitivesSection />
    </>
  );
}
```

Each `*Section` component implements one PlaygroundSection. Details below.

#### Section 1 — Full SettingsDialog

```tsx
function FullSettingsDialogSection() {
  const [open, setOpen] = useState(false);
  return (
    <PlaygroundSection
      title="Full Settings Dialog"
      description="The complete Settings dialog with all tabs. Server/Tools/Channels tabs render in their empty state because the playground transport returns null for all queries — see Loading & Empty States for richer demos."
    >
      <ShowcaseDemo responsive>
        <Button onClick={() => setOpen(true)}>Open Settings</Button>
        <SettingsDialog open={open} onOpenChange={setOpen} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
```

#### Section 2 — Full AgentDialog

```tsx
function FullAgentDialogSection() {
  const [open, setOpen] = useState(false);
  return (
    <PlaygroundSection
      title="Full Agent Dialog"
      description="The Agent configuration dialog with Identity, Personality, Tools, and Channels tabs. Uses a static mock agent manifest."
    >
      <ShowcaseDemo responsive>
        <Button onClick={() => setOpen(true)}>Open Agent Dialog</Button>
        <MockedQueryProvider>
          <AgentDialog
            projectPath="/Users/dev/example-project"
            open={open}
            onOpenChange={setOpen}
          />
        </MockedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
```

`MockedQueryProvider` is described in §6.5.

#### Section 3 — Individual tabs

Each tab is rendered inside a bare `NavigationLayout` shell. The shell exists because the tabs were designed to live inside one (e.g., they may use `NavigationLayoutPanelHeader`). For tabs that render their own panel header, the shell provides the right ancestry.

```tsx
function IndividualTabsSection() {
  return (
    <PlaygroundSection
      title="Individual Tabs"
      description="Each settings tab rendered in isolation inside a bare NavigationLayout shell. Useful for iterating on a single tab without opening the full dialog."
    >
      <ShowcaseLabel>Appearance Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="appearance">
          <AppearanceTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Preferences Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="preferences">
          <PreferencesTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Status Bar Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="statusBar">
          <StatusBarTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Server Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="server">
          <ServerTab config={MOCK_SERVER_CONFIG} isLoading={false} />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Tools Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="tools">
            <ToolsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Channels Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="channels">
            <ChannelsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Agents Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="agents">
            <AgentsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Advanced Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="advanced">
          <AdvancedTab onResetComplete={() => {}} onRestartComplete={() => {}} />
        </TabShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Bare NavigationLayout shell with one panel for showcasing a single tab. */
function TabShell({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={value} onValueChange={() => {}}>
        <NavigationLayoutBody>
          <NavigationLayoutContent className="p-4">
            <NavigationLayoutPanel value={value}>
              <div className="space-y-4">{children}</div>
            </NavigationLayoutPanel>
          </NavigationLayoutContent>
        </NavigationLayoutBody>
      </NavigationLayout>
    </div>
  );
}
```

> **Note on `ServerTab`:** today it takes `config`/`isLoading` props. The playground passes `MOCK_SERVER_CONFIG` directly. After `settings-dialog-02-tabbed-primitive` lands, `ServerTab` will be self-fetching and the playground will switch to using `MockedQueryProvider`. This spec accommodates the current shape; the mock-data approach makes the migration trivial.

> **Note on `AdvancedTab`:** it takes `onResetComplete`/`onRestartComplete` callback props. The playground passes no-ops. After `settings-dialog-02-tabbed-primitive` lands, those callbacks lift to a Zustand store action and the props go away — at which point the playground showcase becomes parameterless too.

#### Section 4 — Mobile drill-in

```tsx
function MobileDrillInSection() {
  const [active, setActive] = useState('preferences');
  return (
    <PlaygroundSection
      title="Mobile Drill-In"
      description="At narrow viewports the sidebar collapses to a list view, and tapping an item drills into the panel with a back button. Use the viewport toggle to see the responsive behavior."
    >
      <ShowcaseDemo responsive>
        <div className="border-border overflow-hidden rounded-lg border" style={{ height: 480 }}>
          <NavigationLayout value={active} onValueChange={setActive}>
            <NavigationLayoutDialogHeader>
              <ResponsiveDialogTitle className="text-sm font-medium">
                Settings
              </ResponsiveDialogTitle>
            </NavigationLayoutDialogHeader>
            <NavigationLayoutBody>
              <NavigationLayoutSidebar>
                <NavigationLayoutItem value="appearance" icon={Palette}>
                  Appearance
                </NavigationLayoutItem>
                <NavigationLayoutItem value="preferences" icon={Settings2}>
                  Preferences
                </NavigationLayoutItem>
                <NavigationLayoutItem value="server" icon={Server}>
                  Server
                </NavigationLayoutItem>
              </NavigationLayoutSidebar>
              <NavigationLayoutContent className="p-4">
                <NavigationLayoutPanel value="appearance">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Appearance</NavigationLayoutPanelHeader>
                    <AppearanceTab />
                  </div>
                </NavigationLayoutPanel>
                <NavigationLayoutPanel value="preferences">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Preferences</NavigationLayoutPanelHeader>
                    <PreferencesTab />
                  </div>
                </NavigationLayoutPanel>
                <NavigationLayoutPanel value="server">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Server</NavigationLayoutPanelHeader>
                    <ServerTab config={MOCK_SERVER_CONFIG} isLoading={false} />
                  </div>
                </NavigationLayoutPanel>
              </NavigationLayoutContent>
            </NavigationLayoutBody>
          </NavigationLayout>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
```

#### Section 5 — Loading and empty states

```tsx
function LoadingEmptyStatesSection() {
  return (
    <PlaygroundSection
      title="Loading & Empty States"
      description="Skeleton and empty-state renderings for data-driven tabs. These are normally only visible during the brief moment before queries resolve."
    >
      <ShowcaseLabel>Server Tab — Loading</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="server">
          <ServerTab config={undefined} isLoading={true} />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Server Tab — Empty (no config)</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="server">
          <ServerTab config={undefined} isLoading={false} />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Channels Tab — Empty Catalog</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="channels">
          {/* No QueryClient prepopulation → ChannelsTab renders the "no channels" empty state */}
          <ChannelsTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Agents Tab — No Default Agent</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="agents">
          <AgentsTab />
        </TabShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
```

#### Section 6 — Primitives

```tsx
function PrimitivesSection() {
  const [toggleA, setToggleA] = useState(true);
  const [toggleB, setToggleB] = useState(false);
  return (
    <PlaygroundSection
      title="Settings Primitives"
      description="Building blocks used by every settings tab — FieldCard wraps groups of rows, SettingRow is the horizontal label/description/control row."
    >
      <ShowcaseLabel>FieldCard with SettingRows</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldCard>
          <FieldCardContent>
            <SettingRow label="Show timestamps" description="Display message timestamps in chat">
              <Switch checked={toggleA} onCheckedChange={setToggleA} />
            </SettingRow>
            <SettingRow label="Auto-hide tool calls" description="Fade out completed tool calls">
              <Switch checked={toggleB} onCheckedChange={setToggleB} />
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      </ShowcaseDemo>

      <ShowcaseLabel>FieldCard — single row</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldCard>
          <FieldCardContent>
            <SettingRow label="Theme" description="Choose your preferred color scheme">
              <Button variant="outline" size="sm">
                System
              </Button>
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      </ShowcaseDemo>

      <ShowcaseLabel>SettingRow — disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <SettingRow label="Background sync" description="Requires premium plan">
          <Switch checked={false} disabled />
        </SettingRow>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
```

### 6.4 `settings-mock-data.ts` — typed mock data

```ts
import type { ServerConfig } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Realistic mock server config used by ServerTab/ToolsTab showcases. */
export const MOCK_SERVER_CONFIG: ServerConfig = {
  version: '0.30.0',
  latestVersion: '0.30.0',
  port: 4242,
  uptime: 12_345,
  workingDirectory: '/Users/dev/dorkos',
  dorkHome: '/Users/dev/.dork',
  boundary: '/Users/dev',
  nodeVersion: 'v22.10.0',
  isDevMode: false,
  claudeCliPath: '/usr/local/bin/claude',
  scheduler: { maxConcurrentRuns: 3, timezone: null, retentionCount: 100 },
  tasks: { enabled: true },
  relay: { enabled: true },
  mesh: { enabled: true },
  agents: { defaultAgent: 'dorkbot' },
  agentContext: { tasksTools: true, relayTools: true, meshTools: true, adapterTools: true },
  mcp: {
    enabled: false,
    endpoint: 'http://localhost:4242/mcp',
    authConfigured: false,
    authSource: 'none',
    rateLimit: { enabled: false, maxPerWindow: 60, windowSecs: 60 },
  },
  logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
  // Other fields filled in to match the ServerConfig schema
};

/** Mock agent manifest used by the AgentDialog showcase. */
export const MOCK_AGENT_MANIFEST: AgentManifest = {
  id: 'mock-agent-01',
  name: 'Mock Agent',
  slug: 'mock-agent',
  description: 'A static agent used for playground showcases',
  color: '#3b82f6',
  isSystem: false,
  // Other required fields per the schema
};

/** Mock mesh agents list used by AgentsTab. */
export const MOCK_MESH_AGENTS = {
  agents: [
    { id: 'dorkbot', name: 'dorkbot', slug: 'dorkbot', isSystem: true },
    { id: 'mock-agent-01', name: 'Mock Agent', slug: 'mock-agent', isSystem: false },
  ],
};
```

> **Schema-shape risk:** the actual `ServerConfig` schema is large and will likely have required fields not listed above. The mock data file imports the type so TypeScript catches any missing fields at compile time. Update the mock when types change.

### 6.5 `MockedQueryProvider` helper

```tsx
function MockedQueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    c.setQueryData(['config'], MOCK_SERVER_CONFIG);
    c.setQueryData(['mesh', 'agents'], MOCK_MESH_AGENTS);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

The component creates a fresh `QueryClient` per showcase mount, prepopulates the queries that settings tabs read, and provides it. Each tab that uses `MockedQueryProvider` sees populated query state instead of the playground's null transport.

> **Why per-component, not page-wide?** Different sections want different mock states. The Loading/Empty section deliberately doesn't prepopulate so the tabs render their empty branches. Wrapping per-section keeps each demo independent.

### 6.6 `settings-sections.ts` — registry entries

```ts
import type { PlaygroundSection } from '../playground-registry';

export const SETTINGS_SECTIONS: PlaygroundSection[] = [
  // Dialogs
  {
    id: 'full-settings-dialog',
    title: 'Full Settings Dialog',
    page: 'settings',
    category: 'Dialogs',
    keywords: ['settings', 'dialog', 'modal', 'full', 'tabs'],
  },
  {
    id: 'full-agent-dialog',
    title: 'Full Agent Dialog',
    page: 'settings',
    category: 'Dialogs',
    keywords: ['agent', 'dialog', 'modal', 'configuration'],
  },
  // Individual tabs
  {
    id: 'individual-tabs',
    title: 'Individual Tabs',
    page: 'settings',
    category: 'Tabs',
    keywords: [
      'appearance',
      'preferences',
      'status bar',
      'server',
      'tools',
      'channels',
      'agents',
      'advanced',
      'tab',
      'isolated',
    ],
  },
  // Responsive
  {
    id: 'mobile-drill-in',
    title: 'Mobile Drill-In',
    page: 'settings',
    category: 'Responsive',
    keywords: ['mobile', 'drill', 'drawer', 'responsive', 'narrow'],
  },
  // States
  {
    id: 'loading-empty-states',
    title: 'Loading & Empty States',
    page: 'settings',
    category: 'States',
    keywords: ['loading', 'empty', 'skeleton', 'placeholder', 'no data'],
  },
  // Primitives
  {
    id: 'settings-primitives',
    title: 'Settings Primitives',
    page: 'settings',
    category: 'Primitives',
    keywords: ['fieldcard', 'settingrow', 'switch', 'row', 'card', 'wrapper'],
  },
];
```

> **Note on section count:** the spec earlier proposed 15 entries (one per tab), but this would clutter the search index and TOC. Consolidating into 6 well-categorized entries (one per `<PlaygroundSection>`) is the right granularity — matches every other playground page (Components, Tables, Forms, etc., all have one entry per `PlaygroundSection`, not per `ShowcaseLabel`). Individual tabs are findable via the search keywords.

### 6.7 `playground-registry.ts` — registry wiring

```ts
// Add 'settings' to Page union
export type Page =
  | 'overview'
  | 'tokens'
  | 'forms'
  | 'components'
  | 'chat'
  | 'features'
  | 'promos'
  | 'command-palette'
  | 'simulator'
  | 'topology'
  | 'filter-bar'
  | 'error-states'
  | 'onboarding'
  | 'tables'
  | 'settings'; // NEW

// Add re-export
export { SETTINGS_SECTIONS } from './sections/settings-sections';

// Add to PLAYGROUND_REGISTRY
import { SETTINGS_SECTIONS as settings } from './sections/settings-sections';
export const PLAYGROUND_REGISTRY: PlaygroundSection[] = [
  // ... existing
  ...settings,
];
```

### 6.8 `playground-config.ts` — page metadata

```ts
import { Settings as SettingsIcon } from 'lucide-react'; // alias to avoid name collision
import { SETTINGS_SECTIONS } from './playground-registry';

// Add to PAGE_CONFIGS array (in the app-shell group section)
{
  id: 'settings',
  label: 'Settings',
  description:
    'Settings dialogs, individual tabs, mobile drill-in, loading and empty states, and the underlying primitives.',
  icon: SettingsIcon,
  group: 'app-shell',
  sections: SETTINGS_SECTIONS,
  path: 'settings',
},
```

### 6.9 `DevPlayground.tsx` — page component map

```tsx
import { SettingsPage } from './pages/SettingsPage';

const PAGE_COMPONENTS: Record<string, React.ComponentType<PlaygroundPageProps>> = {
  overview: OverviewPage as React.ComponentType<PlaygroundPageProps>,
  tokens: TokensPage,
  forms: FormsPage,
  components: ComponentsPage,
  chat: ChatPage,
  features: FeaturesPage,
  topology: TopologyPage,
  promos: PromosPage,
  'command-palette': CommandPalettePage,
  simulator: SimulatorPage,
  'filter-bar': FilterBarPage,
  'error-states': ErrorStatesPage,
  onboarding: OnboardingPage,
  tables: TablesPage,
  settings: SettingsPage, // NEW
};
```

### 6.10 Files modified — summary

| File                                                  | Lines added | Purpose                               |
| ----------------------------------------------------- | ----------: | ------------------------------------- |
| `apps/client/src/dev/pages/SettingsPage.tsx`          |   ~20 (new) | Page wrapper                          |
| `apps/client/src/dev/showcases/SettingsShowcases.tsx` |  ~250 (new) | Six showcase sections                 |
| `apps/client/src/dev/showcases/settings-mock-data.ts` |   ~70 (new) | Typed mocks                           |
| `apps/client/src/dev/sections/settings-sections.ts`   |   ~50 (new) | Registry entries                      |
| `apps/client/src/dev/playground-registry.ts`          | +3 modified | Add 'settings' to union, export array |
| `apps/client/src/dev/playground-config.ts`            | +9 modified | New PAGE_CONFIGS entry                |
| `apps/client/src/dev/DevPlayground.tsx`               | +2 modified | Add to PAGE_COMPONENTS                |

Total: 4 new files + 3 modified files. Pure additions; nothing removed.

## 7. User Experience

This is **a developer surface, not a user surface.** The audience is:

- **Designers** iterating on a single tab without launching the full app
- **Developers** building or debugging settings features
- **Reviewers** verifying visual changes
- **New contributors** browsing the gallery to understand the system

The persona that benefits most is **Priya Sharma** (`meta/personas/the-knowledge-architect.md`) — the staff engineer who reads source code before adopting tools. The playground is her primary surface for understanding how DorkOS UI works.

User journey:

1. Run `pnpm dev`, navigate to `http://localhost:6241/dev/settings`
2. Sidebar shows "Settings" under the "App Shell" group
3. Page loads with the six PlaygroundSection blocks
4. Click "Open Settings" → full dialog opens, click through tabs
5. Switch viewport to mobile in the responsive demo → see drill-in
6. Scroll to "Settings Primitives" → see `FieldCard`/`SettingRow` demos
7. Hit `⌘K`, type "appearance" → search jumps to `/dev/settings#individual-tabs`

No new affordances; the page just exists, slots into the existing playground patterns, and passively documents.

## 8. Testing Strategy

### 8.1 What we test

| What                               | How                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The page renders without crashing  | Manual smoke test (the playground has no per-page render tests today; this is consistent)                                                                          |
| Section IDs match registry entries | TypeScript: `PlaygroundSection.id` is a string; mismatch shows up as a missing scroll anchor                                                                       |
| Mock data shape matches schema     | TypeScript: `MOCK_SERVER_CONFIG: ServerConfig` enforces the type                                                                                                   |
| Existing playground tests pass     | `OverviewPage.test.tsx`, `TocSidebar.test.tsx`, `PlaygroundSearch.test.tsx` continue to pass without modification (they're data-driven from `PLAYGROUND_REGISTRY`) |

### 8.2 What we don't test

- Per-section render snapshots — playground showcases are intentionally not snapshot-tested (visual review is the point)
- The actual `SettingsDialog`/`AgentDialog` behavior — covered by their own test files
- Mock data correctness beyond the type check — the mock is for visual demo, not functional validation

### 8.3 Verification commands

```bash
pnpm typecheck                                                # All types resolve
pnpm test -- --run                                            # No existing tests break
pnpm vitest run apps/client/src/dev/__tests__                 # Playground tests
pnpm lint                                                     # No new lint violations
pnpm dev                                                      # Manual smoke test at /dev/settings
```

### 8.4 Manual smoke checklist

After launching `/dev/settings`:

- [ ] Page header renders with "Settings" title and description
- [ ] TOC sidebar lists all 6 sections grouped by category
- [ ] Section 1: clicking "Open Settings" opens the full dialog
- [ ] Section 1: dialog tabs all render (some in empty state)
- [ ] Section 2: clicking "Open Agent Dialog" opens with mock agent
- [ ] Section 3: each individual tab renders
- [ ] Section 3: AppearanceTab toggles work (Zustand state updates)
- [ ] Section 3: PreferencesTab toggles work
- [ ] Section 3: ServerTab shows MOCK_SERVER_CONFIG values
- [ ] Section 3: ToolsTab renders with mock query data
- [ ] Section 4: viewport toggle to mobile shows drill-in
- [ ] Section 5: ServerTab loading variant shows skeleton
- [ ] Section 5: ServerTab empty variant renders without crash
- [ ] Section 5: ChannelsTab empty state renders
- [ ] Section 6: FieldCard + SettingRow primitives render with toggleable switches
- [ ] `⌘K` palette finds "Settings Dialog" → navigates correctly
- [ ] No console errors during any interaction

## 9. Performance Considerations

**None.** The playground is a dev-only surface, lazy-loaded, and not part of the production bundle:

- The playground page tree is **already** loaded only when navigating to `/dev/*`
- New mock data is ~70 lines of static JSON-like literals — negligible
- `MockedQueryProvider` creates a fresh `QueryClient` per showcase mount; the playground doesn't have enough showcases for this to matter
- No new dependencies, no new bundle size concerns
- The full Settings/Agent dialogs are heavy components, but they're only mounted when the user clicks "Open" — same pattern as `OverlayShowcases.tsx` already uses

## 10. Security Considerations

**None.**

- Mock data is hardcoded literals — no secrets, no real config
- No network calls (playground transport returns null)
- No new auth flows
- The dev playground is gated by `import.meta.env.DEV` and not exposed in production builds (verify in `DevPlayground.tsx` if not already)

## 11. Documentation

- TSDoc on `SettingsShowcases` and the six section components per `.claude/rules/documentation.md`
- TSDoc on `MockedQueryProvider` and `TabShell` helpers
- TSDoc on each export in `settings-mock-data.ts`
- No `contributing/` doc updates (the playground has no dedicated guide today)
- No user-facing docs (`docs/`) — the playground is internal
- Add a brief note to the next changelog under "Internal": "Dev playground gains a Settings page covering dialogs, tabs, primitives, and responsive states"

## 12. Implementation Phases

**Phase 1 — Mock data and helpers** (no UI yet)

1. Create `settings-mock-data.ts` with `MOCK_SERVER_CONFIG`, `MOCK_AGENT_MANIFEST`, `MOCK_MESH_AGENTS`
2. Run `pnpm typecheck` to verify the mock data matches the actual schema; fill in any missing required fields
3. Commit: `chore(dev): add settings mock data for playground showcases`

**Phase 2 — Registry wiring** (gives the page a slot, even if empty)

1. Create `sections/settings-sections.ts` with `SETTINGS_SECTIONS` array
2. Update `playground-registry.ts` to add `'settings'` to the `Page` union and export `SETTINGS_SECTIONS`
3. Update `playground-config.ts` with the new `PageConfig` entry
4. Create empty `pages/SettingsPage.tsx` (renders an empty `PlaygroundPageLayout`)
5. Update `DevPlayground.tsx` to add `'settings'` to `PAGE_COMPONENTS`
6. Run `pnpm typecheck` and `pnpm test -- --run`
7. Verify navigation: open `/dev/settings`, page should render the empty layout
8. Commit: `feat(dev): add Settings page registry entries`

**Phase 3 — Showcases**

1. Create `showcases/SettingsShowcases.tsx` with the six section components
2. Wire `SettingsShowcases` into `pages/SettingsPage.tsx`
3. Run `pnpm typecheck`
4. Manual smoke test of every section
5. Commit: `feat(dev): add Settings showcases for dialogs, tabs, and primitives`

**Phase 4 — Verification**

1. `pnpm typecheck` — green
2. `pnpm test -- --run` — green (no test changes needed)
3. `pnpm vitest run apps/client/src/dev/__tests__` — green
4. `pnpm lint` — green
5. Manual: walk through the smoke checklist (§8.4)
6. Manual: search `⌘K` for "settings" and navigate to each section
7. Optional follow-up commit: address any visual issues found during smoke

## 13. Open Questions

**Q1. Should we mock the playground transport globally to return realistic data, or use per-showcase `MockedQueryProvider` wrappers?**

Resolved (§6.5): **per-showcase wrappers**. Different showcases want different mock states (loaded vs empty vs loading). A global mock would force all of them into one state.

**Q2. How granular should section entries be — one per `PlaygroundSection` or one per `ShowcaseLabel`?**

Resolved (§6.6): **one per `PlaygroundSection`** (6 entries), matching every other playground page. Individual tabs are findable via search keywords.

**Q3. Should the playground showcase migrate to using whatever shape `ServerTab`/`AdvancedTab` end up with after `settings-dialog-02-tabbed-primitive`?**

**Open**, but the right answer is: **target the post-`settings-dialog-02-tabbed-primitive` shape** when it lands. For now, this spec uses the current parameterized shape. After the primitive spec lands, update `IndividualTabsSection` to drop the props and wrap in `MockedQueryProvider`. The change is one commit and trivial.

**Q4. Should we add a showcase for `RemoteAccessAction` (the non-tab sidebar item in `SettingsDialog`)?**

**No** — it's a one-off button, not a reusable primitive. Including it in the Mobile Drill-In showcase if convenient, otherwise skip.

**Q5. Should we mock `useTransport` globally just for the playground page, or rely on the existing `createPlaygroundTransport`?**

**Rely on existing.** The Settings page uses the global `TransportProvider` set up in `DevPlayground.tsx`, which already wraps everything in `createPlaygroundTransport`. Mocked queries via `MockedQueryProvider` give us the data layer we need without changing the transport.

**Q6. Should the page lazy-load the showcase components?**

**No** — the playground is dev-only and the bundle isn't shipped. Lazy-loading adds complexity for no benefit.

**Q7. Should the mobile drill-in showcase use `iframe`-based viewport simulation instead of CSS `max-width`?**

**No.** `ShowcaseDemo.tsx:25-63` already provides viewport simulation via CSS `max-width`. This is consistent with how every other responsive showcase works (e.g., `NavigationShowcases.tsx`).

**Q8. Should we add a showcase entry for `TunnelDialog`?**

**No.** `TunnelDialog` has timers, fetch calls, and a 5-state machine that don't translate to a static demo. Add a placeholder card linking to the in-app version if we want discoverability, but don't try to render it.

## 14. Related ADRs

- **ADR 0002 — Adopt Feature-Sliced Design** (`decisions/0002-adopt-feature-sliced-design.md`) — `dev/` lives outside the `layers/` hierarchy and can import from any layer, so this spec can freely import settings components.
- **ADR 0008 — Promote shared components for cross-feature reuse** (`decisions/0008-promote-shared-components-for-cross-feature-reuse.md`) — Justifies that the playground can reach into `features/settings` and `features/agent-settings` directly (it's a sibling-of-features dev tool, not a feature itself).
- **ADR 0005 — Zustand for UI state, TanStack Query for server state** (`decisions/0005-zustand-ui-state-tanstack-query-server-state.md`) — Explains why the AppearanceTab/PreferencesTab/StatusBarTab work without query mocks (they're Zustand-backed).

## 15. References

### Internal

- `specs/settings-dialog-01-file-splits/` — **Prerequisite spec.** Must land first.
- `specs/dev-playground-navigation-overhaul/` — Created the current playground structure (`PlaygroundPageLayout`, `PlaygroundSection`, page-config-driven sidebar)
- `specs/settings-dialog-02-tabbed-primitive/` — Related but independent. After it lands, `ServerTab`/`AdvancedTab` become parameterless and the playground showcase becomes simpler.
- `apps/client/src/dev/pages/ComponentsPage.tsx` — Pattern reference for `SettingsPage`
- `apps/client/src/dev/showcases/NavigationShowcases.tsx` — Existing partial coverage of `NavigationLayout` (stays as-is)
- `apps/client/src/dev/showcases/OverlayShowcases.tsx` — Pattern reference for dialog showcases
- `apps/client/src/dev/showcases/FormShowcases.tsx` — Pattern reference for primitive showcases
- `apps/client/src/dev/playground-config.ts` — Where to add the page entry
- `apps/client/src/dev/playground-registry.ts` — Where to register sections
- `apps/client/src/dev/DevPlayground.tsx` — Where to wire the page component
- `apps/client/src/dev/playground-transport.ts` — The null-returning Proxy transport
- `apps/client/src/dev/PlaygroundSection.tsx`, `ShowcaseDemo.tsx`, `ShowcaseLabel.tsx` — Showcase primitives
- `apps/client/src/layers/features/settings/ui/*` — The components being showcased
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — The agent dialog being showcased
- `meta/personas/the-knowledge-architect.md` — Priya Sharma persona (the playground audience)
- `.claude/skills/maintaining-dev-playground/SKILL.md` — The methodology for keeping the playground in sync with the app

### External

- React 19 docs: https://react.dev/reference/react
- TanStack Query — `setQueryData`: https://tanstack.com/query/latest/docs/reference/QueryClient/#queryclientsetquerydata
