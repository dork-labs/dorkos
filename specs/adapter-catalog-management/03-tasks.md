# Task Breakdown: Adapter Catalog & Management UI
Generated: 2026-02-27
Source: specs/adapter-catalog-management/02-specification.md
Last Decompose: 2026-02-27

## Overview

Add a declarative adapter metadata system and management UI to DorkOS's Relay subsystem. Each adapter (built-in or npm plugin) declares an `AdapterManifest` with config schema descriptors, display info, and setup instructions. The server aggregates manifests into a browsable catalog. The client renders catalog cards, setup wizards with dynamic forms, and CRUD controls for adapter instances. Users can add, configure, test, and remove adapters entirely through the UI.

## Phase 1: Foundation

### Task 1.1: Add ConfigField, AdapterManifest, and CatalogEntry Zod schemas to shared package
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:
- Add seven Zod schemas to `packages/shared/src/relay-schemas.ts`: `ConfigFieldTypeSchema`, `ConfigFieldOptionSchema`, `ConfigFieldSchema`, `AdapterSetupStepSchema`, `AdapterCategorySchema`, `AdapterManifestSchema`, `CatalogEntrySchema`
- `ConfigFieldTypeSchema` supports: text, password, number, boolean, select, textarea, url
- `ConfigFieldSchema` includes: key, label, type, required, default, placeholder, description, options, section, showWhen
- `AdapterManifestSchema` includes: type, displayName, description, iconEmoji, category, docsUrl, builtin, configFields, setupSteps, setupInstructions, multiInstance
- `CatalogEntrySchema` pairs a manifest with an array of `CatalogInstanceSchema` (id, enabled, status)
- All schemas export inferred TypeScript types

**Acceptance Criteria**:
- [ ] All schemas exported from `packages/shared/src/relay-schemas.ts`
- [ ] All inferred types exported
- [ ] `pnpm typecheck` passes
- [ ] Tests validate that example manifests parse successfully
- [ ] Tests validate that invalid manifests are rejected

---

### Task 1.2: Export built-in adapter manifests from relay package
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:
- Add `TELEGRAM_MANIFEST` to `packages/relay/src/adapters/telegram-adapter.ts` with full config fields (token, mode, webhookUrl, webhookPort with showWhen conditions)
- Add `WEBHOOK_MANIFEST` to `packages/relay/src/adapters/webhook-adapter.ts` with nested dot-notation keys and section grouping (Inbound, Outbound)
- Add `CLAUDE_CODE_MANIFEST` to `packages/relay/src/adapters/claude-code-adapter.ts` with minimal config fields (maxConcurrent, defaultTimeoutMs)
- Re-export all three manifests from `packages/relay/src/index.ts`

**Acceptance Criteria**:
- [ ] All three manifests exported from `@dorkos/relay`
- [ ] Each manifest validates against `AdapterManifestSchema`
- [ ] Manifest configField keys match TypeScript config interfaces
- [ ] Tests in `packages/relay/src/__tests__/manifests.test.ts` pass

---

### Task 1.3: Add getCatalog and sensitive field masking to AdapterManager
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:
- Add `manifests` Map to AdapterManager, populated on initialize via `populateBuiltinManifests()`
- Add `getCatalog()` returning `CatalogEntry[]` pairing manifests with configured instances
- Add `maskSensitiveFields()` that traverses dot-notation paths for password-type fields
- Update `listAdapters()` to mask sensitive fields
- Add `getManifest()` and `registerPluginManifest()` accessors for Phase 2

**Acceptance Criteria**:
- [ ] `getCatalog()` returns all built-in manifests with instances
- [ ] Password fields masked with `'***'` in both getCatalog and listAdapters
- [ ] Dot-notation keys (e.g., `inbound.secret`) traversed and masked correctly
- [ ] All tests pass

---

### Task 1.4: Add GET /adapters/catalog route and Transport interface methods
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Technical Requirements**:
- Add `GET /api/relay/adapters/catalog` route BEFORE any parameterized adapter routes
- Add `getAdapterCatalog()` to Transport interface
- Implement in HttpTransport via `fetchJSON`
- Stub in DirectTransport returning empty array

**Acceptance Criteria**:
- [ ] `GET /api/relay/adapters/catalog` returns 200 with `CatalogEntry[]`
- [ ] Route ordering prevents "catalog" matching as adapter ID
- [ ] Transport interface updated across all implementations
- [ ] Route tests pass

---

## Phase 2: Server CRUD & Connection Test

