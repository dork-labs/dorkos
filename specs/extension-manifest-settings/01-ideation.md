---
slug: extension-manifest-settings
number: 209
created: 2026-03-29
status: ideation
---

# Extension Manifest Settings

**Slug:** extension-manifest-settings
**Author:** Claude Code
**Date:** 2026-03-29
**Branch:** preflight/extension-manifest-settings

---

## 1) Intent & Assumptions

- **Task brief:** Extend the DorkOS extension manifest schema with (1) a `settings` array for non-secret config (text, number, boolean, select fields) that auto-generates full settings forms, (2) a `placeholder` field on `SecretDeclaration` for custom input hints, and (3) grouped secrets/settings via collapsible sections for extensions that connect to multiple APIs.

- **Assumptions:**
  - Builds on the existing `ManifestSecretsPanel` auto-generated UI pattern
  - Settings live inside `serverCapabilities` alongside `secrets` (server-side storage, consistent namespace)
  - Non-secret settings are stored as plaintext JSON (no encryption needed — these are config, not credentials)
  - Extension authors get polished settings forms for free with zero UI code
  - All changes are additive and backward-compatible — existing manifests continue to work unchanged

- **Out of scope:**
  - Complex field types (file upload, color picker, multi-select, textarea)
  - Conditional/dependent fields (show field B only when field A is true)
  - Per-field validation rules beyond min/max for numbers
  - Client-side extension access to settings (server-only for v1)
  - Settings migration/versioning when manifest changes

## 2) Pre-reading Log

