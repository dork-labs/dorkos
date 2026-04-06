---
slug: settings-dialog-03-url-deeplinks
number: 221
created: 2026-04-06
status: specified
---

# Dialog URL Deeplinks

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-04-06

---

## 1. Overview

Migrate dialog deep-linking from the Zustand `panels` slice to TanStack Router search params. After this spec, every modal dialog in DorkOS — Settings, Agent, Tasks, Relay, Mesh — is URL-addressable, shareable, bookmarkable, and respects browser history. Existing store-based opens continue to work as a fallback during the migration; the goal is **additive** dual-source support, not a hard cutover.

URLs after this spec:

```
/agents?settings=open                                  → Settings dialog (default tab) on Agents page
/session?session=abc123&settings=tools                 → Settings → Tools tab on Session page
/?settings=tools&settingsSection=external-mcp          → Settings → Tools tab, scrolled to External MCP
/?agent=identity&agentPath=/abs/path/to/repo           → Agent dialog → Identity tab for that project
/?tasks=open                                           → Tasks dialog
/?relay=open                                           → Relay dialog
/?mesh=open                                            → Mesh dialog
```

## 2. Background / Problem Statement

DorkOS dialogs are deep-linkable internally via Zustand store actions:

```ts
// apps/client/src/layers/shared/model/app-store/app-store-panels.ts
openSettingsToTab: (tab) => set({ settingsOpen: true, settingsInitialTab: tab }),
openAgentDialogToTab: (tab) => set({ agentDialogOpen: true, agentDialogInitialTab: tab }),
```

This works _inside_ the app — any callsite can `useAppStore().openSettingsToTab('tools')` and Settings opens to Tools. But it's invisible to the URL, which means:

| Limitation                                            | Impact                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot share "open Settings to Tools" with a teammate | Support, onboarding, docs all fail                                                                                                        |
| Browser back doesn't close the dialog                 | Mobile users hit hardware-back and lose context                                                                                           |
| Reload loses dialog state                             | Frustrating during dev iteration                                                                                                          |
| Cannot link from external sources                     | Changelog, support docs, the litepaper, scheduled task notifications, hooks all need a way to say "open this view"                        |
| Bookmarks don't include dialog state                  | Power users can't save "always open Settings to Tools"                                                                                    |
| Two inconsistent sync patterns exist                  | `SettingsDialog` uses `useEffect` (lines 120-124), `AgentDialog` uses adjust-state-during-render (lines 53-59). Same job, different code. |

The store-based approach is the **root cause** of the divergence between the two sync patterns: because the only signal is a Zustand value, each dialog is free to invent its own way of consuming it. URL state, by contrast, is handled by a single `useSearch` hook from TanStack Router that returns typed values — there's no room for divergence.

DorkOS already uses TanStack Router with `validateSearch: zodValidator(...)` schemas on every route (`apps/client/src/router.tsx:42-66`). Search params are first-class. The infrastructure for this migration is already in place — we just haven't used it for dialogs yet.

### Migration scale

A grep of `openSettingsToTab|openAgentDialogToTab|setSettingsOpen|setTasksOpen|setRelayOpen|setMeshOpen` across `apps/client/src` finds **27 files** that touch dialog state today, including:

- `command-palette/model/use-palette-actions.ts` — palette opens Settings/Tasks/Relay/Mesh
- `feature-promos/ui/dialogs/{RelayAdapters,Schedules,AgentChat}Dialog.tsx` — promo cards deep-link
- `agent-settings/ui/ChannelsTab.tsx` — switches from agent dialog to settings dialog
- `agents-list/ui/AgentRow.tsx` — opens agent dialog
- `feature-promo-system/...` — open settings to specific tabs from promo cards
- `dashboard-status/ui/SystemStatusRow.tsx` — opens dialogs from health cards
- `session-list/{model,ui}/...` — sidebar contributions, footer buttons
- `mesh/ui/MeshPanel.tsx` — opens mesh dialog
- `shared/lib/ui-action-dispatcher.ts` — programmatic dispatcher used by agents (UI control)

Most callsites are one-liners. The migration is mechanical but broad.

## 3. Goals

- All five dialogs (Settings, Agent, Tasks, Relay, Mesh) URL-addressable via search params
- A typed `dialogSearchSchema` merged into every route's `validateSearch`
- Shared `useSettingsDeepLink` / `useAgentDialogDeepLink` / `useTasksDeepLink` / `useRelayDeepLink` / `useMeshDeepLink` hooks with a consistent API
- `RegistryDialog` reads **both** signals (URL **OR** store) so existing store-based opens continue working
- Closing the dialog clears both store and URL state
- Sub-section deep links work for Settings (`?settings=tools&settingsSection=external-mcp`)
- Browser back closes the dialog (not the underlying page)
- Reloading a deep link reopens the dialog
- All ~27 callsites migrated to the new hooks
- Existing tests continue to pass (with import-path updates only)
- New unit tests for each hook + integration test for `DialogHost` URL-aware behavior + E2E Playwright test for URL-driven open

## 4. Non-Goals

- **Hard cutover** — store-based opens stay as a fallback. We can delete the store fields in a follow-up once we're confident every callsite has migrated.
- **Migrating away from the `panels` slice entirely** — `setSettingsOpen(false)` etc. remain valid. Only `openSettingsToTab` and `openAgentDialogToTab` (the _deep-link_ actions) become URL-driven.
- **Refactoring `DIALOG_CONTRIBUTIONS` shape** beyond adding the optional `urlParam` field
- **URL state for tabs _inside_ dialogs that aren't deep-linked today** (e.g., the Setup Instructions tab inside `ExternalMcpCard` — that's intra-card state, not URL-worthy)
- **SSR / SEO concerns** — DorkOS is an SPA; no SSR
- **A different routing library** — TanStack Router stays
- **Browser history pruning or cleanup** — back button just works; no manual history manipulation
- **Breaking changes to existing route schemas** (`?session=`, `?dir=`, `?detail=`, `?view=`, `?sort=`)
- **Deep-linking dialogs that don't have store entries today** (e.g., `TunnelDialog`, `ServerRestartOverlay`, `DirectoryPicker`, `ResetDialog`, `RestartDialog`) — they're opened from inside other dialogs, not from across the app
- **Migration from `useEffect`-based deep-link sync in `SettingsDialog` to React-recommended pattern** — that's the `settings-dialog-02-tabbed-primitive` spec's job. This spec replaces the _whole_ sync layer with URL reads.

