---
slug: core-extensions
number: 256
created: 2026-06-13
status: specified
---

# Core Extensions

**Status:** Specified
**Authors:** Claude Code, 2026-06-13
**Spec:** #256
**Ideation:** `specs/core-extensions/01-ideation.md`

---

## Overview

Introduce a recognized **Core Extensions** tier — first-party extensions that ship bundled with DorkOS, appear in Settings as toggleable cards, and have a per-extension configurable default state (on or off). This is the Obsidian "core plugins" model: bundled, first-party, and fully user-controllable.

The work renames the in-repo `builtin-extensions` source directory to `core-extensions`, generalizes the one-off `ensure-marketplace` staging into a directory scanner, adds `origin` (`core` | `user`) tracking to extension records, migrates the config schema to support default-on (opt-out) state alongside the existing default-off (opt-in) behavior, splits the extensions settings UI into "Core" and "Installed" sections, and seeds the tier with three extensions: Marketplace (default-on), Hello World (default-off), and Linear Loop (default-off).

Core extensions reuse the **exact same** manifest schema, compiler, and lifecycle as user extensions — DorkOS dogfoods its own public extension API with first-party code (the VS Code principle).

---

## Background / Problem Statement

Today DorkOS has a single bundled extension, Marketplace (`marketplace`), staged at server startup by `ensureBuiltinMarketplaceExtension()` (`apps/server/src/services/builtin-extensions/ensure-marketplace.ts`). It is copied into `{dorkHome}/extensions/` and from then on behaves like any other extension. There are three problems:

1. **No "core" concept.** There is no way to ship a curated set of first-party extensions, mark which ship enabled vs disabled, or present them distinctly from user-installed ones. The settings list is flat.
2. **The config model can't express default-on.** `extensions: { enabled: string[] }` (`packages/shared/src/config-schema.ts:135`) is opt-in only — an empty config means "everything off." A core extension that should ship enabled cannot be represented for a fresh user.
3. **Documentation describes behavior the code doesn't have.** `contributing/extension-authoring.md` claims built-ins are staged via `extensionManager.stageBuiltinExtension()` and "do not appear as user-togglable items / are always enabled." Neither is true — the method does not exist and Marketplace is an ordinary discoverable extension. This drift misleads contributors.

Separately, `examples/extensions/` holds `hello-world`, `hello-world-js`, and a fully-grown `linear-issues` (Linear Loop, v2.0.0). These are referenced only by docs — no code, test, or build depends on them — yet `linear-issues` is real, product-grade functionality sitting in an `examples/` folder it has outgrown.

### Why Now

The extension platform (discovery, compilation, server-side capabilities, secrets) is stable. Establishing the Core Extensions tier now (a) gives a curated home for first-party extensions, (b) fixes the config model before more bundled extensions accrete, (c) corrects the doc/code drift, and (d) provides an honest, Obsidian-style control surface that fits the brand ("a control panel, not a consumer app").

---

## Goals

- A `core-extensions/` source tree in the server app holds bundled first-party extensions; a generalized `ensureCoreExtensions()` stages all of them at startup.
- Each core extension declares its default state (`defaultEnabled`) in its own manifest; the tier supports both default-on and default-off members.
- The config schema represents user overrides as **deviation lists**: `disabled` (things turned off that default on) alongside the existing `enabled` (things turned on that default off). Backward-compatible, additive, migration-covered.
- Extension records carry `origin: 'core' | 'user'`, surfaced to the client.
- Settings UI renders two sections — "Core extensions" and "Installed extensions" — each with working toggles. Core extensions are user-disableable (matching Obsidian/VS Code); a reserved `canDisable: false` manifest flag can lock an extension on in the future.
- Initial core set: Marketplace (default-on), Hello World (default-off, doubles as the authoring skeleton + live demo), Linear Loop (default-off, incubating until it migrates to the marketplace).
- `examples/extensions/` is removed; authoring docs point at the shipped core extensions.
- Existing user/global/local extensions continue to work unchanged; no extension HTTP API surface change.

## Non-Goals

