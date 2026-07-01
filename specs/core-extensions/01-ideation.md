---
slug: core-extensions
number: 256
created: 2026-06-13
status: ideation
---

# Core Extensions

**Slug:** core-extensions
**Author:** Claude Code
**Date:** 2026-06-13
**Branch:** core-extensions

---

## 1) Intent & Assumptions

- **Task brief:** Introduce a recognized **Core Extensions** tier — extensions that ship bundled with DorkOS, appear in Settings as toggleable cards, and have a per-extension configurable default (on or off). This is the Obsidian "core plugins" model: first-party, bundled, user-controllable. Rename the existing `builtin-extensions` directory to `core-extensions`, generalize the one-off staging mechanism into a scanner, add origin tracking (`core` vs `user`), split the settings UI into "Core" and "Installed" sections, and migrate the config schema to support default-on (opt-out) alongside the existing default-off (opt-in) behavior.

- **Assumptions:**
  - The runtime extensions directory (`{dorkHome}/extensions/`) is the discovery contract and does **not** change. Only the in-repo _source_ directory `builtin-extensions/` is renamed to `core-extensions/`.
  - Core extensions reuse the exact same `ExtensionManifestSchema`, compilation, and lifecycle as user extensions (the VS Code principle: dogfood the public API with first-party code). No separate internal extension API.
  - Per-extension _settings_ (the values a user configures inside an extension) already have a home and are out of scope here; this work governs only on/off state and the core tier.
  - There are no external consumers of the `builtin-extensions` directory name; it is server-internal.
  - The user's `~/.dork/config.json` already exists in production, so the config change must be additive and backward-compatible (no destructive migration).

- **Out of scope:**
  - Publishing `@dorkos/extension-api` to npm (tracked separately; it currently blocks moving extensions fully to the marketplace).
  - Migrating Linear Loop to `dork-labs/marketplace` (deferred until `@dorkos/extension-api` is public; Linear Loop incubates as a default-off core extension for now).
  - Extension sandboxing / security model (a known v1 limitation, unchanged here).
  - Any change to per-extension settings/secrets storage.

---

## 2) Pre-reading Log

From codebase exploration (file → takeaway):

- `apps/server/src/services/extensions/extension-manager.ts` — Orchestrates lifecycle. `enable()`/`disable()` mutate `configManager.get('extensions').enabled` directly (lines 198–245). `initialize()`/`reload()` read the enabled list and pass it to discovery. This is the seam where "is this extension enabled?" must become tier-aware.
- `apps/server/src/services/extensions/extension-discovery.ts` — `discover(cwd, enabledIds)` scans global + local dirs, sets `status: 'enabled' | 'disabled'` purely from membership in `enabledIds`. Record carries `scope: 'global' | 'local'` but **no `origin`** today.
- `apps/server/src/services/extensions/extension-manager-types.ts` — `ExtensionRecord` shape (id, manifest, status, scope, path, bundleReady, hasServerEntry, …). `toPublic()` strips server-internal fields. `origin` must be added here and surfaced in `toPublic()`.
- `apps/server/src/services/builtin-extensions/ensure-marketplace.ts` — The staging pattern: read bundled manifest version, compare to installed, copy tree on fresh/upgrade, no-op otherwise. `BUILTIN_SOURCE_DIR = resolve(__dirname, '../../builtin-extensions/marketplace')`. Called from `index.ts:167`, non-fatal. This is the template to generalize into `ensureCoreExtensions()`.
- `apps/server/src/builtin-extensions/marketplace/` — Canonical built-in source: `extension.json` (id `marketplace`, name "Marketplace"), `index.ts`, `server.ts`. Same manifest format as user extensions.
- `packages/shared/src/config-schema.ts` — `extensions: { enabled: string[] }` (lines 135–140), opt-in only. Top-level `version: z.literal(1)`. This is the field to extend with `disabled: string[]`.
- `apps/server/src/services/core/config-manager.ts` — `conf` v15.1.0 wrapper. `CONFIG_MIGRATIONS` keyed by app version (lines 81–90), append-only. `projectVersion` from `SERVER_VERSION` (dynamic, never hardcoded). Zod → JSON Schema bridge via `z.toJSONSchema`. Corrupt-recovery path reuses the same options so migrations apply equally.
- `.claude/skills/adding-config-fields/SKILL.md` — The mandated lifecycle for config changes: Zod field + default → verify `USER_CONFIG_DEFAULTS` parses → append version-keyed migration → update `contributing/configuration.md` + `docs/getting-started/configuration.mdx` → upgrade-path tests → CLI flag if needed.
- `apps/client/src/layers/features/extensions/ui/ExtensionsSettingsTab.tsx` — Renders a **flat** list of `ExtensionCard`s. No sectioning today. This is where the Core/Installed split lands.
- `apps/client/src/layers/features/extensions/ui/ExtensionCard.tsx` — Per-extension toggle UI.
- `apps/client/src/layers/features/extensions/api/queries.ts` — `useExtensions` (GET, 30s poll), `useEnableExtension`/`useDisableExtension` (POST + invalidate), `useReloadExtensions`. No grouping by origin yet.
- `apps/client/src/layers/features/extensions/model/types.ts` — Client `LoadedExtension`; sees `scope` but not `origin`.
- `apps/server/src/routes/extensions.ts` — HTTP routes: list, enable, disable, settings, secrets, reload.
- `apps/server/package.json:14` — Build step: `tsc` then `cpSync('src/builtin-extensions','dist/builtin-extensions', {recursive, filter: p=>!p.endsWith('.ts')})`. Hardcoded dir names; must update on rename.
- `examples/extensions/` — `hello-world/` (tiny), `hello-world-js/` (tiny), `linear-issues/` (full v2.0.0). Referenced only by docs (`contributing/extension-authoring.md`) and a few spec docs — **no code/test/build dependency**.