## 5. Technical Dependencies

| Dependency               | Version                          | Notes                                        |
| ------------------------ | -------------------------------- | -------------------------------------------- |
| `@tanstack/react-router` | ^1 (already installed, ADR 0154) | `useSearch`, `useNavigate`, `validateSearch` |
| `@tanstack/zod-adapter`  | already installed                | `zodValidator`                               |
| `zod`                    | ^3 (already installed)           | Schema validation                            |
| React                    | ^19                              | No new patterns                              |
| `@dorkos/test-utils`     | (in repo)                        | For browser test helpers                     |
| Playwright               | (in `apps/e2e`)                  | For URL-driven E2E test                      |

No new runtime dependencies.

**TanStack Router docs:** https://tanstack.com/router/latest/docs/framework/react/guide/search-params

## 6. Detailed Design

### 6.1 Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  router.tsx                                                 │
│                                                             │
│  dialogSearchSchema (NEW) — merged into every route         │
│    settings?: string             // 'open' | tab id         │
│    settingsSection?: string      // intra-tab anchor        │
│    agent?: string                // 'open' | tab id         │
│    agentPath?: string            // project path            │
│    tasks?: string                // 'open'                  │
│    relay?: string                // 'open'                  │
│    mesh?: string                 // 'open'                  │
└────────────────────┬────────────────────────────────────────┘
                     │ via useSearch({ strict: false })
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  shared/model/use-dialog-deep-link.ts (NEW)                 │
│                                                             │
│  useSettingsDeepLink()    → DialogDeepLink<SettingsTab>     │
│  useAgentDialogDeepLink() → DialogDeepLink<AgentTab>+path   │
│  useTasksDeepLink()       → DialogDeepLink<never>           │
│  useRelayDeepLink()       → DialogDeepLink<never>           │
│  useMeshDeepLink()        → DialogDeepLink<never>           │
└────────────┬─────────────────────────────────────┬──────────┘
             │                                     │
             ▼                                     ▼
┌──────────────────────────┐         ┌─────────────────────────┐
│  RegistryDialog          │         │  Direct callsites       │
│  reads URL+store         │         │  use the hooks to       │
│  open = url OR store     │         │  open dialogs           │
│  close clears both       │         │  (palette, promos, …)   │
└──────────────────────────┘         └─────────────────────────┘
```

The key idea: **two parallel signals — URL and store — feed into one open state.** Closing the dialog clears both. New code uses the URL-based hooks; existing store-based code keeps working until migrated.

### 6.2 The shared search schema

**File:** `apps/client/src/layers/shared/model/dialog-search-schema.ts` (NEW)

```ts
import { z } from 'zod';

/**
 * URL search params for deep-linking modal dialogs.
 *
 * Merged into every route's `validateSearch` schema via `mergeDialogSearch`
 * so dialog deep links work from any page without route-specific wiring.
 *
 * Each dialog uses two patterns:
 *  - Boolean-ish: `?tasks=open` opens the dialog (any non-empty value works,
 *    but `'open'` is the canonical form for parameterless dialogs)
 *  - Tab-targeted: `?settings=tools` opens the dialog to a specific tab
 *
 * Sub-section anchors use a sibling param (e.g. `?settings=tools&settingsSection=mcp`).
 */
export const dialogSearchSchema = z.object({
  // Settings
  settings: z.string().optional(),
  settingsSection: z.string().optional(),
  // Agent dialog
  agent: z.string().optional(),
  agentPath: z.string().optional(),
  // Other dialogs (parameterless — no tabs)
  tasks: z.string().optional(),
  relay: z.string().optional(),
  mesh: z.string().optional(),
});

export type DialogSearch = z.infer<typeof dialogSearchSchema>;
```

**Helper to merge into route schemas:**

```ts
// in dialog-search-schema.ts
import type { ZodObject, ZodRawShape } from 'zod';

/**
 * Merge dialog search params into a route's existing search schema.
 *
 * @example
 * const sessionSearchSchema = mergeDialogSearch(
 *   z.object({ session: z.string().optional(), dir: z.string().optional() })
 * );
 */
export function mergeDialogSearch<T extends ZodRawShape>(routeSchema: ZodObject<T>) {
  return routeSchema.merge(dialogSearchSchema);
}
```

### 6.3 Router integration

**File:** `apps/client/src/router.tsx` (MODIFIED)

Wrap each existing route's `validateSearch` schema with `mergeDialogSearch`:

```ts
import { mergeDialogSearch, dialogSearchSchema } from '@/layers/shared/model';

// Dashboard at /
const dashboardSearchSchema = mergeDialogSearch(
  z.object({
    detail: z.enum(['dead-letter', 'failed-run', 'offline-agent']).optional(),
    itemId: z.string().optional(),
  })
);

// Session at /session
const sessionSearchSchema = mergeDialogSearch(
  z.object({
    session: z.string().optional(),
    dir: z.string().optional(),
  })
);

// Agents at /agents
const agentsSearchSchema = mergeDialogSearch(
  z
    .object({
      view: z.enum(['list', 'topology']).optional().default('list'),
      sort: z.string().optional().default('lastSeen:desc'),
    })
    .merge(agentFilterSchema.searchValidator)
);

// Activity at /activity
const activitySearchSchema = mergeDialogSearch(
  z.object({
    categories: z.string().optional(),
    actorType: z.string().optional(),
    actorId: z.string().optional(),
    since: z.string().optional(),
  })
);
```

> **Why per-route merging instead of inheriting from `appShellRoute`?**
>
> TanStack Router _does_ support nested route search schemas, and a parent layout route's `validateSearch` is inherited by children. We could lift `dialogSearchSchema` to `appShellRoute` and avoid the per-route merge.
>
> **Tradeoff:** inheriting saves ~4 lines of code but the inferred search type at child routes becomes a union (parent ∪ child), and `useSearch({ from: '/session' })` doesn't see the parent params unless you also call `useSearch({ from: '__root__' })` or use `strict: false`. The explicit per-route merge is more verbose but cleaner type ergonomics.
>
> **Decision:** explicit merge per route. The duplication is one line per route (4 lines total) and the type story is unambiguous.

### 6.4 The deep-link hooks

**File:** `apps/client/src/layers/shared/model/use-dialog-deep-link.ts` (NEW)

```ts
import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { SettingsTab, AgentDialogTab } from './app-store/app-store-panels';

