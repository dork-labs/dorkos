# Core Extensions — Task Breakdown

**Spec:** `specs/core-extensions/02-specification.md`
**Slug:** `core-extensions`
**Generated:** 2026-06-13T20:27:40Z
**Mode:** full
**Total tasks:** 18 across 6 phases

This breakdown mirrors the spec's six ordered phases. Testing is folded into each task (the relevant test files from the spec's Testing Strategy are attached to the task that owns the code). There is no separate testing phase.

**Phase dependencies (from spec):** 1 → 2 → 3 → 4; phase 5 depends on phase 1 (dir exists) + phase 3 (defaults honored); phase 6 is last.

**Verification note:** Use `pnpm test -- --run` (the pre-push gate). Per `reference_vitest_dev_env_gotcha`, bare `pnpm vitest run` falsely fails two DEV-env tests; build packages before bare vitest in the worktree.

---

## Phase 1 — Rename + generalized staging

Behavior-preserving structural change: rename the in-repo dirs and generalize the one-off marketplace staging into a directory scanner. The runtime `{dorkHome}/extensions/` discovery dir is unchanged.

### 1.1 — Rename builtin-extensions source + service dirs and update build cpSync

`git mv apps/server/src/builtin-extensions/ → core-extensions/` and `apps/server/src/services/builtin-extensions/ → services/core-extensions/`. Update `apps/server/package.json:14` cpSync to `src/core-extensions`/`dist/core-extensions`. Grep the server tree for residual `builtin-extensions` references.
**Size:** small · **Priority:** high · **Deps:** none · **Parallel with:** —

### 1.2 — Generalize ensure-marketplace into ensureCoreExtensions() scanner and wire into index.ts

New `services/core-extensions/ensure-core-extensions.ts` exporting `ensureCoreExtensions(dorkHome): Promise<CoreExtensionInfo[]>` scanning `CORE_SOURCE_DIR = path.resolve(__dirname, '../../core-extensions')`, version-staging each subdir (reuse read-manifest-version + `fs.cp` fresh/upgrade/no-op logic), returning `{ id, defaultEnabled: manifest.defaultEnabled !== false, canDisable: manifest.canDisable !== false }` per extension. Repoint `index.ts:37`/`:167` to the new non-fatal call and capture the returned list. Delete `ensure-marketplace.ts`. Migrate `ensure-marketplace.test.ts` → `ensure-core-extensions.test.ts` (multi-ext scan, fresh/upgrade/no-op, returns info, idempotent).
**Size:** medium · **Priority:** high · **Deps:** 1.1 · **Parallel with:** —

---

## Phase 2 — Config + manifest

Add the `disabled` deviation list + migration, and the `defaultEnabled`/`canDisable` manifest fields. Follows the `adding-config-fields` lifecycle.

### 2.1 — Extend extensions config schema with deviation-list disabled[] field

`packages/shared/src/config-schema.ts` (~line 135): `extensions` becomes `{ enabled: string[]; disabled: string[] }` (both inner arrays `.default(() => [])`, outer object `.default(() => ({ enabled: [], disabled: [] }))`). Deviation-list mental model documented in comments. Verify `USER_CONFIG_DEFAULTS` parses.
**Size:** small · **Priority:** high · **Deps:** 1.2 · **Parallel with:** 2.3

### 2.2 — Add version-keyed config migration backfilling extensions.disabled

`config-manager.ts` (`CONFIG_MIGRATIONS` ~line 81): append a placeholder-keyed (`'<next-release>'`) entry that backfills `disabled: []` when missing, preserving `enabled`. Comment notes `/system:release` resolves the key at tag time. Upgrade-path test in `config-manager.test.ts`.
**Size:** small · **Priority:** high · **Deps:** 2.1 · **Parallel with:** 2.3

### 2.3 — Add defaultEnabled + canDisable optional fields to ExtensionManifestSchema

`packages/extension-api/src/manifest-schema.ts`: add `defaultEnabled: z.boolean().optional()` and `canDisable: z.boolean().optional()` (with documenting comments). Manifest schema test (present true/false, omitted, round-trip).
**Size:** small · **Priority:** high · **Deps:** 1.2 · **Parallel with:** 2.1, 2.2

---

## Phase 3 — Origin + tier-aware resolution

