# Task Breakdown: Adapter & Binding UX Overhaul

Generated: 2026-03-11
Source: specs/adapter-binding-ux-overhaul/02-specification.md
Last Decompose: 2026-03-11

## Overview

Overhaul the adapter and binding system across seven areas: multi-instance Telegram adapters, adapter naming/labeling, binding management improvements (create, chatId/channelType selection, duplication, PATCH bug fix), post-adapter-setup binding flow, sidebar Connections view filtering, and a new observed chats API. The underlying relay architecture is unchanged; this work focuses on the UX layer and a missing server route.

## Phase 1: Foundation

### Task 1.1: Add PATCH /bindings/:id server route

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3, 1.4

**Technical Requirements**:

- Add PATCH route to `apps/server/src/routes/relay.ts` between POST and DELETE binding routes
- Zod validation schema: `sessionStrategy` (optional), `label` (optional), `chatId` (optional, nullable), `channelType` (optional, nullable)
- Convert `null` values to `undefined` for clearing optional fields
- Use existing `BindingStore.update()` method (lines 130-144 of binding-store.ts)
- Verify HttpTransport sends PATCH to `/api/relay/bindings/:id`

**Implementation Steps**:

1. Add `router.patch('/bindings/:id', ...)` in the `if (adapterManager)` block
2. Import `SessionStrategySchema` and `ChannelTypeSchema` from `@dorkos/shared/relay-schemas`
3. Validate request body with Zod schema
4. Handle null-to-undefined conversion for clearing optional fields
5. Return 200 with updated binding, or 404/400/503 for errors
6. Verify HttpTransport implementation

**Acceptance Criteria**:

- [ ] PATCH `/api/relay/bindings/:id` returns 200 with updated binding
- [ ] Validation rejects invalid session strategy values
- [ ] Sending null for chatId/channelType clears those fields
- [ ] 404 for non-existent binding IDs
- [ ] 503 when binding store unavailable
- [ ] 6 unit tests pass

---

### Task 1.2: Add label field to adapter config schema and server

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3, 1.4

**Technical Requirements**:

- Add `label: z.string().optional()` to `CatalogInstanceSchema` in `relay-adapter-schemas.ts`
- Add `label: z.string().optional()` to `AdapterCreateRequestSchema`
- Server `addAdapter()`: extract label from config record before passing to adapter factory
- Server `getCatalog()`: include label in each CatalogInstance
- Backward compatible: existing adapters without labels continue to work

**Implementation Steps**:

1. Update `CatalogInstanceSchema` with optional label field
2. Update `AdapterCreateRequestSchema` with optional label field
3. Modify `AdapterManager.addAdapter()` to extract `label` from config
4. Modify `AdapterManager.getCatalog()` to return label per instance
5. Write tests for label storage and retrieval

**Acceptance Criteria**:

- [ ] CatalogInstanceSchema includes optional label field
- [ ] AdapterCreateRequestSchema includes optional label field
- [ ] Server addAdapter() extracts and stores label
- [ ] Server getCatalog() returns label in each CatalogInstance
- [ ] Existing adapters without labels continue to work
- [ ] Label is not passed to adapter constructors

---

### Task 1.3: Enable multi-instance Telegram adapters

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.4

**Technical Requirements**:

- Change `multiInstance: false` to `multiInstance: true` in Telegram manifest
- No changes needed to AdapterManager (already supports multiInstance: true)
- Verify two Telegram adapters can coexist

**Implementation Steps**:

1. Change line 34 of `TELEGRAM_MANIFEST` in `packages/relay/src/adapters/telegram/telegram-adapter.ts`
2. Verify AdapterManager guard logic at lines 337-345
3. Write tests for multi-instance behavior

**Acceptance Criteria**:

- [ ] TELEGRAM_MANIFEST.multiInstance is true
- [ ] Two Telegram adapters with different IDs can coexist
- [ ] Catalog shows both instances under the Telegram entry
- [ ] Independent enable/disable works for each instance

---

### Task 1.4: Add ObservedChat schema and Transport method

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3

**Technical Requirements**:

- Add `ObservedChatSchema` to `relay-adapter-schemas.ts` with fields: chatId, displayName (optional), channelType (optional), lastMessageAt, messageCount
- Add `getObservedChats(adapterId)` to Transport interface
- Implement in HttpTransport (GET `/api/relay/adapters/:id/chats`)
- Stub in DirectTransport (returns empty array)
- Add to `createMockTransport()` in test-utils

**Implementation Steps**:

1. Define ObservedChatSchema and ObservedChatsResponseSchema in relay-adapter-schemas.ts
2. Add getObservedChats to Transport interface in transport.ts
3. Implement in HttpTransport
4. Stub in DirectTransport
5. Update createMockTransport()

**Acceptance Criteria**:

- [ ] ObservedChatSchema exported from @dorkos/shared/relay-schemas
- [ ] getObservedChats(adapterId) method on Transport interface
- [ ] HttpTransport hits /api/relay/adapters/:id/chats
- [ ] DirectTransport returns empty array
- [ ] createMockTransport() includes getObservedChats stub
- [ ] TypeScript compiles without errors

---

## Phase 2: Core Binding UX

### Task 2.1: Implement observed chats server endpoint and client hook

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.4
**Can run parallel with**: None

**Technical Requirements**:

- Add GET `/adapters/:id/chats` route to relay.ts
- Add `getObservedChats(adapterId, limit)` method to TraceStore class
- Query trace metadata for chatId grouping via SQLite json_extract
- Create `useObservedChats(adapterId)` TanStack Query hook in entities/relay
- 30-second staleTime, disabled when adapterId undefined

**Implementation Steps**:

1. Add TraceStore.getObservedChats() method with JSON metadata extraction
2. Add GET route in relay.ts inside adapterManager block
3. Create useObservedChats hook in entities/relay/model/
4. Export from entities/relay/index.ts
5. Write server tests for aggregation, empty results, limit

**Acceptance Criteria**:

- [ ] GET /api/relay/adapters/:id/chats returns observed chats
- [ ] TraceStore groups by chatId with correct counts
- [ ] Client hook returns query result
- [ ] Hook disabled when adapterId undefined
- [ ] Server tests pass

---

### Task 2.2: Expand BindingDialog with adapter/agent pickers and chat filter

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.4, 2.1
**Can run parallel with**: None

**Technical Requirements**:

- New BindingFormValues interface with adapterId, agentId, projectPath, sessionStrategy, label, chatId, channelType
- Create mode: adapter picker (from useAdapterCatalog), agent picker (from useRegisteredAgents), project path, session strategy, label, collapsible chat filter
- Edit mode: read-only adapter/agent, editable strategy/label/chatId/channelType
- Chat filter: collapsible section with chatId dropdown (from useObservedChats) and channelType dropdown
- "Active" badge on collapsible when filters set

**Implementation Steps**:

1. Define new BindingFormValues and BindingDialogProps interfaces
2. Add adapter/agent picker state and UI for create mode
3. Add chat filter collapsible section with chatId/channelType pickers
4. Wire up useObservedChats to populate chatId picker
5. Update confirm handler to pass all fields
6. Add edit mode with read-only adapter/agent display
7. Write component tests

**Acceptance Criteria**:

- [ ] Create mode shows all pickers and fields
- [ ] Edit mode shows read-only adapter/agent
- [ ] Chat filter is collapsible with Active badge
- [ ] ChatId picker populated from observed chats
- [ ] Clear filters button works
- [ ] All tests pass

---

### Task 2.3: Add New Binding button and duplicate action to BindingList

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, 2.2
**Can run parallel with**: None

**Technical Requirements**:

- "New Binding" button in header above binding list (also above empty state)
- Opens BindingDialog in create mode with no pre-filled values
- "Add similar binding" action in kebab menu between Edit and Delete
- Duplicate pre-fills all fields except chatId (intentionally cleared)
- Update edit handler to work with new BindingFormValues

**Implementation Steps**:

1. Add create dialog state and "New Binding" button in list header
2. Add duplicate state and "Add similar binding" dropdown menu item
3. Wire up create/duplicate dialogs to BindingDialog
4. Update edit handler for new BindingFormValues interface
5. Write tests for new button, duplicate action, and pre-fill behavior