/** Generic shape returned by every dialog deep-link hook. */
export interface DialogDeepLink<T extends string> {
  /** True if the dialog should be open per the URL. */
  isOpen: boolean;
  /** Active tab from the URL (or null if the param is `'open'` / not set). */
  activeTab: T | null;
  /** Sub-section anchor (for intra-tab scroll/expand). */
  section: string | null;
  /** Open the dialog. Pass a tab to deep-link to a specific tab. */
  open: (tab?: T, section?: string) => void;
  /** Close the dialog. Clears all related search params. */
  close: () => void;
  /** Switch active tab without closing. Replaces history entry. */
  setTab: (tab: T) => void;
  /** Set or clear the sub-section anchor. Replaces history entry. */
  setSection: (section: string | null) => void;
}

/** Settings dialog deep-link state and actions. */
export function useSettingsDeepLink(): DialogDeepLink<SettingsTab> {
  const search = useSearch({ strict: false }) as { settings?: string; settingsSection?: string };
  const navigate = useNavigate();

  const isOpen = !!search.settings;
  const activeTab = isOpen && search.settings !== 'open' ? (search.settings as SettingsTab) : null;
  const section = search.settingsSection ?? null;

  const open = useCallback(
    (tab?: SettingsTab, sectionId?: string) => {
      navigate({
        search: (prev) => ({
          ...prev,
          settings: tab ?? 'open',
          settingsSection: sectionId,
        }),
      });
    },
    [navigate]
  );

  const close = useCallback(() => {
    navigate({
      search: (prev) => ({ ...prev, settings: undefined, settingsSection: undefined }),
    });
  }, [navigate]);

  const setTab = useCallback(
    (tab: SettingsTab) => {
      navigate({
        search: (prev) => ({ ...prev, settings: tab, settingsSection: undefined }),
        replace: true,
      });
    },
    [navigate]
  );

  const setSection = useCallback(
    (sectionId: string | null) => {
      navigate({
        search: (prev) => ({ ...prev, settingsSection: sectionId ?? undefined }),
        replace: true,
      });
    },
    [navigate]
  );

  return { isOpen, activeTab, section, open, close, setTab, setSection };
}

/** Agent dialog deep-link state and actions. Includes `agentPath` accessor. */
export function useAgentDialogDeepLink(): DialogDeepLink<AgentDialogTab> & {
  agentPath: string | null;
} {
  const search = useSearch({ strict: false }) as { agent?: string; agentPath?: string };
  const navigate = useNavigate();

  const isOpen = !!search.agent && !!search.agentPath;
  const activeTab = isOpen && search.agent !== 'open' ? (search.agent as AgentDialogTab) : null;
  const agentPath = search.agentPath ?? null;

  const open = useCallback(
    (tab?: AgentDialogTab) => {
      // open requires the agentPath be set already; callers use `openForAgent` below
      navigate({ search: (prev) => ({ ...prev, agent: tab ?? 'open' }) });
    },
    [navigate]
  );

  const close = useCallback(() => {
    navigate({
      search: (prev) => ({ ...prev, agent: undefined, agentPath: undefined }),
    });
  }, [navigate]);

  const setTab = useCallback(
    (tab: AgentDialogTab) => {
      navigate({ search: (prev) => ({ ...prev, agent: tab }), replace: true });
    },
    [navigate]
  );

  return {
    isOpen,
    activeTab,
    section: null,
    agentPath,
    open,
    close,
    setTab,
    setSection: () => {},
  };
}

/** Convenience: open the agent dialog for a specific project path. */
export function useOpenAgentDialog() {
  const navigate = useNavigate();
  return useCallback(
    (agentPath: string, tab?: AgentDialogTab) => {
      navigate({
        search: (prev) => ({ ...prev, agent: tab ?? 'open', agentPath }),
      });
    },
    [navigate]
  );
}

/** Tasks dialog deep-link state and actions. No tabs. */
export function useTasksDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('tasks');
}

/** Relay dialog deep-link state and actions. No tabs. */
export function useRelayDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('relay');
}

/** Mesh dialog deep-link state and actions. No tabs. */
export function useMeshDeepLink(): DialogDeepLink<never> {
  return useSimpleDialogDeepLink('mesh');
}

/** Internal helper for parameterless (no-tab) dialogs. */
function useSimpleDialogDeepLink(paramName: 'tasks' | 'relay' | 'mesh'): DialogDeepLink<never> {
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const navigate = useNavigate();
  const isOpen = !!search[paramName];

  const open = useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, [paramName]: 'open' }) });
  }, [navigate, paramName]);

  const close = useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, [paramName]: undefined }) });
  }, [navigate, paramName]);

  return {
    isOpen,
    activeTab: null,
    section: null,
    open,
    close,
    setTab: () => {},
    setSection: () => {},
  };
}
```

Notes:

- `useSearch({ strict: false })` returns the deepest matching search type. Since `dialogSearchSchema` is merged into every route, the types resolve correctly. The cast to a typed object is needed because `strict: false` returns `unknown` in the inferred type.
- `setTab` and `setSection` use `replace: true` so in-dialog navigation doesn't pollute browser history. `open` and `close` use the default `push` so back-button works.
- `useAgentDialogDeepLink` separates the read API (`open(tab?)`) from the convenience opener (`useOpenAgentDialog(path, tab?)`) because the agent dialog requires both `agent` _and_ `agentPath`. Most callsites need the convenience form.

### 6.5 `RegistryDialog` — dual-source open state

**File:** `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` (MODIFIED)

The current `RegistryDialog` reads `open` exclusively from the store:

```ts
function RegistryDialog({ contribution }: { contribution: DialogContribution }) {
  const open = useAppStore((s) => s[contribution.openStateKey] as boolean);
  const setter = useAppStore((s) => s[toSetterKey(contribution.openStateKey)]);
  const Component = contribution.component;
  return <Component open={open} onOpenChange={setter} />;
}
```

After this spec, it reads **both** the URL signal and the store signal:

```tsx
function RegistryDialog({ contribution }: { contribution: DialogContribution }) {
  const storeOpen = useAppStore((s) => s[contribution.openStateKey as keyof typeof s] as boolean);
  const setStoreOpen = useAppStore(
    (s) => s[toSetterKey(contribution.openStateKey) as keyof typeof s] as (open: boolean) => void
  );

  // URL signal — only when contribution declares a urlParam
  const urlSignal = useDialogUrlSignal(contribution.urlParam);

  const open = storeOpen || urlSignal.isOpen;

  const onOpenChange = useCallback(
    (value: boolean) => {
      setStoreOpen(value);
      if (!value && urlSignal.isOpen) urlSignal.close();
    },
    [setStoreOpen, urlSignal]
  );

  const Component = contribution.component;
  return <Component open={open} onOpenChange={onOpenChange} />;
}

