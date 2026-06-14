# Implementation Summary: Core Extensions

**Created:** 2026-06-13
**Last Updated:** 2026-06-13
**Spec:** specs/core-extensions/02-specification.md

## Session

Worktree: `/Users/doriancollier/.dork/workspaces/core/core-extensions`
Branch: `core-extensions`
Ports: DORKOS_PORT=4312, VITE_PORT=4462

## Progress

**Status:** Complete
**Tasks Completed:** 18 / 18

## Tasks Completed

### Session 1 - 2026-06-13

- Task #1 (P1): Renamed `builtin-extensions` → `core-extensions` (source dir, service dir, `cpSync` build line, all path refs). `git mv` preserved history. Server typecheck clean, build copies `dist/core-extensions/marketplace/extension.json`, `ensure-marketplace` tests pass (4/4).
- Task #5 (P2, pulled forward): Added optional `defaultEnabled` + `canDisable` to `ExtensionManifestSchema` (`packages/extension-api`). Done before #2 so the scanner could derive tier metadata from typed manifest fields without casts. 55 schema tests pass; `dist` d.ts rebuilt so the server resolves the new fields.
- Task #2 (P1): Replaced `ensure-marketplace.ts` with `ensure-core-extensions.ts` — `ensureCoreExtensions(dorkHome, sourceDir?)` scans the bundled tree, version-stages each valid subdir (fresh/upgrade/no-op, non-fatal per extension), returns `CoreExtensionInfo[]`. `index.ts` captures the metadata and passes it to `new ExtensionManager(dorkHome, coreExtensions)` (stored as a map seam, consumed in Phase 3). `sourceDir` param added for deterministic multi-ext fixture tests. 10 scanner tests pass; **full server suite 2850 pass / 0 fail**.
- Task #3 (P2): `extensions` config block is now the two-list deviation model `{ enabled: string[]; disabled: string[] }` (both with `.default([])`, outer `.default({...})`). Interim-patched `extension-manager` `enable()`/`disable()` `set()` calls to preserve `disabled` (superseded by #10's `setEnabled()` routing). Added 5 deviation-list schema tests. Rebuilt `@dorkos/shared` so the server resolves the new type.
- Task #4 (P2): Added `backfillExtensionsDisabled` migration body (exported `@internal`) + a release-time placeholder key `'<next-release>'` in `CONFIG_MIGRATIONS`. Confirmed conf 15.1.0 treats the non-semver key as an unsatisfiable range — inert (no crash) until `/system:release` resolves it. 4 migration-body tests (backfill+preserve, idempotent, absent-key skip, non-array disabled). config-manager suite 20 pass.

