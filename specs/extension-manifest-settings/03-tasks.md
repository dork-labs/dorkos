# Extension Manifest Settings — Task Breakdown

**Spec:** `specs/extension-manifest-settings/02-specification.md`
**Generated:** 2026-03-29
**Mode:** Full decomposition

---

## Phase 1: Schema + Placeholder + Group (Foundation)

Foundation changes to the Zod manifest schemas, barrel exports, tests, and initial UI for placeholder/group rendering on the existing secrets panel.

### 1.1 Add SettingDeclarationSchema, SettingOptionSchema, and extend SecretDeclarationSchema

**Size:** Medium | **Priority:** High | **Dependencies:** None

**Files:**

- `packages/extension-api/src/manifest-schema.ts`

**What:**

- Add `SettingOptionSchema` (label + value for select options)
- Add `SettingDeclarationSchema` (type, key, label, description, placeholder, default, required, group, options, min, max)
- Extend `SecretDeclarationSchema` with optional `placeholder` and `group` fields
- Add optional `settings` array to `ServerCapabilitiesSchema`
- Export `SettingOption` and `SettingDeclaration` types (via `z.infer`)
- Export `SettingOptionSchema` and `SettingDeclarationSchema` for runtime validation

All changes are additive and optional — existing manifests continue to parse correctly.

---

### 1.2 Update barrel exports in extension-api index.ts

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

**Files:**

- `packages/extension-api/src/index.ts`

**What:**

- Add `SettingOption`, `SettingDeclaration` type exports from `manifest-schema.js`
- Add `SettingOptionSchema`, `SettingDeclarationSchema` schema exports from `manifest-schema.js`
- `SettingsStore` export deferred to task 2.1 (when the interface is created)

---

### 1.3 Add manifest schema tests for settings declarations, placeholder, and group

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

**Files:**

- `packages/extension-api/src/__tests__/manifest-schema.test.ts`

**What:**

- `SettingDeclarationSchema` tests: all four types (text, number, boolean, select), key validation, required defaults, edge cases
- `SecretDeclarationSchema` tests: placeholder/group acceptance, backward compatibility without those fields
- `ServerCapabilitiesSchema` tests: settings alongside secrets, settings-only, invalid settings types, legacy manifests

---

### 1.4 Render placeholder on PasswordInput and add group-based CollapsibleFieldCard

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 1.2, 1.3

**Files:**

- `apps/client/src/layers/features/extensions/ui/ManifestSecretsPanel.tsx`

**What:**

- Replace hardcoded `secret.key` placeholder with `secret.placeholder ?? secret.key`
- Add `groupSecrets()` helper to organize secrets by `group` field
- Render ungrouped secrets in a flat `FieldCard`
- Render named groups as `CollapsibleFieldCard` sections
- Import `CollapsibleFieldCard` from shared UI

Delivers visible UI improvements before the full unified panel in Phase 3.

---

## Phase 2: Settings Storage + API (Server)

Server-side infrastructure: the `SettingsStore` interface, plaintext JSON file storage, CRUD API endpoints, and factory wiring.

### 2.1 Add SettingsStore interface to server-extension-api.ts

**Size:** Small | **Priority:** High | **Dependencies:** 1.2

**Files:**

- `packages/extension-api/src/server-extension-api.ts`
- `packages/extension-api/src/index.ts`

**What:**

- Add `SettingsStore` interface with `get<T>()`, `set()`, `delete()`, `getAll()` methods
- Add `readonly settings: SettingsStore` to `DataProviderContext` interface
- Export `SettingsStore` from barrel

**Impact:** Adding `settings` to `DataProviderContext` causes a transient TypeScript error in the server API factory until task 2.3 resolves it.

---

### 2.2 Create ExtensionSettingsStore

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

**Files:**

- `packages/shared/src/extension-settings.ts` (NEW)
- `packages/shared/package.json` (subpath export)

**What:**

- Implement `SettingsStore` interface with plaintext JSON file storage
- Store at `{dorkHome}/extension-settings/{extensionId}.json`
- Atomic writes via temp-file-then-rename pattern (matches `ExtensionSecretStore`)
- No encryption, no in-memory cache
- Values are `string | number | boolean`
- Add `./extension-settings` subpath export to `packages/shared/package.json`

---

### 2.3 Update extension-server-api-factory.ts with settings

**Size:** Small | **Priority:** High | **Dependencies:** 2.2 | **Parallel with:** 2.4, 2.5

**Files:**

- `apps/server/src/services/extensions/extension-server-api-factory.ts`

**What:**

- Import `ExtensionSettingsStore` from `@dorkos/shared/extension-settings`
- Instantiate `ExtensionSettingsStore(dorkHome, extensionId)` alongside the existing `ExtensionSecretStore`
- Add `settings` to the `DataProviderContext` object

---

### 2.4 Add settings CRUD endpoints to extensions router

**Size:** Medium | **Priority:** High | **Dependencies:** 2.2 | **Parallel with:** 2.3, 2.5

**Files:**

- `apps/server/src/routes/extensions.ts`

**What:**

- `GET /api/extensions/:id/settings` — Returns declared settings merged with stored values and defaults
- `PUT /api/extensions/:id/settings/:key` — Stores a setting value (validates key against manifest declarations)
- `DELETE /api/extensions/:id/settings/:key` — Resets a setting to its manifest default

Response shape includes `isDefault` flag, options, min/max for UI rendering.

---

### 2.5 Add ExtensionSettingsStore unit tests

**Size:** Medium | **Priority:** High | **Dependencies:** 2.2 | **Parallel with:** 2.3, 2.4