/** Read the URL open signal for a dialog by its `urlParam` field. Returns no-op for undefined. */
function useDialogUrlSignal(urlParam: DialogContribution['urlParam']) {
  const settings = useSettingsDeepLink();
  const agent = useAgentDialogDeepLink();
  const tasks = useTasksDeepLink();
  const relay = useRelayDeepLink();
  const mesh = useMeshDeepLink();

  switch (urlParam) {
    case 'settings':
      return { isOpen: settings.isOpen, close: settings.close };
    case 'agent':
      return { isOpen: agent.isOpen, close: agent.close };
    case 'tasks':
      return { isOpen: tasks.isOpen, close: tasks.close };
    case 'relay':
      return { isOpen: relay.isOpen, close: relay.close };
    case 'mesh':
      return { isOpen: mesh.isOpen, close: mesh.close };
    default:
      return { isOpen: false, close: () => {} };
  }
}
```

> **Hooks-in-a-switch caveat:** The five `use*DeepLink` calls are unconditional (called every render in the same order), so React's rules-of-hooks are satisfied. The switch only chooses _which result_ to return.

### 6.6 `DialogContribution` schema update

**File:** `apps/client/src/layers/shared/model/extension-registry.ts` (MODIFIED)

```ts
export interface DialogContribution extends BaseContribution {
  /** Dialog component accepting `open` and `onOpenChange` props. */
  component: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void }>;
  /** Key in `useAppStore()` that controls open state (e.g., 'settingsOpen'). */
  openStateKey: string;
  /** Optional URL search param name for deep-linking. */
  urlParam?: 'settings' | 'agent' | 'tasks' | 'relay' | 'mesh';
}
```

**File:** `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` (MODIFIED)

```ts
export const DIALOG_CONTRIBUTIONS: DialogContribution[] = [
  {
    id: 'settings',
    component: SettingsDialogWrapper,
    openStateKey: 'settingsOpen',
    urlParam: 'settings',
    priority: 1,
  },
  {
    id: 'directory-picker',
    component: DirectoryPickerWrapper,
    openStateKey: 'pickerOpen',
    priority: 2,
  },
  {
    id: 'tasks',
    component: TasksDialogWrapper,
    openStateKey: 'tasksOpen',
    urlParam: 'tasks',
    priority: 3,
  },
  {
    id: 'relay',
    component: RelayDialogWrapper,
    openStateKey: 'relayOpen',
    urlParam: 'relay',
    priority: 4,
  },
  {
    id: 'mesh',
    component: MeshDialogWrapper,
    openStateKey: 'meshOpen',
    urlParam: 'mesh',
    priority: 5,
  },
  {
    id: 'agent',
    component: AgentDialogWrapper,
    openStateKey: 'agentDialogOpen',
    urlParam: 'agent',
    priority: 6,
  },
];
```

`directory-picker` does **not** get a `urlParam` — it's not deep-linkable across the app (it's opened from inside other dialogs and has its own ephemeral state).

### 6.7 Settings/Agent dialog tab sync

When the URL drives the open state, the dialogs need to read the _active tab_ from the URL too — otherwise the existing `useState(initialTab)` pattern reads from the now-stale store.

**Settings:** Inside `SettingsDialog.tsx`, replace the deep-link sync with the URL-driven hook:

```tsx
// Before
const settingsInitialTab = useAppStore((s) => s.settingsInitialTab);
const [activeTab, setActiveTab] = useState(settingsInitialTab ?? 'appearance');
useEffect(() => {
  if (open && settingsInitialTab) setActiveTab(settingsInitialTab);
}, [open, settingsInitialTab]);

// After
const { activeTab: urlTab, setTab } = useSettingsDeepLink();
const [localTab, setLocalTab] = useState<SettingsTab>(urlTab ?? 'appearance');
const activeTab = urlTab ?? localTab;
const setActiveTab = useCallback(
  (tab: SettingsTab) => {
    setLocalTab(tab);
    if (urlTab) setTab(tab); // mirror to URL only when URL is the source
  },
  [urlTab, setTab]
);
```

The dialog still has local state (so non-URL opens work), but the URL takes precedence when present. Switching tabs while URL-open updates the URL via `replace: true` so back-button still closes the whole dialog (not stepping through tabs).

**Agent dialog:** Same pattern with `useAgentDialogDeepLink()`.

> **Note:** This subsection becomes simpler after `settings-dialog-02-tabbed-primitive` lands. `TabbedDialog` will own this logic via its updated `useDialogTabState` hook (which becomes URL-aware in this spec). For now, write the explicit version in `SettingsDialog.tsx` and `AgentDialog.tsx`; collapse it into the primitive when both specs have shipped.

### 6.8 Sub-section scrolling

For URLs like `?settings=tools&settingsSection=external-mcp`, the Tools tab should scroll the External MCP section into view. Implementation:

**1. Tag scrollable sections with `data-section`:**

```tsx
// inside ToolsTab.tsx after refactor
{
  serverConfig?.mcp && (
    <div data-section="external-mcp">
      <ExternalMcpCard mcp={serverConfig.mcp} />
    </div>
  );
}
```

**2. New shared hook `useDeepLinkScroll`:**

```ts
// shared/model/use-deep-link-scroll.ts
import { useEffect } from 'react';

/**
 * Scroll the element with `[data-section="<section>"]` into view when the section
 * matches the deep-link target. Optionally fires a callback to expand collapsibles.
 *
 * @param section - Current section anchor from `useSettingsDeepLink().section`
 * @param onMatch - Optional callback fired when a section matches (use to expand collapsibles)
 */