**Phase 3 — Origin + tier-aware resolution (#6–#11):**

- Task #7 (P3): NEW pure helper `extension-enable-resolution.ts` — canonical `CoreExtensionInfo`/`ExtensionsConfig` types + `defaultsOn`, `isEnabled`, `setEnabled` (deviation-list routing; immutable, deduped). 20 helper tests.
- Task #8 (P3): Consolidated `CoreExtensionInfo` to the helper as the single definition; `ensure-core-extensions.ts`, `extension-manager.ts`, `index.ts` import from it.
- Task #6 (P3): Added required `origin: 'core' | 'user'` to `ExtensionRecord` + `ExtensionRecordPublic`; `toPublic()` passes it through. Rebuilt `@dorkos/extension-api` dist. Also set `origin: 'user'` on the marketplace-install transient record.
- Task #9 (P3): `discover(cwd, config, core)` new signature; readers typed `Omit<ExtensionRecord,'origin'>`; loop sets `origin` (from core-map membership) + tier-aware `status` via `isEnabled`; log line includes origin. Discovery suite 23 pass (5 new tier/origin cases).
- Task #10 (P3): Manager `reload()` passes `{enabled,disabled}` + core map to discover; `enable()`/`disable()` route through `setEnabled()`; `canDisable:false` guard in `disable()` returns null before mutation. Replaced #3's interim patch. Manager suite 35 pass (4 tier-routing cases).
- Task #11 (P3): Verified route handlers delegate to the manager unchanged (locked-disable → existing 404 null-path, no contract change). Route suite 23 pass (origin surfaced + locked no-op). Updated integration + server-lifecycle tests for the new signature/config shape.
- **Full server suite: 2887 pass / 1 skip / 0 fail.**

**Phase 4 — Settings UI (#12–#14):**

- Task #12 (P4): `origin` is already on `ExtensionRecordPublic` (the type the settings UI consumes via `useExtensions`), so no production client type change was needed — `LoadedExtension` is the activated-instance type, not the list record, and was intentionally left unchanged. Fixed 3 client test fixtures (`ExtensionsSettingsTab`, `extension-loader`, `extension-hot-reload`) to include the now-required `origin` (client tsconfig includes tests).
- Task #13 (P4): `ExtensionsSettingsTab` partitions by `origin` into "Core extensions" and "Installed extensions" sections (`<h3 className="text-sm font-semibold">` per the established settings heading pattern). Empty Installed → dashed empty-state with a Dork Hub pointer. Preserved the overall-empty fallback.
- Task #14 (P4): `ExtensionCard` renders a "Required" badge instead of the toggle when `manifest.canDisable === false`; added a distinct health badge (Error/Incompatible/Invalid) in the metadata row, kept separate from the on/off toggle (research pitfall #4).
- **Full client suite: 4162 pass / 0 fail** (357 files). Client typecheck + extensions-feature lint clean.

**Phase 5 — Initial core set + examples removal (#15, #16):**

- Task #15 (P5): Dork Hub manifest gains `defaultEnabled: true`, `canDisable: true` (default-on, disableable). Exercises the `disabled`-list opt-out path.
- Task #16 (P5): `git mv` `examples/extensions/{hello-world,linear-issues}` → `apps/server/src/core-extensions/`, both with `defaultEnabled: false`, `canDisable: true` (opt-in path). Dropped `hello-world-js`; `examples/` removed entirely. No code/build referenced `examples/extensions` (only docs → #18).
- **Architecture fix (required by the move):** the moved `*.ts` extension entries contain JSX, which the server's Node `tsc` cannot compile. Excluded `src/core-extensions/**` from the server `tsconfig` and changed the build `cpSync` to copy the full tree (including `.ts`) — core extensions now ship as SOURCE and are compiled at runtime by the same esbuild pipeline as user extensions (dogfooding the public API, per spec). Clean build yields source-only `dist/core-extensions/{marketplace,hello-world,linear-issues}/`.
- Scanner smoke test now asserts the three-extension set with correct tier metadata. **Full server suite: 2887 pass / 1 skip / 0 fail.**

**Phase 6 — Docs + hand-edit warning (#17, #18):**

- Task #17 (P6): NEW `warn-redundant-enabled.ts` — `warnRedundantEnabledEntries(core, enabled)` logs a one-line warning per default-on core id found in `extensions.enabled` (a no-op; use `extensions.disabled`). Wired into `index.ts` after staging. Pure of config mutation. 4 unit tests (logger spy + restore).
- Task #18 (P6): Rewrote `contributing/extension-authoring.md` "Built-in Extensions" → "Core Extensions" (real `ensureCoreExtensions()` model, Settings sections, `defaultEnabled`/`canDisable` semantics, three-extension table, no per-extension `ensure-{id}.ts`, Quick Start pointing at the shipped Hello World). Documented `extensions.disabled` + the deviation model in `contributing/configuration.md` and `docs/getting-started/configuration.mdx`. Fixed all lingering `builtin-extensions`/`stageBuiltinExtension`/`examples/extensions` references across `AGENTS.md`, `contributing/{architecture,project-structure,marketplace-installs,INDEX}.md`, and `docs/{contributing,concepts}/architecture.mdx`. (Delegated to one focused docs agent; verified — all three acceptance greps empty.)
- **Build fix (extension source compiles at runtime, not by tsc/eslint):** excluded `src/core-extensions/**` from the server `tsconfig` AND `eslint.config.js`; build copies the full source tree.

## Final Verification (monorepo)

- **Typecheck:** 21/21 packages ✓
- **Lint:** 16/16 ✓ (0 errors; only pre-existing warnings in untouched files)
- **Test:** 20/20 ✓ — server 2891 pass / 1 skip, client 4162 pass, relay 1325, mesh 291, a2a 99, shared 499, extension-api 55
- **Build:** 14/14 ✓ — clean `dist/core-extensions/{marketplace,hello-world,linear-issues}/` (source-only); site MDX renders.

**Files (Phase 3–4):**

- `apps/server/src/services/extensions/extension-enable-resolution.ts` (NEW), `extension-discovery.ts`, `extension-manager.ts`, `extension-manager-types.ts`; `apps/server/src/services/marketplace/flows/install-plugin.ts`; `packages/extension-api/src/types.ts`; `packages/shared/src/config-schema.ts`; `apps/server/src/services/core/config-manager.ts`.
- Client: `apps/client/src/layers/features/extensions/ui/{ExtensionsSettingsTab,ExtensionCard}.tsx`.
- Tests: server `extension-enable-resolution`, `extension-discovery`, `extension-manager`, `extension-manager-server`, `extension-lifecycle.integration`, `routes/extensions`, `config-manager`, `config-schema`, `manifest-schema`; client `ExtensionsSettingsTab`, `extension-loader`, `extension-hot-reload`.

## Files Modified/Created

**Source files:**

- `apps/server/src/core-extensions/marketplace/{index,server}.ts` — moved from `builtin-extensions/`; `@module` tags updated.
- `apps/server/src/services/core-extensions/ensure-core-extensions.ts` — NEW generalized scanner (replaces `ensure-marketplace.ts`, which was deleted).
- `apps/server/src/services/extensions/extension-manager.ts` — constructor takes `coreExtensions: CoreExtensionInfo[]`, stored as `private coreExtensions` map (Phase 3 seam).
- `apps/server/src/index.ts` — imports `ensureCoreExtensions` + `CoreExtensionInfo`; captures metadata, passes to `ExtensionManager`.
- `apps/server/package.json` — build `cpSync` `src/core-extensions` → `dist/core-extensions`.
- `packages/extension-api/src/manifest-schema.ts` — `defaultEnabled` + `canDisable` optional fields.

**Test files:**

- `apps/server/src/services/core-extensions/__tests__/ensure-core-extensions.test.ts` — NEW (replaces `ensure-marketplace.test.ts`): multi-ext scan, skip-invalid, tier-metadata derivation, fresh/upgrade/corrupt/no-op, idempotent, missing-source, real-bundled smoke.
- `packages/extension-api/src/__tests__/manifest-schema.test.ts` — added tier-field cases (present true/false, omitted, round-trip, reject non-boolean).

## Known Issues

- None. (The earlier `builtin-extensions` doc drift was resolved in Phase 6 / #18 — scope expanded beyond `extension-authoring.md` to all referencing docs.)

## Implementation Notes

### Session 1

Executed sequentially (single writer) phase-by-phase rather than via parallel background agents — the repo's per-edit PostToolUse hooks run a full-workspace `tsc` + related vitest on **every** edit, which makes concurrent writers counterproductive (racing tsc / intermediate-state churn). Verification used phase-level holistic gates (per saved preference `feedback_holistic_batch_gates`).

Notable deviations / decisions, all documented above:

- **#5 pulled before #2** so the scanner could derive tier metadata from typed manifest fields without casts.
- **#3 → interim `set()` patch**, later superseded by **#10**'s `setEnabled()` routing (kept the tree green between phases).
- **Migration key** is the literal placeholder `'<next-release>'` — confirmed inert under conf 15.1.0 (treated as an unsatisfiable range) until `/system:release` resolves it.
- **#12** required no production client type change (origin already on `ExtensionRecordPublic`); only client test fixtures needed the now-required field.
- **#16 build/lint/tsc architecture fix**: core-extension source ships as source and is compiled at runtime by esbuild — excluded from server `tsc` + `eslint`.

### Post-implementation review (2026-06-13)

Ran `/review-recent-work` plus an independent `code-reviewer` subagent over the full
`git diff`. The reviewer empirically confirmed the `conf` placeholder-key is inert
(`semver.satisfies('0.1.0','<next-release>')` → `false`, no throw), that the scanner
copies code only (the Linear API key is read at runtime via `ctx.secrets`, never
staged), and that there is zero remaining `builtin-extensions` / `stageBuiltinExtension`
/ `examples/extensions` drift in code. No Critical issues. Two findings fixed:

- **`canDisable` UI/server guard mismatch (Important).** `ExtensionCard` decided the
  "Required" lock from `manifest.canDisable !== false` (origin-independent), while the
  server guard (`extension-manager.disable`) only locks `origin === 'core'`. A
  user/marketplace extension declaring `canDisable: false` would have hidden its toggle
  while the server still allowed disabling. Fixed `ExtensionCard.tsx` to gate the lock on
  `origin === 'core' && manifest.canDisable === false`, matching the server exactly
  (ADR-0271's "two enforcement points must stay in sync"). Added a regression test that a
  `user` extension with `canDisable:false` still renders an interactive switch.
- **Honest status for a locked disable (Minor → fixed).** `POST /:id/disable` returned
  404 ("not found") when the manager refused a required core extension — misleading for
  the `/mcp` surface that exposes this to external agents. The route now distinguishes
  the two `null` reasons via `extensionManager.get(id)`: 409 Conflict ("required and
  cannot be disabled") when the record exists, 404 only when genuinely absent. Updated
  the route test to assert 409.

Re-verified after fixes: typecheck 21/21, lint 16/16 (0 errors), affected suites green
(server `routes/extensions` 23/23, client `ExtensionsSettingsTab` 18/18).

### Follow-ups (not blockers)

- `/system:release` must replace the `'<next-release>'` migration key with the real release version at tag time (it auto-detects this drift).
- Draft ADRs 0268–0271 await `/adr:curate` (0270/0271 overlap slightly).
- **Type coverage for core-extension server code.** Excluding `src/core-extensions/**`
  from the server `tsc`/`eslint` is the intended model — core extensions are compiled at
  runtime by esbuild exactly like user extensions (which are never type-checked by the
  server). The one real consequence is that the marketplace extension's `server.ts`
  (~250 lines, no JSX) lost the compile-time checking it had under `builtin-extensions/`.
  A future `tsconfig.core-extensions.json` (no-emit, `jsx: react-jsx`) wired into the
  typecheck task could restore it without entering the server build. Deferred, not blocking.
- Pre-existing `index.ts` max-lines lint **warning** (653 lines) is unrelated to this spec; out of scope.