### Task 2.1: Add addAdapter, removeAdapter, updateConfig methods to AdapterManager
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:
- `addAdapter(type, id, config, enabled)` — validates ID uniqueness, checks multiInstance constraint, persists, starts if enabled
- `removeAdapter(id)` — stops adapter, removes from config, persists; rejects built-in claude-code
- `updateConfig(id, config)` — merges config with password preservation (empty/masked passwords preserve existing), restarts adapter
- `AdapterError` class with typed error codes: DUPLICATE_ID, NOT_FOUND, UNKNOWN_TYPE, MULTI_INSTANCE_DENIED, REMOVE_BUILTIN_DENIED
- Password preservation uses dot-notation traversal matching maskSensitiveFields pattern

**Acceptance Criteria**:
- [ ] CRUD operations work correctly with proper error handling
- [ ] Password preservation for empty/masked submissions
- [ ] Adapter restart on config update
- [ ] Built-in claude-code cannot be removed
- [ ] All tests pass

---

### Task 2.2: Add testConnection method to AdapterManager
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- Create transient adapter instance, attempt `start()` with noop RelayPublisher
- 15-second timeout via `Promise.race`
- Always call `stop()` in finally block
- Never register adapter in registry
- Return `{ ok: true }` or `{ ok: false, error: string }`

**Acceptance Criteria**:
- [ ] Connection test creates, starts, and cleans up transient adapter
- [ ] 15-second timeout prevents hanging
- [ ] Adapter never registered in registry
- [ ] All tests pass

---

### Task 2.3: Add CRUD and test routes to relay router
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: Task 2.4

**Technical Requirements**:
- `POST /api/relay/adapters` — 201 on success, 400/409 on error
- `DELETE /api/relay/adapters/:id` — 200 on success, 404/400 on error
- `PATCH /api/relay/adapters/:id/config` — 200 on success, 400/404 on error
- `POST /api/relay/adapters/test` — 200 with `{ ok, error? }`
- AdapterError codes map to HTTP status codes (409 for DUPLICATE_ID, 404 for NOT_FOUND, 400 for others)
- Transport interface methods: addRelayAdapter, removeRelayAdapter, updateRelayAdapterConfig, testRelayAdapterConnection
- HttpTransport: fetchJSON implementations
- DirectTransport: throw "not supported in embedded mode"

**Acceptance Criteria**:
- [ ] All four routes work with correct status codes
- [ ] Transport interface updated across all implementations
- [ ] All route tests pass

---

### Task 2.4: Update plugin loader to extract manifests from plugin modules
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 2.3

**Technical Requirements**:
- Update `AdapterPluginModule` to include optional `getManifest?(): AdapterManifest`
- Add `LoadedAdapter` return type: `{ adapter, manifest? }`
- Update `loadAdapters()` to return `LoadedAdapter[]`
- Extract manifest via `getManifest()` with schema validation, fallback to minimal manifest
- Update `AdapterManager.loadPlugin()` to register discovered plugin manifests

**Acceptance Criteria**:
- [ ] Plugin modules with `getManifest()` have manifests extracted and validated
- [ ] Plugins without `getManifest()` get minimal fallback manifest
- [ ] `AdapterManager.loadPlugin()` registers plugin manifests
- [ ] All tests pass

---

## Phase 3: Client Catalog UI

### Task 3.1: Add adapter catalog entity hooks
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.4
**Can run parallel with**: Task 3.2, Task 3.3

**Technical Requirements**:
- `useAdapterCatalog(enabled?)` — TanStack Query with 30s refetch interval
- `useAddAdapter()` — mutation invalidating catalog + adapters queries
- `useRemoveAdapter()` — mutation invalidating catalog + adapters queries
- `useUpdateAdapterConfig()` — mutation invalidating catalog + adapters queries
- `useTestAdapterConnection()` — mutation with no query invalidation
- All hooks in `entities/relay/model/use-adapter-catalog.ts`, exported from entity barrel

**Acceptance Criteria**:
- [ ] All five hooks exported from `@/layers/entities/relay`
- [ ] Correct query key patterns for cache invalidation
- [ ] Hook tests pass

---

### Task 3.2: Build ConfigFieldInput component
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.1, Task 3.3

**Technical Requirements**:
- Maps seven ConfigField types to shadcn/ui components: text -> Input, url -> Input[type=url], password -> Input[type=password] with eye toggle, number -> Input[type=number], boolean -> Switch, select -> Select, textarea -> Textarea
- Each field renders: Label (with required asterisk), input component, description text, error message
- `showWhen` conditional visibility: hide when condition not met
- `ConfigFieldGroup` component for section-based grouping with section headings
- Password eye toggle button with aria-label