- Publishing `@dorkos/extension-api` to npm (tracked separately; blocks the eventual marketplace migration of Linear Loop).
- Migrating Linear Loop to `dork-labs/marketplace` (deferred; it incubates as a default-off core extension here).
- A dedicated `packages/core-extensions/` workspace or one-package-per-extension (rejected — see Detailed Design § Packaging).
- Changing the runtime `{dorkHome}/extensions/` discovery directory (it stays; only the in-repo source dir is renamed).
- Per-extension settings/secrets storage changes (already exists; unchanged).
- Extension sandboxing / worker isolation (a known v1 limitation, unchanged).
- A visual "first-party"/integration badge or sub-grouping for vendor-specific core extensions (decided against — Linear Loop ships as a plain default-off core extension).

---

## Technical Dependencies

- `@dorkos/extension-api` — `ExtensionManifestSchema`, `ExtensionRecord`, `ExtensionRecordPublic`, `ExtensionStatus` (`packages/extension-api/src/{manifest-schema,types}.ts`).
- `conf` v15.1.0 config store + Zod→JSON-Schema bridge (`apps/server/src/services/core/config-manager.ts`, `packages/shared/src/config-schema.ts`).
- esbuild extension compiler + discovery + lifecycle (`apps/server/src/services/extensions/`).
- TanStack Query client data layer (`apps/client/src/layers/features/extensions/`).
- The `adding-config-fields` skill lifecycle for the config change.

---

## Detailed Design

### 1. Manifest schema — `defaultEnabled` + `canDisable`

Add two optional fields to `ExtensionManifestSchema` (`packages/extension-api/src/manifest-schema.ts`):

```typescript
/** For core extensions: whether this ships enabled. Omitted/true = on, false = off. Ignored for user extensions. */
defaultEnabled: z.boolean().optional(),
/** Whether the user may disable this extension. Defaults to true. false = always on, no toggle shown. */
canDisable: z.boolean().optional(),
```

Both are harmless for user/marketplace extensions (ignored). `extension.json` is a DorkOS-internal manifest (not the Claude-Code `marketplace.json`), so adding fields carries no marketplace-format-compat concern.

### 2. Config schema — deviation lists

Extend the `extensions` block (`packages/shared/src/config-schema.ts`):

```typescript
extensions: z
  .object({
    /** Extension IDs the user turned ON that default OFF (user/marketplace + default-off core). */
    enabled: z.array(z.string()).default(() => []),
    /** Extension IDs the user turned OFF that default ON (default-on core). */
    disabled: z.array(z.string()).default(() => []),
  })
  .default(() => ({ enabled: [], disabled: [] })),
```

**Mental model:** both lists record _deviations from each extension's default state_. `enabled` records overrides for things whose default is off; `disabled` records overrides for things whose default is on. This is the JetBrains `disabled_plugins.txt` model generalized to two defaults.

Append a version-keyed entry to `CONFIG_MIGRATIONS` (`config-manager.ts:81`) that backfills `disabled: []` for pre-existing configs:

```typescript
// version key resolved at release time — see Open Questions
'<next-release>': (store) => {
  const ext = store.get('extensions');
  if (ext && !Array.isArray((ext as { disabled?: unknown }).disabled)) {
    store.set('extensions', { ...ext, disabled: [] });
  }
},
```

Per the `adding-config-fields` skill: update `USER_CONFIG_DEFAULTS` parse check, `contributing/configuration.md`, and `docs/getting-started/configuration.mdx`.

### 3. Record + origin tracking

Add `origin: 'core' | 'user'` to both `ExtensionRecord` and `ExtensionRecordPublic` (`packages/extension-api/src/types.ts`); include it in `toPublic()` (`extension-manager-types.ts`).

**How origin is derived:** core extensions are staged into the same `{dorkHome}/extensions/` dir as user-global extensions, so location alone does not distinguish them. The authoritative source is the startup staging step: `ensureCoreExtensions()` knows exactly which IDs it staged from the bundled `core-extensions/` source tree. That set is threaded to discovery, which sets `origin = coreIds.has(id) ? 'core' : 'user'` after the global/local merge. (A local `.dork/extensions/<id>` override of a core id is a dev-only edge case; origin remains `'core'` by id membership, using whichever code won the merge.)