export function useDeepLinkScroll(section: string | null, onMatch?: (id: string) => void) {
  useEffect(() => {
    if (!section) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-section="${section}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        onMatch?.(section);
      }
    });
  }, [section, onMatch]);
}
```

**3. Wire into the Tools tab:**

```tsx
// inside ToolsTab.tsx
const { section } = useSettingsDeepLink();
useDeepLinkScroll(section);
```

Same pattern as the dev playground's existing `scrollToSection` in `DevPlayground.tsx:103-109`.

**4. Auto-expand collapsibles** by passing an `onMatch` callback that opens the relevant `Collapsible`:

```tsx
const [expanded, setExpanded] = useState(false);
useDeepLinkScroll(section, (id) => {
  if (id === 'external-mcp') setExpanded(true);
});
```

Each tab tags its scrollable sections and (optionally) its collapsibles. Initial coverage in this spec: only `?settingsSection=external-mcp` for Tools tab. Other sub-section anchors can be added incrementally.

### 6.9 Callsite migration map

A grep for `openSettingsToTab|openAgentDialogToTab|setSettingsOpen|setTasksOpen|setRelayOpen|setMeshOpen` finds **27 files** today. The non-test, non-store-definition callsites that need migration:

| File                                                                                | Action                                                | Migration                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx:106`             | `openSettingsToTab('channels')`                       | `useSettingsDeepLink().open('channels')`                       |
| `apps/client/src/layers/features/agents-list/ui/AgentRow.tsx`                       | open agent dialog                                     | `useOpenAgentDialog()(path)`                                   |
| `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`      | open multiple dialogs                                 | replace each `setXxxOpen(true)` with `useXxxDeepLink().open()` |
| `apps/client/src/layers/features/command-palette/model/use-global-palette.ts`       | similar                                               | similar                                                        |
| `apps/client/src/layers/features/feature-promos/ui/dialogs/RelayAdaptersDialog.tsx` | open Settings to Tools                                | `useSettingsDeepLink().open('tools')`                          |
| `apps/client/src/layers/features/feature-promos/ui/dialogs/SchedulesDialog.tsx`     | open Tasks                                            | `useTasksDeepLink().open()`                                    |
| `apps/client/src/layers/features/feature-promos/ui/dialogs/AgentChatDialog.tsx`     | open agent dialog                                     | `useOpenAgentDialog()(path)`                                   |
| `apps/client/src/layers/features/dashboard-status/ui/SystemStatusRow.tsx`           | open dialogs from health cards                        | use respective deep-link hook                                  |
| `apps/client/src/layers/features/session-list/ui/ConnectionsView.tsx`               | similar                                               | similar                                                        |
| `apps/client/src/layers/features/session-list/ui/TasksView.tsx`                     | open Tasks                                            | `useTasksDeepLink().open()`                                    |
| `apps/client/src/layers/features/session-list/model/sidebar-contributions.ts`       | sidebar buttons                                       | use deep-link hooks                                            |
| `apps/client/src/layers/features/session-list/model/use-task-notifications.ts`      | open Tasks from notification                          | `useTasksDeepLink().open()`                                    |
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`                             | open Mesh                                             | `useMeshDeepLink().open()`                                     |
| `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`                         | programmatic dispatcher used by `control_ui` MCP tool | **special case — see §6.10**                                   |

Tests are not migrated — they continue to mock store methods until those methods are deleted in a follow-up spec.

### 6.10 Special case: `ui-action-dispatcher`

`apps/client/src/layers/shared/lib/ui-action-dispatcher.ts` is consumed by the `control_ui` MCP tool that lets agents open panels in the user's UI. It's a pure function that takes a store reference and dispatches actions:

```ts
// current shape (simplified)
function dispatch(action: UiAction, ctx: { store: AppStoreActions }) {
  switch (action.type) {
    case 'open_panel':
      ctx.store[`set${capitalize(action.panel)}Open`](true);
      break;
    // ...
  }
}
```

Two options for migration:

**A. Keep dispatcher store-based, rely on the dual-signal `RegistryDialog`.**
The dispatcher stays as-is. Agents calling `control_ui` open dialogs via the store. The URL doesn't change, but the dialog still opens (because `RegistryDialog` reads the store). **Acceptable** because agents are programmatic — they don't need the URL to be addressable.

**B. Migrate dispatcher to a navigate-based pattern.**
Inject a `navigate` function into the dispatcher context and dispatch URL navigations. The URL becomes shareable.

**Decision: A.** The dispatcher is invoked in response to MCP tool calls from agents, often headlessly during automation. URL state isn't useful in that context. Keep it store-based and let `RegistryDialog`'s dual-signal handling take care of rendering.

This means `ui-action-dispatcher.ts` and its tests are **unchanged** in this spec.

### 6.11 Migration phases

Per-callsite migrations are mechanical and can be split into focused commits:

| Phase | Files                                                                                                                                      | Commit                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1     | `dialog-search-schema.ts`, `router.tsx`, hook file, `RegistryDialog`, `dialog-contributions.ts`                                            | `feat(routing): URL-driven dialog deep-link infrastructure`     |
| 2     | Settings dialog deep-link sync update                                                                                                      | `feat(settings): consume URL deep-link hook`                    |
| 3     | Agent dialog deep-link sync update                                                                                                         | `feat(agent-settings): consume URL deep-link hook`              |
| 4     | Sub-section scroll: add `data-section` to `external-mcp` and wire `useDeepLinkScroll` in Tools tab                                         | `feat(settings): sub-section deep-link scroll for external-mcp` |
| 5     | Migrate command palette callsites (`use-palette-actions.ts`, `use-global-palette.ts`)                                                      | `refactor(command-palette): use URL deep-link hooks`            |
| 6     | Migrate feature promo dialogs (`Relay/Schedules/AgentChat`)                                                                                | `refactor(feature-promos): use URL deep-link hooks`             |
| 7     | Migrate sidebar/dashboard callsites (`SystemStatusRow`, `ConnectionsView`, `TasksView`, `sidebar-contributions`, `use-task-notifications`) | `refactor(session-list): use URL deep-link hooks`               |
| 8     | Migrate `agent-settings/ChannelsTab.tsx`, `agents-list/AgentRow.tsx`, `mesh/MeshPanel.tsx`                                                 | `refactor(misc): use URL deep-link hooks`                       |
| 9     | Tests + Playwright E2E                                                                                                                     | `test(routing): URL deep-link integration tests`                |

After Phase 9, the `openSettingsToTab` and `openAgentDialogToTab` store actions are unused (verified by grep). They can be deleted in a small follow-up commit. The `*Open` / `set*Open` pairs stay because `RegistryDialog` still reads them.

### 6.12 Files modified

**New files:**

| File                                                                          | Purpose                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------- |
| `apps/client/src/layers/shared/model/dialog-search-schema.ts`                 | Zod schema + `mergeDialogSearch` helper       |
| `apps/client/src/layers/shared/model/use-dialog-deep-link.ts`                 | Five hooks + `useOpenAgentDialog` convenience |
| `apps/client/src/layers/shared/model/use-deep-link-scroll.ts`                 | Sub-section scroll hook                       |
| `apps/client/src/layers/shared/model/__tests__/use-dialog-deep-link.test.tsx` | Hook tests                                    |
| `apps/client/src/layers/shared/model/__tests__/use-deep-link-scroll.test.tsx` | Hook tests                                    |
| `apps/e2e/tests/dialog-deep-link.spec.ts`                                     | Playwright E2E                                |

**Modified files:**

| File                                                                      | Change                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/client/src/router.tsx`                                              | Wrap each route's `validateSearch` with `mergeDialogSearch`     |
| `apps/client/src/layers/shared/model/index.ts`                            | Export new hooks + schema                                       |
| `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx`             | Dual-signal `open` state + `useDialogUrlSignal` helper          |
| `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` | Add `urlParam` to settings/tasks/relay/mesh/agent contributions |
| `apps/client/src/layers/shared/model/extension-registry.ts`               | Add `urlParam` to `DialogContribution` interface                |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`          | Replace `useEffect`-based deep-link sync with URL hook          |
| `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`       | Replace adjust-state-during-render sync with URL hook           |
| `apps/client/src/layers/features/settings/ui/ToolsTab.tsx`                | Add `data-section="external-mcp"` + `useDeepLinkScroll`         |
| ~13 callsite files (per §6.9)                                             | Replace store actions with hook calls                           |

**Deleted (in a follow-up commit, not this spec):**

- `openSettingsToTab` and `openAgentDialogToTab` from `app-store-panels.ts`
- `settingsInitialTab` and `agentDialogInitialTab` fields from the panels slice

These deletions are _not_ in this spec because confirming "no callsites remain" is safer as a separate follow-up.

## 7. User Experience

**Three new affordances** for users:

1. **Shareable links.** Right-click → Copy URL on a Settings dialog now produces a URL that, when opened by anyone else, lands in the same dialog state. Ditto for Agent, Tasks, Relay, Mesh.
2. **Browser back closes the dialog.** Hitting back on desktop or hardware back on mobile closes the dialog and returns to the underlying page. Currently it leaves the page with the dialog still open.
3. **Reload preserves dialog state.** Hitting refresh while looking at Settings → Tools keeps you on Settings → Tools.

**No regressions:**

- In-app open buttons still work (palette, sidebar, promo cards)
- Existing keyboard shortcuts still work
- Existing extension dialogs continue to work
- Existing deep-link callsites are migrated to use URL params, but visually the experience is unchanged

**Discoverability:**

- Add a brief mention to the next changelog: "Settings, Tasks, Relay, Mesh, and Agent dialogs are now URL-addressable. Share `?settings=tools` to deep-link to a teammate."
- Document the URL contract in a new section of `contributing/architecture.md`

## 8. Testing Strategy

### 8.1 Unit tests for hooks

**`use-dialog-deep-link.test.tsx`** — covers:

```ts
describe('useSettingsDeepLink', () => {
  it('returns isOpen=false when no settings param');
  it('returns isOpen=true and activeTab=null when settings=open');
  it('returns isOpen=true and activeTab="tools" when settings=tools');
  it('returns section when settingsSection is set');
  it('open() with no args sets settings=open');
  it('open("tools") sets settings=tools');
  it('open("tools", "external-mcp") sets settings=tools and settingsSection=external-mcp');
  it('close() clears both settings and settingsSection');
  it('setTab() updates settings via replace (no new history entry)');
  it('setSection() updates settingsSection via replace');
});