**Acceptance Criteria**:
- [ ] All seven field types render correctly
- [ ] Password toggle works
- [ ] showWhen conditional visibility works
- [ ] Section grouping works
- [ ] All tests pass

---

### Task 3.3: Build CatalogCard component
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.1, Task 3.2

**Technical Requirements**:
- Display: icon emoji, display name, category badge (color-coded), description
- "Add" button with Plus icon calls `onAdd` callback
- Category colors: messaging=blue, automation=purple, internal=gray, custom=green
- Hover effect on card

**Acceptance Criteria**:
- [ ] Card displays all manifest info
- [ ] Add button triggers callback
- [ ] Category badges have correct colors
- [ ] Tests pass

---

### Task 3.4: Build AdapterSetupWizard component
**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1, Task 3.2
**Can run parallel with**: None

**Technical Requirements**:
- Dialog-based wizard with three steps: configure, test, confirm
- Add mode: empty form with defaults, adapter ID field, setup instructions callout
- Edit mode: pre-filled values (passwords empty with "Leave blank to keep current"), no ID field
- Multi-step navigation when `manifest.setupSteps` is defined
- Test step: spinner during pending, green check on success, red X on failure, "Skip" link
- Confirm step: value summary with passwords masked as "***"
- `unflattenConfig()` converts dot-notation flat form to nested objects
- Local React state (useState) for wizard form — not Zustand
- Auto-generated adapter ID from type (with suffix for multiInstance)

**Acceptance Criteria**:
- [ ] Three-step wizard flow works
- [ ] Add and edit modes behave correctly
- [ ] Multi-step navigation works
- [ ] Connection test shows appropriate states
- [ ] `unflattenConfig` handles dot-notation keys
- [ ] All tests pass

---

### Task 3.5: Upgrade AdaptersTab and enhance AdapterCard with kebab menu
**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1, Task 3.3, Task 3.4
**Can run parallel with**: None

**Technical Requirements**:
- Replace AdaptersTab data source from `useRelayAdapters` to `useAdapterCatalog`
- Two sections: "Configured Adapters" (instances from catalog) and "Available Adapters" (unconfigured types + multiInstance types)
- AdapterCard gets kebab menu (DropdownMenu) with Configure and Remove options
- Remove shows AlertDialog confirmation dialog
- Built-in claude-code Remove is disabled with tooltip "Built-in adapter cannot be removed."
- CatalogCard Add and AdapterCard Configure both open AdapterSetupWizard
- Wizard state managed locally in the tab component

**Acceptance Criteria**:
- [ ] Two-section layout renders correctly
- [ ] Kebab menu with Configure and Remove
- [ ] Remove confirmation dialog
- [ ] Built-in claude-code cannot be removed
- [ ] Wizard integration for add and edit
- [ ] All tests pass

---

## Phase 4: Polish & Documentation

### Task 4.1: Handle edge cases and improve error UX
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.5
**Can run parallel with**: Task 4.2

**Technical Requirements**:
- Network error toast notifications for CRUD mutation failures
- Optimistic UI for enable/disable toggle on AdapterCard
- Loading skeleton cards while catalog fetches
- Empty state message when no adapters available to add
- Manual "Refresh" button on AdaptersTab header
- Verify no duplicate adapter starts during config hot-reload

**Acceptance Criteria**:
- [ ] Error toasts for mutation failures
- [ ] Optimistic toggle updates
- [ ] Loading skeletons
- [ ] Empty state
- [ ] Refresh button
- [ ] No hot-reload issues

---

### Task 4.2: Update contributing docs with adapter manifest documentation
**Size**: Medium
**Priority**: Low
**Dependencies**: Task 2.3
**Can run parallel with**: Task 4.1

**Technical Requirements**:
- Update `contributing/relay-adapters.md` with Adapter Manifest section
- Document ConfigField types, showWhen, setupSteps, section grouping
- Show complete Telegram manifest as reference example
- Document plugin manifest export via `getManifest()`
- Update `contributing/api-reference.md` with five new endpoints
- Include example request/response for each endpoint

**Acceptance Criteria**:
- [ ] Adapter Manifest section in relay-adapters.md
- [ ] Plugin manifest creation instructions
- [ ] All five endpoints documented in api-reference.md
- [ ] No broken internal links
