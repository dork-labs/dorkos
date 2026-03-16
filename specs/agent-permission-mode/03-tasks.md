# Task Breakdown: Agent Permission Mode for Adapter Bindings

Generated: 2026-03-15
Source: specs/agent-permission-mode/02-specification.md
Last Decompose: 2026-03-15

## Overview

Add a `permissionMode` field to adapter-agent bindings so that adapter-triggered agent sessions (e.g., from Slack or Telegram messages) use the binding's configured permission mode instead of the invalid `'auto'` value currently hardcoded in the adapter manager. This prevents headless agent sessions from silently skipping tools.

The implementation spans: schema change (shared package), server pipeline (binding store, binding router, adapter manager), client UI (BindingDialog), and documentation.

## Phase 1: Foundation

### Task 1.1: Add permissionMode field to AdapterBindingSchema
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:
- Add `permissionMode: PermissionModeSchema.optional().default('acceptEdits')` to `AdapterBindingSchema` in `packages/shared/src/relay-adapter-schemas.ts`
- Import `PermissionModeSchema` from `./schemas.js`
- Existing bindings without the field will default to `acceptEdits` when parsed
- `CreateBindingRequestSchema` (which uses `.omit()`) inherits the field automatically

**Implementation Steps**:
1. Add import for `PermissionModeSchema` from `./schemas.js`
2. Add `permissionMode` field between `label` and `canInitiate` in the schema
3. Create schema tests in `packages/shared/src/__tests__/relay-adapter-schemas.test.ts`

**Acceptance Criteria**:
- [ ] `permissionMode` field exists with `optional().default('acceptEdits')`
- [ ] Schema tests pass: default value, all valid modes accepted, invalid modes rejected
- [ ] `pnpm typecheck` passes across the monorepo

---

### Task 1.2: Add permissionMode to BindingStore update method and API route
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.3

**Technical Requirements**:
- Add `'permissionMode'` to the `Partial<Pick<...>>` type in `BindingStore.update()`
- Add `permissionMode: PermissionModeSchema.optional()` to the `UpdateBindingSchema` in the `PATCH /bindings/:id` route

**Implementation Steps**:
1. Update `apps/server/src/services/relay/binding-store.ts` — add `'permissionMode'` to the Pick union
2. Update `apps/server/src/routes/relay.ts` — add `permissionMode` to `UpdateBindingSchema`
3. Add binding store tests for permissionMode update and preservation

**Acceptance Criteria**:
- [ ] `BindingStore.update()` accepts `permissionMode`
- [ ] `PATCH /bindings/:id` validates and accepts `permissionMode`
- [ ] Tests verify update and preservation of permissionMode

---

### Task 1.3: Update AgentSessionCreator interface to accept permissionMode
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.2

**Technical Requirements**:
- Update `AgentSessionCreator.createSession()` to accept optional `permissionMode` parameter
- Update `BindingRouter.createNewSession()` to pass `binding.permissionMode` to the session creator
- Update `handleInbound()` enriched payload to include `permissionMode` in `__bindingPermissions`

**Implementation Steps**:
1. Import `PermissionMode` type in `binding-router.ts`
2. Update `AgentSessionCreator` interface signature
3. Update `createNewSession()` to pass `binding.permissionMode`
4. Update `handleInbound()` enriched payload `__bindingPermissions` object
5. Add binding router tests for permissionMode passthrough

**Acceptance Criteria**:
- [ ] `AgentSessionCreator.createSession` accepts optional `permissionMode`
- [ ] `createNewSession` passes `binding.permissionMode` to session creator
- [ ] Enriched payload includes `permissionMode` in `__bindingPermissions`
- [ ] Binding router tests pass

---

### Task 1.4: Fix adapter-manager permissionMode 'auto' bug
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Technical Requirements**:
- Replace `permissionMode: 'auto'` with `permissionMode: permissionMode ?? 'acceptEdits'` in `adapter-manager.ts`
- Update the `sessionCreator` to accept and forward the `permissionMode` parameter

**Implementation Steps**:
1. Import `PermissionMode` type
2. Update `sessionCreator.createSession` to accept `permissionMode` parameter
3. Replace hardcoded `'auto'` with the passed-through value or `'acceptEdits'` fallback
4. Verify no other occurrences of `permissionMode: 'auto'` exist