Add `origin` to records, the pure resolution helper, and route discovery + manager through it.

### 3.1 — Add origin field to ExtensionRecord, ExtensionRecordPublic, and toPublic()

`packages/extension-api/src/types.ts`: add `origin: 'core' | 'user'` to both record types. `extension-manager-types.ts`: copy `origin` through `toPublic()`. Test that `origin` survives `toPublic()`.
**Size:** small · **Priority:** high · **Deps:** 2.3 · **Parallel with:** 3.2, 3.3

### 3.2 — Create extension-enable-resolution pure helper (defaultsOn, isEnabled, setEnabled)

New `services/extensions/extension-enable-resolution.ts` exporting `CoreExtensionInfo`, `ExtensionsConfig`, `defaultsOn`, `isEnabled`, `setEnabled`. Toggle-routing table: default-on core uses `disabled` (enable=remove, disable=add); default-off core + user use `enabled` (enable=add, disable=remove). New test covers default-on/off baselines, all six toggle→list cases, new-core-on-upgrade, default-off opt-in.
**Size:** medium · **Priority:** high · **Deps:** 2.1 · **Parallel with:** 3.1, 3.3

### 3.3 — Point CoreExtensionInfo type from ensureCoreExtensions to the shared resolution helper

Consolidate `CoreExtensionInfo` to one definition (in the resolution helper); `ensure-core-extensions.ts` imports it. Grep confirms a single `interface CoreExtensionInfo`.
**Size:** small · **Priority:** medium · **Deps:** 3.2 · **Parallel with:** 3.1

### 3.4 — Update discover() signature for tier-aware status + origin derivation

`extension-discovery.ts` (~line 31): `discover(cwd, config: {enabled,disabled}, core: Map<string,CoreExtensionInfo>)`. In the status loop (~50–70) set `rec.origin = core.has(rec.id) ? 'core' : 'user'` and `rec.status = isEnabled(...) ? 'enabled' : 'disabled'`; add `origin` to the discovery log line. Local-override-of-core edge case stays `origin: 'core'` by id membership. Update `extension-discovery.test.ts`.
**Size:** medium · **Priority:** high · **Deps:** 3.1, 3.2 · **Parallel with:** —

### 3.5 — Route enable/disable through setEnabled, hold core map, add canDisable guard

`extension-manager.ts`: hold `coreExtensions: Map<string,CoreExtensionInfo>` (from `index.ts`); `reload()` (~107) passes `{enabled,disabled}` + core map to `discover()`; `enable()` (~198)/`disable()` (~227) route through `setEnabled()` (replacing the direct `enabled` mutation at 210–213/235–238); `disable()` returns `null` for `canDisable:false` core extensions. Complete the `index.ts` passthrough of the staged list. Update `extension-manager.test.ts`.
**Size:** medium · **Priority:** high · **Deps:** 3.4, 3.3 · **Parallel with:** —

### 3.6 — Verify extension HTTP routes still flip state under the new model

`routes/extensions.ts` enable/disable endpoints unchanged in contract (server decides the list). Confirm handlers delegate to the manager. Update `extension-routes.test.ts` to assert endpoints flip state correctly (default-on via `disabled`, default-off/user via `enabled`) and `canDisable:false` disable is a no-op.
**Size:** small · **Priority:** medium · **Deps:** 3.5 · **Parallel with:** —

---

## Phase 4 — Settings UI

Split the flat list into Core/Installed sections; honor `canDisable`; keep the health badge distinct from the toggle.

### 4.1 — Add origin to the client extension type

`apps/client/src/layers/features/extensions/model/types.ts`: add `origin: 'core' | 'user'` to the client `LoadedExtension`. `api/queries.ts` unchanged.
**Size:** small · **Priority:** high · **Deps:** 3.5 · **Parallel with:** 4.3

### 4.2 — Partition ExtensionsSettingsTab into Core and Installed sections

`ExtensionsSettingsTab.tsx` (~75–83): partition by `origin` into "Core extensions" (always populated) and "Installed extensions" (empty-state with Marketplace pointer when no user extensions). Responsive. New `ExtensionsSettingsTab.test.tsx` (two sections, partition by origin, empty-state).
**Size:** medium · **Priority:** high · **Deps:** 4.1 · **Parallel with:** —

