---
slug: agent-channels-tab-polish
number: 220
status: specification
created: 2026-04-06
---

# Agent Dialog → Channels Tab — Visual Polish & Information Architecture

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement](#2-problem-statement)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Design Principles](#5-design-principles)
6. [Patterns and Conventions](#6-patterns-and-conventions)
7. [Detailed Design](#7-detailed-design)
8. [Copy Deck](#8-copy-deck)
9. [Color Semantics](#9-color-semantics)
10. [Tab Reordering](#10-tab-reordering)
11. [Progressive Disclosure Model](#11-progressive-disclosure-model)
12. [Implementation Phases](#12-implementation-phases)
13. [Testing Strategy](#13-testing-strategy)
14. [Accessibility](#14-accessibility)
15. [Migration Notes](#15-migration-notes)
16. [Open Questions](#16-open-questions)
17. [Related ADRs](#17-related-adrs)
18. [References](#18-references)

---

## 1. Overview

Spec 217 (agent-channels-tab-correctness) fixed the bugs. This spec makes the Channels tab genuinely world-class by eliminating jargon, introducing brand iconography, humanizing labels, rebalancing colors, reordering the parent tab list, and applying progressive disclosure to the binding card. It is design-intensive and should not begin until Spec 217 is merged.

**Blast radius:** ~8 files modified, 1-2 files created, 1 shared UI primitive extended.

**Design thesis:** Kai is a developer, but that does not mean he wants to read `per-chat` / `per-user` / `stateless` on a card. A world-class control surface speaks the user's language (not the implementation's), uses icons users recognize in under 100ms, and reveals complexity only when the user asks for it.

**Design decisions locked before spec creation:**

| #   | Decision                            | Choice                                                                                                                                                    |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tab reorder                         | Identity → **Channels** → Personality → Tools (Channels moves to position 2)                                                                              |
| 2   | Panel header subtitle               | Supported via extension to `NavigationLayoutPanelHeader`; rendered always (not dismissible)                                                               |
| 3   | Explainer copy                      | "Connect this agent to messaging platforms so it can send and receive messages."                                                                          |
| 4   | Brand icons                         | `AdapterIcon` from `@/layers/features/relay` in both picker items and binding cards                                                                       |
| 5   | Status dot                          | Retained as a small overlay on the icon's bottom-right corner, not a separate element                                                                     |
| 6   | Color semantics                     | `connected: green-500` / `disconnected: muted-foreground (gray)` / `error: red-500` / `connecting, reconnecting, starting, stopping: amber-500 (pulsing)` |
| 7   | Amber swap scope                    | All Channel-facing surfaces: agent ChannelsTab card, agent ChannelPicker, Settings ChannelsTab row, Relay panel adapter cards. All in this spec.          |
| 8   | Session strategy exposure           | Hidden on the card by default; shown only when non-default. Label humanized.                                                                              |
| 9   | `chatId` rendering                  | Resolved to display name via `useObservedChats`; fallback to `#<last-4>` of the ID.                                                                       |
| 10  | Permission icons on card            | Removed from the primary card. Shown in edit dialog only. Card shows a single "Restricted" pill only when any permission deviates from default.           |
| 11  | Hover-only actions                  | Replaced with persistent kebab menu (`DropdownMenu`) on the right edge of the card.                                                                       |
| 12  | Empty state (no bindings)           | Full-bleed illustration + headline + one CTA. No list, no picker visible.                                                                                 |
| 13  | Empty state (no adapters available) | Distinct copy + link to Settings → Channels.                                                                                                              |
| 14  | First-time explainer                | Always-on subtitle in panel header (no dismissible banner — subtitle copy is short enough to remain).                                                     |
| 15  | Preview sentence on card            | Added as a muted italic line under the channel name, built with the same helper currently in `BindingDialog`.                                             |

---

## 2. Problem Statement

After Spec 217 ships, the Channels tab is correct but still not world-class. Specifically:

### 2.1 Jargon leaks into the primary surface

- `ChannelBindingCard.tsx:72-74` renders `binding.sessionStrategy` as a raw Badge: `per-chat` / `per-user` / `stateless`. These are engineering terms. A user's first reaction is "what does that mean?" — a failure state per the Apple Test in `CLAUDE.md`.
- `ChannelBindingCard.tsx:77-80` renders `binding.chatId` as a raw Badge. For Telegram, this is a numeric ID like `-1001234567890`. Meaningless to humans.
- `ChannelPicker.tsx:112` shows raw state names (`connected` / `disconnected` / `error`) as trailing labels.

### 2.2 Visual density without visual recognition

Channel rows look the same at a glance because they're all text. The only differentiator is a colored dot. A brand icon (Telegram logo, Slack logo, webhook icon, etc.) would make the list scannable in milliseconds. The `AdapterIcon` primitive already exists in `@/layers/features/relay/ui/adapter/AdapterIcon.tsx` and is used by `CatalogCard`. It has not been wired into the picker or binding card.

### 2.3 Color semantics mismatch design-system conventions

`ChannelBindingCard.tsx:63` and `ChannelPicker.tsx:29-34` use `amber-500` for `disconnected`. In the rest of the DorkOS design system (and in virtually every other app), amber/yellow means "warning" or "pending," not "idle." A user glancing at an amber dot will wonder whether something is wrong. The correct color for "idle / not actively connected" is `muted-foreground` (gray).

Meanwhile, the transient states (`starting`, `stopping`, `reconnecting`) are currently normalized to `disconnected` before rendering (`ChannelsTab.tsx:66-72`), which means a channel in the middle of reconnecting looks identical to one that is genuinely offline. This hides useful information from the user.

### 2.4 Hover-only actions fail on touch and discoverability

`ChannelBindingCard.tsx:111-124` puts Edit/Remove behind `opacity-0 group-hover:opacity-100`. On touchscreens these are unreachable. On desktop they're invisible until the user mouses over a card, which is the opposite of a discoverable affordance.

### 2.5 No context-setting for first-time users

The panel opens with no explanation of what a channel is or why the user would want one. Kai gets it instantly; Priya will probably infer it; a new user will not. The panel header is just the word "Channels."

### 2.6 Parent tab ordering buries the activation moment

Inside `AgentDialog`, the sidebar order is Identity → Personality → Tools → Channels. Channels is last. For Kai (primary persona) and any user whose goal is "connect this agent to an external chat so it can work while I sleep," Channels is the most important tab. Personality is tweaking. Tools is configuration. Channels is activation. Activation belongs near the front.

### 2.7 Permissions exposed on the card are confusing

`ChannelBindingCard.tsx:83-109` renders a constellation of three small icons showing which permissions are disabled (`!canReply` → MessageSquareOff, `!canReceive` → BellOff, `canInitiate` → Zap). The logic is correct but the presentation is a puzzle: users don't know the baseline, so an _absent_ icon means "fine" and a _present_ icon means "restricted or elevated." That's the inverse of how most iconographic affordances work.

### 2.8 Empty state is a dead end

The current empty state is one gray line: "No channels connected." No explanation. No action. No illustration. The most important moment in the feature — the first open — is the least designed.

---

## 3. Goals

1. **Zero jargon on the primary surface.** The words "adapter", "binding", "session strategy", `per-chat`, `per-user`, `stateless` must not appear in the Channels tab UI by default. They may appear in the edit dialog (advanced) and in TSDoc.
2. **Instant visual recognition.** Every channel row and picker item shows its brand logo. Status is communicated via a small overlay dot on the logo, not as a standalone element.
3. **Honest color semantics.** Gray = idle, green = connected, red = error, amber (pulsing) = transient. Consistent across agent ChannelsTab, agent ChannelPicker, Settings ChannelsTab, and Relay panel adapter cards.
4. **Touch- and discoverability-friendly actions.** Edit and Remove live in an always-visible kebab menu (`DropdownMenu`), not hover-revealed buttons.
5. **First-run clarity.** Every visitor sees a sentence explaining what channels do. New users see a full empty-state illustration with a single action.
6. **Progressive disclosure on the card.** The default card shows icon, name, preview sentence, and kebab. Strategy, filters, and permissions are hidden unless non-default. Restricted permissions collapse to a single "Restricted" pill.
7. **Parent tab reorder.** Identity → Channels → Personality → Tools in `AgentDialog`. Update all tab-level deep-link consumers.
8. **Subtitle on `NavigationLayoutPanelHeader`.** Extend the shared primitive to accept an optional `description` prop, rendered as muted text below the title. Used by Channels in this spec, but generalizable.

---

## 4. Non-Goals

- **Server-side changes.** No changes to `AdapterManager`, `BindingRouter`, or any schema. Entirely client-side.
- **New functionality.** No pause/mute, no test button, no last-activity metadata, no budget warnings. Spec 3.
- **Relay panel redesign.** The Relay panel's adapter cards get the color-semantics fix only. Full visual pass is out of scope.
- **Changes to `BindingDialog`.** Still the canonical edit surface. We do not restyle it, we just ensure the card no longer duplicates what it shows.
- **Tab rename.** "Channels" stays as the tab name; we do not introduce new terminology.
- **i18n.** English-only copy for now. `CLAUDE.md` and the design system are English-only today.
- **Accessibility audit of the entire dialog.** We address the specific accessibility improvements from this spec (kebab menu, keyboard navigation, reduced motion) but do not sweep the whole dialog.

---

## 5. Design Principles

Applied throughout:

1. **The Apple Test (CLAUDE.md):** Describe what happens for the user, not how the system works. "One thread for each conversation" not "per-chat session strategy."
2. **Less, but better (Dieter Rams):** Every element must justify its existence. If removing a badge wouldn't hurt the user, remove it.
3. **Honest by design (CLAUDE.md):** Show reality. If a channel is reconnecting, show that it is reconnecting — do not pretend it is offline.
4. **Progressive disclosure:** The 80% case is "is this working?" The card answers that question in one glance. Everything else is one click away.
5. **Recognition over recall (Nielsen):** Brand logos. Users recognize them faster than they read text.
6. **Figure/ground:** The binding card is the figure. Everything chrome (badges, icons, subtext) is ground and must recede visually unless carrying real information.

---

## 6. Patterns and Conventions

**Shared design tokens** (`contributing/design-system.md`)
Card radius `rounded-xl` (16px), button/input radius `rounded-md` (10px), button height 40px, card padding `p-6` (24px), motion 100-300ms. All new UI follows these tokens.

**Brand logo registry** (`packages/icons/src/adapter-logos/`)
Brand logos are SVG components registered in `ADAPTER_LOGO_MAP` keyed by `iconId` (with `adapterType` fallback). New logo slots added via this map; `AdapterIcon` resolves them.

**`AdapterIcon` primitive** (`apps/client/src/layers/features/relay/ui/adapter/AdapterIcon.tsx`)
Accepts `iconId`, `adapterType`, `size`, and `className`. Falls back to a `Bot` Lucide icon if no logo is registered. We will use this in both `ChannelBindingCard` and `ChannelPicker` items.

**`DropdownMenu` (basecn)** (`apps/client/src/layers/shared/ui/dropdown-menu.tsx`)
Self-contained Content, Label, and Group (per `.claude/rules/components.md`). Triggered by a ghost-variant `Button` with `MoreHorizontal` icon. Items are buttons; destructive items use the destructive text class.

**Status dot as overlay** (established pattern in `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx`)
A small absolutely-positioned dot on the bottom-right of an icon or avatar. We reuse this pattern for adapter icons so the dot travels with the logo.

**Preview sentence helper** (`apps/client/src/layers/features/mesh/ui/BindingDialog.tsx:90-104`)
`buildPreviewSentence({ chatId, channelType, strategy }, agentName)` returns a human-readable sentence. We extract this to a shared lib helper so both the dialog and the card use it.

**`useObservedChats` hook** (`apps/client/src/layers/entities/relay/model/use-observed-chats.ts`)
Returns `{ chatId, displayName, channelType, messageCount }[]` for an adapter instance. The card uses this to resolve raw chat IDs to friendly names.

**`NavigationLayoutPanelHeader` extension** (`apps/client/src/layers/shared/ui/navigation-layout.tsx:500-531`)
Currently accepts `children` (title) and `actions`. This spec extends it to accept an optional `description?: React.ReactNode` rendered as `text-muted-foreground text-xs` below the title on desktop (hidden on mobile since the title is already in the back button).

**FSD compliance** (`.claude/rules/fsd-layers.md`)
`features/agent-settings` may import `AdapterIcon` and `useObservedChats` (entities) via their barrel exports. No new model/hook cross-feature imports introduced.

**Copy conventions** (`CLAUDE.md`, brand voice)
Confident, minimal, technical, honest. Sentence case. No marketing language. Use words like _channel_, _connect_, _receive_, _send_. Avoid _integration_, _service_, _integration hub_.

---

## 7. Detailed Design

### 7.1 Extend `NavigationLayoutPanelHeader` with `description` prop

**File:** `apps/client/src/layers/shared/ui/navigation-layout.tsx` _(modified)_

```tsx
interface NavigationLayoutPanelHeaderProps {
  children: React.ReactNode;
  actions?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}

function NavigationLayoutPanelHeader({
  children,
  actions,
  description,
  className,
}: NavigationLayoutPanelHeaderProps) {
  const { isMobile } = useNavigationLayout();

  if (isMobile) {
    if (!actions) return null;
    return <div className={cn('flex items-center justify-end', className)}>{actions}</div>;
  }

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">{children}</h3>
        {actions}
      </div>
      {description && (
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      )}
    </div>
  );
}
```

**Callers updated:** only the Channels panel in this spec. Other panels (Identity, Personality, Tools, Settings sub-panels) remain unchanged — they do not yet have descriptions, and sweeping them is out of scope.

### 7.2 `AgentDialog` tab reorder

**File:** `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` _(modified)_

Change the sidebar render order:

```tsx
<NavigationLayoutSidebar>
  <NavigationLayoutItem value="identity" icon={User}>
    Identity
  </NavigationLayoutItem>
  <NavigationLayoutItem value="channels" icon={Radio}>
    Channels
  </NavigationLayoutItem>
  <NavigationLayoutItem value="personality" icon={Sparkles}>
    Personality
  </NavigationLayoutItem>
  <NavigationLayoutItem value="tools" icon={Wrench}>
    Tools
  </NavigationLayoutItem>
</NavigationLayoutSidebar>
```

The default `activeTab` remains `'identity'` — new users still land on Identity first. Only the sidebar ordering changes, which affects tab cycle (keyboard arrow key ordering) and visual proximity.

The `AgentDialogTab` type (`app-store-panels.ts:28`) does not need to change — string identifiers are order-agnostic.

**Verify deep-link consumers.** `openAgentDialogToTab('channels')` and `openAgentDialogToTab('personality')` are used from several places (command palette, agents list, etc.). Grep the client for `openAgentDialogToTab` and confirm all call sites still make sense under the new ordering. None require code changes — they all target a specific tab by name.

### 7.3 Channels panel header with subtitle

**File:** `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` _(modified, same file)_

```tsx
<NavigationLayoutPanel value="channels">
  <div className="space-y-4">
    <NavigationLayoutPanelHeader description="Connect this agent to messaging platforms so it can send and receive messages.">
      Channels
    </NavigationLayoutPanelHeader>
    <ChannelsTab agent={agent} />
  </div>
</NavigationLayoutPanel>
```

Note: the subtitle is _permanent_. Not dismissible. The rationale is that the copy is short (one sentence, 15 words) and the cost of re-reading it every time is essentially zero, while the cost of a returning user accidentally dismissing it and then feeling lost is non-zero.

### 7.4 `ChannelBindingCard` — progressive disclosure redesign

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx` _(major rewrite)_

Responsibilities:

1. Show brand icon with status-dot overlay.
2. Show channel name as the primary text.
3. Show a muted "preview sentence" as secondary text (extracted from `BindingDialog`'s helper).
4. Show a single "Restricted" pill only when permissions deviate from default.
5. Show a kebab menu on the right with Edit and Remove actions.
6. Show error message inline when `adapterState === 'error'`.
7. Never show raw `sessionStrategy`, `chatId`, or per-permission icons.

**New prop surface:**

```tsx
interface ChannelBindingCardProps {
  binding: AdapterBinding;
  channelName: string;
  channelIconId?: string;
  channelAdapterType: string;
  adapterState: 'connected' | 'disconnected' | 'error' | 'connecting';
  errorMessage?: string;
  /** Pre-resolved display name for the binding's chatId, if any. */
  chatDisplayName?: string;
  onEdit: () => void;
  onRemove: () => void;
}
```

**Layout (desktop):**

```
┌─────────────────────────────────────────────────────────┐
│ [icon●]  Telegram — Dev chat                        ⋯   │
│          One thread for each conversation               │
│          ⚠ Invalid bot token                            │
└─────────────────────────────────────────────────────────┘
```

- `[icon●]` is the `AdapterIcon` (size 32) with a 10px status dot overlay on the bottom-right.
- `Telegram — Dev chat` concatenates `channelName` with `chatDisplayName` if present (em-dash separator). If no `chatDisplayName`, just `channelName`.
- "One thread for each conversation" is the preview sentence. It reflects the session strategy and any chat filter in plain English. It is always shown except in the `error` state (where the error message takes its place).
- "Restricted" pill is rendered on the right (before the kebab) only when `canInitiate === true`, `canReply === false`, or `canReceive === false`. Single pill, not three icons. Click (or hover on desktop) to see a tooltip listing which permissions are non-default.
- Kebab menu is `DropdownMenu` with ghost `Button` trigger (`MoreHorizontal` icon). Items: Edit, Remove (destructive). Always visible.

**Tailwind structure (abridged):**

```tsx
<div
  className={cn(
    'group relative rounded-xl border px-4 py-3 transition-colors',
    adapterState === 'error' && 'border-red-500/50 bg-red-500/[0.02]'
  )}
>
  <div className="flex items-start gap-3">
    <div className="relative shrink-0">
      <AdapterIcon iconId={channelIconId} adapterType={channelAdapterType} size={32} />
      <span
        className={cn(
          'ring-background absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2',
          STATE_DOT_CLASS[adapterState]
        )}
      />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{primaryText}</span>
      </div>
      {adapterState === 'error' && errorMessage ? (
        <p className="text-xs text-red-600 dark:text-red-400">{errorMessage}</p>
      ) : previewSentence ? (
        <p className="text-muted-foreground truncate text-xs italic">{previewSentence}</p>
      ) : null}
    </div>
    {isRestricted && (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="text-xs">
            Restricted
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{restrictionDetail}</TooltipContent>
      </Tooltip>
    )}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setShowRemoveConfirm(true)}
          className="text-destructive focus:text-destructive"
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
  {/* Existing AlertDialog for remove confirmation, unchanged */}
</div>
```

**Deleted from the component:**

- The three permission icons (`Zap`, `MessageSquareOff`, `BellOff`).
- The `sessionStrategy` raw Badge.
- The `chatId` raw Badge.
- The hover-reveal Edit/Remove buttons.

**Preview sentence helper extraction:**

**File:** `apps/client/src/layers/features/mesh/lib/build-preview-sentence.ts` _(new)_

```ts
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';

const STRATEGY_PHRASES: Record<SessionStrategy, string> = {
  'per-chat': 'One thread for each conversation',
  'per-user': 'One thread for each person',
  stateless: 'No memory between messages',
};

interface Input {
  sessionStrategy: SessionStrategy;
  chatDisplayName?: string;
  channelType?: string;
}

/**
 * Builds a short, human-readable description of a binding's routing behavior.
 *
 * Used on ChannelBindingCard (as the card's subtitle) and in BindingDialog
 * (as the live preview while editing).
 */
export function buildPreviewSentence({
  sessionStrategy,
  chatDisplayName,
  channelType,
}: Input): string {
  const strategy = STRATEGY_PHRASES[sessionStrategy];
  if (chatDisplayName) return `${strategy} in ${chatDisplayName}`;
  if (channelType) return `${strategy} · ${channelType}`;
  return strategy;
}
```

**`BindingDialog.tsx`** is refactored to use this helper; the inline `buildPreviewSentence` function at lines 90-104 is deleted and replaced with an import. This is a minor DX improvement and keeps the card/dialog in sync.

### 7.5 `ChannelsTab.tsx` — wire the new card props

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx` _(modified from Spec 217 output)_

Changes relative to the Spec 217 state:

1. Extend `AdapterDisplay` to carry `iconId` and `adapterType` from the manifest:

```ts
interface AdapterDisplay {
  state: 'connected' | 'disconnected' | 'error' | 'connecting';
  name: string;
  iconId?: string;
  adapterType: string;
  errorMessage?: string;
}
```

2. Update `adapterDisplayByInstanceId` memo to copy `iconId` and `adapterType` from each `entry.manifest`, and to surface transient states as `'connecting'` instead of normalizing to `'disconnected'`:

```ts
const raw = inst.status.state;
const state: AdapterDisplay['state'] =
  raw === 'connected' || raw === 'error'
    ? raw
    : raw === 'starting' || raw === 'stopping' || raw === 'reconnecting'
      ? 'connecting'
      : 'disconnected';
```

3. Resolve `chatDisplayName` using `useObservedChats`. Because `useObservedChats` takes a single `adapterId`, we call it per-binding via a child sub-component (`BoundChannelRow`) that encapsulates the hook call. This avoids calling `useObservedChats` in a loop (which is a React hook rules violation).

**File:** `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx` _(new)_

```tsx
import { useObservedChats } from '@/layers/entities/relay';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { ChannelBindingCard } from './ChannelBindingCard';

interface Props {
  binding: AdapterBinding;
  channelName: string;
  channelIconId?: string;
  channelAdapterType: string;
  adapterState: 'connected' | 'disconnected' | 'error' | 'connecting';
  errorMessage?: string;
  onEdit: () => void;
  onRemove: () => void;
}

/**
 * Thin wrapper around ChannelBindingCard that resolves a binding's
 * raw chatId to a friendly display name via useObservedChats.
 *
 * This exists as a separate component so each row can safely call
 * the per-adapter chat hook without violating the rules-of-hooks.
 */
export function BoundChannelRow({ binding, ...rest }: Props) {
  const { data: observedChats = [] } = useObservedChats(binding.adapterId);
  const chat = binding.chatId ? observedChats.find((c) => c.chatId === binding.chatId) : undefined;
  const chatDisplayName =
    chat?.displayName ?? (binding.chatId ? `#${binding.chatId.slice(-4)}` : undefined);

  return <ChannelBindingCard binding={binding} chatDisplayName={chatDisplayName} {...rest} />;
}
```

`ChannelsTab` renders `<BoundChannelRow>` per binding instead of `<ChannelBindingCard>` directly. The hook fires only when there are bindings and only for the unique set of `adapterId`s used by bindings; `useObservedChats` deduplicates via TanStack Query.

### 7.6 `ChannelPicker.tsx` — brand icons and humanized state

**File:** `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx` _(modified from Spec 217 output)_

Changes:

1. Replace the standalone state dot with `AdapterIcon` + overlay dot (same pattern as the card).
2. Replace raw state labels (`connected` / `disconnected` / `error`) with humanized labels:
   - `connected` → "Connected"
   - `disconnected` → "Ready" (the user's mental model: "ready to be bound")
   - `error` → "Error"
   - `connecting` → "Connecting…"
3. Update `STATE_DOT_CLASS` to use gray for disconnected and amber (pulsing) for transient states.
4. The "Available to set up" section (introduced in Spec 217) gains brand icons next to each manifest row.

```ts
const STATE_DOT_CLASS: Record<AdapterStatus['state'], string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  starting: 'bg-amber-500 animate-pulse',
  stopping: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
};
```

### 7.7 Empty states

**`ChannelsTab.tsx`** renders three distinct empty states depending on context:

**State A — Relay is off:**

```tsx
<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10">
  <Plug2 className="text-muted-foreground/40 size-8" />
  <div className="space-y-1 text-center">
    <p className="text-sm font-medium">The Relay message bus is off</p>
    <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">
      Channels connect this agent to external messaging platforms. Enable Relay in Settings to get
      started.
    </p>
  </div>
  <Button variant="outline" size="sm" onClick={() => openSettingsToTab('advanced')}>
    Open Relay settings
  </Button>
</div>
```

Note: this is a _read-only_ navigation to Settings. The user is not in the middle of a flow, so there is no context to preserve — a direct jump is fine. After Spec 217, `ChannelsTab` no longer imports `useAppStore` for state-juggling; for this empty-state convenience we re-import `openSettingsToTab` but only use it in this one terminal path. No state save/restore needed.

**State B — Relay on, no external adapters in catalog:**

```tsx
<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10">
  <Radio className="text-muted-foreground/40 size-8" />
  <div className="space-y-1 text-center">
    <p className="text-sm font-medium">No channels available</p>
    <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">
      To connect this agent to Telegram, Slack, or a webhook, first configure a channel in Settings.
      It will appear here as soon as it's ready.
    </p>
  </div>
  <Button variant="outline" size="sm" onClick={() => openSettingsToTab('channels')}>
    Configure a channel
  </Button>
</div>
```

**State C — Relay on, external adapters exist, but no bindings yet:**

```tsx
<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-10 px-6">
  <Radio className="text-muted-foreground/40 size-8" />
  <div className="space-y-1 text-center">
    <p className="text-sm font-medium">Let this agent reach the outside world</p>
    <p className="text-muted-foreground text-xs leading-relaxed max-w-xs">
      Connect Telegram, Slack, or a webhook so this agent can send and receive messages while you are away.
    </p>
  </div>
  {/* Primary CTA: render ChannelPicker directly with a prominent button variant */}
  <ChannelPicker ... variant="cta" />
</div>
```

The picker is rendered as the CTA in State C so there is a single affordance. When the user selects or sets up a channel, the empty state is replaced by the binding list.

**State D — At least one binding:** the standard list view with the picker shown as an outline button at the bottom.

### 7.8 Color semantics swap — other surfaces

Apply the new `STATE_DOT_CLASS` map to:

- `ChannelBindingCard.tsx` (new version from this spec)
- `ChannelPicker.tsx` (updated in this spec)
- `apps/client/src/layers/features/settings/ui/ChannelSettingRow.tsx` (grep confirms a status dot; update)
- `apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx` / `AdapterCardHeader.tsx` (status indicators in the Relay panel)

To avoid triplicate maps, extract `ADAPTER_STATE_DOT_CLASS` to `apps/client/src/layers/features/relay/lib/adapter-state-colors.ts` and import from all four sites.

```ts
// apps/client/src/layers/features/relay/lib/adapter-state-colors.ts
import type { AdapterStatus } from '@dorkos/shared/relay-schemas';

export const ADAPTER_STATE_DOT_CLASS: Record<AdapterStatus['state'], string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  starting: 'bg-amber-500 animate-pulse',
  stopping: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
};

/** Humanized label for a raw adapter state, suitable for UI display. */
export const ADAPTER_STATE_LABEL: Record<AdapterStatus['state'], string> = {
  connected: 'Connected',
  disconnected: 'Ready',
  error: 'Error',
  starting: 'Connecting…',
  stopping: 'Stopping…',
  reconnecting: 'Reconnecting…',
};
```

Export both from `@/layers/features/relay` (update barrel). FSD check: `features/agent-settings` already imports from `features/relay`, so adding this export is allowed.

### 7.9 Files summary

| File                                                                                      | Change                                                                  |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/client/src/layers/shared/ui/navigation-layout.tsx`                                  | Extend `NavigationLayoutPanelHeader` with `description` prop            |
| `apps/client/src/layers/shared/ui/__tests__/navigation-layout.test.tsx`                   | Add test for the new prop                                               |
| `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`                       | Reorder sidebar, add Channels subtitle                                  |
| `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`                       | Wire new card props, render new empty states, extract `BoundChannelRow` |
| `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx`                   | **New.** Per-row `useObservedChats` wrapper                             |
| `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`                | Major redesign: brand icon, preview sentence, kebab, Restricted pill    |
| `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`                     | Brand icons, humanized state labels                                     |
| `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelBindingCard.test.tsx` | **New or updated.** Test new prop surface and kebab menu                |
| `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx`        | Update mocks for new props, add empty-state tests                       |
| `apps/client/src/layers/features/mesh/lib/build-preview-sentence.ts`                      | **New.** Shared helper                                                  |
| `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`                               | Use shared preview helper                                               |
| `apps/client/src/layers/features/relay/lib/adapter-state-colors.ts`                       | **New.** Shared color + label constants                                 |
| `apps/client/src/layers/features/relay/index.ts`                                          | Export state color/label constants                                      |
| `apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx`                        | Consume shared color constants                                          |
| `apps/client/src/layers/features/settings/ui/ChannelSettingRow.tsx`                       | Consume shared color constants                                          |

Approximately 10-12 modified files and 3-4 new files. A moderate, design-intensive change.

---

## 8. Copy Deck

All visible strings, in one place, for review and translation in future:

| Location                    | Copy                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Channels panel subtitle     | Connect this agent to messaging platforms so it can send and receive messages.                                                            |
| Empty state A headline      | The Relay message bus is off                                                                                                              |
| Empty state A body          | Channels connect this agent to external messaging platforms. Enable Relay in Settings to get started.                                     |
| Empty state A CTA           | Open Relay settings                                                                                                                       |
| Empty state B headline      | No channels available                                                                                                                     |
| Empty state B body          | To connect this agent to Telegram, Slack, or a webhook, first configure a channel in Settings. It will appear here as soon as it's ready. |
| Empty state B CTA           | Configure a channel                                                                                                                       |
| Empty state C headline      | Let this agent reach the outside world                                                                                                    |
| Empty state C body          | Connect Telegram, Slack, or a webhook so this agent can send and receive messages while you are away.                                     |
| Empty state C CTA           | Connect a channel                                                                                                                         |
| Preview sentence: per-chat  | One thread for each conversation                                                                                                          |
| Preview sentence: per-user  | One thread for each person                                                                                                                |
| Preview sentence: stateless | No memory between messages                                                                                                                |
| Restricted pill tooltip     | (Generated from binding — see `buildRestrictionDetail`)                                                                                   |
| State label: connected      | Connected                                                                                                                                 |
| State label: disconnected   | Ready                                                                                                                                     |
| State label: error          | Error                                                                                                                                     |
| State label: connecting     | Connecting…                                                                                                                               |
| Kebab menu: edit            | Edit                                                                                                                                      |
| Kebab menu: remove          | Remove                                                                                                                                    |
| Remove confirmation title   | Remove channel binding                                                                                                                    |
| Remove confirmation body    | Remove the binding to {channelName}? The agent will no longer receive messages from this channel.                                         |

**`buildRestrictionDetail` logic:**

```ts
function buildRestrictionDetail(binding: AdapterBinding): string {
  const parts: string[] = [];
  if (binding.canInitiate) parts.push('Can start conversations');
  if (!binding.canReply) parts.push('Cannot reply');
  if (!binding.canReceive) parts.push('Cannot receive');
  return parts.join(' · ');
}
```

Example outputs: `Can start conversations`, `Cannot reply · Cannot receive`, `Can start conversations · Cannot reply`.

---

## 9. Color Semantics

**Final state → color map:**

| State          | Dot color                    | Label         | Rationale                  |
| -------------- | ---------------------------- | ------------- | -------------------------- |
| `connected`    | `bg-green-500`               | Connected     | Standard "live" color      |
| `disconnected` | `bg-muted-foreground` (gray) | Ready         | Idle, not a warning        |
| `error`        | `bg-red-500`                 | Error         | Standard destructive color |
| `starting`     | `bg-amber-500 animate-pulse` | Connecting…   | Transient, eye-catching    |
| `stopping`     | `bg-amber-500 animate-pulse` | Stopping…     | Transient                  |
| `reconnecting` | `bg-amber-500 animate-pulse` | Reconnecting… | Transient                  |

**Motion:** the pulse is a 1.5s infinite `animate-pulse` utility (Tailwind built-in). Respects `prefers-reduced-motion` via the Tailwind plugin.

**Dark mode:** all colors use semantic tokens (`bg-green-500`, `bg-red-500`) which resolve correctly in both themes via DorkOS's design tokens.

---

## 10. Tab Reordering

**Before:** Identity → Personality → Tools → Channels
**After:** Identity → Channels → Personality → Tools

**Rationale:**

- Identity first: the user has just created or selected an agent; giving them a name is the gentlest first step.
- Channels second: **activation.** For Kai's use case (overnight agents), this is the whole point of creating the agent.
- Personality third: tweaks that refine an already-working agent.
- Tools fourth: deeper configuration, most users rarely touch it.

**Blast radius of the reorder:** the `AgentDialogTab` union (`app-store-panels.ts:28`) is unchanged because tab identity is string-based. All `openAgentDialogToTab('personality')` call sites continue to work. Keyboard arrow-key navigation follows sidebar order automatically.

**Verification:** grep `openAgentDialogToTab` across `apps/client/src` to confirm all call sites still make contextual sense after the reorder. I expect zero code changes outside `AgentDialog.tsx`.

---

## 11. Progressive Disclosure Model

Each binding has four tiers of information, revealed progressively:

| Tier               | Contents                                                                            | Surface                    |
| ------------------ | ----------------------------------------------------------------------------------- | -------------------------- |
| **1. Glance**      | Brand icon, channel name, state dot                                                 | Always visible on card     |
| **2. Card**        | + Preview sentence, + Restricted pill (conditional), + error message (conditional)  | Always visible on card     |
| **3. Kebab**       | Edit, Remove                                                                        | Kebab menu (one click)     |
| **4. Edit Dialog** | Strategy, chat filter, channel type, permissions, permission mode, advanced options | BindingDialog (two clicks) |

The user's 80% question is "is this working?" — Tier 1 answers it in under 100ms.
The user's 15% question is "what does this do?" — Tier 2 answers it without a click.
The user's 5% question is "can I tweak it?" — Tiers 3/4 are one or two clicks away.

---

## 12. Implementation Phases

Implementation order for a single merge:

1. **Extract the shared helpers first.** Create `buildPreviewSentence` lib, `ADAPTER_STATE_DOT_CLASS` / `ADAPTER_STATE_LABEL` constants. Update `BindingDialog` to use the preview helper.
2. **Extend `NavigationLayoutPanelHeader` with `description`.** Add the test. Merge-safe on its own.
3. **Update `AgentDialog` sidebar order and channels panel header.**
4. **Redesign `ChannelBindingCard`.** Rewrite the component with the new layout, remove the old permission icons and badges.
5. **Create `BoundChannelRow`.** Wire it into `ChannelsTab`.
6. **Update `ChannelsTab` empty states.** Three distinct states. State A imports `openSettingsToTab` as a terminal convenience.
7. **Update `ChannelPicker` icons and humanized labels.**
8. **Sweep other surfaces for color semantics** (Relay panel adapter card, Settings ChannelSettingRow). Confirm visual consistency.
9. **Update all tests.** Card tests, ChannelsTab tests, NavigationLayoutPanelHeader tests.
10. **Run typecheck, lint, full client test suite.**
11. **Manual visual verification** (see Testing Strategy).

All in one PR is fine — the changes are internally consistent and a partial merge would leave the UI in an awkward half-state.

---

## 13. Testing Strategy

### 13.1 Unit tests

**`ChannelBindingCard.test.tsx`** — new/rewritten:

```ts
/** Verifies the brand icon renders with the correct iconId fallback chain. */
it('renders AdapterIcon with iconId from catalog', () => { ... });

/** Verifies the status dot reflects the adapterState prop with correct color class. */
it('renders status dot with correct color for each state', () => { ... });

/** Verifies the preview sentence is shown in non-error states and hidden in error state. */
it('shows preview sentence when healthy and error message when errored', () => { ... });

/** Verifies the Restricted pill is NOT shown when all permissions are default. */
it('does not show Restricted pill for a default-permissioned binding', () => { ... });

/** Verifies the Restricted pill IS shown when any permission deviates. */
it('shows Restricted pill with tooltip when canReply is false', () => { ... });

/** Verifies the kebab menu is always visible (not hover-gated) and contains Edit/Remove. */
it('renders kebab menu with Edit and Remove items, always visible', () => { ... });

/** Verifies Remove opens the confirmation AlertDialog before firing onRemove. */
it('shows confirmation dialog before calling onRemove', () => { ... });

/** Verifies the card does NOT render raw sessionStrategy or chatId as badges. */
it('does not render raw session strategy or chat ID as badges', () => { ... });
```

**`navigation-layout.test.tsx`** — add:

```ts
/** Verifies the new description prop renders below the title on desktop. */
it('renders description below title when provided', () => { ... });

/** Verifies the description prop is hidden on mobile (title is in back button). */
it('hides description on mobile layout', () => { ... });
```

**`build-preview-sentence.test.ts`** — new:

```ts
/** Verifies each SessionStrategy produces the correct humanized phrase. */
it('maps each session strategy to its phrase', () => { ... });

/** Verifies chatDisplayName is appended as "in {name}" when present. */
it('appends chat display name when present', () => { ... });

/** Verifies channelType is appended as separator when no chat name is present. */
it('appends channel type when no chat name is present', () => { ... });
```

**`ChannelsTab.test.tsx`** — update and extend:

```ts
/** Verifies empty state A (relay off) renders with correct copy and CTA. */
it('renders relay-off empty state when relayEnabled is false', () => { ... });

/** Verifies empty state B (no external adapters) renders with correct copy and CTA. */
it('renders no-adapters empty state when catalog is empty', () => { ... });

/** Verifies empty state C (no bindings, adapters available) renders with picker as CTA. */
it('renders no-bindings empty state with prominent picker CTA', () => { ... });

/** Verifies BoundChannelRow resolves chatDisplayName via useObservedChats. */
it('resolves chat display name from observed chats for each binding', () => { ... });
```

**`AgentDialog.test.tsx`** — update:

```ts
/** Verifies the sidebar renders tabs in the new order: identity, channels, personality, tools. */
it('renders tabs in the new order', () => { ... });

/** Verifies the Channels panel header includes the explainer subtitle. */
it('renders Channels panel with explainer subtitle', () => { ... });
```

### 13.2 Visual regression

Playground entries in `/dev/` routes for:

- `ChannelBindingCard` in each state (connected, disconnected, error, connecting) with and without chat filter, with and without restrictions.
- `ChannelsTab` in each empty state (A, B, C) and with bindings.
- `ChannelPicker` with the new icon layout.

These live in the `dev-playground` widget area per `contributing/project-structure.md`. Refer to `.claude/rules/maintaining-dev-playground.md` for placement.

### 13.3 Manual visual verification checklist

1. Open agent → Channels tab → confirm subtitle renders.
2. Confirm tab order is Identity → Channels → Personality → Tools.
3. With zero bindings and Relay off, confirm State A renders with correct copy and "Open Relay settings" opens Settings → Advanced.
4. With zero bindings and Relay on but no external adapters, confirm State B.
5. With zero bindings and at least one external adapter, confirm State C with the picker prominent.
6. Bind a channel. Confirm the card shows: brand icon + name, preview sentence in muted italic, kebab menu on the right, no raw badges, no hover-only actions.
7. Hover over the kebab → confirm both Edit and Remove are always visible (no hover-reveal).
8. Tap the kebab on a touch device (or emulated mobile) → confirm it opens correctly.
9. Edit a binding and set `canReply = false` → confirm the card now shows a "Restricted" pill with tooltip "Cannot reply."
10. Force an adapter into `error` state (disable its config) → confirm the card shows red border, red icon dot, and error message in place of preview sentence.
11. Force an adapter into `starting` state → confirm amber pulsing dot and "Connecting…" label in picker.
12. Confirm dark mode renders correctly for every state.
13. Confirm `prefers-reduced-motion` halts the amber pulse.
14. Confirm keyboard nav: Tab through cards → kebab is focusable → Enter opens menu → Esc closes → Arrow keys cycle menu items.

### 13.4 Accessibility smoke

Run an axe-core audit on the Channels panel after the redesign. Target zero critical or serious issues.

---

## 14. Accessibility

- **Brand icons have `aria-hidden`.** The channel name is the accessible label; the icon is decorative. `AdapterIcon` already supports this pattern.
- **Kebab trigger has `sr-only` label.** "Actions" or "More options for {channelName}".
- **Status dot has `role="status"` and `aria-label`.** e.g., `aria-label="Connected"`.
- **Restricted pill is a button with tooltip.** `aria-describedby` points to the tooltip content.
- **Empty-state CTAs are real buttons with descriptive labels.** Not icon-only.
- **Focus order follows visual order.** Card → kebab → next card → kebab.
- **Amber pulse respects `prefers-reduced-motion`** (Tailwind `animate-pulse` is gated by the `motion-safe` variant; wrap in `motion-safe:animate-pulse`).
- **Color never carries the only meaning.** The state label is always present as text somewhere visible (in the card's preview sentence region, or as a tooltip on the dot).
- **Kebab menu meets WCAG 2.1 AA touch target** (44×44px minimum on mobile, 40px desktop).

---

## 15. Migration Notes

- **Stored binding data is untouched.** `sessionStrategy`, `chatId`, `channelType`, `canInitiate`, `canReply`, `canReceive` remain in `AdapterBinding` on disk. We are only changing how they render.
- **No feature flag.** The redesign is a non-breaking visual change. A user who refreshes mid-session sees the new card immediately with no data loss.
- **No codemod required.** All call sites of `ChannelBindingCard` get updated prop shapes in the same PR.

---

## 16. Open Questions

None at spec-writing time. Locked decisions listed in §1. Escalate only if implementation surfaces a contradiction.

---

## 17. Related ADRs

- **ADR-0131 (Binding-Level Permissions)** — defines `canInitiate`/`canReply`/`canReceive`. We surface the non-default case as a single "Restricted" pill.
- **ADR-0132 (Two-Tab Information Architecture for Relay Panel)** — establishes the separation of channels from bindings at the navigation level. This spec extends the same principle to the card layout.
- **ADR-0135 (Binding-Level Permission Mode)** — `permissionMode` is edited in `BindingDialog`, not shown on the card.
- **ADR-0044 (Adapter Metadata Contract)** — `iconId`, `displayName`, `category`, `description` live on the manifest. This spec relies on every external adapter having a registered brand logo in `ADAPTER_LOGO_MAP`; if one is missing, the `Bot` fallback handles it gracefully.

No new ADR required. The progressive disclosure model for binding cards is a design choice, not an architectural one.

---

## 18. References

**Depends on:** Spec 217 (agent-channels-tab-correctness). Do not begin this spec until Spec 217 is merged.

**Source files modified:**

- `apps/client/src/layers/shared/ui/navigation-layout.tsx`
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`
- `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`
- `apps/client/src/layers/features/agent-settings/ui/ChannelBindingCard.tsx`
- `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`
- `apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`
- `apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx`
- `apps/client/src/layers/features/settings/ui/ChannelSettingRow.tsx`
- `apps/client/src/layers/features/relay/index.ts`
- Associated tests

**Source files created:**

- `apps/client/src/layers/features/agent-settings/ui/BoundChannelRow.tsx`
- `apps/client/src/layers/features/mesh/lib/build-preview-sentence.ts`
- `apps/client/src/layers/features/relay/lib/adapter-state-colors.ts`
- Associated test files

**Design references:**

- `contributing/design-system.md` — Calm Tech design language
- `.claude/rules/components.md` — basecn patterns, `cn()`, focus-visible
- `CLAUDE.md` — decision-making filters (Apple Test, Priya Test, Kai Test)
- Slack → Apps → Manage (pattern reference)
- Linear → Settings → Integrations (pattern reference)
- Raycast → Extensions (kebab menu pattern reference)

**Follow-up spec:**

- **Spec 3 — Channels tab functionality** (post-merge of this spec): pause/mute, test button, last-activity metadata, budget warnings.