Research cache consulted:

- `research/20260323_plugin_extension_ui_architecture_patterns.md`
- `research/20260326_extension_point_registry_patterns.md`
- `research/20260329_extension_manifest_settings_schema.md`
- `research/20260329_extension_server_side_capabilities.md`

---

## 3) Codebase Map

- **Primary components/modules:**
  - Server lifecycle: `apps/server/src/services/extensions/extension-manager.ts`, `extension-discovery.ts`, `extension-manager-types.ts`
  - Core staging: `apps/server/src/services/builtin-extensions/ensure-marketplace.ts` (→ generalize to `ensure-core-extensions.ts`), source tree `apps/server/src/builtin-extensions/` (→ rename `core-extensions/`)
  - Config: `packages/shared/src/config-schema.ts`, `apps/server/src/services/core/config-manager.ts`
  - HTTP: `apps/server/src/routes/extensions.ts`
  - Client: `apps/client/src/layers/features/extensions/{ui,api,model}/`
  - Contract types: `@dorkos/extension-api` (`ExtensionRecord`, `ExtensionManifest`, manifest schema)

- **Shared dependencies:** `conf` (config store), `esbuild` (extension compiler), `@dorkos/extension-api` (manifest/record contracts), TanStack Query (client data), Zod (schemas).

- **Data flow (enable resolution, target state):**
  `ensureCoreExtensions()` stages core sources → `{dorkHome}/extensions/<id>/` → `discovery.discover(cwd, config)` reads each manifest, derives `origin` by source location, computes `status` via tier-aware rule (`core`: on unless in `disabled`; `user`: on only if in `enabled`) → `ExtensionManager` compiles enabled records → client `GET /api/extensions` → settings UI groups by `origin`.

- **Feature flags/config:** `extensions.enabled` (existing), `extensions.disabled` (new). Schema `version` literal + `CONFIG_MIGRATIONS` keyed by release version.

- **Potential blast radius:**
  - Direct: 8–10 source files (config schema, config-manager migration, discovery, manager, manager-types, ensure-core-extensions, index.ts call site, package.json build step, extensions route, client settings tab + card + queries + model types).
  - Tests: ~22 extension/config test files (~7000 LOC). Highest-touch: `extension-manager.test.ts`, `extension-discovery.test.ts`, `extension-routes.test.ts`, `config-manager.test.ts`, `ensure-marketplace.test.ts` (→ rename to `ensure-core-extensions.test.ts`).
  - Docs: `contributing/extension-authoring.md` (the "Built-in Extensions" section is already drifted from code and needs a rewrite to "Core Extensions"), `docs/getting-started/configuration.mdx`, `contributing/configuration.md`.
  - Filesystem: rename `apps/server/src/builtin-extensions/` → `core-extensions/`; relocate `examples/extensions/{hello-world,linear-issues}` into the new core-extensions tree; delete `examples/extensions/` (and `hello-world-js`).

---

## 4) Root Cause Analysis

Not applicable — this is a feature/refactor, not a bug fix.

One pre-existing defect this work corrects in passing: `contributing/extension-authoring.md` documents a `extensionManager.stageBuiltinExtension()` method and claims built-ins "do not appear as user-togglable items / are always enabled." Neither is true in the code — the method does not exist, and Marketplace is staged as an ordinary discoverable extension with no special-casing. The Core Extensions model resolves this drift by making the behavior real and honest: core extensions are visible, toggleable, and have an explicit default.

