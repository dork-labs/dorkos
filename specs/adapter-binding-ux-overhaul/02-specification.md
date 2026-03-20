# Adapter & Binding UX Overhaul — Specification

**Status:** Draft
**Authors:** Claude Code, 2026-03-11
**Spec Number:** 120
**Ideation:** `specs/adapter-binding-ux-overhaul/01-ideation.md`
**Branch:** `preflight/adapter-binding-ux-overhaul`

---

## Overview

Overhaul the adapter and binding system to be more robust, flexible, powerful, and easier to use. This specification covers seven areas: multi-instance Telegram adapters, adapter naming/labeling, binding management improvements (create, chatId/channelType selection, duplication, PATCH bug fix), post-adapter-setup binding flow, sidebar Connections view filtering, and a new observed chats API.

The underlying relay architecture (AdapterRegistry, BindingRouter, BindingStore, subject-based routing, most-specific-first scoring) is sound and unchanged. This work focuses on the UX layer and a missing server route.

## Background / Problem Statement

The current adapter and binding system has several UX gaps that prevent users from getting full value:

1. **Single-instance limitation**: Telegram's manifest has `multiInstance: false`, preventing users from connecting multiple bots (e.g., one per project).
2. **No adapter naming**: Users cannot distinguish between multiple adapters of the same type because there is no label/name field.
3. **No binding creation from UI**: The Bindings tab in RelayPanel has no "New Binding" button — bindings can only be created indirectly through the adapter setup flow.
4. **ChatId/channelType not exposed**: The `AdapterBinding` schema has `chatId` and `channelType` fields, but the `BindingDialog` never exposes them. Users cannot create specific routing rules for individual chats or channel types.
5. **No binding duplication**: Creating similar bindings requires re-entering all fields manually.
6. **Broken binding edits**: The client sends `PATCH /relay/bindings/:id` but no server route handles it — edits return 404.
7. **No post-setup guidance**: After adding an adapter, there is no prompt to create a binding. Users may not realize the adapter won't work without one.
8. **Unfiltered sidebar**: The Connections view shows all adapters and agents regardless of the currently selected agent.

## Goals

- Enable multiple Telegram adapter instances (different bot tokens) with user-friendly labels
- Make bindings a first-class object with full CRUD from the Bindings tab
- Expose chatId/channelType selection via live data pickers and "Route to Agent" from message log
- Add binding duplication via "Add similar binding" action
- Fix the missing PATCH /bindings/:id server route
- Guide users from adapter setup to binding creation with an optional wizard step and persistent amber badge
- Filter the sidebar Connections view to show only adapters/agents relevant to the current agent
- Provide an observed chats API to populate chatId pickers with real data

## Non-Goals

- Changes to the relay publish pipeline or message routing logic
- Topology/React Flow visual changes
- Adapter marketplace or plugin ecosystem
- Mobile-specific layout changes
- Rate limiting or access control per binding
- Temporal status escalation (amber to orange after N days)
- Adapter DX improvements (BaseRelayAdapter, compliance tests) — covered by spec 119
- Changes to AdapterRegistry, AdapterManager routing, or BindingRouter resolution logic

## Technical Dependencies

- **React 19** + **Vite 6** + **Tailwind CSS 4** + **shadcn/ui** (new-york style)
- **Zod** — schema validation for new fields and API endpoints
- **TanStack Query** — data fetching hooks for observed chats, binding mutations
- **Zustand** — no new stores needed (existing UI state patterns suffice)
- **motion/react** — animations for wizard step transitions (already used in AdapterSetupWizard)
- **lucide-react** — icons (already a project dependency)

No new external dependencies required.

## Detailed Design

### Area 1: Multi-Instance Telegram Adapters

**Schema change** (`packages/relay/src/adapters/telegram/telegram-adapter.ts`):

Change line 34 of `TELEGRAM_MANIFEST`:

```typescript
// Before
multiInstance: false,

// After
multiInstance: true,
```

No changes to `AdapterManager.addAdapter()` — it already supports `multiInstance: true` with a guard at lines 337-345 that only blocks when `multiInstance` is `false`.