**Acceptance Criteria**:
- [ ] `permissionMode: 'auto'` replaced with valid values
- [ ] `sessionCreator` accepts and forwards `permissionMode`
- [ ] No `permissionMode: 'auto'` remains in codebase
- [ ] `pnpm typecheck` and `pnpm test -- --run` pass

---

## Phase 2: Client UI

### Task 2.1: Add permissionMode to BindingFormValues and BindingDialog state
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:
- Add `permissionMode?: PermissionMode` to `BindingFormValues` interface
- Add state management (`useState`, `useEffect` sync, reset)
- Update `advancedOpen` auto-detection and `hasAdvancedChanges` badge logic
- Include `permissionMode` in `handleConfirm` and `resetForm`

**Implementation Steps**:
1. Import `PermissionMode` type
2. Add `permissionMode` to `BindingFormValues`
3. Add `permissionMode`, `bypassWarningOpen`, `pendingPermissionMode` state variables
4. Update `useEffect` sync block
5. Update `advancedOpen` initial state and effect
6. Update `hasAdvancedChanges` computation
7. Update `handleConfirm` to include `permissionMode`
8. Update `resetForm` to reset all new state

**Acceptance Criteria**:
- [ ] `BindingFormValues` includes `permissionMode`
- [ ] State syncs from `initialValues` and resets correctly
- [ ] Advanced section auto-opens for non-default permissionMode
- [ ] Badge reflects non-default permissionMode
- [ ] Form submission includes permissionMode

---

### Task 2.2: Add permission mode Select component and bypassPermissions security warning
**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:
- Define `PERMISSION_MODE_OPTIONS` constant with labels and descriptions
- Add `Select` component in the Advanced collapsible section
- Add `bypassPermissions` change interception with `AlertDialog` security warning
- Filter options by runtime capabilities when available

**Implementation Steps**:
1. Define `PERMISSION_MODE_OPTIONS` constant
2. Add `handlePermissionModeChange` function with bypass interception
3. Add `Select` component between Session Strategy and Permissions toggles
4. Add security warning `AlertDialog` for `bypassPermissions`
5. Add component tests for rendering, submission, and security warning

**Acceptance Criteria**:
- [ ] Permission mode Select renders in Advanced section
- [ ] Description text shows below selector
- [ ] `bypassPermissions` triggers AlertDialog warning
- [ ] Confirming AlertDialog sets the mode; canceling leaves it unchanged
- [ ] Component tests pass

---

## Phase 3: Integration and Polish

### Task 3.1: Verify end-to-end binding CRUD and update documentation
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.4, Task 2.2
**Can run parallel with**: None

**Technical Requirements**:
- Verify full CRUD flow with `permissionMode`
- Verify backward compatibility with bindings missing the field
- Update `contributing/relay-adapters.md` with permission mode documentation
- Run full test suite, typecheck, and lint

**Implementation Steps**:
1. Manual verification of create, edit, and backward compatibility
2. Update `contributing/relay-adapters.md` with permission mode section
3. Run `pnpm test -- --run`, `pnpm typecheck`, `pnpm lint`

**Acceptance Criteria**:
- [ ] Full test suite passes
- [ ] Type checking passes
- [ ] Linting passes
- [ ] Backward compatibility verified
- [ ] Documentation updated
- [ ] No `permissionMode: 'auto'` remains in codebase

---

## Dependency Graph

```
1.1 (Schema) ──┬── 1.2 (Store + API) ──┐
               │                        │
               ├── 1.3 (Router) ── 1.4 (Bug Fix) ──┐
               │                                     │
               └── 2.1 (UI State) ── 2.2 (UI Components) ── 3.1 (Integration)
```

## Parallel Opportunities

- Tasks 1.2 and 1.3 can run in parallel (both depend only on 1.1)
- Phase 2 (UI) can begin as soon as 1.1 completes, in parallel with 1.2-1.4

## Critical Path

1.1 → 1.3 → 1.4 → 3.1 (server pipeline)
1.1 → 2.1 → 2.2 → 3.1 (client UI)