---

## 5) Research

Full findings synthesized from the research agent and local cache. Decision-relevant highlights:

- **Potential solutions (config schema for default-on/opt-out):**
  1. **Keep `enabled: string[]` only (status quo).** Cannot express default-on — an empty config means everything off. ❌ Fails the core requirement.
  2. **Per-extension `{ [id]: boolean }` map.** Expressive but ambiguous on upgrade: when a new core extension ships, an absent key has no defined default without an extra per-extension lookup table. Verbose.
  3. **Tri-state `{ [id]: 'on' | 'off' | 'unset' }`.** Semantically complete but still needs a default-per-tier lookup for `'unset'`; more machinery than warranted.
  4. **Add a parallel `disabled: string[]` opt-out list (RECOMMENDED).** `enabled` keeps opt-in semantics for default-off (marketplace) extensions; `disabled` provides opt-out for default-on (core) extensions. Absence from `disabled` = default behavior = on for core. Cleanly handles the upgrade case (a new core extension is absent from everyone's `disabled`, so it turns on automatically — the correct default-on outcome). This is exactly JetBrains' `disabled_plugins.txt` model.

- **Reference patterns:**
  - **Obsidian (primary):** Core plugins bundled in the app, no install step; `.obsidian/core-plugins.json` is an enabled-IDs array (+ a back-compat `{id:bool}` mirror). Navigation/search/command-palette ship **on**; opinionated workflows (daily notes, templates, audio recorder) ship **off**. All core plugins are user-disableable; none locked.
  - **VS Code:** Built-in extensions are real extensions in a flat `extensions/` dir using the same API as marketplace ones; `isBuiltin` is derived from **load location**, not a manifest claim. All ship enabled; all disableable; shown in a separate "Built-in" section.
  - **JetBrains:** Bundled plugins in a flat `plugins/` dir; pure opt-out `disabled_plugins.txt`; all default-on.

- **Monorepo packaging:** VS Code (flat dir, ~40 built-ins, no per-extension workspace), JetBrains (flat dir), Obsidian (compiled in). For a 1–5 extension early-stage monorepo, a dedicated package or per-extension packages add workspace edges and build-copy complexity with no payoff. Flat directory inside the server app wins.

- **Recommendation:** Two-list config (`enabled` + `disabled`); location-derived `origin`; manifest-level `defaultEnabled`; flat `core-extensions/` directory in the server app; optional `required`/`canDisable` flag reserved but defaulted to disableable.

- **Pitfalls flagged:**
  - Users hand-editing config may add a core extension to `enabled` expecting it to turn on — for core extensions only `disabled` matters. Document clearly; consider a validation warning.
  - The `ensure*` copy-on-upgrade overwrites staged code — correct for code files, but never co-locate user data with staged core-extension code.
  - Don't replicate Obsidian's dual-file redundancy; `conf`'s single versioned config + migrations already covers multi-version compat.
  - Settings UI should visually separate "disabled by user" from "unavailable due to runtime error" (toggle state vs health badge).

---

## 6) Decisions

| #   | Decision                                        | Choice                                                                                               | Rationale                                                                                                                                                                                                          |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Per-extension configurable default-on/off       | **Yes** — manifest `defaultEnabled` field per core extension                                         | User requirement; cleanly expressible. Default lives in the extension's own `extension.json` (DorkOS-internal manifest, no Claude-Code marketplace-format concern).                                                |
| 2   | Rename `builtin-extensions` → `core-extensions` | **Yes** (source dir only)                                                                            | Matches user-facing language. Blast radius is small/precise: build `cpSync` step + `ensure-*` source path. Runtime `{dorkHome}/extensions/` stays (discovery contract).                                            |
| 3   | Config schema for default-on                    | **Two-list: keep `enabled`, add `disabled`**                                                         | Research convergence (JetBrains model). Backward-compatible/additive; handles "new core extension on upgrade" without ambiguity. Core = on unless in `disabled`; user = on only if in `enabled`.                   |
| 4   | Origin tracking                                 | **`origin: 'core' \| 'user'` on `ExtensionRecord`, derived by source location**                      | VS Code `isBuiltin` pattern. Location-derived can't be spoofed by a manifest claim. Surfaced via `toPublic()` for the UI split.                                                                                    |
| 5   | Generalized staging                             | **`ensureCoreExtensions()` scans `core-extensions/*` and version-stages each**                       | Replaces the one-`ensure-*`-per-extension pattern (doesn't scale to "a handful"). Same version-diff copy logic as today.                                                                                           |
| 6   | Monorepo structure (user's Q#4)                 | **Flat dir in server app: `apps/server/src/core-extensions/<id>/`**                                  | Confirmed by user. Matches VS Code/JetBrains; zero new workspace edges; existing build-copy already handles it. A dedicated/per-extension package adds complexity with no payoff at this scale.                    |
| 7   | `hello-world` example (user's Q#3)              | **Ship as a default-OFF core extension**                                                             | Confirmed by user. Doubles as the canonical authoring skeleton AND a live toggleable demo. Bonus: gives us a real default-off core extension to prove that code path from day one.                                 |
| 8   | Linear Loop (`linear-issues`)                   | **Ship as a default-OFF core extension now; migrate to `dork-labs/marketplace` later**               | Confirmed by user. Pragmatic incubation while `@dorkos/extension-api` is still private; users with Linear opt in, others never see it.                                                                             |
| 9   | `examples/extensions/` folder                   | **Remove** (relocate `hello-world` + `linear-issues` into `core-extensions/`; drop `hello-world-js`) | Doc-only references; no code/test/build dependency. "Core extensions are the examples."                                                                                                                            |
| 10  | Disableability (user's Q#4 on Marketplace)      | **All core extensions disableable; Marketplace `defaultEnabled: true`**                              | Confirmed by user. Matches Obsidian/VS Code (everything disableable). `/marketplace` must handle the Marketplace-disabled state gracefully. Add a `canDisable` flag reserved for future use, defaulting to `true`. |

### Proposed design (for `/ideate-to-spec`)

The decisions above imply this concrete shape:

1. **Config schema** (`packages/shared/src/config-schema.ts`):

   ```typescript
   extensions: z.object({
     enabled: z.array(z.string()).default(() => []), // opt-in: default-off (user/marketplace) extensions
     disabled: z.array(z.string()).default(() => []), // opt-out: default-on (core) extensions
   }).default(() => ({ enabled: [], disabled: [] }));
   ```

   Plus an append-only `CONFIG_MIGRATIONS` entry keyed to the release version that ensures `extensions.disabled` exists for pre-existing configs (additive; never removes `enabled`).

2. **Manifest** (`@dorkos/extension-api` `ExtensionManifestSchema`): add optional `defaultEnabled?: boolean` (default `true` for core, irrelevant for user extensions) and optional `canDisable?: boolean` (default `true`).

3. **Record** (`ExtensionRecord` + `toPublic()`): add `origin: 'core' | 'user'`, derived during discovery from whether the extension was staged from the core source tree.

4. **Enable resolution** (single tier-aware helper used by discovery/manager):

   ```
   core:  enabled = !config.extensions.disabled.includes(id)
   user:  enabled =  config.extensions.enabled.includes(id)
   ```

   `enable()`/`disable()` write to the correct list based on `origin` (core toggles mutate `disabled`; user toggles mutate `enabled`).

5. **Staging**: `ensureCoreExtensions(dorkHome)` scans `core-extensions/*/extension.json`, version-stages each into `{dorkHome}/extensions/<id>/`. Replaces `ensureBuiltinMarketplaceExtension`. Called from `index.ts` before `ExtensionManager.initialize()`.

6. **Build**: update `apps/server/package.json:14` `cpSync` source/dest to `core-extensions`.

7. **Settings UI**: `ExtensionsSettingsTab` renders two sections — "Core extensions" (`origin === 'core'`) and "Installed extensions" (`origin === 'user'`). Cards show a toggle (hidden/locked when `canDisable === false`) plus a health/availability badge distinct from on/off.

8. **Initial core set**: `marketplace` (Marketplace, default-on), `hello-world` (default-off), `linear-issues` (Linear Loop, default-off).

9. **Cleanup**: delete `examples/extensions/`; rewrite the "Built-in Extensions" section of `contributing/extension-authoring.md` as "Core Extensions" (fixing the existing `stageBuiltinExtension`/"always enabled" drift); update configuration docs for the new `disabled` field.

### Open sub-questions for the spec phase (non-blocking)

- Exact migration version key (depends on the release this lands in — `/system:release` drift check applies).
- Whether to add a hand-editing validation warning when a core-extension id is found in `enabled` (pitfall #1).
- Ordering/curation of the Core section (alphabetical vs a curated order) — a thin `CORE_EXTENSION_ORDER` list if needed, otherwise manifest order.
- Whether Linear Loop's vendor-specificity warrants a "first-party" sub-label in the Core section to set expectations before its marketplace migration.

---

## Next steps

1. Review this ideation document.
2. Run: `/ideate-to-spec specs/core-extensions/01-ideation.md`