**UI change** (`apps/client/src/layers/features/relay/ui/CatalogCard.tsx`):

The `CatalogCard` currently shows a simple "Add" button. For multi-instance adapter types that already have instances configured:

- Show an instance count badge next to the adapter name (e.g., "2 configured")
- Change the button label to "Add Another" instead of "Add"
- The card appears in the "Available Adapters" section because `multiInstance` types are always shown in the catalog regardless of existing instances

```tsx
// CatalogCard props addition
interface CatalogCardProps {
  manifest: AdapterManifest;
  instanceCount: number; // NEW — number of existing instances of this type
  onAdd: () => void;
}
```

The `AdaptersTab` in `RelayPanel.tsx` already separates catalog entries by whether they have instances. For `multiInstance` types, show them in both the "Configured" section (as `AdapterCard` instances) and the "Available" section (as a `CatalogCard` with `instanceCount`).

### Area 2: Adapter Naming/Labeling

**Schema change** (`packages/shared/src/relay-adapter-schemas.ts`):

Add `label` as an optional field on `AdapterConfigSchema` (or create it if it doesn't exist as a separate schema). The `AdapterConfig` type used by `AdapterManager` stores per-instance configuration including `id`, `type`, `enabled`, and a `config` record. Add `label` as a top-level optional string:

```typescript
// In the adapter config structure stored by AdapterManager
interface AdapterInstanceConfig {
  id: string;
  type: string;
  enabled: boolean;
  label?: string; // NEW — user-facing name for this adapter instance
  config: Record<string, unknown>;
}
```

**Server change** (`apps/server/src/services/relay/adapter-manager.ts`):

- `addAdapter()`: Accept an optional `label` parameter. Store it alongside the adapter config.
- `getCatalog()`: Include the `label` in each `CatalogInstance` returned to the client.
- Add `updateAdapterLabel(id: string, label: string)` method, or include label in the existing `updateConfig` flow.

**Transport change** (`packages/shared/src/transport.ts`):

The existing `addAdapter` method signature:

```typescript
addAdapter(type: string, id: string, config: Record<string, unknown>): Promise<void>;
```

Add `label` to the config record (it's already a generic Record, so no interface change needed — the server extracts `label` from the config before storing).

**UI change — AdapterSetupWizard** (`apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`):

Add a "Name" text input on the Configure step, above the adapter-specific config fields:

```tsx
<div className="space-y-2">
  <Label htmlFor="adapter-label">Name (optional)</Label>
  <Input
    id="adapter-label"
    placeholder={manifest.displayName}
    value={label}
    onChange={(e) => setLabel(e.target.value)}
  />
  <p className="text-muted-foreground text-xs">
    A friendly name to identify this adapter instance.
  </p>
</div>
```

For Telegram specifically: during the Test step, when `testRelayAdapterConnection` succeeds, the server response should include bot info from `getMe()`. Auto-populate the label field with `@bot_username` if the user hasn't set one. The user can override.

**Server change for Telegram auto-label**: The `testConnection()` method on `TelegramAdapter` already calls the Telegram API. Extend the test response to include `botUsername` when available. The client reads this from the test result and pre-fills the label.

**UI change — AdapterCard** (`apps/client/src/layers/features/relay/ui/AdapterCard.tsx`):

Display both the custom label (primary, larger text) and the adapter type's `displayName` (secondary, smaller muted text) in the card header:

```tsx
<div className="flex flex-col">
  <span className="text-sm font-medium">{instance.label || instance.id}</span>
  <span className="text-muted-foreground text-xs">{manifest.displayName}</span>
</div>
```

### Area 3: Binding Management Improvements

#### 3a: Create Binding from Bindings Tab

**UI change — BindingList** (`apps/client/src/layers/features/relay/ui/BindingList.tsx`):

Add a "New Binding" button at the top of the binding list, next to the heading:

```tsx
<div className="flex items-center justify-between px-4 py-2">
  <h3 className="text-muted-foreground text-sm font-medium">Bindings</h3>
  <Button variant="outline" size="sm" onClick={() => setDialogState({ mode: 'create' })}>
    <Plus className="mr-1.5 size-3.5" />
    New Binding
  </Button>
</div>
```

**UI change — BindingDialog** (`apps/client/src/layers/features/mesh/ui/BindingDialog.tsx`):

Expand the dialog to support full creation mode. Current props:

```typescript
interface BindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adapterName: string;
  agentName: string;
  onConfirm: (values: { sessionStrategy: SessionStrategy; label: string }) => void;
  mode: 'create' | 'edit';
  initialValues?: { sessionStrategy: SessionStrategy; label: string };
}
```

New props:

```typescript
interface BindingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (values: BindingFormValues) => void;
  mode: 'create' | 'edit';
  initialValues?: Partial<BindingFormValues>;
  /** In edit mode, adapter and agent are read-only display strings */
  adapterName?: string;
  agentName?: string;
}

interface BindingFormValues {
  adapterId: string;
  agentId: string;
  projectPath: string;
  sessionStrategy: SessionStrategy;
  label: string;
  chatId?: string;
  channelType?: 'dm' | 'group' | 'channel' | 'thread';
}
```

In **create mode**:

- Show adapter picker dropdown (populated from `useAdapterCatalog()` — only enabled adapter instances)
- Show agent picker dropdown (populated from `useRegisteredAgents()`)
- Show project path field (auto-filled from the selected agent's `cwd` or the current directory)
- Show session strategy selector (existing)
- Show label input (existing)
- Show chat filter section (see 3b below)

In **edit mode**:

- Adapter and agent shown as read-only text (cannot change which adapter/agent a binding routes to)
- Session strategy, label, chatId, channelType are editable

#### 3b: ChatId/ChannelType Selection from Live Data

**BindingDialog — Chat Filter section**:

Add a collapsible "Chat Filter" section below the session strategy:

```tsx
<Collapsible>
  <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium">
    <ChevronRight className="size-3.5 transition-transform data-[state=open]:rotate-90" />
    Chat Filter
    {(chatId || channelType) && (
      <Badge variant="secondary" className="text-xs">
        Active
      </Badge>
    )}
  </CollapsibleTrigger>
  <CollapsibleContent className="space-y-3 pt-2">
    {/* ChatId picker */}
    <div className="space-y-1.5">
      <Label>Chat ID</Label>
      <Select value={chatId} onValueChange={setChatId}>
        <SelectTrigger>
          <SelectValue placeholder="Any chat (wildcard)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Any chat (wildcard)</SelectItem>
          {observedChats.map((chat) => (
            <SelectItem key={chat.chatId} value={chat.chatId}>
              {chat.displayName || chat.chatId}
              <span className="text-muted-foreground ml-2 text-xs">
                {chat.channelType} · {chat.messageCount} msgs
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    {/* ChannelType picker */}
    <div className="space-y-1.5">
      <Label>Channel Type</Label>
      <Select value={channelType} onValueChange={setChannelType}>
        <SelectTrigger>
          <SelectValue placeholder="Any type (wildcard)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Any type (wildcard)</SelectItem>
          <SelectItem value="dm">Direct Message</SelectItem>
          <SelectItem value="group">Group</SelectItem>
          <SelectItem value="channel">Channel</SelectItem>
          <SelectItem value="thread">Thread</SelectItem>
        </SelectContent>
      </Select>
    </div>

    {(chatId || channelType) && (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setChatId('');
          setChannelType('');
        }}
      >
        Clear filters
      </Button>
    )}
  </CollapsibleContent>
</Collapsible>
```

The chatId dropdown is populated from the observed chats API (Area 6). When the selected adapter changes in create mode, fetch observed chats for that adapter.

**ConversationRow — "Route to Agent" action** (`apps/client/src/layers/features/relay/ui/ConversationRow.tsx`):

Add a "Route to Agent" button/action to each conversation row in the Inbox tab. When clicked:

1. Open a popover with an agent picker dropdown
2. When agent is selected, open the `BindingDialog` in create mode with:
   - `adapterId` pre-filled from the conversation's adapter
   - `chatId` pre-filled from the conversation's metadata (`conversation.from` or equivalent)
   - `channelType` pre-filled from the conversation's channel type
   - Agent pre-selected from the popover choice

This follows the Gmail "filter from message" pattern — users create routing rules reactively from actual messages, not proactively from empty forms.

#### 3c: Duplicate Bindings

**BindingList — "Add similar binding" action**:

Add to the existing kebab menu dropdown (alongside Edit and Delete):

```tsx
<DropdownMenuItem onClick={() => handleDuplicate(binding)}>
  <Copy className="mr-2 size-3.5" />
  Add similar binding
</DropdownMenuItem>
```

`handleDuplicate` opens the `BindingDialog` in create mode, pre-filled with all fields from the source binding **except** `chatId` (which must be different or empty for the new binding to be useful). The new binding gets a fresh UUID and timestamps from the server.

#### 3d: Fix Missing PATCH /bindings/:id Route (Bug Fix)

**Server change** (`apps/server/src/routes/relay.ts`):

Add the missing route between the existing POST and DELETE binding routes:

```typescript
router.patch('/bindings/:id', async (req, res) => {
  const bindingStore = adapterManager.getBindingStore();
  if (!bindingStore) {
    return res.status(503).json({ error: 'Binding subsystem not available' });
  }

  const UpdateBindingSchema = z.object({
    sessionStrategy: SessionStrategySchema.optional(),
    label: z.string().optional(),
    chatId: z.string().optional().nullable(),
    channelType: ChannelTypeSchema.optional().nullable(),
  });

  const result = UpdateBindingSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
  }

  // Convert null to undefined for clearing optional fields
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.data)) {
    if (value !== undefined) {
      updates[key] = value === null ? undefined : value;
    }
  }

  const updated = await bindingStore.update(req.params.id, updates);
  if (!updated) {
    return res.status(404).json({ error: 'Binding not found' });
  }
  return res.json({ binding: updated });
});
```

The `BindingStore.update()` method already exists at lines 130-144 of `binding-store.ts` and handles the merge + save. This route simply wires it to Express.

### Area 4: Post-Adapter-Setup Binding Flow

**AdapterSetupWizard — optional "Bind to Agent" step** (`AdapterSetupWizard.tsx`):

After the existing 3-step wizard (configure → test → confirm), add an optional 4th step:

```typescript
type WizardStep = 'configure' | 'test' | 'confirm' | 'bind'; // NEW step
```

After the confirm step successfully saves the adapter:

1. Transition to the `bind` step automatically
2. Show an agent picker dropdown and session strategy selector
3. Two buttons: "Bind to Agent" (primary) and "Skip — I'll do this later" (ghost)
4. If the user selects an agent and confirms, create a binding via `useCreateBinding()` with `adapterId` set to the newly created adapter's ID
5. If the user skips, close the wizard

The bind step is non-blocking — skipping it is always available and clearly labeled.

**AdapterCard — binding status and bound agents** (`AdapterCard.tsx`):

Extend the adapter card to show binding information:

```tsx
// New props or derived data
interface AdapterCardBindingInfo {
  boundAgents: Array<{ agentId: string; agentName: string; label: string }>;
  bindingCount: number;
}
```

Display:

- **Status dot** in the card header:
  - Green: adapter connected + has bindings + recent message flow
  - Blue: adapter connected + has bindings + quiet (no recent messages)
  - Amber: adapter connected + zero bindings ("No agent bound")
  - Red: adapter connection error
- **Bound agents list**: Small text/badges below the adapter info showing which agents are bound. Example: "→ LifeOS Agent, 144x.co Agent"
- When amber (no bindings): Show "No agent bound" text next to the amber dot and a small "Bind" button that opens the BindingDialog in create mode with the adapter pre-selected

The binding data comes from joining `useBindings()` with `useRegisteredAgents()` — filter bindings by this adapter's ID, then resolve agent names.

**One-time toast**: After adapter creation succeeds (in the confirm step), show a sonner toast: "Adapter connected — bind to an agent to start routing messages."

### Area 5: Sidebar Connections View Filtering

**NavigationLayout — Connections tab** (`apps/client/src/layers/shared/ui/navigation-layout.tsx`):

The sidebar Connections tab (part of the `NavigationLayout` used in `SettingsDialog` and other dialogs) shows adapters and agents. Add filtering based on the currently selected agent:

When an agent is selected (determined from the current session's agent context or a Zustand store):

1. **Filter adapters**: Show only adapters that have at least one binding to the current agent
2. **Filter agents**: Show only agents that share a binding relationship with the current agent (connected via the same adapter)
3. Show a summary line: "Showing N of M adapters for [Agent Name]"
4. Show a "Show all" link/button to remove the filter

When no agent is selected, show all adapters and agents (unfiltered).

This filtering requires access to the binding list (`useBindings()`) and the agent registry (`useRegisteredAgents()`). Since `NavigationLayout` is in the `shared` layer, the filtering logic should be implemented as a hook in the `entities` or `features` layer and passed down as props or via context.

**FSD layer consideration**: The `NavigationLayout` is in `shared/ui/` and cannot import from `entities` or `features`. The filtering data must be provided by the parent component (e.g., `SettingsDialog` in `features/settings/`) which has access to `useBindings()` and `useRegisteredAgents()`. The `NavigationLayout` accepts an optional `filter` prop:

```typescript
interface NavigationLayoutProps {
  children: React.ReactNode;
  // NEW
  connectionFilter?: {
    agentName: string;
    filteredAdapterIds: string[];
    totalAdapterCount: number;
    onClearFilter: () => void;
  };
}
```

### Area 6: Observed Chats API

**New server endpoint** (`apps/server/src/routes/relay.ts`):

```
GET /api/relay/adapters/:id/chats
```

Returns a list of unique chat IDs observed in message traces for the given adapter. Data is extracted from the existing trace store.

**Response schema** (`packages/shared/src/relay-adapter-schemas.ts`):

```typescript
export const ObservedChatSchema = z.object({
  chatId: z.string(),
  displayName: z.string().optional(),
  channelType: ChannelTypeSchema.optional(),
  lastMessageAt: z.string().datetime(),
  messageCount: z.number(),
});

export type ObservedChat = z.infer<typeof ObservedChatSchema>;
```

**Server implementation**: Query the trace store for all traces where `adapterId` matches, group by `chatId` from trace metadata, and return aggregated results. The trace store (`apps/server/src/services/relay/trace-store.ts`) already records message metadata including source chat information.

**Transport interface** (`packages/shared/src/transport.ts`):

```typescript
/** Get observed chats for an adapter (for chatId picker). */
getObservedChats(adapterId: string): Promise<ObservedChat[]>;
```

**Client hook** (`apps/client/src/layers/entities/relay/`):

```typescript
export function useObservedChats(adapterId: string | undefined) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['relay', 'observed-chats', adapterId],
    queryFn: () => transport.getObservedChats(adapterId!),
    enabled: !!adapterId,
    staleTime: 30_000, // Refresh every 30s
  });
}
```

### Area 7: Adapter Config Label in Transport

The transport methods for adding and configuring adapters pass config as `Record<string, unknown>`. The `label` field will be included in this record. The server extracts it before storing:

```typescript
// In AdapterManager.addAdapter()
const { label, ...adapterConfig } = config;
// Store label separately, pass adapterConfig to the adapter factory
```

No changes to the `Transport` interface signature — `label` travels inside the config record.

## User Experience

### Flow 1: Adding a Second Telegram Bot

1. User opens Relay dialog → Adapters tab
2. Sees existing "Telegram" adapter card with label "@my_bot" and a green dot
3. In "Available Adapters", sees Telegram card with "1 configured" badge and "Add Another" button
4. Clicks "Add Another" → wizard opens
5. Enters bot token, types a name like "Support Bot"
6. Test step runs, auto-fills label with "@support_bot" from Telegram API
7. Confirm step saves. Wizard transitions to "Bind to Agent" step
8. User picks an agent and clicks "Bind to Agent"
9. Done — two Telegram bots, each routing to different agents

### Flow 2: Creating a Specific Chat Binding

1. User opens Relay dialog → Activity tab → selects an endpoint → sees inbox
2. Sees conversation rows with messages from various chats
3. On a specific chat's row, clicks the "Route to Agent" button
4. Popover shows agent picker — user selects "ProjectBot"
5. BindingDialog opens pre-filled with adapterId, chatId from that conversation
6. User confirms → binding created
7. Future messages from that chat now route specifically to "ProjectBot"

### Flow 3: Managing Bindings

1. User opens Relay dialog → Bindings tab
2. Sees list of bindings with adapter name, agent name, strategy, chatId badges
3. Clicks "New Binding" → full creation dialog with adapter/agent pickers
4. Clicks kebab menu on existing binding → "Add similar binding" → dialog pre-filled
5. Clicks kebab menu → "Edit" → dialog opens with editable fields (PATCH now works)
6. Clicks kebab menu → "Delete" → binding removed

### Flow 4: Sidebar Filtering

1. User is in a session with "LifeOS Agent" selected
2. Opens Settings → sidebar shows Connections tab
3. Connections tab shows "Showing 1 of 3 adapters for LifeOS Agent"
4. Only the Telegram adapter bound to LifeOS Agent is visible
5. User clicks "Show all" → sees all 3 adapters

## Testing Strategy

### Unit Tests

**BindingDialog tests** (`apps/client/src/layers/features/relay/ui/__tests__/BindingDialog.test.tsx`):

- Renders adapter/agent pickers in create mode
- Renders read-only adapter/agent in edit mode
- Submits with correct form values including chatId/channelType
- Clears chat filter when "Clear filters" clicked
- Pre-fills fields when `initialValues` provided (duplicate flow)

**BindingList tests** (`apps/client/src/layers/features/relay/ui/__tests__/BindingList.test.tsx`):

- Renders "New Binding" button
- Opens BindingDialog in create mode when button clicked
- Shows "Add similar binding" in kebab menu
- Pre-fills dialog correctly for duplicate (chatId cleared)

**AdapterCard tests** (`apps/client/src/layers/features/relay/__tests__/AdapterCard.test.tsx`):

- Shows amber dot and "No agent bound" when no bindings
- Shows green dot and bound agent names when bindings exist
- Shows adapter label as primary text, type name as secondary

**CatalogCard tests**:

- Shows instance count badge when `instanceCount > 0`
- Shows "Add Another" button text for multi-instance types with existing instances
- Shows "Add" button text when no instances exist

**PATCH route tests** (`apps/server/src/routes/__tests__/relay-bindings.test.ts`):

- Returns 200 with updated binding for valid PATCH
- Returns 400 for invalid update payload
- Returns 404 for non-existent binding ID
- Returns 503 when binding store unavailable
- Supports null values to clear optional fields (chatId, channelType)

**Observed chats tests** (`apps/server/src/routes/__tests__/relay-observed-chats.test.ts`):

- Returns aggregated chats from trace data
- Returns empty array when no traces exist for adapter
- Groups by chatId with correct counts and timestamps

### Integration Tests

**Binding CRUD roundtrip**: Create binding → read → update via PATCH → verify fields changed → delete → verify gone.

**Multi-instance adapter flow**: Add first Telegram adapter → verify success → add second Telegram adapter with different ID → verify both in catalog → verify both in adapter cards.

**Observed chats pipeline**: Publish messages through adapter with different chatIds → query observed chats endpoint → verify all chats returned with correct counts.

### Mocking Strategy

- Use `createMockTransport()` from `@dorkos/test-utils` for all client component tests
- Add `getObservedChats` stub to `createMockTransport()` returning fixture data
- Mock `useRegisteredAgents()` and `useAdapterCatalog()` for picker components
- Use `vi.mock()` for entity hooks when testing feature-layer components

## Performance Considerations

- **Observed chats query**: Could be expensive if trace store is large. Add a `limit` parameter (default 100) and cache results for 30 seconds on the client.
- **Binding count on AdapterCard**: Computed by filtering `useBindings()` result — no additional API call needed. The binding list is already cached by TanStack Query.
- **Sidebar filtering**: Pure client-side filtering of already-fetched data. No performance concern.
- **CatalogCard instance count**: Computed from existing catalog data. No additional API call.

## Security Considerations

- **PATCH validation**: The update schema restricts which fields are mutable (`sessionStrategy`, `label`, `chatId`, `channelType`). Fields like `adapterId`, `agentId`, and `id` cannot be changed via PATCH.
- **Observed chats**: The endpoint only returns chat IDs and metadata, not message content. No sensitive data exposure.
- **Adapter labels**: Labels are user-provided strings. Sanitize for XSS when rendering (React handles this by default).
- **Telegram bot tokens**: Never include in labels or display text. The auto-label uses `@username`, not the token.

## Documentation

- Update `contributing/relay-adapters.md` to document:
  - Multi-instance adapter configuration
  - Adapter label field and auto-generation
  - The `bind` wizard step
- Update `docs/relay.mdx` (user-facing) to cover:
  - Creating bindings from the Bindings tab
  - ChatId/channelType routing concepts
  - "Route to Agent" from conversation log
  - Managing multiple Telegram bots

## Implementation Phases

### Phase 1: Foundation (Bug Fix + Schema)

1. Add PATCH `/bindings/:id` route to server (`routes/relay.ts`)
2. Add `label` field to adapter config schema
3. Change Telegram manifest `multiInstance: false` → `true`
4. Add `ObservedChat` schema to `relay-adapter-schemas.ts`
5. Add `getObservedChats` to Transport interface + implementations

### Phase 2: Core Binding UX

6. Expand `BindingDialog` with adapter/agent pickers and chatId/channelType section
7. Add "New Binding" button to `BindingList`
8. Add "Add similar binding" action to BindingList kebab menu
9. Implement observed chats server endpoint and client hook

### Phase 3: Adapter Improvements

10. Add label input to `AdapterSetupWizard` configure step
11. Add Telegram auto-label from `getMe()` response
12. Update `AdapterCard` with label display, binding status dot, bound agents list
13. Update `CatalogCard` with instance count badge and "Add Another" button

### Phase 4: Post-Setup + Sidebar

14. Add optional "Bind to Agent" step to `AdapterSetupWizard`
15. Add "Route to Agent" action to `ConversationRow`
16. Implement sidebar Connections view filtering
17. Add one-time toast after adapter creation

### Phase 5: Tests + Polish

18. Write unit tests for all new/modified components
19. Write integration tests for PATCH route and observed chats
20. Update mock factories with new transport methods
21. Polish animations and transitions

## Open Questions

1. ~~**Observed chats data source**~~ (RESOLVED)
   **Answer:** Extract from trace store metadata. Traces already contain adapter ID, chat ID, and channel type from inbound messages.

2. ~~**Adapter label persistence format**~~ (RESOLVED)
   **Answer:** Top-level field in the adapter config JSON (alongside `id`, `type`, `enabled`). Cleaner separation. Existing configs without `label` default to `undefined` — no migration needed.

3. ~~**ConversationRow "Route to Agent" — popover vs dialog**~~ (RESOLVED)
   **Answer:** Popover with "More options..." link. Quick agent selection in a small inline popover for the fast path, with a "More options..." link that opens the full BindingDialog pre-filled for users who want to set chatId, channelType, or other advanced fields.

## Related ADRs

- **ADR-0044**: ConfigField descriptors drive the setup wizard form. Adapter naming uses a new top-level field rather than a ConfigField.
- **ADR-0046**: Central BindingRouter for adapter-agent routing. Adapters remain protocol bridges; bindings are the routing configuration.
- **ADR-0047**: Most-specific-first binding resolution. Scoring: adapterId+chatId+channelType (7) > adapterId+chatId (5) > adapterId+channelType (3) > adapterId-only (1).

## References

- Ideation document: `specs/adapter-binding-ux-overhaul/01-ideation.md`
- Research: `research/20260311_adapter_binding_configuration_ux_patterns.md`
- Research: `research/20260311_adapter_binding_ux_overhaul_gaps.md`
- Related spec 67: `specs/adapter-catalog-management/02-specification.md`
- Related spec 71: `specs/adapter-agent-routing/02-specification.md`
- Related spec 117: `specs/sidebar-tabbed-views/02-specification.md`
- Related spec 119: `specs/relay-adapter-dx/01-ideation.md`

## Changelog

### 2026-03-11 — Initial Draft

- Full specification covering all 7 areas of improvement
- Based on ideation document decisions and two research reports