**Files:**

- `packages/shared/src/__tests__/extension-settings.test.ts` (NEW)

**What:**

- CRUD operations: get/set/delete/getAll for string, number, boolean
- Edge cases: missing keys (null), false booleans, zero numbers, empty strings
- Extension isolation: different IDs use different files
- Persistence: new instance reads same file
- Directory auto-creation for nested paths
- Uses real filesystem (tmpdir), not mocks

---

## Phase 3: Unified Settings Panel (Client)

Client-side unified settings UI: rename panel, add field renderers, update extension loader, add tests.

### 3.1 Rename ManifestSecretsPanel to ManifestSettingsPanel and add field renderers

**Size:** Large | **Priority:** High | **Dependencies:** 1.4, 2.4

**Files:**

- `apps/client/src/layers/features/extensions/ui/ManifestSettingsPanel.tsx` (rename from ManifestSecretsPanel.tsx)

**What:**

- Rename component and file
- Accept both `secrets: SecretDeclaration[]` and `settings: SettingDeclaration[]` props
- Fetch both secrets statuses and settings statuses in parallel
- Implement `groupConfigItems()` for unified grouping (secrets + settings)
- Add field renderers:
  - `TextSettingRow` — Input + Save button
  - `NumberSettingRow` — Input type="number" + Save button (min/max enforced)
  - `BooleanSettingRow` — Switch, immediate save on toggle
  - `SelectSettingRow` — Select dropdown, immediate save on change
- Render ungrouped items in `FieldCard`, named groups in `CollapsibleFieldCard`
- Change icon export from `KeyRound` to `Settings` (lucide-react)

---

### 3.2 Update extension-loader.ts with renamed method and settings support

**Size:** Medium | **Priority:** High | **Dependencies:** 3.1

**Files:**

- `apps/client/src/layers/features/extensions/model/extension-loader.ts`

**What:**

- Rename `autoRegisterSecretsTab` to `autoRegisterConfigTab`
- Update condition: register tab when `secrets?.length || settings?.length` (either present)
- Pass both `secrets` and `settings` arrays to `ManifestSettingsPanel` via `createElement`
- Update imports from `ManifestSecretsPanel` to `ManifestSettingsPanel`
- Update icon import from `ManifestSecretsIcon` to `ManifestSettingsIcon`
- Update both call sites (initialize + reloadExtensions)

---

### 3.3 Add extension loader tests for settings-only and combined tab registration

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.2

**Files:**

- `apps/client/src/layers/features/extensions/__tests__/extension-loader.test.ts`

**What:**

- Test: settings-only extension triggers tab registration
- Test: combined secrets+settings produces single unified tab
- Test: no registration when neither secrets nor settings exist
- Test: empty arrays treated same as missing
- Test: cleanup function is tracked

---

## Phase 4: Templates + Documentation

Polish: update scaffolding templates, example manifests, and the extension authoring guide.

### 4.1 Update data-provider template with settings examples

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1 | **Parallel with:** 4.2, 4.3

**Files:**

- `apps/server/src/services/extensions/extension-templates.ts`

**What:**

- Add `placeholder: 'your-api-key-here'` to the data-provider secret template
- Add `settings` array with `refresh_interval` example (number, min 10, max 3600, default 60)
- Update server template Quick Reference to include `ctx.settings` methods
- Add commented `ctx.settings.get<number>('refresh_interval')` in schedule callback
- Update client template comments to reference both secrets and settings

---

### 4.2 Update Linear Issues example manifest with placeholder

**Size:** Small | **Priority:** Low | **Dependencies:** 1.1 | **Parallel with:** 4.1, 4.3

**Files:**

- `examples/extensions/linear-issues/extension.json`

**What:**

- Add `placeholder: "lin_api_xxxxxxxxxxxx"` to the `linear_api_key` secret declaration
- Do NOT modify the dev runtime copy at `apps/server/.temp/`

---

### 4.3 Update extension authoring guide with settings documentation

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1 | **Parallel with:** 4.1, 4.2

**Files:**

- `contributing/extension-authoring.md`

**What:**

- Document `placeholder` and `group` fields on secrets
- Add "Settings Declaration" section: field types table, field properties, complete example manifest
- Document grouping behavior (shared group name = collapsible section)
- Add `ctx.settings` to DataProviderContext quick reference (get, set, delete, getAll)
- Add "Secrets vs Settings" best practice note

---

## Dependency Graph

```
Phase 1 (Foundation):
  1.1 ──┬── 1.2 ── (feeds into P2)
        ├── 1.3 (parallel with 1.2)
        └── 1.4 (parallel with 1.2, 1.3)

Phase 2 (Server):
  1.2 ── 2.1 ── 2.2 ──┬── 2.3
                       ├── 2.4
                       └── 2.5 (all three parallel)

Phase 3 (Client):
  1.4 + 2.4 ── 3.1 ── 3.2 ── 3.3

Phase 4 (Templates + Docs):
  2.1 ── 4.1 ┐
  1.1 ── 4.2 ├── all parallel
  2.1 ── 4.3 ┘
```

## Summary

| Phase               | Tasks        | Size Distribution           |
| ------------------- | ------------ | --------------------------- |
| 1. Foundation       | 4 tasks      | 2 medium, 1 small, 1 medium |
| 2. Server           | 5 tasks      | 2 small, 3 medium           |
| 3. Client           | 3 tasks      | 1 large, 2 medium           |
| 4. Templates + Docs | 3 tasks      | 1 small, 2 medium           |
| **Total**           | **15 tasks** | 1 large, 10 medium, 4 small |