### 4.3 — Handle canDisable:false in ExtensionCard and keep health badge distinct from toggle

`ExtensionCard.tsx`: `canDisable === false` → locked/absent toggle + "Required" hint; otherwise normal toggle. Keep the runtime-health/availability badge visually distinct from the on/off toggle (research pitfall #4). Tests for canDisable:false lock, normal toggle, badge-vs-toggle separation.
**Size:** medium · **Priority:** high · **Deps:** 4.1 · **Parallel with:** 4.2

---

## Phase 5 — Initial core set + examples removal

Seed the tier and remove `examples/extensions/`. Depends on phase 1 (dir) + phase 3 (defaults honored).

### 5.1 — Set Marketplace manifest defaultEnabled:true, canDisable:true

`apps/server/src/core-extensions/marketplace/extension.json`: add `defaultEnabled: true`, `canDisable: true`. Exercises the default-on opt-out path. Verified via `ensure-core-extensions.test.ts` + discovery/manager tests.
**Size:** small · **Priority:** high · **Deps:** 1.2, 3.5 · **Parallel with:** 5.2

### 5.2 — Move Hello World + Linear Loop into core-extensions as default-off, delete examples/extensions

`git mv examples/extensions/hello-world/ → core-extensions/hello-world/` (`defaultEnabled:false, canDisable:true`) and `examples/extensions/linear-issues/ → core-extensions/linear-issues/` (Linear Loop, `defaultEnabled:false, canDisable:true`). Drop `hello-world-js`. Delete `examples/extensions/`. Staging copies code only, never the Linear secret (research pitfall #2). Extend `ensure-core-extensions.test.ts` for the three-extension set; discovery resolves both default-off members to `disabled` on fresh config.
**Size:** medium · **Priority:** high · **Deps:** 1.1, 3.5 · **Parallel with:** 5.1

---

## Phase 6 — Docs + hand-edit warning

Last phase: the config-load guardrail and the doc rewrites that fix existing drift.

### 6.1 — Add config-load hand-edit warning for default-on core ids in enabled

Near the `ensureCoreExtensions()` call site in `index.ts` (the config-manager doesn't know core defaults), warn once per default-on core id found in `extensions.enabled` (no-op; point the user to `extensions.disabled`). No config mutation. Unit test with logger spy + cleanup (research pitfall #1).
**Size:** small · **Priority:** medium · **Deps:** 3.5, 5.1 · **Parallel with:** 6.2

### 6.2 — Rewrite extension-authoring + configuration docs for Core Extensions

`contributing/extension-authoring.md`: rewrite "Built-in Extensions" → "Core Extensions" (remove the phantom `stageBuiltinExtension()` + "always enabled" drift; update Quick Start to reference the Hello World core extension instead of copying `examples/…`; document `defaultEnabled`/`canDisable`). `contributing/configuration.md` + `docs/getting-started/configuration.mdx`: document `extensions.disabled` + the deviation-list model + hand-edit caveat. Leave historical spec/research docs as-is.
**Size:** medium · **Priority:** medium · **Deps:** 5.2 · **Parallel with:** 6.1

---

## Parallelization & Critical Path

**Parallel opportunities (disjoint files):**

- Phase 2: **2.1 + 2.3** (config schema vs manifest schema — different packages), then **2.2 + 2.3** (migration vs manifest).
- Phase 3: **3.1 + 3.2 + 3.3** (record types vs resolution helper vs type consolidation) before the discovery/manager merge points.
- Phase 4: **4.1 + 4.3**, and **4.2 + 4.3** (settings tab vs extension card).
- Phase 5: **5.1 + 5.2** (Marketplace manifest vs the move/delete — different dirs).
- Phase 6: **6.1 + 6.2** (warning code vs docs).

**Critical path (longest dependency chain):**
1.1 → 1.2 → 2.1 → 3.2 → 3.4 → 3.5 → 5.2 → 6.2

This is the spine: rename → generalize staging → config schema → resolution helper → tier-aware discovery → manager routing → move-in the initial set → final docs. Phase 4 (UI) branches off 3.5 in parallel with phase 5; phase 6's warning (6.1) also hangs off 3.5/5.1. Most leaf tasks (2.2, 2.3, 3.1, 3.3, 3.6, 4.x, 5.1, 6.1) sit off the spine and can run alongside it.