### 4. Enable resolution — a single pure helper

Extract the on/off decision into a pure, unit-testable helper (e.g. `apps/server/src/services/extensions/extension-enable-resolution.ts`), used by **both** discovery (initial status) and the manager (which list to mutate on toggle). This keeps the logic DRY and isolated.

```typescript
interface CoreExtensionInfo {
  id: string;
  defaultEnabled: boolean;
  canDisable: boolean;
}
interface ExtensionsConfig {
  enabled: string[];
  disabled: string[];
}

/** True when an extension's baseline (pre-override) state is ON. */
function defaultsOn(id: string, core: Map<string, CoreExtensionInfo>): boolean {
  const info = core.get(id);
  return info ? info.defaultEnabled : false; // user extensions default off
}

/** Resolve whether an extension should be enabled, given config overrides. */
function isEnabled(
  id: string,
  config: ExtensionsConfig,
  core: Map<string, CoreExtensionInfo>
): boolean {
  return defaultsOn(id, core)
    ? !config.disabled.includes(id) // default-on: off only if explicitly disabled
    : config.enabled.includes(id); // default-off: on only if explicitly enabled
}
```

**Toggle routing** (used by `enable()`/`disable()`): the lists capture deviations, so the helper also dictates which list to mutate.

| Extension                                   | Default | Enable action             | Disable action           |
| ------------------------------------------- | ------- | ------------------------- | ------------------------ |
| default-on core (Marketplace)               | on      | remove id from `disabled` | add id to `disabled`     |
| default-off core (Hello World, Linear Loop) | off     | add id to `enabled`       | remove id from `enabled` |
| user / marketplace                          | off     | add id to `enabled`       | remove id from `enabled` |

Default-off core and user extensions share identical mechanics (both use `enabled`); only default-on core uses `disabled`. A small `setEnabled(id, on)` helper computes the next `{enabled, disabled}` from current config + the resolution rule.

### 5. Discovery changes

`discover()` (`extension-discovery.ts:31`) currently takes `enabledIds: string[]`. Change the signature to carry the full config + core info:

```typescript
async discover(
  cwd: string | null,
  config: ExtensionsConfig,
  core: Map<string, CoreExtensionInfo>,
): Promise<ExtensionRecord[]>
```

In the status-resolution loop (lines 50–70), after compatibility checks, set `rec.origin` from `core` membership and `rec.status = isEnabled(rec.id, config, core) ? 'enabled' : 'disabled'`. The discovery log line gains `origin` for observability.

### 6. Generalized staging — `ensureCoreExtensions()`

Replace `ensure-marketplace.ts` with `apps/server/src/services/builtin-extensions/ensure-core-extensions.ts` (directory also renamed: see § 8). It scans the bundled source tree and version-stages each subdirectory, reusing the existing read-manifest-version + `fs.cp` copy logic:

```typescript
const CORE_SOURCE_DIR = path.resolve(__dirname, '../../core-extensions');

/** Stage every bundled core extension into {dorkHome}/extensions/<id>/; return their tier metadata. */
export async function ensureCoreExtensions(dorkHome: string): Promise<CoreExtensionInfo[]> {
  // for each subdir of CORE_SOURCE_DIR with a valid extension.json:
  //   compare bundled vs installed version → fresh-copy / upgrade-copy / no-op (unchanged logic)
  //   collect { id, defaultEnabled: manifest.defaultEnabled !== false, canDisable: manifest.canDisable !== false }
}
```

Wiring in `apps/server/src/index.ts` (replacing the `ensureBuiltinMarketplaceExtension` call at line 167): call `ensureCoreExtensions(dorkHome)` (non-fatal, same try/catch), capture the returned `CoreExtensionInfo[]`, and pass it to the `ExtensionManager` (constructor arg or `setCoreExtensions()`), which builds the `Map` and forwards it to `discover()` on every `reload()`. `reload()` reads `configManager.get('extensions')` (now `{enabled, disabled}`) and passes both through.