describe('useAgentDialogDeepLink', () => {
  it('returns isOpen=false when only agent param is set without agentPath');
  it('returns isOpen=true when both agent and agentPath are set');
  it('exposes agentPath');
  it('close() clears both agent and agentPath');
});

describe('useOpenAgentDialog', () => {
  it('navigates with agent and agentPath set');
  it('uses default tab when no tab provided');
});

describe('useTasksDeepLink / useRelayDeepLink / useMeshDeepLink', () => {
  it('opens via param=open');
  it('isOpen reads from corresponding param');
  it('close clears the param');
});
```

Tests use `@testing-library/react` with a `MemoryRouter` (or TanStack's `createMemoryHistory`) to control the URL.

### 8.2 Unit tests for `useDeepLinkScroll`

```ts
describe('useDeepLinkScroll', () => {
  it('does nothing when section is null');
  it('calls scrollIntoView on the matched element');
  it('calls onMatch callback with the section id');
  it('does not throw when no element matches');
  it('re-runs when section changes');
});
```

Mocks `Element.prototype.scrollIntoView` and uses jsdom's querySelector.

### 8.3 Integration test for `RegistryDialog`

```ts
describe('RegistryDialog with urlParam', () => {
  it('opens when URL param is set');
  it('opens when store flag is set');
  it('opens when both are set');
  it('closing the dialog clears both URL and store');
  it('does not read URL when contribution.urlParam is undefined');
});
```

Lives in `apps/client/src/layers/widgets/app-layout/__tests__/DialogHost.test.tsx`.

### 8.4 E2E Playwright test

**File:** `apps/e2e/tests/dialog-deep-link.spec.ts` (NEW)

```ts
test('navigating to ?settings=tools opens Settings to Tools tab', async ({ page }) => {
  await page.goto('/?settings=tools');
  await page.waitForSelector('[data-testid="settings-dialog"]');
  await expect(page.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true');
});

test('navigating to ?settings=tools&settingsSection=external-mcp scrolls into view', async ({
  page,
}) => {
  await page.goto('/?settings=tools&settingsSection=external-mcp');
  await page.waitForSelector('[data-section="external-mcp"]');
  const element = await page.locator('[data-section="external-mcp"]');
  await expect(element).toBeInViewport();
});

test('browser back closes the dialog', async ({ page }) => {
  await page.goto('/');
  await page.goto('/?settings=tools');
  await page.waitForSelector('[data-testid="settings-dialog"]');
  await page.goBack();
  await expect(page.locator('[data-testid="settings-dialog"]')).toBeHidden();
});

test('palette open keeps URL clean (store-based fallback)', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Meta+K');
  await page.getByText('Settings').click();
  await page.waitForSelector('[data-testid="settings-dialog"]');
  // URL should still be `/` because palette uses store-based open... or URL after migration
  // (this test will need adjustment depending on whether palette callsite is migrated in this spec)
});
```

### 8.5 Existing tests

| Test                                                   | Action                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `DialogHost.test.tsx`                                  | Update to mock URL via memory history; new assertions for dual-signal behavior |
| `SettingsDialog.test.tsx`                              | Update mocks for `useSearch`/`useNavigate` since dialog now reads URL          |
| `AgentDialog.test.tsx`                                 | Same                                                                           |
| `command-palette-integration.test.tsx`                 | Verify palette still opens dialogs after migration                             |
| `ChannelsTab.test.tsx` (agent-settings)                | Verify the "switch to settings" link still works                               |
| `SidebarFooterBar.test.tsx`, `SessionSidebar.test.tsx` | Verify sidebar buttons still open dialogs                                      |

## 9. Performance Considerations

**Negligible.**

- TanStack Router's `useSearch` is already used on every route — no new infra
- The dual-signal `RegistryDialog` adds **one** `useSearch` subscription per dialog (5 dialogs × 1 subscription = 5 reads). All five share the same `useSearch` underlying state.
- Hook re-renders are scoped: when `?settings=tools` changes to `?settings=preferences`, only `useSettingsDeepLink` consumers re-render
- `useNavigate({ search: (prev) => ... })` calls a single `history.pushState` per navigation — no extra work
- Browser history grows by 1 entry per dialog open. Acceptable; closing the dialog doesn't add an entry (uses `replace: true` for tab switches)
- No new bundle size — TanStack Router's hook surface is already imported

## 10. Security Considerations

**Mostly none, with two notes:**

1. **`agentPath` in URL is sensitive.** The agent dialog deep link includes the absolute project path (e.g., `?agentPath=/Users/dorian/secret-project`). This is **already** the case for the existing `?dir=` search param on `/session`, so it's not a new exposure. The path is not transmitted to any external server and is only visible in browser history and share URLs. **Decision:** acceptable, but document the privacy implication in the changelog ("Sharing a deep link with `?agentPath=...` includes your local project path").

2. **No injection risk.** All search params are validated by Zod (`z.string().optional()`). The values are used as React state (rendered as text in tab IDs) and as `scrollIntoView` selectors via `data-section="<value>"` attribute selectors. The latter could in principle be a CSS selector injection vector if the value contained `"]` characters — `document.querySelector` would throw. **Mitigation:** sanitize the section value to alphanumeric + dash only:

   ```ts
   const safeSection = section?.replace(/[^a-zA-Z0-9-]/g, '');
   ```

   Apply inside `useDeepLinkScroll`.