- `packages/extension-api/src/manifest-schema.ts`: Zod schemas for `ExtensionManifestSchema`, `SecretDeclarationSchema`, `ServerCapabilitiesSchema`. Currently no `placeholder`, `group`, or `settings` fields.
- `apps/client/src/layers/features/extensions/ui/ManifestSecretsPanel.tsx`: Auto-generated settings panel for secrets. Uses `FieldCard`, `SettingRow`, `PasswordInput`, `Badge`, `Button`. Pattern to extend for unified settings+secrets panel.
- `apps/client/src/layers/features/extensions/model/extension-loader.ts`: `autoRegisterSecretsTab()` method (lines 297-319) auto-registers settings tab from manifest. Will become unified auto-register for both secrets and settings.
- `apps/client/src/layers/shared/ui/field-card.tsx`: Has `FieldCard`, `FieldCardContent`, and `CollapsibleFieldCard` — the collapsible variant is perfect for grouped sections.
- `apps/client/src/layers/shared/ui/setting-row.tsx`: Row layout for label + description + content. Reusable for all field types.
- `apps/client/src/layers/shared/ui/form-fields/`: Existing field components — `TextField`, `SelectField`, `SwitchField`, `CheckboxField`. Uses `useFieldContext<T>()` + TanStack Form.
- `apps/server/src/services/extensions/extension-templates.ts`: Generates starter manifest and code for `dashboard-card`, `command`, `settings-panel`, `data-provider` templates.
- `apps/server/src/routes/extensions.ts`: HTTP handlers for extension lifecycle and secrets endpoints.
- `packages/shared/src/extension-secrets.ts`: `ExtensionSecretStore` with AES-256-GCM encryption. Model for separate settings storage.
- `packages/extension-api/src/server-extension-api.ts`: `SecretStore` and `DataProviderContext` interfaces. May need `SettingsStore` addition.
- `packages/extension-api/src/__tests__/manifest-schema.test.ts`: 446-line test suite for manifest schema validation. Pattern for new tests.
- `contributing/extension-authoring.md`: Developer guide covering manifest fields, secrets, data providers. Needs new settings section.
- `research/20260329_extension_server_side_capabilities.md`: Existing research on extension systems (VS Code, Raycast, Obsidian, Grafana, Backstage, Chrome, Directus).
- `research/20260329_extension_manifest_settings_schema.md`: New research report written by research agent — covers Raycast, VS Code, Grafana, Shopify patterns for manifest-driven settings.

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/extension-api/src/manifest-schema.ts` — Zod schema definitions (will add `SettingDeclarationSchema`, `placeholder`, `group`)
  - `apps/client/src/layers/features/extensions/ui/ManifestSecretsPanel.tsx` — Will evolve into unified `ManifestSettingsPanel` with support for both secrets and non-secret settings, grouped by `group` field
  - `apps/client/src/layers/features/extensions/model/extension-loader.ts` — `autoRegisterSecretsTab()` will become unified auto-register checking both secrets and settings
  - `apps/server/src/routes/extensions.ts` — New endpoints for settings CRUD
  - `apps/server/src/services/extensions/extension-templates.ts` — Add example settings to data-provider template

- **Shared dependencies:**
  - `apps/client/src/layers/shared/ui/field-card.tsx` — `CollapsibleFieldCard` for groups
  - `apps/client/src/layers/shared/ui/setting-row.tsx` — Row layout for each field
  - `apps/client/src/layers/shared/ui/form-fields/` — TextField, SelectField, SwitchField
  - `packages/shared/src/extension-secrets.ts` — Pattern for settings storage

- **Data flow:**
  - **Write:** Settings UI → `PUT /api/extensions/{id}/settings/{key}` → `{dorkHome}/extension-settings/{id}.json`
  - **Read (UI):** `GET /api/extensions/{id}/settings` → ManifestSettingsPanel renders current values
  - **Read (server.ts):** `ctx.settings.get(key)` reads from same JSON file
  - **Manifest:** `extension.json` → `ExtensionManifestSchema` (Zod parse) → `ExtensionRecord` → client receives via `GET /api/extensions`

- **Feature flags/config:** None

- **Potential blast radius:**
  - Direct: 5 files (manifest-schema, ManifestSecretsPanel→ManifestSettingsPanel, extension-loader, routes, templates)
  - Indirect: 3 files (extension-discovery auto-inherits schema, server-extension-api types, extension-authoring docs)
  - Tests: 2 files (manifest-schema.test.ts, extension-loader.test.ts)
  - New files: 1-2 (extension-settings storage module, possibly ManifestSettingsPanel if we rename/replace)

## 5) Research

### Potential Solutions

**1. Flat Settings Array (Raycast/Shopify pattern) — Recommended**

- Description: Add `settings` as a flat array of typed field declarations inside `serverCapabilities`, parallel to `secrets`. Each field has `type`, `key`, `label`, `description`, `placeholder`, `default`, `group`, and type-specific props (`options` for select, `min`/`max` for number).
- Pros:
  - Dead simple for extension authors
  - Mirrors existing `secrets` array pattern — consistent DX
  - Each field is self-contained and readable
  - Easy to add new types without structural change
  - Backward compatible (optional array)
- Cons:
  - Type-specific validation (min/max, options) lives in a flat object with optional fields
  - No inherent grouping hierarchy (uses `group` string field instead)
- Complexity: Low
- Maintenance: Low

**2. Grouped Settings with Sections (VS Code pattern)**

- Description: Settings organized into explicit `settingGroups` with `{ title, settings[] }` structure.
- Pros: Natural mapping to collapsible sections, proven at VS Code scale
- Cons: More nesting in manifest, harder to author, must create group structure for even a single setting
- Complexity: Medium
- Maintenance: Medium

**3. JSON Schema-Based (react-jsonschema-form pattern)**

- Description: Use JSON Schema for field definitions with auto-generation.
- Pros: Standard format, broad tooling, type validation built in
- Cons: Extension authors must know JSON Schema syntax, no native `select`/`placeholder`, more host-side complexity
- Complexity: High
- Maintenance: High

### Recommendation

**Flat settings array (Approach 1).** It follows Raycast's proven model, matches the existing `secrets` array DX, and keeps manifest authoring simple. Grouping via a `group` string field on both secrets and settings allows collapsible sections without structural nesting.

### Key Research Findings

- **Raycast**: `preferences` array with `type`, `placeholder`, `data` (for select options), `label`. Strongest reference for DorkOS.
- **Grafana**: `jsonData` (non-secret) vs `secureJsonData` (encrypted) split — exactly the `settings` vs `secrets` principle.
- **VS Code**: `contributes.configuration` supports array-of-sections for grouping. But JSON Schema complexity is overkill for DorkOS.
- **Shopify**: `[[settings.fields]]` TOML with `key`, `type`, `name`, `description`, `required` — confirms flat array pattern.

Full research: `research/20260329_extension_manifest_settings_schema.md`

## 6) Decisions

| #   | Decision                           | Choice                                                                                                                                                       | Rationale                                                                                                                                                                                         |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unified vs. separate settings tab  | Unified tab — one auto-generated settings tab per extension rendering both secrets and non-secret settings together, with `group`-based collapsible sections | Cleaner UX: one place for all extension configuration. Groups can mix secrets and settings in the same collapsible section (e.g., "GitHub" group containing both the token and org name setting). |
| 2   | Where `settings` lives in manifest | Inside `serverCapabilities` alongside `secrets`                                                                                                              | Consistency with secrets. Settings values are persisted server-side and accessed by `server.ts` code. Same namespace, same lifecycle.                                                             |
| 3   | Schema approach                    | Flat object with `type` enum (non-discriminated union)                                                                                                       | Simpler than discriminated union for v1. The form renderer validates type-specific constraints at render time. Can upgrade to discriminated union later if needed.                                |
| 4   | Grouping mechanism                 | `group?: string` field on both `SecretDeclaration` and `SettingDeclaration`                                                                                  | Backward compatible (optional field). UI groups by `group` value into collapsible sections. Ungrouped items render at the top. Simpler than nested `secretGroups` array.                          |
| 5   | Settings storage                   | `{dorkHome}/extension-settings/{id}.json` (plaintext JSON, separate from encrypted secrets)                                                                  | Non-secret config doesn't need encryption. Separate file keeps concerns clean. Server extension API can read directly.                                                                            |