### 7. Manager changes

`extension-manager.ts`:

- Hold `coreExtensions: Map<string, CoreExtensionInfo>` (from `index.ts`).
- `reload()` (line 107): read full `extensions` config, pass `{enabled, disabled}` + core map to `discover()`.
- `enable()` (line 198) / `disable()` (line 227): replace the direct `enabled`-list mutation (lines 210–213, 235–238) with the `setEnabled()` helper, which writes the correct deviation list based on the extension's default. Public API and return shape unchanged.
- Guard: if `record.origin === 'core'` and its `canDisable === false`, `disable()` returns `null` (no-op) — defense in depth behind the UI.

### 8. Rename `builtin-extensions` → `core-extensions`

- Move `apps/server/src/builtin-extensions/` → `apps/server/src/core-extensions/` (currently holds `marketplace/`).
- Update the build step `apps/server/package.json:14`: `cpSync('src/core-extensions','dist/core-extensions', { recursive: true, filter: p => !p.endsWith('.ts') })`.
- Rename the service dir `services/builtin-extensions/` → `services/core-extensions/` (holds the new `ensure-core-extensions.ts` + tests).
- The runtime `{dorkHome}/extensions/` directory is unchanged (discovery contract).

### 9. Settings UI — Core / Installed sections

- `apps/client/src/layers/features/extensions/model/types.ts` + the client-facing record type: add `origin`.
- `ExtensionsSettingsTab.tsx` (currently a flat `extensions.map`, lines 75–83): partition by `origin` into a "Core extensions" section and an "Installed extensions" section, each rendering `ExtensionCard`. Empty "Installed" section shows a short empty-state; "Core" always has members.
- `ExtensionCard.tsx`: when `manifest.canDisable === false`, render the toggle as locked/absent with a small "Required" hint; otherwise the normal toggle. Keep the health/availability badge (compile/runtime error) visually distinct from the on/off toggle (research pitfall #4).
- `api/queries.ts`: enable/disable mutations unchanged — the server decides which list to mutate, so the HTTP surface (`POST /api/extensions/:id/{enable,disable}`) is untouched.

### 10. Initial core set

| ID              | Name        | `defaultEnabled` | `canDisable` | Source move                                                             |
| --------------- | ----------- | ---------------- | ------------ | ----------------------------------------------------------------------- |
| `marketplace`   | Marketplace | `true`           | `true`       | renamed dir (builtin → core)                                            |
| `hello-world`   | Hello World | `false`          | `true`       | `examples/extensions/hello-world/` → `core-extensions/hello-world/`     |
| `linear-issues` | Linear Loop | `false`          | `true`       | `examples/extensions/linear-issues/` → `core-extensions/linear-issues/` |

Hello World doubles as the canonical authoring skeleton (its source is the reference) and a live demo a user can toggle on. Linear Loop incubates here until `@dorkos/extension-api` is published and it migrates to the marketplace. Both default-off members exercise the `enabled`-list opt-in path, proving that branch from day one.

### 11. Remove `examples/extensions/`

Delete `examples/extensions/` entirely (`hello-world` and `linear-issues` move into `core-extensions/`; `hello-world-js` is dropped). Update references:

- `contributing/extension-authoring.md`: rewrite the "Built-in Extensions" section as "Core Extensions" (fixing the `stageBuiltinExtension`/"always enabled" drift); update the Quick Start (no longer "copy examples/… to ~/.dork/extensions/" — instead reference the shipped Hello World core extension and the scaffolding flow).
- Configuration docs: document the new `disabled` field and the deviation-list model.
- Historical spec docs that mention `examples/extensions/` are left as-is (point-in-time records).

### 12. Config hand-edit safety warning

On config load/validation, if any **default-on core** extension id appears in `extensions.enabled`, log a one-line warning (that entry is a no-op; the user likely meant to remove it from `disabled`). Cheap guardrail for hand-editors (research pitfall #1).

### Packaging (decision rationale)

Core extensions stay as a **flat directory inside the server app** (`apps/server/src/core-extensions/<id>/`), staged via the existing build-copy. A dedicated `packages/core-extensions/` workspace or one-package-per-extension was rejected: it adds a workspace dependency edge and build/copy complexity for server-internal, bundled-by-definition code with no payoff at this scale. This matches VS Code (flat `extensions/` dir) and JetBrains (flat `plugins/` dir). See research: `research/20260323_plugin_extension_ui_architecture_patterns.md`.

---

## User Experience

- **Settings → Extensions** now shows two labeled sections. "Core extensions" lists Marketplace (on), Hello World (off), Linear Loop (off), each with a toggle. "Installed extensions" lists anything the user added (empty by default, with a pointer to Marketplace).
- Toggling a core extension off persists across restarts (recorded in `disabled` for default-on, removed from `enabled` for default-off).
- A user who has never touched config sees Marketplace enabled and the two default-off extensions available but off — no surprise activation.
- On upgrade, a newly-shipped default-on core extension turns on automatically (absent from everyone's `disabled`); a newly-shipped default-off one stays off until opted in. This is the correct, unsurprising default per the deviation-list model.
- Disabling Marketplace is allowed; the `/marketplace` route handles the disabled state gracefully (it already degrades when the extension is absent). No core extension is locked on in the initial set.

---

## Testing Strategy

New tests:

- `extension-enable-resolution.test.ts` — the pure helper: default-on/off baselines, all six enable/disable→list-mutation cases, the "new core extension on upgrade" case (absent from both lists → resolves to its default), and the default-off-core opt-in path.
- `ensure-core-extensions.test.ts` — multi-extension scan; fresh-install / upgrade / no-op per extension; returns correct `CoreExtensionInfo[]`; idempotent on repeat calls (carried over + generalized from `ensure-marketplace.test.ts`).
- Manifest schema test — `defaultEnabled` / `canDisable` parse and defaults.
- `config-manager.test.ts` — upgrade-path: a v-prior config without `extensions.disabled` gains `disabled: []`; existing `enabled` preserved.
- Discovery test — `origin` derivation from the core set; tier-aware status for default-on vs default-off members.
- `ExtensionsSettingsTab.test.tsx` — two sections render; core vs installed partition by `origin`; `canDisable: false` hides/locks the toggle.

Updated tests:

- `extension-manager.test.ts` — enable/disable route to the correct deviation list by origin/default; `canDisable:false` disable is a no-op.
- `extension-discovery.test.ts` — new `discover()` signature + tier-aware status.
- `extension-routes.test.ts` — unchanged endpoints still flip state correctly under the new model.

Full suite (`pnpm test -- --run`) must pass; verify with the pre-push gate per `reference_vitest_dev_env_gotcha` (bare `pnpm vitest run` falsely fails two DEV-env tests). Build packages before bare vitest in the worktree.

## Performance Considerations

Negligible. `ensureCoreExtensions()` does a handful of stat/version comparisons and copies only changed trees at startup (same cost profile as today's single-extension stage, ×3). The resolution helper is O(list length) set membership per extension. No runtime hot-path change.

## Security Considerations

- Core extensions run with the same trust level as today's bundled Marketplace (in-process, no sandbox — unchanged v1 limitation). They ship with the app, so trust equals the app's own.
- Linear Loop holds a Linear API key via the existing encrypted secret store; staging copies only code, never secrets, and the copy-on-upgrade overwrites code files only — never co-located user data (research pitfall #2).
- No new external network surface beyond what Linear Loop already declares (`externalHosts: ["https://api.linear.app"]`), and it ships **off** by default.

## Documentation

- Rewrite `contributing/extension-authoring.md` "Built-in Extensions" → "Core Extensions" (behavior now matches docs; drift fixed).
- `contributing/configuration.md` + `docs/getting-started/configuration.mdx` — document `extensions.disabled` and the deviation-list model.
- Update `MEMORY.md` pointers if the core-extension layout becomes a recurring reference.

---

## Implementation Phases

Single comprehensive spec, six ordered phases. Phases can land as incremental PRs off the `core-extensions` worktree branch.

1. **Phase 1 — Rename + generalized staging.** `builtin-extensions` → `core-extensions` (source dir, service dir, `cpSync`, `index.ts` wiring). `ensureBuiltinMarketplaceExtension` → `ensureCoreExtensions()` returning `CoreExtensionInfo[]`. Behavior-preserving: Marketplace still stages and stays enabled. Migrate `ensure-marketplace.test.ts`.
2. **Phase 2 — Config + manifest.** Add `extensions.disabled` + version-keyed migration; add `defaultEnabled`/`canDisable` to the manifest schema. Full `adding-config-fields` lifecycle + tests.
3. **Phase 3 — Origin + tier-aware resolution.** Add `origin` to records/public/`toPublic()`; new `discover()` signature; the `extension-enable-resolution` helper; route `enable()`/`disable()` through it; `canDisable:false` guard. Tests.
4. **Phase 4 — Settings UI.** Core/Installed sections; `origin` on the client type; `canDisable` toggle handling; health badge separation. Tests.
5. **Phase 5 — Initial core set + examples removal.** Set Marketplace `defaultEnabled:true`; move Hello World + Linear Loop into `core-extensions/` with `defaultEnabled:false`; delete `examples/extensions/`.
6. **Phase 6 — Docs + hand-edit warning.** Rewrite extension-authoring + configuration docs; add the config load warning.

Dependencies: 1 → 2 → 3 → 4; 5 depends on 1 (dir) + 3 (defaults honored); 6 last.

---

## Open Questions (All Resolved)

1. ~~**One comprehensive spec or split into two?**~~ (RESOLVED)
   **Answer:** One comprehensive spec with six ordered phases (phases may still PR incrementally).
   **Rationale:** Cohesive refactor+feature with sequential dependencies; single worktree; matches the holistic-batch working preference.

2. ~~**How does Linear Loop appear in the Core section?**~~ (RESOLVED)
   **Answer:** Plain default-off core extension — no badge or sub-grouping.
   **Rationale:** The off-by-default state already signals "optional"; uniform treatment keeps the Core section clean. A badge can be revisited if/when more vendor integrations land.

3. ~~**Config hand-edit safety warning?**~~ (RESOLVED)
   **Answer:** Include it — warn when a default-on core id appears in `enabled` (no-op).
   **Rationale:** Cheap, honest-by-design guardrail (research pitfall #1).

4. ~~**Migration version key?**~~ (RESOLVED — deferred to release)
   **Answer:** Keyed to the release this lands in; not hardcoded in the spec.
   **Rationale:** `/system:release` detects config drift and scaffolds the keyed migration at tag time. The spec specifies the migration body; the key is filled at release.

---

## Related ADRs

Draft ADRs auto-extracted from this spec (run `/adr:curate` to promote significant ones):

- Two-list deviation-based config (`enabled` + `disabled`) for default-on/off extension state.
- `origin` tracking derived from the startup staging set (core vs user).
- Core extensions as same-API first-party extensions in a flat server-app directory (vs separate package / separate API).
- Core extensions are user-disableable; reserved `canDisable: false` flag (no locked built-ins in the initial set).

Prior art: ADR-0200 (app-layer synchronous extension init), ADR-0202 (esbuild content-hash cache), ADR-0213 (Directus-style server extension registration), ADR-0237 (same-repo monorepo for the marketplace seed — defines where extensions graduate to).

## References

- Ideation: `specs/core-extensions/01-ideation.md`
- Research: `research/20260323_plugin_extension_ui_architecture_patterns.md`, `research/20260326_extension_point_registry_patterns.md`, `research/20260329_extension_manifest_settings_schema.md`, `research/20260329_extension_server_side_capabilities.md`
- Code: `apps/server/src/services/extensions/`, `apps/server/src/services/builtin-extensions/ensure-marketplace.ts`, `apps/server/src/builtin-extensions/marketplace/`, `packages/shared/src/config-schema.ts`, `apps/server/src/services/core/config-manager.ts`, `apps/client/src/layers/features/extensions/`
- Skill: `.claude/skills/adding-config-fields/`