3. **No CSRF, no auth changes, no new network calls.** This is purely client-side routing.

## 11. Documentation

- TSDoc on every hook export in `use-dialog-deep-link.ts` and `use-deep-link-scroll.ts`
- TSDoc on `dialogSearchSchema` and `mergeDialogSearch`
- Update `contributing/architecture.md` with a new section "Dialog deep linking via URL search params" describing the dual-signal pattern and the per-dialog hook API
- Update `contributing/state-management.md` to point at the new hooks for cross-page dialog opens (replacing the existing guidance to use `openSettingsToTab` etc.)
- Add a changelog entry: "Settings, Tasks, Relay, Mesh, and Agent dialogs are now URL-addressable via search params. Share links like `?settings=tools` to deep-link teammates."
- Reference the URL params from the upcoming `settings-dialog-04-playground` spec (so the playground demonstrates the feature)
- No user-facing docs change in `docs/` — this is an SPA convention, not a user feature to teach

## 12. Implementation Phases

**Phase 1 — Infrastructure**

1. Create `dialog-search-schema.ts` + `mergeDialogSearch` helper
2. Wrap each route's `validateSearch` in `router.tsx`
3. Verify `pnpm typecheck` still passes (route schema changes)
4. Commit: `feat(routing): add dialog search schema infrastructure`

**Phase 2 — Hooks**

1. Create `use-dialog-deep-link.ts` with all five hooks + `useOpenAgentDialog`
2. Create `use-deep-link-scroll.ts`
3. Add to `shared/model/index.ts` barrel
4. Write unit tests for both files
5. Run `pnpm vitest run apps/client/src/layers/shared/model/__tests__/use-dialog-deep-link`
6. Commit: `feat(routing): add useDialogDeepLink hooks`

**Phase 3 — DialogHost dual-signal**

1. Update `DialogContribution` interface with `urlParam`
2. Update `DIALOG_CONTRIBUTIONS` array
3. Refactor `RegistryDialog` to read both signals
4. Update `DialogHost.test.tsx` with dual-signal cases
5. Run typecheck + tests + visual smoke (open Settings via store, then via URL)
6. Commit: `feat(routing): RegistryDialog reads URL and store signals`

**Phase 4 — Settings + Agent dialog tab sync**

1. Update `SettingsDialog.tsx` to read active tab from `useSettingsDeepLink`
2. Update `AgentDialog.tsx` to read active tab from `useAgentDialogDeepLink`
3. Run tests + visual smoke (deep-link `?settings=tools`, `?agent=identity&agentPath=/abs/path`)
4. Commit: `feat(settings,agent-settings): consume URL deep-link hooks`

**Phase 5 — Sub-section scroll**

1. Add `data-section="external-mcp"` to the External MCP card wrapper in `ToolsTab.tsx`
2. Wire `useDeepLinkScroll` in `ToolsTab.tsx`
3. Test manually: `?settings=tools&settingsSection=external-mcp`
4. Commit: `feat(settings): sub-section deep-link scroll for external-mcp`

**Phase 6 — Callsite migrations** (split into 4 commits per §6.11)

1. Command palette migration
2. Feature promo dialog migrations
3. Sidebar/dashboard migrations
4. Misc migrations (ChannelsTab, AgentRow, MeshPanel)

After each, run typecheck + tests.

**Phase 7 — E2E**

1. Add `dialog-deep-link.spec.ts` Playwright test
2. Run `pnpm browsertest`
3. Commit: `test(routing): add E2E tests for dialog deep linking`

**Phase 8 — Verification gate**