**Acceptance Criteria**:

- [ ] "New Binding" button visible above binding list and empty state
- [ ] Create dialog opens in create mode
- [ ] "Add similar binding" in kebab menu
- [ ] Duplicate pre-fills all except chatId
- [ ] Edit passes chatId/channelType updates
- [ ] Tests pass

---

## Phase 3: Adapter Improvements

### Task 3.1: Add label input and Telegram auto-label to AdapterSetupWizard

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.2
**Can run parallel with**: Task 3.2, 3.3

**Technical Requirements**:

- "Name" text input on Configure step, above adapter-specific fields
- Include label in config record when calling addRelayAdapter
- Extend Telegram test response to include botUsername from getMe()
- Auto-populate label with @username when test succeeds and label is empty
- User-set label must not be overwritten by auto-label

**Implementation Steps**:

1. Add label state and input to configure step
2. Include label in config when submitting
3. Extend Telegram testConnection to return botUsername
4. Update testRelayAdapterConnection return type (add optional botUsername)
5. Auto-fill label from test result
6. Write tests

**Acceptance Criteria**:

- [ ] Name input appears above config fields
- [ ] Label included in config when provided
- [ ] Telegram test response includes botUsername
- [ ] Auto-label with @username when label empty
- [ ] User-set label preserved
- [ ] Tests pass

---

### Task 3.2: Update AdapterCard with label display and binding status

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.2
**Can run parallel with**: Task 3.1, 3.3

**Technical Requirements**:

- Show label as primary text, type displayName as secondary (when label exists)
- Status dot: green (connected + bindings), amber (connected + no bindings), red (error)
- Bound agents list below adapter info
- "No agent bound" text + "Bind" button in amber state
- New onBindClick prop for opening BindingDialog

**Implementation Steps**:

1. Update card header with label/displayName display
2. Add status dot with binding-aware color logic
3. Add bound agents display using useBindings + useRegisteredAgents
4. Add amber state UI with "Bind" button
5. Add onBindClick prop
6. Write tests

**Acceptance Criteria**:

- [ ] Label shown as primary, type name as secondary
- [ ] Green/amber/red dot based on connection and binding state
- [ ] Bound agent names listed
- [ ] "Bind" button in amber state
- [ ] Tests pass

---

### Task 3.3: Update CatalogCard with instance count and Add Another button

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Task 3.1, 3.2

**Technical Requirements**:

- Add instanceCount prop to CatalogCardProps
- Show "{N} configured" badge when instanceCount > 0
- Button text "Add Another" when instances exist, "Add" when none
- Parent component passes instanceCount from catalog entry
- Multi-instance types shown in Available section even with existing instances

**Implementation Steps**:

1. Add instanceCount prop to CatalogCard
2. Add instance count badge
3. Update button text logic
4. Update parent component to filter and pass instanceCount
5. Write tests

**Acceptance Criteria**:

- [ ] Badge shows "{N} configured" when instances exist
- [ ] "Add Another" vs "Add" button text
- [ ] Multi-instance types in Available section
- [ ] Tests pass

---

## Phase 4: Post-Setup and Sidebar

### Task 4.1: Add optional Bind to Agent step to AdapterSetupWizard

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 3.1, 2.2
**Can run parallel with**: Task 4.3

**Technical Requirements**:

- New 'bind' wizard step after 'confirm'
- Agent picker dropdown from useRegisteredAgents
- Session strategy selector
- "Bind to Agent" (primary) and "Skip" (ghost) buttons
- Creates binding via useCreateBinding when confirmed
- Sonner toast after adapter creation
- Step indicator shows 4 steps

**Implementation Steps**:

1. Extend WizardStep type with 'bind'
2. Add bind step state (agentId, strategy, createdAdapterId)
3. Implement bind step UI with agent picker and strategy selector
4. Add bind handler using useCreateBinding
5. Add toast notification on adapter creation
6. Update step indicator
7. Write tests

**Acceptance Criteria**:

- [ ] Bind step appears after confirm
- [ ] Agent picker populates from registry
- [ ] "Bind to Agent" creates binding
- [ ] "Skip" closes wizard
- [ ] Toast fires on adapter creation
- [ ] Tests pass

---

### Task 4.2: Add Route to Agent action to ConversationRow

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 2.2, 2.3
**Can run parallel with**: Task 4.1, 4.3

**Technical Requirements**:

- "Route" button on each ConversationRow
- Popover with agent picker dropdown
- Quick route: creates binding with chatId pre-filled from conversation
- "More options..." link opens full BindingDialog pre-filled
- stopPropagation prevents row expand on Route click
- Extract adapterId, chatId, channelType from conversation metadata

**Implementation Steps**:

1. Add Route button and Popover to ConversationRow
2. Add agent picker in popover
3. Implement quick route handler (creates binding directly)
4. Implement "More options" handler (opens BindingDialog)
5. Add metadata extraction helpers
6. Write tests

**Acceptance Criteria**:

- [ ] Route button visible on conversation rows
- [ ] Popover with agent picker
- [ ] Quick route creates binding with chatId
- [ ] "More options" opens pre-filled BindingDialog
- [ ] Tests pass

---

### Task 4.3: Implement sidebar Connections view filtering

**Size**: Medium
**Priority**: Low
**Dependencies**: Task 1.2
**Can run parallel with**: Task 4.1, 4.2

**Technical Requirements**:

- Add connectionFilter prop to NavigationLayout (shared layer)
- Filter summary: "Showing N of M adapters for [Agent Name]"
- "Show all" button to remove filter
- No filter when no agent selected
- FSD compliance: filtering logic in parent component, passed via props

**Implementation Steps**:

1. Add connectionFilter prop type to NavigationLayout
2. Add filter summary UI and "Show all" button
3. Create useConnectionFilter hook in parent component
4. Compute filtered adapter IDs from bindings
5. Write tests

**Acceptance Criteria**:

- [ ] Filter summary shows correct counts
- [ ] Only filtered adapters displayed
- [ ] "Show all" removes filter
- [ ] No filter when no agent selected
- [ ] FSD layers respected
- [ ] Tests pass

---

## Phase 5: Integration Tests and Polish

### Task 5.1: Write integration tests for binding CRUD and observed chats

**Size**: Large
**Priority**: Medium
**Dependencies**: Task 1.1, 1.3, 2.1
**Can run parallel with**: Task 5.2

**Technical Requirements**:

- Binding CRUD roundtrip: create, read, PATCH update, verify, delete, verify gone
- Null clearing test: PATCH with `chatId: null` clears the field
- Multi-instance adapter flow: add two Telegram adapters, verify both in catalog
- Observed chats pipeline: insert traces with different chatIds, query, verify aggregation
- Empty adapter observed chats: verify empty array for unknown adapter

**Implementation Steps**:

1. Set up test harness with Express app, mock AdapterManager, test SQLite
2. Write binding CRUD roundtrip test
3. Write null clearing test
4. Write multi-instance adapter test
5. Write observed chats aggregation tests
6. Verify all pass in CI

**Acceptance Criteria**:

- [ ] Binding CRUD roundtrip passes
- [ ] Null clearing passes
- [ ] Multi-instance adapter passes
- [ ] Observed chats aggregation passes
- [ ] All integration tests pass in CI

---

### Task 5.2: Update mock factories and polish animations

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 4.1, 4.2, 4.3
**Can run parallel with**: Task 5.1

**Technical Requirements**:

- Verify createMockTransport includes all new methods
- Add createMockObservedChat() and createMockBinding() fixture factories
- Verify wizard bind step animation matches existing steps (motion/react)
- Amber status dot uses Tailwind animate-pulse
- Run full test suite with no regressions

**Implementation Steps**:

1. Verify and update createMockTransport
2. Add mock data fixture factories
3. Review animation consistency across new components
4. Run full test suite
5. Fix any regressions

**Acceptance Criteria**:

- [ ] createMockTransport includes all new methods
- [ ] Fixture factories exported
- [ ] Animations consistent
- [ ] Full test suite passes
- [ ] No TypeScript errors
