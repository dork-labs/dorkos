---
slug: agent-channels-tab-01-correctness
number: 217
status: specification
created: 2026-04-06
---

# Agent Dialog → Channels Tab — Correctness & Architecture Cleanup (01 of 03)

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement](#2-problem-statement)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Patterns and Conventions](#5-patterns-and-conventions)
6. [Detailed Design](#6-detailed-design)
7. [Data Flow](#7-data-flow)
8. [User Experience](#8-user-experience)
9. [Implementation Phases](#9-implementation-phases)
10. [Testing Strategy](#10-testing-strategy)
11. [Performance Considerations](#11-performance-considerations)
12. [Security Considerations](#12-security-considerations)
13. [Documentation](#13-documentation)
14. [Open Questions](#14-open-questions)
15. [Related ADRs](#15-related-adrs)
16. [References](#16-references)

---

## 1. Overview

The Channels tab inside `AgentDialog` (`apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`) ships with two user-visible bugs and a set of render-path smells. This spec is a **correctness-only** change that fixes the bugs, consolidates a duplicated filter into a shared hook, and inlines `AdapterSetupWizard` so the user never loses context when configuring a new channel.

Visual redesign (brand icons, humanized copy, explainer text, tab reorder, kebab menu, color semantics) is deferred to a follow-up spec. New functionality (pause/mute, test button, activity metadata) is deferred to a second follow-up spec. This spec only removes what is actively broken and wrong.

**Blast radius:** 5 files modified, 1 file created. Zero schema changes. Zero server changes. Zero public API changes.

**Design decisions locked before spec creation:**

| #   | Decision                       | Choice                                                                                                               |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Catalog filter location        | New shared `useExternalAdapterCatalog()` hook in `@/layers/entities/relay`                                           |
| 2   | "Internal" category comparison | Constant `ADAPTER_CATEGORY_INTERNAL = 'internal'` (no string literals in consumers)                                  |
| 3   | Cross-dialog setup flow        | Inline `AdapterSetupWizard` in agent-settings ChannelsTab (stacked dialog), matching the Settings → Channels pattern |
| 4   | Power-user escape hatch        | Keep a small text link "Manage all channels in Settings →" but no dialog juggling                                    |
| 5   | Picker data source             | ChannelsTab owns the filtered catalog; ChannelPicker receives it as a prop (no double-fetching)                      |
| 6   | Three `resolve*` helpers       | Collapsed into a single `resolveAdapterDisplay(adapterId)` returning `{ state, name, errorMessage }`                 |
| 7   | Settings → Channels            | Refactored in this spec to consume the same shared hook (one source of truth)                                        |
| 8   | Transient adapter states       | No change in this spec; stay normalized to "disconnected" until Spec 02 addresses color semantics                    |

---

## 2. Problem Statement

### 2.1 Bug — "Claude Code" appears in the Connect to Channel picker

The `claude-code` relay adapter is a runtime bridge, not a messaging platform. It is correctly marked `category: 'internal'` in its manifest (`packages/relay/src/adapters/claude-code/claude-code-adapter.ts:56-62`) precisely so the UI can distinguish it from external channels like Telegram and Slack.

The Settings → Channels tab already applies the filter:

```ts
// apps/client/src/layers/features/settings/ui/ChannelsTab.tsx:31-34
// Exclude internal adapters (e.g. claude-code) — they belong on the Agents tab.
const externalCatalog = useMemo(
  () => catalog.filter((entry) => entry.manifest.category !== 'internal'),
  [catalog]
);
```

The **agent-facing** `ChannelsTab` and its `ChannelPicker` do not apply this filter:

- `ChannelsTab.tsx:51-62` builds `adapterStatusByInstanceId` from every catalog entry, including `claude-code`.
- `ChannelPicker.tsx:55-64` builds `configuredChannels` from every catalog entry, again including `claude-code`.

**User impact:** Users see "Claude Code" as a connectable "channel" in the picker, which breaks their mental model of what a channel is. If they click it, they create a binding between their agent and the Claude Code runtime adapter — nonsensical in this context.

**Root cause:** The filter is duplicated as a loose convention rather than a shared abstraction. Any new surface that lists "channels" has to remember to apply it. The agent-facing ChannelsTab is the first place we forgot.

### 2.2 Bug — "Set up a new channel" drops the user out of context

```ts
// apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx:103-107
const handleSetupNewChannel = useCallback(() => {
  // Close the agent dialog, then navigate to Settings → Channels.
  setAgentDialogOpen(false);
  requestAnimationFrame(() => openSettingsToTab('channels'));
}, [setAgentDialogOpen, openSettingsToTab]);
```

The user clicks "Set up a new channel…" inside the AgentDialog's ChannelPicker. The dialog closes. The Settings dialog opens on its Channels tab. The user configures and tests a new adapter. They close the Settings dialog.

**They are now on the main view.** The AgentDialog is gone. They have to re-navigate: sidebar → agent → settings → Channels. Their original intent ("connect this agent to a new channel") has been broken into two disconnected tasks.

The `requestAnimationFrame` wrapping is itself a symptom: closing one Radix dialog and opening another in the same synchronous tick breaks focus management. The fact that we needed it indicates the state choreography is wrong.

**The correct pattern is already in the codebase.** Settings → Channels opens `AdapterSetupWizard` directly as a dialog on top of itself (`features/settings/ui/ChannelsTab.tsx:144-154`). When the wizard closes, the user is still on the Channels tab of the Settings dialog. We should apply the same pattern to the agent-facing ChannelsTab: open `AdapterSetupWizard` directly on top of `AgentDialog`.

### 2.3 Code smells — render-path inefficiencies and stale deps

- `ChannelsTab.tsx:51-62` — `adapterStatusByInstanceId` is a `Map` reconstructed on every render. Not expensive in isolation, but it invalidates the identity of every downstream callback.
- `ChannelsTab.tsx:109-119` — `handleEdit`'s `useCallback` dep list contains `catalog` (not directly used inside the callback; only used to derive the Map) and `adapterStatusByInstanceId` (which changes identity every render). Both make the `useCallback` a no-op.
- `ChannelsTab.tsx:66-81` — three separate accessor functions (`resolveAdapterState`, `resolveAdapterName`, `resolveErrorMessage`) each perform a `Map.get` into the same Map for the same `adapterId`. Every binding render triggers three lookups when one would do.
- `ChannelPicker.tsx:52` — calls `useAdapterCatalog()` independently of `ChannelsTab`, which also fetches it. TanStack Query deduplicates the network request, but it is still a second subscription and — more importantly — a second place where the category filter must be applied, which is exactly how the Claude Code bug was born.

---

## 3. Goals

1. Eliminate "Claude Code" (and any other `category: 'internal'` adapter) from the agent-facing Connect to Channel picker.
2. Prevent regression of the filter bug by making "external adapters only" a single hook call, with a typed constant for the category name.
3. Keep the user inside `AgentDialog` throughout the full flow of discovering, configuring, and binding a new channel.
4. Remove the `requestAnimationFrame` + `setAgentDialogOpen(false)` + `openSettingsToTab` state-juggling.
5. Consolidate the filter logic used by Settings → Channels into the same shared hook (no duplication).
6. Clean up hot-path rendering smells in `ChannelsTab.tsx` (memoize the Map, collapse the three accessors, fix `handleEdit` deps) without changing visible behavior.

---

## 4. Non-Goals

The following are explicitly out of scope and belong to downstream specs:

- **Visual redesign:** card layout changes, brand icons in the picker/cards, humanized `sessionStrategy`/`chatId` labels, permission summary pills, kebab menu replacing hover actions, empty-state redesign, explainer copy, panel-header subtitle. All deferred to Spec 02 ("Channels tab polish").
- **Tab reorder:** moving Channels to position 2 in the AgentDialog sidebar. Spec 02.
- **Color semantics:** amber → gray for "disconnected", reclaiming amber for transient states. Spec 02.
- **Transient state surfacing:** showing `reconnecting` / `starting` distinctly. Spec 02.
- **New functionality:** pause/mute, test button, last-activity metadata, per-binding budget warnings. Spec 03 ("Channels tab functionality").
- **Schema changes:** `AdapterBinding`, `AdapterManifest`, and `CatalogEntry` remain untouched.
- **Server-side changes:** `AdapterManager.getCatalog()` remains untouched. All fixes are client-side.
- **`BindingDialog` changes:** reused as-is in edit mode.
- **`ChannelBindingCard` visual changes:** no edits to this file in this spec.

---

## 5. Patterns and Conventions

The following existing patterns directly inform the implementation.

**Entity hooks with query wrappers** (`apps/client/src/layers/entities/relay/model/use-adapter-catalog.ts:20-28`)
The `useAdapterCatalog` hook uses `useQuery` with a stable query key and a `refetchInterval`. Derived hooks layered on top must not re-subscribe — they should consume the original query result and transform it with `useMemo`, preserving the 30s refetch interval and the query key identity.

**Memoized derived state from a TanStack query** (`apps/client/src/layers/features/settings/ui/ChannelsTab.tsx:31-34`)
The canonical pattern for deriving a filtered view from a catalog is `useMemo(() => data?.filter(...) ?? [], [data])`. The derived hook must follow this shape exactly so memoization semantics carry over.

**Shared constants for string-based enum values** (`.claude/rules/code-quality.md` — "stringly-typed code" smell)
String literals used in multiple call sites should live in a typed constant. For this spec: `ADAPTER_CATEGORY_INTERNAL: AdapterCategory = 'internal'`.

**Inline wizard dialog stacking** (`apps/client/src/layers/features/settings/ui/ChannelsTab.tsx:93-154`)
`AdapterSetupWizard` is a self-contained `Dialog` that can be opened as a child of any parent dialog. The Settings → Channels tab hoists `wizardState: { open, manifest, instanceId }` to the parent component and opens the wizard in place. On success, query invalidation inside the wizard causes the parent's catalog view to update automatically.

**FSD cross-feature UI composition** (`.claude/rules/fsd-layers.md`)
Feature-to-feature UI composition is allowed. `features/agent-settings` already imports from `features/relay` (`agent-settings/ui/SubsystemRow.tsx:3` imports `RelativeTime` from `@/layers/features/relay`). Importing `AdapterSetupWizard` and `AdapterIcon` from the same barrel is permitted. Model/hook cross-imports between sibling features remain forbidden — verify we are only importing the wizard component, not any of its internal hooks.

**Popover → nested dialog interaction** (`apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx:77-131`)
The Popover closes before the dialog opens. We follow the same pattern: `handleSelectChannel` / `handleSetupNewChannel` call `setOpen(false)` on the popover _before_ delegating to the parent, and the parent opens the wizard dialog on the next frame naturally (no rAF hack needed because the popover is a non-modal layer — Radix handles the focus transfer cleanly when the dialog opens after the popover closes).

**Barrel exports from `entities/*`** (`apps/client/src/layers/entities/relay/index.ts`)
New hooks are exported from the entity module's `index.ts` barrel. Consumers must never reach into `/model/*` subpaths (`.claude/rules/fsd-layers.md` — "Always Import from index.ts").

---

## 6. Detailed Design

### 6.1 New shared hook — `useExternalAdapterCatalog`

**File:** `apps/client/src/layers/entities/relay/model/use-external-adapter-catalog.ts` _(new)_

```ts
import { useMemo } from 'react';
import type { AdapterCategory, CatalogEntry } from '@dorkos/shared/relay-schemas';
import { useAdapterCatalog } from './use-adapter-catalog';

/**
 * The `internal` adapter category identifies runtime-bridge adapters
 * (e.g., `claude-code`) that must never surface in channel pickers.
 */
export const ADAPTER_CATEGORY_INTERNAL: AdapterCategory = 'internal';

/**
 * Adapter catalog with `category: 'internal'` entries filtered out.
 *
 * Use this hook instead of {@link useAdapterCatalog} in any UI surface
 * that presents adapters as "channels" to the user. Runtime-bridge
 * adapters (the `claude-code` adapter is the canonical example) belong
 * on the Agents surface, not the Channels surface.
 *
 * The underlying query is shared with `useAdapterCatalog` via TanStack
 * Query's cache, so no additional network request is issued.
 *
 * @param enabled - When false, the query is skipped entirely (Relay feature gate).
 */
export function useExternalAdapterCatalog(enabled = true) {
  const query = useAdapterCatalog(enabled);
  const data = useMemo<CatalogEntry[]>(
    () =>
      query.data?.filter((entry) => entry.manifest.category !== ADAPTER_CATEGORY_INTERNAL) ?? [],
    [query.data]
  );
  return { ...query, data };
}
```

**Key properties:**

- Returns the same shape as `useAdapterCatalog` (`UseQueryResult<CatalogEntry[]>`). Consumers can drop-in replace.
- Preserves `refetchInterval`, `enabled`, and cache semantics because it composes rather than re-subscribes.
- `data` is always a stable reference for a given `query.data` reference (memoized on identity).
- `ADAPTER_CATEGORY_INTERNAL` is a typed constant so any future `manifest.category` change to a non-string literal union fails at compile time.

**File:** `apps/client/src/layers/entities/relay/index.ts` _(modified)_

Add the export next to `useAdapterCatalog`:

```ts
export {
  useAdapterCatalog,
  useAddAdapter,
  useRemoveAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from './model/use-adapter-catalog';
export {
  useExternalAdapterCatalog,
  ADAPTER_CATEGORY_INTERNAL,
} from './model/use-external-adapter-catalog';
```

### 6.2 `ChannelsTab.tsx` (agent-settings) — consolidated

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx` _(modified)_

Changes:

1. Swap `useAdapterCatalog` → `useExternalAdapterCatalog`.
2. Memoize `adapterStatusByInstanceId` with `useMemo` keyed on `catalog`.
3. Collapse the three `resolve*` helpers into one `resolveAdapterDisplay(adapterId)` returning `{ state, name, errorMessage }`.
4. Hoist `wizardState: { open: boolean; manifest?: AdapterManifest }` to this component.
5. Remove `handleSetupNewChannel`, `setAgentDialogOpen`, `openSettingsToTab`, and the `useAppStore` import (we no longer need panel state).
6. Pass the filtered catalog to `ChannelPicker` as a prop.
7. Add a new `handleRequestSetup(manifest)` callback that sets `wizardState` and triggers the wizard dialog.
8. Render `<AdapterSetupWizard>` inline at the bottom of the component, mirroring Settings → Channels.
9. Drop `catalog` from `handleEdit`'s dep list.

**New component shape:**

```tsx
import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  useBindings,
  useCreateBinding,
  useDeleteBinding,
  useUpdateBinding,
} from '@/layers/entities/binding';
import { useExternalAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import { BindingDialog, type BindingFormValues } from '@/layers/features/mesh/ui/BindingDialog';
import { AdapterSetupWizard } from '@/layers/features/relay';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding, AdapterManifest } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard } from './ChannelBindingCard';
import { ChannelPicker } from './ChannelPicker';

interface ChannelsTabProps {
  /** The agent whose channel bindings are displayed and managed. */
  agent: AgentManifest;
}

/** Display fields derived from a catalog entry for a bound adapter instance. */
interface AdapterDisplay {
  state: 'connected' | 'disconnected' | 'error';
  name: string;
  errorMessage?: string;
}

interface EditDialogState {
  open: boolean;
  binding: AdapterBinding | null;
  adapterName: string;
}

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
}

const CLOSED_EDIT_DIALOG: EditDialogState = { open: false, binding: null, adapterName: '' };
const CLOSED_WIZARD: WizardState = { open: false };

export function ChannelsTab({ agent }: ChannelsTabProps) {
  const relayEnabled = useRelayEnabled();
  const { data: allBindings = [] } = useBindings();
  const { data: externalCatalog = [] } = useExternalAdapterCatalog(relayEnabled);
  const createBinding = useCreateBinding();
  const deleteBinding = useDeleteBinding();
  const updateBinding = useUpdateBinding();

  const [editDialog, setEditDialog] = useState<EditDialogState>(CLOSED_EDIT_DIALOG);
  const [wizardState, setWizardState] = useState<WizardState>(CLOSED_WIZARD);

  const agentBindings = allBindings.filter((b) => b.agentId === agent.id);

  const adapterDisplayByInstanceId = useMemo(() => {
    const map = new Map<string, AdapterDisplay>();
    for (const entry of externalCatalog) {
      for (const inst of entry.instances) {
        const raw = inst.status.state;
        const state: AdapterDisplay['state'] =
          raw === 'connected' || raw === 'error' ? raw : 'disconnected';
        map.set(inst.id, {
          state,
          name: inst.status.displayName ?? entry.manifest.displayName,
          errorMessage: inst.status.lastError ?? undefined,
        });
      }
    }
    return map;
  }, [externalCatalog]);

  const resolveAdapterDisplay = useCallback(
    (adapterId: string): AdapterDisplay =>
      adapterDisplayByInstanceId.get(adapterId) ?? { state: 'disconnected', name: adapterId },
    [adapterDisplayByInstanceId]
  );

  const boundAdapterIds = useMemo(
    () => new Set(agentBindings.map((b) => b.adapterId)),
    [agentBindings]
  );

  const handleSelectChannel = useCallback(
    async (adapterId: string) => {
      try {
        await createBinding.mutateAsync({
          adapterId,
          agentId: agent.id,
          sessionStrategy: 'per-chat',
          label: '',
          canInitiate: false,
          canReply: true,
          canReceive: true,
        });
        toast.success('Channel connected');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to connect channel');
      }
    },
    [agent.id, createBinding]
  );

  const handleRequestSetup = useCallback((manifest: AdapterManifest) => {
    setWizardState({ open: true, manifest });
  }, []);

  const handleEdit = useCallback(
    (binding: AdapterBinding) => {
      setEditDialog({
        open: true,
        binding,
        adapterName: resolveAdapterDisplay(binding.adapterId).name,
      });
    },
    [resolveAdapterDisplay]
  );

  const handleRemove = useCallback(
    async (bindingId: string) => {
      try {
        await deleteBinding.mutateAsync(bindingId);
        toast.success('Channel removed');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove channel');
      }
    },
    [deleteBinding]
  );

  const handleEditConfirm = useCallback(
    async (values: BindingFormValues) => {
      if (!editDialog.binding) return;
      try {
        await updateBinding.mutateAsync({
          id: editDialog.binding.id,
          updates: {
            sessionStrategy: values.sessionStrategy,
            label: values.label,
            chatId: values.chatId,
            channelType: values.channelType,
            canInitiate: values.canInitiate,
            canReply: values.canReply,
            canReceive: values.canReceive,
          },
        });
        toast.success('Binding updated');
        setEditDialog(CLOSED_EDIT_DIALOG);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update binding');
      }
    },
    [editDialog.binding, updateBinding]
  );

  const handleEditDelete = useCallback(
    async (bindingId: string) => {
      try {
        await deleteBinding.mutateAsync(bindingId);
        toast.success('Channel removed');
        setEditDialog(CLOSED_EDIT_DIALOG);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove channel');
      }
    },
    [deleteBinding]
  );

  return (
    <div className="space-y-4">
      {/* Binding list */}
      {agentBindings.length > 0 ? (
        <div className="space-y-2">
          {agentBindings.map((binding) => {
            const display = resolveAdapterDisplay(binding.adapterId);
            return (
              <ChannelBindingCard
                key={binding.id}
                binding={binding}
                channelName={display.name}
                adapterState={display.state}
                errorMessage={display.errorMessage}
                onEdit={() => handleEdit(binding)}
                onRemove={() => handleRemove(binding.id)}
              />
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground py-2 text-sm">
          {relayEnabled ? 'No channels connected.' : 'Relay is not enabled.'}
        </p>
      )}

      {/* Add channel picker */}
      <ChannelPicker
        catalog={externalCatalog}
        boundAdapterIds={boundAdapterIds}
        onSelectChannel={handleSelectChannel}
        onRequestSetup={handleRequestSetup}
        disabled={!relayEnabled || createBinding.isPending}
      />

      {/* Edit binding dialog */}
      {editDialog.binding && (
        <BindingDialog
          open={editDialog.open}
          onOpenChange={(open) => {
            if (!open) setEditDialog(CLOSED_EDIT_DIALOG);
          }}
          mode="edit"
          initialValues={{
            adapterId: editDialog.binding.adapterId,
            agentId: editDialog.binding.agentId,
            sessionStrategy: editDialog.binding.sessionStrategy,
            label: editDialog.binding.label,
            chatId: editDialog.binding.chatId,
            channelType: editDialog.binding.channelType,
            canInitiate: editDialog.binding.canInitiate,
            canReply: editDialog.binding.canReply,
            canReceive: editDialog.binding.canReceive,
          }}
          adapterName={editDialog.adapterName}
          agentName={agent.name}
          bindingId={editDialog.binding.id}
          onConfirm={handleEditConfirm}
          onDelete={handleEditDelete}
          isPending={updateBinding.isPending || deleteBinding.isPending}
        />
      )}

      {/* Inline setup wizard — opens on top of the AgentDialog */}
      {wizardState.manifest && (
        <AdapterSetupWizard
          open={wizardState.open}
          onOpenChange={(open) => {
            if (!open) setWizardState(CLOSED_WIZARD);
          }}
          manifest={wizardState.manifest}
          existingAdapterIds={externalCatalog.flatMap((e) => e.instances.map((i) => i.id))}
        />
      )}
    </div>
  );
}
```

**Removals:**

- `import { useAppStore } from '@/layers/shared/model';`
- `import { useAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';` → replaced
- `handleSetupNewChannel` callback (deleted entirely)
- `setAgentDialogOpen` and `openSettingsToTab` destructuring from `useAppStore`
- `resolveAdapterState`, `resolveAdapterName`, `resolveErrorMessage` (deleted, replaced by `resolveAdapterDisplay`)
- Unmemoized `adapterStatusByInstanceId` `Map` construction
- The `requestAnimationFrame(() => openSettingsToTab('channels'))` line

### 6.3 `ChannelPicker.tsx` — dumber component

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx` _(modified)_

Changes:

1. Receive `catalog: CatalogEntry[]` as a prop instead of calling `useAdapterCatalog()` directly.
2. Receive `onRequestSetup(manifest: AdapterManifest)` instead of `onSetupNewChannel()`.
3. Add a secondary "Available to set up" section inside the popover that lists manifests for entries with `!deprecated && (instances.length === 0 || multiInstance)`. Clicking a manifest calls `onRequestSetup(manifest)` and closes the popover.
4. Replace the footer "Set up a new channel…" action with a lightweight text link "Manage all channels in Settings →" that is purely informational — it is a plain anchor that uses `openSettingsToTab` from the store **only** as a non-critical convenience (preserving the existing power-user escape hatch without the state-juggling). **Alternative:** omit the link entirely since the user can always reach Settings from the nav. **Chosen:** omit the link — the picker's primary affordance now covers both configured and unconfigured adapters, and a secondary link would clutter a screen we are explicitly trying to simplify.
5. Delete the `useRelayEnabled` / `useAdapterCatalog` imports — the component becomes a pure presentation component.

**New component signature:**

```tsx
interface ChannelPickerProps {
  /** Pre-filtered external adapter catalog (no `category: 'internal'` entries). */
  catalog: CatalogEntry[];
  /** Adapter IDs already bound to this agent (shown as "connected" in the picker). */
  boundAdapterIds: Set<string>;
  /** Called when the user selects an existing adapter instance to bind. */
  onSelectChannel: (adapterId: string) => void;
  /** Called when the user picks an adapter type to configure from scratch. */
  onRequestSetup: (manifest: AdapterManifest) => void;
  /** Whether the popover trigger button is disabled. */
  disabled?: boolean;
}
```

**Popover structure:**

```
┌─ Connect to Channel ─────────────┐
│ [CONFIGURED]                     │
│ ● Telegram — Dev chat  connected │
│ ● Telegram — Support   connected │
│ ● Slack — #general     error     │
│                                  │
│ ── Available to set up ────────  │
│ + Webhook                         │
│ + Telegram (new instance)         │
└──────────────────────────────────┘
```

The "Available to set up" section is rendered only when at least one qualifying manifest exists. A simple `<div className="border-t" />` separates the sections. When both sections are empty, the popover shows "No channels available — install a relay adapter plugin to get started" (terminal state; user must install a plugin or enable built-in relay adapters — no actionable button, same UX as today's "No channels configured" message).

### 6.4 `ChannelsTab.tsx` (settings) — shared hook adoption

**File:** `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx` _(modified)_

Change only one thing: replace the inline `useMemo` filter with the shared hook.

```diff
- import { useAdapterCatalog, useToggleAdapter } from '@/layers/entities/relay';
- import { useRelayEnabled } from '@/layers/entities/relay';
+ import {
+   useExternalAdapterCatalog,
+   useRelayEnabled,
+   useToggleAdapter,
+ } from '@/layers/entities/relay';
...
-   const { data: catalog = [], isLoading } = useAdapterCatalog(relayEnabled);
+   const { data: externalCatalog = [], isLoading } = useExternalAdapterCatalog(relayEnabled);
...
-   // Exclude internal adapters (e.g. claude-code) — they belong on the Agents tab.
-   const externalCatalog = useMemo(
-     () => catalog.filter((entry) => entry.manifest.category !== 'internal'),
-     [catalog]
-   );
```

The rest of this file is unchanged — `externalCatalog` keeps the same name, so the downstream code (which already uses `externalCatalog`) requires no modifications.

### 6.5 Files summary

| File                                                                               | Change                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/client/src/layers/entities/relay/model/use-external-adapter-catalog.ts`      | **Create.** Export `useExternalAdapterCatalog` and `ADAPTER_CATEGORY_INTERNAL`.                                    |
| `apps/client/src/layers/entities/relay/index.ts`                                   | Add exports.                                                                                                       |
| `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`                | Swap hook, hoist wizard state, memoize Map, collapse accessors, drop cross-dialog flow.                            |
| `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`              | Accept filtered catalog + setup callback as props; render "Available to set up" section; remove internal fetching. |
| `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx`                      | Replace inline filter with shared hook.                                                                            |
| `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx` | Update mocks, add filter assertion, add inline-wizard flow assertion.                                              |

No new barrels, no config changes, no server touches.

---

## 7. Data Flow

**Connect existing channel (unchanged by this spec):**

```
User clicks "Connect to Channel"
  → ChannelPicker popover opens
  → User clicks a configured instance
  → handleSelectChannel(adapterId)
  → useCreateBinding.mutateAsync(...)
  → Server: POST /api/bindings
  → Query invalidation
  → ChannelsTab re-renders with new binding card
```

**Set up new channel from agent context (NEW flow):**

```
User clicks "Connect to Channel"
  → ChannelPicker popover opens
  → User scrolls to "Available to set up" section
  → User clicks a manifest (e.g. Webhook)
  → Popover closes, onRequestSetup(manifest) fires
  → ChannelsTab sets wizardState = { open: true, manifest }
  → AdapterSetupWizard renders as stacked dialog ON TOP of AgentDialog
  → User completes wizard (Configure → Test → Confirm → Bind steps)
  → Wizard calls useAddAdapter internally, invalidates catalog query
  → User closes wizard → wizardState reset to CLOSED_WIZARD
  → ChannelsTab is still mounted — its catalog query already updated
  → New instance is now visible in the ChannelPicker
  → User opens the picker again and binds to it (or the wizard's BindStep already bound it)
```

**Critical property:** at every step, the AgentDialog remains open and the ChannelsTab remains the active tab. The user's context is preserved end-to-end.

**Catalog filtering (NEW):**

```
Server: GET /api/relay/adapters/catalog → [all manifests + instances, incl. claude-code]
  → useAdapterCatalog() — raw data
  → useExternalAdapterCatalog() — filtered, memoized
  → Settings → Channels consumes filtered
  → Agent → Channels consumes filtered
  → ChannelPicker consumes the same filtered data via prop
```

There is exactly **one** `useQuery` subscription (TanStack Query deduplicates since the wrapper calls `useAdapterCatalog`). There is exactly **one** filter location. There is exactly **one** "what is an internal adapter?" constant.

---

## 8. User Experience

### 8.1 The bug disappears

Before: User clicks "Connect to Channel" → sees "Claude Code" listed → confusion.
After: User clicks "Connect to Channel" → only actual messaging channels are listed.

### 8.2 Setting up a new channel stays in place

Before: User clicks "Set up a new channel…" → AgentDialog closes → Settings dialog opens → user configures → closes Settings → lost.
After: User clicks an "Available to set up" item → wizard opens over AgentDialog → user configures → wizard closes → user is back in the ChannelsTab with the new channel visible.

### 8.3 No visual changes

Every other aspect of the tab looks identical to today. The binding cards, the status dots, the edit flow, the remove confirmation, the empty state text — all unchanged. This is intentional. The visual pass is Spec 02 and deserves its own design attention.

### 8.4 Picker popover re-organization

The ChannelPicker popover now has two sections instead of one. This is a small interaction change, but one that brings it in line with how "pickers with an add action" work in Linear, Slack's channel browser, and GitHub's repo picker (configured items on top, a divider, "create new" below). Users who want to add a channel never leave the popover to hunt for a separate button.

---

## 9. Implementation Phases

This spec is small enough to ship as a single phase. The steps below are the implementation order, not separate phases.

1. **Create `useExternalAdapterCatalog` hook + constant.** Add the file, add the export, add a unit test for the memoization behavior and the filter.
2. **Update Settings → Channels to use the shared hook.** Verify existing tests pass unchanged. This is a safety net — it proves the new hook has identical behavior to the inline filter it replaces.
3. **Update `ChannelPicker` to accept the catalog and setup callback as props.** Update the popover structure to include the "Available to set up" section. Remove `useAdapterCatalog` and `useRelayEnabled` imports.
4. **Update agent-settings `ChannelsTab`.** Swap the hook, hoist wizard state, memoize the Map, collapse the accessors, delete the cross-dialog callback and its store imports, render `AdapterSetupWizard` inline.
5. **Update tests.** Add assertions for the filter, for the wizard-open flow, and for the absence of cross-dialog navigation.
6. **Run typecheck, lint, and the full client test suite.**
7. **Manual smoke test** — open agent dialog, switch to Channels tab, verify Claude Code is not listed, click an "Available to set up" item, verify wizard opens on top, complete wizard, verify return to tab with new instance visible.

---

## 10. Testing Strategy

### 10.1 New unit test — `use-external-adapter-catalog.test.ts`

**File:** `apps/client/src/layers/entities/relay/model/__tests__/use-external-adapter-catalog.test.ts` _(new)_

Three tests, each with a purpose comment:

```ts
/**
 * Verifies the hook strips `category: 'internal'` entries from the catalog.
 * This test is the primary regression guard for the Claude Code bug —
 * if anyone removes or weakens the filter, it will fail.
 */
it('filters out adapters with category: internal', () => { ... });

/**
 * Verifies that `data` keeps a stable reference when the underlying query
 * data does not change. This guards against re-render storms if a consumer
 * passes `data` into a `useEffect` dep list or a child component prop.
 */
it('returns a stable data reference when query data is unchanged', () => { ... });

/**
 * Verifies that when the Relay feature is disabled, the hook returns an
 * empty catalog and does not trigger a network request. This guards the
 * "Relay off" code path that ChannelsTab relies on for its empty state.
 */
it('returns empty data when disabled', () => { ... });
```

Use `renderHook` from `@testing-library/react` with a `QueryClientProvider` wrapper. Mock `useTransport` via the existing `TransportProvider` pattern from `.claude/rules/testing.md`.

### 10.2 Updated test — `ChannelsTab.test.tsx` (agent-settings)

**File:** `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx` _(modified)_

Update the existing test mocks: the component now imports `useExternalAdapterCatalog` instead of `useAdapterCatalog`. The mock factory must be renamed and the test fixtures must provide a pre-filtered catalog (which is trivially the same as the full catalog with any `internal`-category fixtures removed).

Add three new tests:

```ts
/**
 * Verifies that `claude-code` / internal-category adapters never appear in the
 * bound-adapter Map, even if the mocked catalog contains them. This is the
 * end-to-end regression guard — the previous test file exercised the
 * component, not the filter, so the bug slipped through before.
 */
it('never surfaces internal-category adapters in the picker or binding list', () => { ... });

/**
 * Verifies that clicking an "Available to set up" item opens the
 * AdapterSetupWizard without closing the AgentDialog. The mock wizard
 * renders a sentinel testid when open; we assert the AgentDialog's
 * testid is still present after the wizard opens.
 */
it('opens AdapterSetupWizard inline without closing the AgentDialog', () => { ... });

/**
 * Verifies that ChannelsTab no longer calls `setAgentDialogOpen` or
 * `openSettingsToTab`. This is a defensive test — it protects against
 * accidental reintroduction of the cross-dialog flow.
 */
it('does not dispatch cross-dialog navigation when setting up a new channel', () => { ... });
```

The existing test that mocks `setAgentDialogOpen` and `openSettingsToTab` should be **deleted**, since those store functions are no longer called by this component.

**Mock `AdapterSetupWizard`** similarly to how `BindingDialog` is mocked in the existing test file:

```ts
vi.mock('@/layers/features/relay', () => ({
  AdapterSetupWizard: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div data-testid="adapter-setup-wizard">
        <button onClick={() => onOpenChange(false)}>Close</button>
      </div>
    ) : null,
}));
```

### 10.3 Updated test — `ChannelsTab.test.tsx` (settings)

**File:** `apps/client/src/layers/features/settings/ui/__tests__/ChannelsTab.test.tsx` _(modified)_

Update the mock for `@/layers/entities/relay` to provide `useExternalAdapterCatalog` instead of a raw `useAdapterCatalog` + inline filter. The existing test fixtures already produce an externally-filtered catalog implicitly; confirm all existing assertions still pass. No new tests required — this file's scope is "Settings Channels correctly lists available and configured channels," which remains unchanged.

### 10.4 Full suite

Run `pnpm vitest run apps/client` as a final check. No integration tests or E2E tests are added — the acceptance criteria are all checkable at the unit-test level, and the manual smoke test covers the dialog-stacking visual verification that tests cannot easily assert.

### 10.5 Manual verification checklist

Before marking the PR ready:

1. Open DorkOS dev → open any agent → open Agent Dialog → switch to Channels.
2. Click "Connect to Channel." Confirm **Claude Code is not in the list**.
3. If the catalog has any unconfigured external adapter (e.g., Webhook), confirm the "Available to set up" section renders with it.
4. Click one of the "Available to set up" items. Confirm:
   - The popover closes.
   - `AdapterSetupWizard` opens **on top of** the AgentDialog (both are visible; the AgentDialog dims).
   - The wizard is fully interactive (focus works, escape works, backdrop click works).
5. Complete or cancel the wizard. Confirm:
   - The wizard closes cleanly.
   - The AgentDialog is still open on the Channels tab.
   - If a new instance was created, it appears in the picker on the next open.
6. Bind an existing channel. Confirm the toast and new card.
7. Edit a binding. Confirm the existing `BindingDialog` flow still works.
8. Remove a binding. Confirm the confirmation dialog still works.
9. Open Settings → Channels. Confirm it still renders all external channels correctly and excludes `claude-code`. Confirm the setup wizard flow there still works.
10. Run `pnpm typecheck`, `pnpm lint`, and `pnpm vitest run apps/client`.

---

## 11. Performance Considerations

- **No additional network requests.** The new `useExternalAdapterCatalog` composes `useAdapterCatalog`, so TanStack Query deduplicates the underlying query by key. The component tree ends up with one subscription and one derived memo, regardless of how many places call the filtered hook.
- **Memoizing `adapterStatusByInstanceId` eliminates per-render Map construction.** For an agent with `N` bindings and a catalog of `M` instances, the previous code did `O(M)` Map construction work on every render. The new code does it once per catalog update (every 30 seconds under steady state, or on-demand on binding create/update).
- **Collapsing the three accessors reduces Map lookups per binding card from 3 to 1.** With 10-20 bindings (Kai's target), that is 20-40 fewer lookups per render.
- **Dialog stacking has no measurable cost.** Radix/basecn handle `AdapterSetupWizard` as an independent portal; the AgentDialog is simply in the background. The browser's paint cost is negligible.

---

## 12. Security Considerations

No security surface changes. This spec:

- Does not modify authentication, authorization, or any server-side validation.
- Does not change what data is sent to or from the server.
- Does not introduce new trust boundaries.
- Does not affect the binding permission model (`canInitiate`, `canReply`, `canReceive` — see ADR-0131).

The one nuance worth noting: filtering out `category: 'internal'` adapters at the UI layer is a **UX concern, not a security boundary**. The server already refuses to create bindings between agents and internal adapters where it matters (the `claude-code` adapter is single-instance and self-configures). The filter simply prevents users from seeing nonsensical options — it is not a permission check, and must not be relied upon as one by any future code.

---

## 13. Documentation

- **TSDoc on `useExternalAdapterCatalog`**: module-level doc explaining why the hook exists and when to use it instead of `useAdapterCatalog`. Required by `eslint-plugin-jsdoc` for exported functions.
- **TSDoc on `ADAPTER_CATEGORY_INTERNAL`**: one-line explanation of what "internal" means in the category taxonomy.
- **No changes to `contributing/` guides.** The relevant guide (`contributing/architecture.md` or `contributing/design-system.md`) does not currently document the channel picker pattern, and extending it is out of scope for a correctness-only spec.
- **No changes to `docs/`** (external user docs). User-visible behavior stays the same except for the bug disappearing; there is nothing new to document.
- **No ADR** is required. The "share filter as hook" decision is small enough to live in this spec; the "inline wizard over cross-dialog navigation" decision is consistent with the existing Settings → Channels pattern and creates no new precedent.

---

## 14. Open Questions

None. All decisions were locked before spec creation:

1. Catalog filter location → new shared hook in `entities/relay`.
2. "Internal" category string → typed constant.
3. Cross-dialog flow → inline the wizard, delete the store juggling.
4. Power-user escape hatch → omit entirely; the picker's two sections cover the need.
5. Picker data source → prop, not internal fetch.
6. Three `resolve*` helpers → single `resolveAdapterDisplay`.
7. Settings → Channels → refactor to use the shared hook in this spec.
8. Transient adapter states → no change in this spec; deferred to Spec 02.

If any of these turn out to be wrong during implementation, stop and re-discuss rather than working around them.

---

## 15. Related ADRs

- **ADR-0044 (Adapter Metadata Contract)** — Adapters self-declare a manifest including `category`. This spec depends on that contract; without `manifest.category`, the filter would have nothing to match on.
- **ADR-0046 (Central Binding Router for Adapter-Agent Routing)** — The server-side binding router, which is not touched but whose abstraction makes the UI-only fix safe.
- **ADR-0047 (Binding Resolution Algorithm)** — Referenced by ADR-0131 for how bindings resolve; unchanged by this spec.
- **ADR-0130 (Derive Binding CWD from Agent Registry)** — Confirms bindings are the source of truth for agent-adapter routing; no changes needed here.
- **ADR-0131 (Binding-Level Permissions Over Adapter-Level)** — Establishes that `canInitiate` / `canReply` / `canReceive` live on the binding. This spec's `handleSelectChannel` continues to supply the conservative defaults (`canInitiate: false`, `canReply: true`, `canReceive: true`) when creating bindings.
- **ADR-0132 (Two-Tab Information Architecture for Relay Panel)** — Confirms that channels and bindings have distinct primary surfaces; the Claude Code bug is a violation of this same principle in a different context.
- **ADR-0135 (Binding-Level Permission Mode)** — Referenced but unchanged.

No new ADR is created by this spec.

---

## 16. References

**Source files directly modified:**

- `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`
- `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`
- `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx`
- `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx`
- `apps/client/src/layers/entities/relay/index.ts`

**Source files created:**

- `apps/client/src/layers/entities/relay/model/use-external-adapter-catalog.ts`
- `apps/client/src/layers/entities/relay/model/__tests__/use-external-adapter-catalog.test.ts`

**Source files read but not modified (reference patterns):**

- `apps/client/src/layers/entities/relay/model/use-adapter-catalog.ts` (query shape)
- `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx` (wizard inline pattern, filter pattern)
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx` (dialog component)
- `apps/client/src/layers/features/relay/index.ts` (barrel export)
- `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx` (unchanged consumer)
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx` (unchanged edit flow)
- `apps/client/src/layers/widgets/app-layout/model/wrappers/AgentDialogWrapper.tsx` (dialog host)
- `apps/client/src/layers/shared/model/app-store/app-store-panels.ts` (store slice being un-imported)
- `packages/shared/src/relay-adapter-schemas.ts` (category enum, manifest schema, binding schema)
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` (the offending manifest)
- `apps/server/src/services/relay/adapter-manager.ts` (catalog endpoint, unchanged)

**Project rules consulted:**

- `.claude/rules/fsd-layers.md` — import hierarchy, barrel-only imports
- `.claude/rules/code-quality.md` — stringly-typed code smell, DRY 3-strike rule
- `.claude/rules/components.md` — React component conventions
- `.claude/rules/testing.md` — test patterns, Wrapper, mock patterns
- `.claude/rules/file-size.md` — 300-line comfort threshold

**Series — execute in order:**

1. **`agent-channels-tab-01-correctness`** _(this spec)_ — bug fixes and architecture cleanup.
2. **`agent-channels-tab-02-polish`** — visual redesign, brand icons, humanized copy, tab reorder, color semantics, empty-state redesign.
3. **`agent-channels-tab-03-functionality`** — pause/mute, test button, last-activity metadata, budget warnings.

Do not begin Spec 02 until this spec is merged. Do not begin Spec 03 until both 01 and 02 are merged.