1. `pnpm typecheck` — green
2. `pnpm test -- --run` — green
3. `pnpm lint` — green
4. `pnpm browsertest` — green
5. Manual: copy `?settings=tools` URL into a fresh tab, verify dialog opens
6. Manual: navigate to `/agents`, click Settings in palette, verify URL shows `?settings=open`
7. Manual: open Settings via deep link, hit browser back, verify dialog closes

## 13. Open Questions

**Q1. Per-route merge vs. inheriting from `appShellRoute`?**

Resolved (§6.3): **per-route merge**. Cleaner type ergonomics outweigh the four lines of duplication.

**Q2. Should `useOpenAgentDialog` be the only way to open the agent dialog, or should `useAgentDialogDeepLink().open()` also work?**

Resolved: `useOpenAgentDialog` is the convenience opener (handles `agentPath`), `useAgentDialogDeepLink().open(tab)` exists for in-dialog tab switches when `agentPath` is already set. **Don't expose** an `open()` method on `useAgentDialogDeepLink` that takes only a tab — it would be confusing because `agentPath` is required. **Decision:** rename internal method or document it clearly. Recommendation: keep as documented in §6.4.

**Q3. Should we enforce zod-validated tab IDs?**

Today the schema is `settings: z.string().optional()`. We _could_ tighten to `z.enum([...SETTINGS_TABS, 'open']).optional()`, which would reject invalid deep links at the router level. **Tradeoff:** breaks extension tabs (they use arbitrary string IDs not known at compile time). **Decision:** keep as `z.string().optional()`. Validation happens in the consumer hook (`activeTab` returns `null` for unknown values).

**Q4. Should the dispatcher (`ui-action-dispatcher.ts`) migrate too?**

Resolved (§6.10): **No.** Keep store-based for headless agent control. The dual-signal `RegistryDialog` handles both surfaces.

**Q5. What happens if a route's existing search schema has a key that conflicts with a dialog param?**

Verify by inspection that no existing route has `settings`, `agent`, `tasks`, `relay`, or `mesh` as a search param. **Pre-flight check** during Phase 1: grep `zodValidator` schemas in `router.tsx` for those keys. None should match. If a future route conflicts, it can rename its param.

**Q6. Should `agentPath` be encoded?**

`?agentPath=/Users/dorian/repo` works in modern browsers — `/` and `:` are valid in query string values. But spaces, `?`, and `#` need encoding. TanStack Router's `useNavigate({ search: (prev) => ({ ...prev, agentPath: '/path with spaces' }) })` handles encoding automatically. **No special handling needed.**

**Q7. Should we deep-link to specific _items_ inside Tasks/Relay/Mesh dialogs (e.g., `?tasks=open&taskId=abc123`)?**

**Out of scope** for this spec but a natural follow-up. The schema can be widened later. For now, only the open/close state is URL-addressable for those three dialogs.

**Q8. What about extension-registered dialogs?**

Extensions register dialogs via `extensionApi.registerDialog`. Today they use a synthetic `openStateKey` (`ext-dialog:<id>`) that doesn't exist on the app store, so the existing `RegistryDialog` won't work for them in store-mode either (this is a known limitation). **Out of scope** — extension dialogs are managed by their own open/close handles, not the registry. URL deep-linking for extension dialogs can be added later by extending the schema with a generic `extensionDialog?: string` param.

**Q9. Should `setTab` use `replace: true` always, or only when the tab change is "implicit" (e.g., from a sidebar click vs. external nav)?**

**Always replace.** Tab changes inside an open dialog shouldn't add history entries — back-button should close the whole dialog, not step through tabs. This matches user expectations from settings panels in OS-level apps.

## 14. Related ADRs

- **ADR 0154 — Adopt TanStack Router for Client-Side Routing** (`decisions/0154-adopt-tanstack-router-for-client-routing.md`) — The foundational decision this spec builds on. The ADR explicitly highlights "Type-safe routes and search params — Zod schemas colocated with route definitions" as a key benefit, which is exactly what this spec exercises.
- **ADR 0005 — Zustand for UI state, TanStack Query for server state** (`decisions/0005-zustand-ui-state-tanstack-query-server-state.md`) — Justifies keeping the store-based open/close as a fallback. Dialog open state is UI state.
- **ADR 0008 — Promote shared components for cross-feature reuse** (`decisions/0008-promote-shared-components-for-cross-feature-reuse.md`) — Justifies placing the deep-link hooks in `shared/model`.
- **ADR 0116 — Entity layer Zustand store for cross-feature coordination** (`decisions/0116-entity-layer-zustand-store-for-cross-feature-coordination.md`) — Pattern reference; the panels slice already follows this.

## 15. References

### Internal

- `apps/client/src/router.tsx` — Existing TanStack Router setup with `validateSearch` schemas
- `apps/client/src/layers/shared/model/app-store/app-store-panels.ts` — Current store-based pattern
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — `RegistryDialog` (target of dual-signal refactor)
- `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` — `DIALOG_CONTRIBUTIONS` (target of `urlParam` additions)
- `apps/client/src/layers/shared/model/extension-registry.ts` — `DialogContribution` interface
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Settings consumer
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` — Agent consumer
- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts` — Major callsite group
- `apps/client/src/layers/features/feature-promos/ui/dialogs/*.tsx` — Promo card callsites
- `apps/client/src/dev/DevPlayground.tsx:103-109` — Pattern reference for `scrollToSection` (mirrors `useDeepLinkScroll`)
- `.claude/rules/fsd-layers.md`
- `.claude/rules/documentation.md`
- `.claude/rules/testing.md`

### External

- TanStack Router — Search Params Guide: https://tanstack.com/router/latest/docs/framework/react/guide/search-params
- TanStack Router — Type-Safe Navigation: https://tanstack.com/router/latest/docs/framework/react/guide/navigation
- TanStack Router — `useSearch`: https://tanstack.com/router/latest/docs/framework/react/api/router/useSearchHook
- TanStack Router — `useNavigate`: https://tanstack.com/router/latest/docs/framework/react/api/router/useNavigateHook

### Related specs

- `specs/settings-dialog-01-file-splits/` — Independent prerequisite for cleaner Settings refactor (this spec works without it but the migration is easier)
- `specs/settings-dialog-02-tabbed-primitive/` — Related but independent. `useDialogTabState` from that spec collapses into URL-aware `useDialogDeepLink` once both ship. Either order works; prefer `settings-dialog-02-tabbed-primitive` first so the abstraction lands cleanly.
- `specs/settings-dialog-04-playground/` — Will demonstrate URL deep-linking in the playground
