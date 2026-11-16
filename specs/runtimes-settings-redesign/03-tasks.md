---
slug: runtimes-settings-redesign
spec: specs/runtimes-settings-redesign/02-specification.md
generated: 2026-08-03
mode: full
---

# Task breakdown - Runtimes settings redesign

Human-readable mirror of [03-tasks.json](03-tasks.json). The JSON is the machine
contract; this file is the same content for reading. Two phases, two stacked
PRs: phase 1 is the declaration layer with no visual change, phase 2 is the new
tab.

Frozen spec: [02-specification.md](02-specification.md).
Approved design: [04-design-decisions.md](04-design-decisions.md).
Discovery with file:line anchors: [01-ideation.md](01-ideation.md).

## P1 — Declaration layer

PR 1. Mechanically verifiable, zero visual risk. The runtime interface grows a
required `settings` capability, four adapters declare it, the conformance suite
enforces it, and three hand-kept maps are retired against it.

### Task 1.1: Add RuntimeSettingsCapability to the shared runtime interface

**Size:** small · **Priority:** high · **Depends on:** none · **Parallel with:** none

Add the runtime-declared settings capability to `packages/shared/src/agent-runtime.ts`.

STEP 1 - insert these two exported interfaces directly above the `RuntimeCapabilities` declaration (currently line 413), copied verbatim. TSDoc on exports is lint-enforced by `eslint-plugin-jsdoc`, so keep the comments:

```ts
/** One bespoke settings section a runtime's settings card renders. */
export interface RuntimeSettingsSection {
  /**
   * Renderer key, e.g. 'claude-accounts', 'opencode-power-source'. The client
   * maps known kinds to feature-supplied renderers (same slot pattern as the
   * connect flows); unknown kinds render nothing (forward-compatible).
   */
  kind: string;
}

/** Static settings declaration for a runtime. */
export interface RuntimeSettingsCapability {
  /**
   * Key of this runtime's section under `runtimes.*` in user config
   * ('claudeCode' | 'codex' | 'opencode' today), or null when the runtime has
   * no config section (test-mode). Replaces the duplicated
   * CONFIG_SECTION_BY_RUNTIME maps. Typed `string | null` in shared (the
   * config schema is host-side); the server validates it against the real
   * config shape with a type guard and skips unknown sections.
   */
  configSection: string | null;
  /**
   * Whether this runtime takes an effort setting at all - the runtime-level
   * static fact (replaces shared `runtimeSupportsEffort()` /
   * RUNTIMES_WITHOUT_EFFORT). Per-model effort support remains
   * `ModelOption.supportsEffort` / `supportedEffortLevels`; both gates apply,
   * exactly as ExecutionDefaultsCard implements today.
   */
  supportsEffort: boolean;
  /** Ordered bespoke sections for the settings card. Empty for most runtimes. */
  sections: RuntimeSettingsSection[];
}
```

STEP 2 - add a REQUIRED field to `RuntimeCapabilities`, placed as a sibling of `commandIntents` and above `features`:

```ts
/**
 * Required - every adapter declares its settings surface. Compile-time
 * forcing per the `commandIntents` precedent (ADR-0256): a new runtime
 * cannot silently omit it. Static only: account lists, current provider and
 * readiness stay on the refetched surfaces (`GET /api/config`,
 * `GET /api/system/requirements`) so capabilities remain safe to cache with
 * `staleTime: Infinity`.
 */
settings: RuntimeSettingsCapability;
```

Do NOT make it optional. Making it required is the whole point: the four adapters and every capability fixture go red until they declare it, which is task 1.2 and task 1.3.

Acceptance criteria:

- `pnpm --filter @dorkos/shared typecheck` is green after `packages/shared/src/__tests__/agent-runtime.test.ts` fixtures are updated (that file builds full `RuntimeCapabilities` objects at lines 36, 94 and 114 - add `settings: { configSection: null, supportsEffort: false, sections: [] }` to each unless the test's subject calls for otherwise).
- Add one test to `packages/shared/src/__tests__/agent-runtime.test.ts` that pins the requiredness: build a capability object literal missing `settings` under `// @ts-expect-error settings is required` and assert the surrounding object still constructs. If the field is ever made optional the `@ts-expect-error` becomes an unused-directive error, which is the failure signal.
- Run `pnpm vitest run packages/shared/src/__tests__/agent-runtime.test.ts`.
- Finish with `pnpm --filter @dorkos/shared build` so downstream packages resolve the new type (a stale `@dorkos/shared` dist produces false-red type errors across the monorepo).

### Task 1.2: Declare settings capabilities in all four runtime adapters

**Size:** small · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 1.3

Declare `settings` in each adapter's static capability constant. One file per runtime, all under `apps/server/src/services/runtimes/*/runtime-constants.ts`:

| File                               | Constant                   | configSection  | supportsEffort | sections                              |
| ---------------------------------- | -------------------------- | -------------- | -------------- | ------------------------------------- |
| `claude-code/runtime-constants.ts` | `CLAUDE_CODE_CAPABILITIES` | `'claudeCode'` | `true`         | `[{ kind: 'claude-accounts' }]`       |
| `codex/runtime-constants.ts`       | `CODEX_CAPABILITIES`       | `'codex'`      | `true`         | `[]`                                  |
| `opencode/runtime-constants.ts`    | `OPENCODE_CAPABILITIES`    | `'opencode'`   | `false`        | `[{ kind: 'opencode-power-source' }]` |
| `test-mode/runtime-constants.ts`   | test-mode capabilities     | `null`         | `false`        | `[]`                                  |

(Confirm the exact exported constant names by reading each file; `OPENCODE_CAPABILITIES` and `CODEX_CAPABILITIES` are the documented models in `contributing/adding-a-runtime.md`.)

Place the field next to `permissionModes` in each object, with a short comment per runtime saying WHY the values are what they are:

- claude-code: effort is real at the API and per-model rungs come from the catalog; the accounts section is the relocated billing-account feature.
- codex: effort is real; no bespoke section.
- opencode: `supportsEffort: false` because OpenCode's prompt body carries no effort field in either the pinned or current SDK (this is the exact fact `RUNTIMES_WITHOUT_EFFORT` encoded); the power-source section is the provider picker.
- test-mode: `configSection: null` because it is a real runtime with no config section, which is why it must stay absent from `executionDefaults.perRuntime[]`.

Acceptance criteria:

- `pnpm --filter @dorkos/server typecheck` green.
- `pnpm vitest run apps/server/src/routes/__tests__/capabilities.test.ts` green; extend it with one assertion that `GET /api/capabilities` returns `settings.configSection === 'claudeCode'` for claude-code and `null` for test-mode, so the wire projection is pinned.
- No dynamic state anywhere in these literals (no account lists, no provider ids, no readiness).

### Task 1.3: Sweep every RuntimeCapabilities fixture for the new required field

**Size:** medium · **Priority:** high · **Depends on:** 1.1 · **Parallel with:** 1.2

Making `settings` required breaks every test fixture and mock that builds a full `RuntimeCapabilities` object. Find them all and add the field.

GREP FIRST (run both, the second catches objects that spell only some flags):

```
grep -rn "supportsQuestionPrompt" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules | grep -v /dist/
grep -rn "commandIntents" --include="*.ts" --include="*.tsx" apps packages | grep -v node_modules | grep -v /dist/
```

Known call sites at decompose time (re-point any newly found ones too):

- `packages/test-utils/src/fake-agent-runtime.ts` (FakeAgentRuntime, used by every server session-route test)
- `packages/test-utils/src/mock-factories.ts`
- `apps/client/src/dev/playground-transport.ts` (three capability objects, lines ~22, ~81, ~127)
- `apps/server/src/routes/__tests__/capabilities.test.ts`
- `apps/client/src/layers/features/tasks/__tests__/CreateTaskDialog.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/ChatStatusSection-permission-descriptor.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/RunWithMenu.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/ChatStatusSection-make-default.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/ChatStatusSection-autonomy-door.test.tsx`
- `apps/client/src/layers/features/chat/__tests__/ChatStatusSection-plan-mode.test.tsx`
- `apps/client/src/layers/features/status/__tests__/RuntimeItem.test.tsx`
- `apps/client/src/layers/features/status/__tests__/PermissionModeItem.test.tsx`
- `apps/client/src/layers/entities/runtime/__tests__/runtime-hooks.test.tsx`
- `apps/client/src/layers/entities/binding/ui/__tests__/BindingAdvancedSection.test.tsx`

Rules for the sweep:

- Objects typed `RuntimeCapabilities` get a real declaration. Default filler for fixtures that do not care: `settings: { configSection: null, supportsEffort: false, sections: [] }`.
- `playground-transport.ts` is NOT filler: give claude-code `{ configSection: 'claudeCode', supportsEffort: true, sections: [{ kind: 'claude-accounts' }] }`, codex `{ configSection: 'codex', supportsEffort: true, sections: [] }`, opencode `{ configSection: 'opencode', supportsEffort: false, sections: [{ kind: 'opencode-power-source' }] }` - phase 2 showcases render off this transport and need the real declarations.
- `packages/test-utils/src/fake-agent-runtime.ts` should expose the settings declaration as an override on its options object (same pattern its other capability overrides use) so a conformance test can hand it a deliberately-malformed value (task 1.4 needs this).
- Objects that are partial casts (`as RuntimeCapabilities`, `as unknown as ...`) are left alone unless the test asserts on `settings`.

Acceptance criteria: `pnpm --filter @dorkos/server typecheck`, `pnpm --filter @dorkos/client typecheck` and `pnpm --filter @dorkos/test-utils typecheck` all green; `pnpm test -- --run` shows no new failures.

### Task 1.4: Add settings assertions to the runtime conformance suite, with a prove-it-can-fail test

**Size:** medium · **Priority:** high · **Depends on:** 1.2, 1.3 · **Parallel with:** 1.5

Extend the shared conformance suite so no adapter can ship a malformed settings declaration.

FILE: `packages/test-utils/src/runtime-conformance.ts`, inside the existing `describe('capabilities')` block whose single test is `getCapabilities returns a structurally valid RuntimeCapabilities` (around lines 665-777, right after the `permissionModes` structural assertions).

Add assertions, re-read from the runtime value (not the compile-time type, because runtime values drift from types via casts - the same reason the permissionModes block re-asserts structurally):

- `capabilities.settings` is defined (message: `capabilities.settings is required`).
- `settings.configSection` is either `null` or a string with `.trim().length > 0`. An empty or whitespace-only section key must fail: it would read a config leaf nobody writes.
- `typeof settings.supportsEffort === 'boolean'`.
- `Array.isArray(settings.sections)`.
- Every entry of `sections` is a non-null object with `typeof entry.kind === 'string'` and `entry.kind.trim().length > 0`.
- Section kinds are unique: `new Set(sections.map((s) => s.kind)).size === sections.length`, message naming the duplicate. Two sections of one kind would render the same bespoke panel twice.

PROVE THE CHECK CAN FAIL (required, not optional). Add a standalone test file `packages/test-utils/src/__tests__/runtime-conformance-settings.test.ts` that does NOT use the suite's `describe` wrapper but exercises the same predicate. Build four deliberately-malformed settings objects and assert each is rejected:

1. `settings` omitted entirely (cast through `as unknown as RuntimeCapabilities`).
2. `configSection: ''` (empty string).
3. `sections: [{ kind: '' }]`.
4. `sections: [{ kind: 'claude-accounts' }, { kind: 'claude-accounts' }]` (duplicate).
   The cleanest way to make this testable without re-implementing the assertions is to extract the settings checks into an exported `@internal` predicate in `runtime-conformance.ts` (e.g. `assertSettingsCapability(settings: unknown): void` that throws, or `validateSettingsCapability(settings: unknown): string[]` returning failure messages) and have the suite call it. The four cases above then assert non-empty failure output, and the happy path asserts empty. Do NOT settle for `it.fails()` around a whole conformance run: `it.fails()` passes on ANY throw, which is not evidence the settings check fired.

Acceptance criteria:

- `pnpm vitest run packages/test-utils/src/__tests__/runtime-conformance-settings.test.ts` green.
- Every adapter's existing conformance test still passes: `pnpm vitest run apps/server/src/services/runtimes/__tests__` plus each adapter's own conformance spec.
- Temporarily break one adapter declaration (e.g. set opencode's `configSection` to `''`), confirm its conformance test goes RED, then revert. Note the observed failure in the PR description.

### Task 1.5: Add settings to the OpenAPI capabilities schema and regenerate the spec

**Size:** small · **Priority:** medium · **Depends on:** 1.2 · **Parallel with:** 1.4

`GET /api/capabilities` responses grow the `settings` field. The Zod schema that documents that route is NOT in `packages/shared/src/schemas.ts` (there is no runtime-capabilities Zod schema there); it lives in `apps/server/src/services/core/openapi-registry.ts` as `RuntimeCapabilitiesSchema` (currently around line 899).

Add, as a sibling of `permissionModes` and above `features`:

```ts
  settings: z
    .object({
      configSection: z.string().nullable().openapi({
        description:
          'Key of this runtime\u2019s section under `runtimes.*` in user config (`claudeCode`, `codex`, `opencode`). `null` when the runtime has no config section, in which case it never appears in `executionDefaults.perRuntime`.',
      }),
      supportsEffort: z.boolean().openapi({
        description:
          'Whether this runtime takes a reasoning-effort setting at all. Per-model support is a separate, catalog-level fact on `ModelOption.supportsEffort`.',
      }),
      sections: z
        .array(z.object({ kind: z.string() }))
        .openapi({
          description:
            'Ordered bespoke settings sections the runtime declares, by renderer kind (`claude-accounts`, `opencode-power-source`). Unknown kinds render nothing.',
        }),
    })
    .openapi({
      description:
        'Static settings declaration: which config section holds this runtime\u2019s defaults, whether it takes effort, and which bespoke sections its settings card renders.',
    }),
```

Then regenerate the committed spec: `pnpm docs:export-api` (writes `docs/api/openapi.json`). CI job `openapi-fresh` in `.github/workflows/docs-openapi-check.yml` fails if the committed JSON drifts from the registry, so the regenerated file MUST be committed in the same change.

Acceptance criteria:

- `pnpm docs:export-api` produces a diff containing the new `settings` object, and re-running it produces no further diff.
- `pnpm --filter @dorkos/server typecheck` and `pnpm --filter @dorkos/server lint` green.
- Note in the PR body that `RuntimeCapabilitiesSchema` documents a subset of the interface (it already omits `commandIntents`, `nativeContext` and `logBackedHistory`); adding `settings` is deliberate because the settings tab is a documented client contract.

### Task 1.6: Make describeExecutionDefaults capability-driven and retire CONFIG_SECTION_BY_RUNTIME

**Size:** medium · **Priority:** high · **Depends on:** 1.2 · **Parallel with:** 1.4, 1.5

Replace the server's hand-kept runtime-to-config-section map with capability-driven iteration.

FILE: `apps/server/src/services/session/resolve-session-defaults.ts`.

STEP 1 - delete `CONFIG_SECTION_BY_RUNTIME` (currently lines 141-153, the `Readonly<Record<string, 'claudeCode' | 'codex' | 'opencode'>>` literal) and add a type guard in its place:

```ts
/** The `runtimes.*` config keys that actually exist in {@link UserConfig}. */
const RUNTIMES_CONFIG_SECTIONS = ['claudeCode', 'codex', 'opencode'] as const;

/** One of the config keys a runtime's execution defaults can live under. */
type RuntimesConfigSection = (typeof RUNTIMES_CONFIG_SECTIONS)[number];

/**
 * Whether a runtime-declared config section is one this config file has.
 *
 * The declaration is typed `string | null` in shared because the config schema
 * is host-side; this is where the two meet. A section this build does not know
 * is skipped rather than thrown on, so a newer adapter never breaks the screen.
 */
function isRuntimesConfigSection(section: string | null): section is RuntimesConfigSection {
  return section !== null && (RUNTIMES_CONFIG_SECTIONS as readonly string[]).includes(section);
}
```

STEP 2 - change `describeExecutionDefaults` (currently line 317) to take capabilities as a REQUIRED first argument, so every call site is compile-forced:

```ts
export function describeExecutionDefaults(
  capabilities: Record<string, RuntimeCapabilities>,
  runtimes?: UserConfig['runtimes']
): ExecutionDefaults;
```

Its `perRuntime` builder becomes: iterate `Object.entries(capabilities)`; skip any runtime whose `settings.configSection` fails `isRuntimesConfigSection`; for the rest read `section?.[key]` exactly as today for `defaultModel`, `defaultTrustStop` and `defaultEffort`, and take `supportsEffort` from `capability.settings.supportsEffort` instead of the shared `runtimeSupportsEffort()` helper. Keep the existing `'defaultEffort' in configured` structural check verbatim - OpenCode's config section genuinely has no `defaultEffort` key, and that check is what keeps structural absence and a configured `null` the same answer. Keep the ordering stable (sort by runtime type id) so the client list never reshuffles.

STEP 3 - INJECTION, and this is the trap: `apps/server/src/services/core/runtime-registry.ts` line 16 already imports from `resolve-session-defaults.js`, so importing `runtimeRegistry` back into `resolve-session-defaults.ts` is an import cycle. Do not do it. The caller injects instead: `apps/server/src/routes/config.ts` line 109 becomes `executionDefaults: describeExecutionDefaults(runtimeRegistry.getAllCapabilities())`. Update the barrel re-export at `apps/server/src/services/session/index.ts` line 66 if its signature is spelled there.

TESTS - `apps/server/src/services/session/__tests__/resolve-session-defaults.test.ts`:

- A fake capability map with a runtime declaring `configSection: null` produces NO entry for it in `perRuntime` (this is the test-mode behavior, unchanged).
- A runtime declaring `configSection: 'codex'` reads `runtimes.codex.defaultModel` / `.defaultTrustStop` / `.defaultEffort` and nothing else.
- A runtime declaring `configSection: 'notARealSection'` is skipped without throwing (type-guard path).
- `supportsEffort` in the output equals the declared capability value, including a runtime that declares `supportsEffort: false` while its config section happens to hold a `defaultEffort` (assert the reported `effort` is `null`).
- `runtime` and `trustStop` top-level fields are unchanged.
  Also pin the response shape in `apps/server/src/routes/__tests__/config.test.ts`: `GET /api/config` still returns the same `executionDefaults` keys with the same types (no client contract break).

Acceptance: `pnpm vitest run apps/server/src/services/session/__tests__/resolve-session-defaults.test.ts` and `pnpm vitest run apps/server/src/routes/__tests__/config.test.ts` green; `pnpm --filter @dorkos/server typecheck` green; `grep -rn CONFIG_SECTION_BY_RUNTIME apps/server/src` returns nothing.

### Task 1.7: Re-point the server's runtimeSupportsEffort callers to the capability

**Size:** medium · **Priority:** high · **Depends on:** 1.6 · **Parallel with:** 1.9

The shared `runtimeSupportsEffort()` helper is being retired (task 1.8 deletes it). This task re-points the two remaining SERVER callers.

AUDIT FIRST, do not work from this list alone:

```
grep -rn "runtimeSupportsEffort\\|RUNTIMES_WITHOUT_EFFORT" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v /dist/
```

Known server callers at decompose time (re-point any newly found ones too):

1. `apps/server/src/services/session/resolve-session-defaults.ts:212` - inside `resolveSessionDefaults`, gating whether an agent manifest's `effort` is applied: `...(opts.agent?.effort !== undefined && runtimeSupportsEffort(opts.runtimeType) ? ... : {})`. Add an optional `supportsEffort?: boolean` to the `opts` object, documented the same way `permissionModes` is (`omitted means the caller does not know, and the safe direction is ...`). Decide and document the omitted-value behavior explicitly: default `true`, matching today's `unknown runtimes answer true, so a new adapter is never silently muted`. Update every caller of `resolveSessionDefaults` that already has the runtime's capabilities in hand (search with `grep -rn "resolveSessionDefaults(" apps/server/src`) to pass `capabilities.settings.supportsEffort`.
2. `apps/server/src/services/session/session-settings-overlay.ts:101` - `applyStoredSettings` suppresses a stored effort for a runtime that has none (the display rule: `the screen is where Not supported by OpenCode is either true or a lie`). This function already reaches runtimes through `SessionSettingsOverlayPort` (`port.has(type)` / `port.get(type)` around `settingsKeyFor`). Route the answer through the port: read the runtime's `getCapabilities().settings.supportsEffort`, falling back to `true` when the port has no such runtime, and keep the TSDoc paragraph explaining the display-versus-storage distinction (only update the sentence that named the retired helper).

Also update `resolve-session-defaults.ts` line 116's doc comment, which names `runtimeSupportsEffort` in prose.

TESTS:

- `apps/server/src/services/session/__tests__/resolve-session-defaults.test.ts`: an agent manifest carrying `effort: 'high'` on a runtime whose capability declares `supportsEffort: false` yields no `effort` in the resolved settings; the same manifest on a `supportsEffort: true` runtime yields `effort: 'high'`; omitting the new opt keeps today's permissive behavior.
- The overlay's own test file (`apps/server/src/services/session/__tests__/` - find the `session-settings-overlay` spec): a stored `effort` is suppressed for an OpenCode-shaped fake runtime and preserved for a Claude-shaped one, and the STORED value is not mutated in either case.

Acceptance: `pnpm --filter @dorkos/server typecheck` green; `pnpm vitest run apps/server/src/services/session/__tests__` green; the grep above shows no remaining server hits.

### Task 1.8: Re-point the client's effort callers and delete runtimeSupportsEffort from shared

**Size:** medium · **Priority:** high · **Depends on:** 1.7 · **Parallel with:** none

Finish the retirement: re-point the client callers, then delete the shared helper and its constant.

AUDIT FIRST:

```
grep -rn "runtimeSupportsEffort\\|RUNTIMES_WITHOUT_EFFORT" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v /dist/
```

Known client callers at decompose time (re-point any newly found ones too):

1. `apps/client/src/layers/shared/lib/execution-config.ts:245` - inside `describeAgentExecution`, deciding the `effort-unsupported-runtime` breakage. This is the `shared` FSD layer and may not import from `entities`, so the answer must arrive as INPUT. Add a field to `DescribeAgentExecutionInput` (declared around line 114):

```ts
  /**
   * Whether the runtime this agent runs on takes an effort setting at all,
   * from that runtime's declared `settings.supportsEffort`. `undefined` means
   * the capability map has not answered yet, and the permissive reading is the
   * right one: an unanswered runtime is never called broken on a guess.
   */
  runtimeSupportsEffort?: boolean;
```

and change the guard to `if (input.runtimeSupportsEffort === false) { ...breakage... }`. 2. `apps/client/src/layers/entities/agent/model/use-execution-exceptions.ts:184` - the only non-test caller besides (3). It already holds `capabilityMap` from `useRuntimeCapabilities()` (line ~109), so pass `runtimeSupportsEffort: capabilityMap?.capabilities[runtime]?.settings?.supportsEffort`. 3. `apps/client/src/layers/features/agent-hub/ui/tabs/AgentExecutionRows.tsx:206` - currently `const runtimeHasEffort = serverForRuntime?.supportsEffort ?? runtimeSupportsEffort(runtime);`. `serverForRuntime` is the `executionDefaults.perRuntime[]` entry, which task 1.6 already makes capability-driven, so drop the fallback call and fall back to the capability map instead (this component can import `entities/runtime`). Pass the same value into its `describeAgentExecution(...)` call at line 211 as `runtimeSupportsEffort`.

THEN DELETE from `packages/shared/src/constants.ts`: the `RUNTIMES_WITHOUT_EFFORT` const (line 65) and the whole `runtimeSupportsEffort` function with its TSDoc (lines 67-88). Remove the export from any barrel that re-exports it and check `packages/shared/package.json`'s `exports` map is unaffected. Rebuild: `pnpm --filter @dorkos/shared build`.

TESTS:

- `apps/client/src/layers/shared/lib/__tests__/execution-config.test.ts` (find the actual filename): a report built with `runtimeSupportsEffort: false` and a set effort produces the `effort-unsupported-runtime` breakage; with `true` it does not; with the field OMITTED it does not (the permissive default), and this last case must be an explicit test because it is the behavior change from the old helper's `unknown answers true`.
- The `use-execution-exceptions` test file: an OpenCode-declaring capability map plus an agent with `effort` set yields a broken row whose message reads `OpenCode has no effort setting, so this one does nothing.`
- `AgentExecutionRows` test: an OpenCode row shows the runtime-level unsupported state and no effort control.

Acceptance: the audit grep returns ZERO hits repo-wide; `pnpm --filter @dorkos/shared typecheck`, `pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/server typecheck` all green; `pnpm test -- --run` shows no new failures.

### Task 1.9: Add the settingsForRuntime selector and retire the client's config-section map

**Size:** medium · **Priority:** high · **Depends on:** 1.2 · **Parallel with:** 1.7

Retire `apps/client/src/layers/entities/config/lib/runtime-config-section.ts` (whose own doc comment admits it duplicates the server map) and give the client one capability-backed lookup.

STEP 1 - add a selector to `entities/runtime`. New file `apps/client/src/layers/entities/runtime/lib/settings-for-runtime.ts`:

```ts
/**
 * One runtime's declared settings surface, from the capability map.
 *
 * Half-loaded map, unregistered runtime, or a nullish type all answer
 * `undefined`, and callers no-op on it - the optional-all-the-way-down
 * convention the settings surfaces already follow. Absence is never an error:
 * a runtime with no config section simply has no per-runtime leaf to write.
 *
 * @param capabilityMap - The `useRuntimeCapabilities()` payload, or undefined.
 * @param type - Runtime type id, e.g. `'claude-code'`.
 */
export function settingsForRuntime(
  capabilityMap: { capabilities: Record<string, RuntimeCapabilities> } | undefined,
  type: string | null | undefined
): RuntimeSettingsCapability | undefined {
  if (!type) return undefined;
  return capabilityMap?.capabilities[type]?.settings;
}
```

Export it and the `RuntimeSettingsCapability` type re-export from `apps/client/src/layers/entities/runtime/index.ts` (import from the barrel only, never an internal path).

STEP 2 - re-point the two consumers found by `grep -rn configSectionForRuntime apps/client/src`:

- `apps/client/src/layers/features/settings/ui/execution-defaults/ExecutionDefaultsCard.tsx` lines 125 and 136 (`writeForRuntime` and `trustStopPatch`). It already calls `useRuntimeCapabilities()` at line 63, so use `settingsForRuntime(capabilityMap, runtime)?.configSection`. Behavior must be IDENTICAL: a runtime with no section still returns early / returns `null` and writes nothing. (This card is retired in phase 2; it must keep working and keep its tests green through phase 1.)
- `apps/client/src/layers/features/status/model/use-make-default-stop.ts` line 144: `const targetSection = override != null ? settingsForRuntime(capabilityMap, forRuntime)?.configSection : undefined;`. The hook does not currently call `useRuntimeCapabilities()`; add it (it is an entities hook, callable from a feature model). The written patch shape stays exactly `{ [targetSection]: { defaultTrustStop: stop } }` versus the global `{ defaultTrustStop: stop }`, and the ack-plus-stop single-request behavior is untouched.

STEP 3 - delete `entities/config/lib/runtime-config-section.ts` and its export line in `apps/client/src/layers/entities/config/index.ts` (line 11). Delete any test file dedicated to it.

TESTS:

- New `apps/client/src/layers/entities/runtime/__tests__/settings-for-runtime.test.ts`: known runtime returns its declaration; unknown runtime, `undefined` map, `null` type and a runtime whose capability object lacks `settings` all return `undefined`.
- `apps/client/src/layers/features/status/__tests__/` - the existing `use-make-default-stop` tests: accepting the offer with a per-runtime override in force still PATCHes the per-runtime leaf, and with only a global stop set still PATCHes `runtimes.defaultTrustStop`; a Full-autonomy accept still sends `ui.autonomyAcknowledgedAt` and the stop in ONE request. Add a case where the capability map has not loaded: the hook must not write a wrong leaf (it falls back to the global leaf only if that is the current behavior; assert whichever, and comment why).
- `apps/client/src/layers/features/settings/__tests__/ExecutionDefaultsCard.test.tsx` stays green untouched.

Acceptance: `grep -rn configSectionForRuntime apps/client/src` returns nothing; `pnpm --filter @dorkos/client typecheck` and `lint` green; the three test files above pass.

### Task 1.10: Document the settings declaration in contributing/adding-a-runtime.md

**Size:** small · **Priority:** medium · **Depends on:** 1.2 · **Parallel with:** 1.7, 1.9

Give runtime authors the row they need. FILE: `contributing/adding-a-runtime.md`.

STEP 1 - in the `## Key Files` table near the top (lines 11-30), no new row is needed, but confirm the `The contract` row still reads correctly now that `RuntimeSettingsCapability` lives beside `RuntimeCapabilities`.

STEP 2 - in `### RuntimeCapabilities` (line 87), which today says `Two parts deserve care` and covers `permissionModes` then `features`, change it to three parts and insert the settings bullet between them, matching the existing voice (guide prose is for coding agents and human authors; follow `contributing/` house style, no marketing tone):

- Lead sentence: `settings` is required, and it is what puts your runtime on the Settings > Runtimes page. Declare it next to `permissionModes`.
- A three-row field table:
  | Field | Type | What it answers |
  | `configSection` | `string \| null` | Which key under `runtimes.*` in user config holds this runtime's default model, effort and trust stop (`claudeCode`, `codex`, `opencode`). `null` when the runtime has no config section, and then it never appears in `executionDefaults.perRuntime` - `test-mode` is the worked example. |
  | `supportsEffort` | `boolean` | Whether your backend can be asked for more or less thinking AT ALL. Per-model rungs are a separate, catalog-level fact (`ModelOption.supportsEffort` / `supportedEffortLevels`); both gates apply. OpenCode declares `false` because its prompt body carries no effort field. |
  | `sections` | `RuntimeSettingsSection[]` | Ordered bespoke panels your settings card renders, by `kind`. Empty for most runtimes. |
- One paragraph that says the thing an author will otherwise get wrong: a declared section only appears if the CLIENT has a renderer registered for that kind (`apps/client/src/layers/features/settings/ui/runtimes/section-registry.tsx`). An unknown kind renders nothing, deliberately, so an older cockpit against a newer server degrades instead of crashing. Declaring a new kind is therefore a two-sided change.
- One paragraph on the static/dynamic line: the declaration carries NO dynamic state. Account lists, the current provider and readiness ride `GET /api/config` and `GET /api/system/requirements`, which refetch; capabilities are cached with `staleTime: Infinity` and would go stale.
- A short code block showing claude-code's real declaration:

```typescript
settings: {
  configSection: 'claudeCode',
  supportsEffort: true,
  sections: [{ kind: 'claude-accounts' }],
},
```

- One sentence naming the conformance assertions an author will hit: `configSection` must be `null` or a non-empty string, and `sections` kinds must be unique.

Acceptance: prose has no em dashes; `pnpm --filter @dorkos/server lint` unaffected; the guide's own coverage check (`/docs:coverage` or `contributing/INDEX.md`) still passes if the file is tracked there.

### Task 1.11: Verify the declaration layer end to end and open PR 1

**Size:** small · **Priority:** high · **Depends on:** 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10 · **Parallel with:** none

Cross-cutting close-out for PR 1. This phase is explicitly a NO-VISUAL-CHANGE change, so the verification is about proving that.

COMMANDS (run in this order, from the worktree root):

1. `pnpm --filter @dorkos/shared build` (stale dists cause false-red type errors).
2. `pnpm --filter @dorkos/shared typecheck && pnpm --filter @dorkos/test-utils typecheck && pnpm --filter @dorkos/server typecheck && pnpm --filter @dorkos/client typecheck`.
3. `pnpm test -- --run` (full suite via turbo, never bare `pnpm vitest run` for a full run).
4. `pnpm verify` for the affected-only lint pass.
5. `pnpm docs:export-api` and confirm it produces NO diff (task 1.5 already committed the regenerated spec).

DEAD-CODE AND RESIDUE CHECKS (all must return zero hits):

- `grep -rn "runtimeSupportsEffort\\|RUNTIMES_WITHOUT_EFFORT" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v /dist/`
- `grep -rn CONFIG_SECTION_BY_RUNTIME apps packages | grep -v node_modules`
- `grep -rn configSectionForRuntime apps packages | grep -v node_modules`
- `pnpm knip` (build dists first) shows no newly-orphaned exports.

BEHAVIORAL PROOF that nothing visual moved:

- Boot the cockpit (`pnpm dev`), open Settings > Runtimes, and confirm the tab is byte-for-byte the same five-component stack: intro, RuntimeSetupPanel, ExecutionDefaultsCard, ExecutionExceptionsStrip, ClaudeAccountsCard. Change the default runtime, a model and an effort and confirm each still round-trips.
- Confirm `GET /api/config` still returns `executionDefaults` with entries for exactly claude-code, codex and opencode (not test-mode), each carrying `model`, `trustStop`, `effort`, `supportsEffort`.

PR: open from the worktree branch against `origin/main`. Changelog decision: this phase is internal with no user-visible change, so apply the `skip-changelog` label rather than writing a fragment. Record that decision in the PR body (phase 2 carries the user-facing fragment). Review the branch BEFORE opening the PR per `REVIEW.md`.

## P2 — The new tab

PR 2, stacked on PR 1. The settings tab becomes one card per runtime, the
default runtime becomes a card state, and every runtime's model and effort
become editable at all times.

### Task 2.1: Build the pure RuntimeCardSummary segment builder

**Size:** medium · **Priority:** high · **Depends on:** 1.11 · **Parallel with:** 2.2, 2.3, 2.5

Build the collapsed card's one-line summary as a PURE function so every segment rule is table-testable without React.

FILE: `apps/client/src/layers/features/settings/ui/runtimes/RuntimeCardSummary.ts`.

EXPORT a function that takes plain data and returns ordered segments (return structured segments, not a pre-joined string, so the view can style the value half and the separator):

```ts
export interface RuntimeSummarySegment {
  /** Which rule produced this segment. */
  kind: 'model' | 'effort' | 'trust' | 'section';
  /** The rendered value, e.g. `Opus 4.6`, `High effort`, `Asks first`. */
  label: string;
  /** True when the value is inherited rather than set on this runtime. */
  inherited?: boolean;
}

export interface RuntimeCardSummaryInput {
  /* see rules below */
}

export function buildRuntimeCardSummary(input: RuntimeCardSummaryInput): RuntimeSummarySegment[];
```

SEGMENT RULES, in order (this is the contract; implement exactly):

1. MODEL - the catalog entry's `displayName` when the configured model id resolves in the loaded catalog; else the raw configured model id (the honest interim truth while the catalog is still loading or the model is gone); else `Runtime's choice` when nothing is configured, marked `inherited: true`.
2. EFFORT - the effort label (via the existing `effortLabel()` helper in `@/layers/shared/lib`) rendered as `<Label> effort`, and emitted ONLY when the runtime declares `supportsEffort: true` AND an effort is configured. A runtime that takes no effort emits no effort segment at all (it is not an empty segment, it is an absent one).
3. TRUST - a short label for the EFFECTIVE stop (`ask` -> `Asks first`, `act` -> `Pauses at big steps`, `autonomy` -> `Full autonomy`), with `inherited: true` when the runtime has no override and the value came from the global dial, `inherited: false` when the runtime overrides it.
4. SECTION - emitted only when the runtime DECLARES a matching bespoke section AND a value exists for it. Claude accounts: `billing <AccountName>`, only when a non-default account is resolved. OpenCode power source: `<ProviderName>`, only when a provider is set. A runtime that declares a section but has no value emits nothing.

NOT-READY SHORT-CIRCUIT: when the runtime is not ready, the function returns an EMPTY array. The view renders `One sign-in away. Settings unlock once it's connected.` instead of a summary; the builder must not invent a summary for a runtime that cannot start a conversation.

TESTS - `apps/client/src/layers/features/settings/ui/runtimes/__tests__/RuntimeCardSummary.test.ts`, written as a table (`it.each`) over at minimum these rows, asserting the full segment array each time:

- fully configured Claude Code: model displayName + `High effort` + `Asks first` (inherited) + `billing Personal`
- inherit model: first segment is `Runtime's choice` with `inherited: true`
- configured model NOT in the catalog: segment label is the raw id (assert it is the id, not `undefined` and not `Runtime's choice`)
- catalog not loaded at all (empty/undefined list) with a configured model: raw id again
- `supportsEffort: false` runtime with an effort saved anyway: NO effort segment (this is the stranded-effort case, and it is the row the expanded card warns about; the summary stays quiet)
- `supportsEffort: true` with no effort configured: NO effort segment
- trust overridden on the runtime: `inherited: false`
- trust inherited from global: `inherited: true`
- runtime declaring no sections: no section segment even when accounts exist elsewhere
- runtime declaring `claude-accounts` but on the default account: no section segment
- not-ready runtime: empty array

Acceptance: `pnpm vitest run apps/client/src/layers/features/settings/ui/runtimes/__tests__/RuntimeCardSummary.test.ts` green; the file imports NO React and NO hooks; TSDoc on every export.

### Task 2.2: Build the three presentational card rows (Model, Effort, Trust)

**Size:** large · **Priority:** high · **Depends on:** 1.11 · **Parallel with:** 2.1, 2.3, 2.5

Build the expanded card body's three rows as props-only components. No hooks, no queries, no config writes: values in, change callbacks out. This is what makes them showcaseable (design decision 7).

DIRECTORY: `apps/client/src/layers/features/settings/ui/runtimes/rows/`.

ModelRow.tsx - a `SettingRow` + `Select` over the runtime's catalog, lifted from `ExecutionDefaultsCard.tsx` lines 252-286. Preserve these exactly:

- The inherit option renders `Runtime's choice` and writes `null`. It needs a sentinel because Radix refuses an empty-string item value: keep `const INHERIT = '__inherit__'`.
- A configured model that is NOT in the catalog is still rendered as a selectable item labeled `<id> (no longer offered)`. Never silently swap it.
- Description copy: `Which <RuntimeLabel> model a new conversation starts on. Leave it on Runtime's choice to let <RuntimeLabel> decide.`
- Props: `runtimeLabel`, `models: ModelOption[] | undefined`, `value: string | null`, `onChange(value: string | null)`, `disabled?`.
- Test id: `runtime-model-select-<type>` (scoped per card, since three cards now render this row at once; the old page-global `default-model-select` cannot survive three instances).

EffortRow.tsx - a segmented control (Low / Medium / High / Max style, filtered by the selected model's `supportedEffortLevels`) plus BOTH honest unsupported states, lifted from `ExecutionDefaultsCard.tsx` lines 288-345:

- Runtime does not take effort: muted text `Not supported by <RuntimeLabel>`, test id `runtime-effort-unsupported-<type>`. The row STAYS; the absence is the answer.
- Runtime takes effort but the selected model does not: `<ModelDisplayName> doesn't take an effort setting`, test id `runtime-effort-model-unsupported-<type>`, AND when an effort is nonetheless saved, an amber one-tap clear button reading `<EffortLabel> is saved here and does nothing - clear it` (test id `runtime-effort-clear-<type>`) that calls `onChange(null)`.
- A model whose catalog entry has not arrived leaves the full ladder available (`modelTakesEffort = selectedModel ? (selectedModel.supportsEffort ?? false) : true`): evidence nobody has is never evidence against.
- Props: `runtimeLabel`, `supportsEffort: boolean`, `selectedModel: ModelOption | undefined`, `configuredModelId: string | null`, `value: EffortLevel | null`, `onChange(value: EffortLevel | null)`.

TrustRow.tsx - the per-runtime trust override, split out of `DefaultTrustStopSection.tsx`'s per-runtime disclosure block (lines 212-266). Reuse its resolution helpers verbatim rather than re-deriving: `resolveTrustStops` and `isDivergent` from `@/layers/shared/lib`, and the `TrustDial` primitive from `@/layers/shared/ui`.

- Reads `Global setting` until overridden; when overridden it offers a way back (today's `Use the setting above` button, calling `onChange(null)`).
- A runtime that declares no descriptors renders the existing honest line: `<Label> hasn't said what it can do, so there is nothing to choose from yet - new sessions start where it starts them.` (test id `runtime-trust-unavailable-<type>`).
- `strandsWorkingMode` and `strandedNote` are passed through to `TrustDial` exactly as the current section does.
- Props: `runtimeLabel`, `descriptors: readonly PermissionModeDescriptor[]`, `stop: PermissionStop | null` (null = inherits), `globalStop: PermissionStop`, `onChange(stop: PermissionStop | null)`.

TESTS - `apps/client/src/layers/features/settings/ui/runtimes/__tests__/` one file per row, React Testing Library, rendered with plain props (no TransportProvider needed):

- ModelRow: inherit selection calls `onChange(null)`; a gone model appears as a selectable `(no longer offered)` item; picking a catalog model calls `onChange(id)`.
- EffortRow: `supportsEffort: false` renders the runtime-unsupported text and NO control; a model with `supportsEffort: false` plus a saved effort renders the clear button and clicking it calls `onChange(null)`; `supportedEffortLevels` filtering hides rungs the model does not offer.
- TrustRow: unoverridden shows the global-inherited affordance and no revert button; overridden shows the revert button and clicking it calls `onChange(null)`; empty descriptors renders the unavailable line and no dial.

Acceptance: all three files are import-clean of `useConfig`/`useUpdateConfig`/`useQuery`; `pnpm --filter @dorkos/client typecheck` and `lint` green.

### Task 2.3: Extract the trust-stop write path into a shared use-trust-stop-writes hook

**Size:** medium · **Priority:** high · **Depends on:** 1.11 · **Parallel with:** 2.1, 2.2, 2.5

Both the per-runtime `TrustRow` and the global `GlobalTrustRow` write trust stops through the SAME consent contract. Extract that contract once so it cannot drift.

FILE: `apps/client/src/layers/features/settings/model/use-trust-stop-writes.ts` (same-feature model sharing is allowed under the FSD rules; cross-FEATURE model imports are not, which is why this lives in `features/settings`).

CARRY OVER VERBATIM from `ExecutionDefaultsCard.tsx` lines 100-188. The contract that must not change:

- `trustStopPatch(forRuntime, stop)`: `forRuntime === null` yields `{ defaultTrustStop: stop }`; otherwise it resolves the runtime's config section via `settingsForRuntime(capabilityMap, forRuntime)?.configSection` (the phase-1 selector) and yields `{ [section]: { defaultTrustStop: stop } }`, or `null` when the runtime has no section (and a `null` patch writes NOTHING).
- `changeTrustStop(forRuntime, stop)`: when `stop === 'autonomy'` AND `autonomyAck.acknowledgedAt === null`, it does NOT write. It stages `{ runtime: forRuntime, descriptor }` where the descriptor is that runtime's own mode at the autonomy stop (`resolveTrustStops(declared).find((s) => s.stop === 'autonomy')?.mode`, using the runtime being changed, or the default runtime when the change is global), and the caller renders `AutonomyConfirmDialog` off it. A `null` stop is never Full autonomy, so it never asks.
- `confirmAutonomyDefault()`: sends ONE `PATCH /api/config` carrying BOTH `ui: { autonomyAcknowledgedAt: new Date().toISOString() }` AND `runtimes: <patch>`. This single-request property is load-bearing: the server refuses the stop without an acknowledgement, so two requests would race and the stop could land first and bounce. Any refactor that splits it is a defect.
- Every successful write invalidates the `['config']` PREFIX (not an exact key): the status bar, sidebar badges and `useFeatureEnabled` read config off a broader key set.
- Failures surface through `describeWriteFailure(err)` = `(err instanceof Error && err.message) || 'Could not save that. Try again.'`. The server's own refusal wording is shown verbatim; do not write a second wording.

SHAPE: the hook returns `{ changeTrustStop, pendingAutonomy, confirmAutonomy, cancelAutonomy, writeError, clearWriteError, isPending }`. It owns `useConfig`, `useUpdateConfig`, `useAutonomyAcknowledgement`, `useRuntimeCapabilities` and `useQueryClient` internally.

TESTS - `apps/client/src/layers/features/settings/__tests__/use-trust-stop-writes.test.tsx` with a mock `Transport` via `TransportProvider`:

- Global non-autonomy stop PATCHes exactly `{ runtimes: { defaultTrustStop: 'act' } }`.
- Per-runtime stop on codex PATCHes exactly `{ runtimes: { codex: { defaultTrustStop: 'act' } } }`.
- A runtime whose declaration has `configSection: null` produces NO request at all.
- Autonomy with no standing acknowledgement makes NO request and stages `pendingAutonomy` with the runtime's own descriptor.
- Confirming sends exactly ONE request whose body contains both `ui.autonomyAcknowledgedAt` and the stop patch. Assert the transport was called once; this is the regression test for the split-request defect.
- Autonomy WITH a standing acknowledgement writes immediately without staging.
- A rejected write leaves `writeError` set to the server's message verbatim.

### Task 2.4: Build RuntimeCardView, the props-only runtime card

**Size:** large · **Priority:** high · **Depends on:** 2.1, 2.2 · **Parallel with:** 2.5, 2.6

Build the presentational card: everything the design's card anatomy shows, with zero hooks. This is the component every playground showcase renders.

FILE: `apps/client/src/layers/features/settings/ui/runtimes/RuntimeCardView.tsx`.

HEADER (always visible):

- Logo tile tinted with the runtime's accent color at 24px. Descriptors come from `getRuntimeDescriptor(type)` in `entities/runtime`: `.icon`, `.label`, `.accent` (a CSS var like `var(--color-orange-500)`); the accents are currently unused on this page and this is where they land.
- Name and a one-line identity subtitle.
- Readiness: a `Ready` state, or a `Connect` action slot. Ready keeps the quiet reconnect affordance the setup panel already offers: `Fix sign-in` for login runtimes (Claude, Codex) and `Change` for the provider-picker runtime (OpenCode). Take these as a render prop / slot so the container can supply the real connect flow.
- Default marker: an accent `Default` pill on the default runtime's card, a quiet `Make default` text affordance on the others. The default card also carries a subtle accent border ring.

COLLAPSED BODY: the summary line, rendered from the `RuntimeSummarySegment[]` the container passes in (built by `buildRuntimeCardSummary`), joined with a middot separator, values emphasized, inherited values styled muted. A not-ready card renders NO summary and instead reads `One sign-in away. Settings unlock once it's connected.`

EXPANDED BODY, in this order: Model row, Effort row, Trust row, declared bespoke sections (boxed sub-sections, rendered through a `renderSection(kind)` slot prop), then a `Setup details` collapsed disclosure carrying the unchanged dependency rows / install hints / transparency note.

EDGE STATE - default but not connected: the card keeps its `Default` pill AND shows the warning together with Connect: `Your default runtime isn't connected - new conversations can't start here.` The problem and the setting share a card; do not hide the pill and do not hide the warning.

INTERACTION:

- Expansion is per-card independent state (no accordion auto-close). Collapse restores the summary.
- The click target is the header/summary region; every control inside stops propagation so changing a model does not collapse the card.
- Expansion state is controlled from props (`expanded` + `onToggleExpanded`) so showcases can render an expanded card directly.

MOBILE (responsive classes only, same components, no drawer):

- Cards stack full width and expand inline.
- The summary line shortens and wraps; status chips never wrap.
- Redundant `Ready` text drops below the `sm` breakpoint where the pill or Connect already implies it.
- `Make default` moves into the EXPANDED BODY below `sm` (there is no room for a quiet header affordance).

TESTS - `apps/client/src/layers/features/settings/ui/runtimes/__tests__/RuntimeCardView.test.tsx`:

- Collapsed renders the summary segments and not the rows; expanded renders the rows and not the summary.
- The default card renders the `Default` pill and no `Make default`; a non-default card renders `Make default` and clicking it fires the callback.
- Broken default (isDefault + not ready) renders BOTH the pill and the warning sentence and the Connect slot.
- Not-ready renders the `One sign-in away.` line and no summary and no rows.
- Declared sections render via `renderSection` in declared order; a kind the slot returns nothing for renders nothing and does NOT leave an empty boxed container.
- Clicking the header toggles expansion; clicking a control inside the expanded body does NOT toggle it (assert with a click on a row control).
- `Fix sign-in` appears for a ready login runtime, `Change` for a ready provider-picker runtime, neither when no connect renderer is supplied.

Acceptance: the file imports nothing from `entities/config`, `@tanstack/react-query`, or any `use*Config` hook; `pnpm --filter @dorkos/client typecheck` and `lint` green.

### Task 2.5: Relocate the Claude billing-accounts feature into ClaudeAccountsSection

**Size:** large · **Priority:** high · **Depends on:** 1.11 · **Parallel with:** 2.1, 2.2, 2.3

Move the whole accounts feature out of its bolted-on sibling card and into the Claude Code card's declared section, with its write semantics unchanged.

FILE: `apps/client/src/layers/features/settings/ui/runtimes/sections/ClaudeAccountsSection.tsx`. Source: `apps/client/src/layers/features/settings/ui/ClaudeAccountsCard.tsx` (307 lines, including its private `AccountRow` sub-component).

WHAT MOVES UNCHANGED:

- The account `Select` whose `__default__` sentinel writes `activeAccount: null` (Radix refuses an empty-string item value). The default option reads `Default (<shortenHomePath(resolvedAccount)>)` when inherited and a resolved account exists, else just `Default`.
- The `AccountRow` list: name via `claudeAccountName(path, accounts)`, `in use` marker on the active one, `shortenHomePath` for the path, the `claude-account-not-ready` warning for a folder that is not an account root, and the remove button labeled `Remove <name>`.
- ADD-ACCOUNT VALIDATION, both rules: the path must be ABSOLUTE (`isAbsoluteAccountPath`), because nothing between the field and the server expands a `~` and a junk entry still counts towards `more than one account`, which turns account badges on across every session row; and DUPLICATE paths are refused. The two messages (`claude-account-duplicate`, `claude-account-not-absolute`) keep their exact copy.
- REMOVE RELEASES ACTIVE: removing the account work currently runs on must clear it in the same patch: `const releasesActive = !inherited && resolvedAccount === path; write({ accounts: remaining, ...(releasesActive && { activeAccount: null }) })`. Without it DorkOS keeps billing an account the operator just removed.
- Every write is one `PATCH /api/config` shaped `{ runtimes: { claudeCode: patch } }` followed by invalidating the `['config']` PREFIX.
- `describeWriteFailure` shows the server's refusal wording verbatim (both leaves are operator-only, so a refusal is a real outcome, not an edge case).
- The `DirectoryPicker` browse flow.

WHAT CHANGES: the outer `FieldCard`/`FieldCardContent` wrapper is replaced by the card's boxed sub-section chrome (the section renders INSIDE a runtime card now), and the section gets a heading reading `Billing account`. Keep every `data-testid` byte-identical (`claude-account-select`, `claude-account-row`, `claude-account-path`, `browse-claude-account`, `claude-account-duplicate`, `claude-account-not-absolute`, `claude-account-not-ready`, `claude-account-error`) so the existing tests and showcase assertions keep working at the new location.

TESTS: move `apps/client/src/layers/features/settings/__tests__/ClaudeAccountsCard.test.tsx` to `.../__tests__/ClaudeAccountsSection.test.tsx`, re-point the import, and keep every case. Add one new case: removing the ACTIVE account sends a single patch containing both the trimmed `accounts` array and `activeAccount: null`; removing a non-active account sends `accounts` only.

Acceptance: `pnpm vitest run apps/client/src/layers/features/settings/__tests__/ClaudeAccountsSection.test.tsx` green with no assertion weakened. The old `ClaudeAccountsCard.tsx` is deleted in task 2.10, not here.

### Task 2.6: Build PowerSourceSection and the kind-keyed section registry

**Size:** medium · **Priority:** high · **Depends on:** 1.11, 2.5 · **Parallel with:** 2.1, 2.2, 2.3

Build OpenCode's declared section and the registry that maps declared kinds to renderers.

FILE 1 - `apps/client/src/layers/features/settings/ui/runtimes/sections/PowerSourceSection.tsx`. A boxed sub-section headed `Power source` that shows the CURRENT provider and a `Change` action which reopens the existing provider-picker connect flow. Do not build a second picker: reuse `renderRuntimeConnect` from `@/layers/features/runtime-connect` with the descriptor `{ kind: 'provider-picker', label: 'Change power source' }`, exactly as `selectReadyReconnect` in `entities/runtime/ui/RuntimeSetupDialog.tsx` constructs it today, and pass the current provider through for the picker's `Currently:` label. The provider id is DYNAMIC state and comes from `GET /api/system/requirements` (`requirements.runtimes[type].provider`), never from the capability declaration. When no provider is set there is nothing to change, so render the section with an honest empty state rather than a dead `Change` button. Props-only: `provider: string | undefined`, `renderConnect` slot, `onDone`.

FILE 2 - `apps/client/src/layers/features/settings/ui/runtimes/section-registry.tsx`. A `kind` to renderer map plus one lookup function:

```tsx
/**
 * Renderers for the bespoke settings sections runtimes declare.
 *
 * Keyed on the declared `RuntimeSettingsSection.kind`, the same slot pattern
 * `renderRuntimeConnect` uses for `login` / `provider-picker`. An UNKNOWN kind
 * renders nothing, deliberately: an older cockpit against a newer server that
 * declares a section it has never heard of degrades to a card without that
 * panel rather than crashing.
 */
export function renderRuntimeSettingsSection(
  kind: string,
  ctx: RuntimeSettingsSectionContext
): ReactNode | null;
```

Known kinds: `claude-accounts` -> `ClaudeAccountsSection`, `opencode-power-source` -> `PowerSourceSection`. The context object carries what both renderers need (runtime type, readiness entry, connect slot renderer). Adding a kind must be a one-line registry change plus the component.

TESTS - `apps/client/src/layers/features/settings/ui/runtimes/__tests__/section-registry.test.tsx`:

- `claude-accounts` resolves to something that renders the accounts select.
- `opencode-power-source` resolves to something that renders the provider name.
- An unknown kind (`'not-a-real-kind'`) returns null and renders NOTHING, with no console error and no thrown exception. Assert the container is empty.
- A kind whose renderer exists but whose context data is absent still renders without throwing (optional-all-the-way-down).
  Plus `apps/client/src/layers/features/settings/ui/runtimes/__tests__/PowerSourceSection.test.tsx`: a set provider renders its name plus an enabled `Change`; no provider renders the empty state and no `Change`; clicking `Change` invokes the injected connect slot with `kind: 'provider-picker'`.

Acceptance: `pnpm --filter @dorkos/client typecheck` and `lint` green; no new picker UI was written.

### Task 2.7: Build GlobalTrustRow, the one dial beneath the cards

**Size:** medium · **Priority:** high · **Depends on:** 2.2, 2.3 · **Parallel with:** 2.4

Build the single global trust control that sits below the cards, splitting it out of `DefaultTrustStopSection`.

FILE: `apps/client/src/layers/features/settings/ui/runtimes/GlobalTrustRow.tsx`.

CONTENT (design decision 3, semantics identical to today's global dial):

- Heading `Where agents stop for you`.
- A segmented control with three positions: `Asks before acting` / `Pauses at big steps` / `Full autonomy`, rendered through the existing `TrustDial` primitive with `CANONICAL_TRUST_STOPS` (`@/layers/shared/ui`) - the same descriptors today's global dial uses.
- Hint line: `Every runtime follows this unless its card says otherwise.`
- `null` (no preference) has no way to be drawn, so it renders as the stop the runtimes would actually take (the `effectiveStop` prop), exactly as `DefaultTrustStopSection` does today.

WHAT DOES NOT MOVE HERE: the per-runtime override rows (they became `TrustRow` on each card in task 2.2) and the `Customize per runtime` disclosure (deleted; each card is its own disclosure now).

WHAT MUST SURVIVE from `DefaultTrustStopSection`: the standing-autonomy note. When ANY runtime's EFFECTIVE stop resolves to `autonomy` - whether from this dial or from a card override - the row shows the red `ShieldOff` line (`New sessions run without asking` when the global dial is the one at autonomy, else `New sessions on <runtime list> run without asking`) with an inline `change` button that undoes exactly what is set: the global choice when it is the one at autonomy, plus every per-runtime override that is. Keep `data-testid="default-trust-stop-standing-note"` so existing assertions survive. It is fired on the EFFECTIVE resolution, not the global selection, because a card can sit at autonomy while the shared setting reads `Asks first`.

WRITES: consume `use-trust-stop-writes` (task 2.3) with `forRuntime: null`, and render `AutonomyConfirmDialog` off its `pendingAutonomy` state. UI composition across features is allowed, which is how `AutonomyConfirmDialog` comes from `@/layers/features/status`.

MOBILE: the segmented control stacks full width below the `sm` breakpoint.

TESTS - `apps/client/src/layers/features/settings/ui/runtimes/__tests__/GlobalTrustRow.test.tsx`, with a mock Transport:

- Moving the dial to `act` PATCHes `{ runtimes: { defaultTrustStop: 'act' } }`.
- Moving it to `autonomy` with no standing acknowledgement opens `AutonomyConfirmDialog` and sends NO request; confirming sends exactly one request carrying both the ack and the stop.
- With one runtime overridden to autonomy while the global reads `ask`, the standing note appears and names that runtime; clicking `change` clears the OVERRIDE (not the global).
- With the global at autonomy, `change` sets the global back to `ask`.

### Task 2.8: Build the RuntimeCard container that owns every write path

**Size:** large · **Priority:** high · **Depends on:** 2.4, 2.6, 2.3 · **Parallel with:** 2.7

Wire the presentational card to live data. This is the only component in the family that touches hooks.

FILE: `apps/client/src/layers/features/settings/ui/runtimes/RuntimeCard.tsx`. Props: `{ type: string; isDefault: boolean }` plus whatever the tab passes down (requirements payload, connect renderer).

HOOKS IT OWNS: `useConfig`, `useUpdateConfig`, `useRuntimeCapabilities`, `useRuntimeReadiness(type)`, `useProvisionRuntime`, `renderRuntimeConnect`, `renderRuntimeSettingsSection` (the task 2.6 registry), `use-trust-stop-writes` (task 2.3), and `useModels({ runtime })`.

MODEL-CATALOG LAZINESS (spec resolution to open question 2): enable `useModels` ONLY when the runtime is ready AND (the card is expanded OR it has a configured model that needs naming). Do not fetch three catalogs on tab open. While the catalog is absent the summary falls back to the raw model id, which is honest interim truth. Assert this in tests.

WRITE PATHS - all are ONE `PATCH /api/config` followed by invalidating the `['config']` PREFIX (never an exact key: the status bar, sidebar badges and `useFeatureEnabled` read config off a broader key set):

- Make default: `{ runtimes: { default: type } }`.
- Model: `{ runtimes: { [section]: { defaultModel: value } } }` where `value` is `null` for inherit.
- Effort: `{ runtimes: { [section]: { defaultEffort: value } } }`, `null` to clear.
- `section` comes from `settingsForRuntime(capabilityMap, type)?.configSection` (the phase-1 selector). A runtime with NO section writes nothing at all: return early rather than inventing a key.
- Trust (per runtime and the autonomy dialog) goes entirely through `use-trust-stop-writes`, preserving the single-request ack-plus-stop contract.
- Accounts section keeps its own write semantics inside `ClaudeAccountsSection`.
- Failures render through `describeWriteFailure` (server wording verbatim).

DATA IT DERIVES: the summary segments via `buildRuntimeCardSummary` (task 2.1); the per-runtime entry from `config.executionDefaults.perRuntime.find((e) => e.runtime === type)`; `supportsEffort` from the capability declaration; the selected model's catalog entry for the effort gate; readiness plus provider from `useRuntimeReadiness`. Everything optional-all-the-way-down: a half-loaded capability map renders a card without sections rather than throwing.

TESTS - `apps/client/src/layers/features/settings/ui/runtimes/__tests__/RuntimeCard.test.tsx` with mock Transport via `TransportProvider`:

- `Make default` on the Codex card PATCHes exactly `{ runtimes: { default: 'codex' } }`.
- Choosing a model on the CODEX card while claude-code is the default PATCHes `{ runtimes: { codex: { defaultModel: '<id>' } } }`. This is the capability hole closing: assert it explicitly, because before this change setting Codex's model required making Codex the default first.
- Choosing `Runtime's choice` PATCHes `defaultModel: null`.
- Clearing a stranded effort PATCHes `defaultEffort: null`.
- Setting a per-runtime trust stop of `autonomy` with no standing acknowledgement makes NO request, shows the dialog, and confirming sends exactly ONE request containing both `ui.autonomyAcknowledgedAt` and `runtimes.<section>.defaultTrustStop`.
- Model-catalog laziness: a collapsed, ready card with NO configured model issues no `/api/models` request; expanding it issues exactly one; a collapsed card WITH a configured model issues one so the summary can name it.
- A card for a runtime whose declaration has `configSection: null` renders but issues no config write when its rows are touched.
- Removing the active account through the Claude card's accounts section releases it (single patch with `activeAccount: null`).
- A half-loaded capability map (undefined) renders the card with no bespoke sections and no crash.

### Task 2.9: Recompose RuntimesTab and give ExecutionExceptionsStrip an optional exceptions prop

**Size:** medium · **Priority:** high · **Depends on:** 2.8, 2.7 · **Parallel with:** none

Replace the five-component stack with the new composition.

FILE 1 - `apps/client/src/layers/features/settings/ui/runtimes/RuntimesTab.tsx` (new home; the old `ui/tabs/RuntimesTab.tsx` is deleted in task 2.10 and `SettingsDialog.tsx` line 19 re-points its import).

COMPOSITION, top to bottom:

1. A ONE-LINE intro (the current three-clause paragraph shrinks; keep it honest and plain).
2. The runtime cards: `PRIMARY_RUNTIME_TYPES` followed by any other registered runtime that is not primary and not `test-mode`, appended stably so the list never reshuffles when a recheck flips a state. This is the SAME ordering rule `selectTargetRuntimes` in `entities/runtime/ui/RuntimeSetupDialog.tsx` applies; reuse it rather than re-spelling it if it can be exported cleanly, otherwise mirror it with a comment naming the source.
3. A small refresh ICON affordance replacing the labeled `Check again` row (still `requirementsQuery.refetch()`, still disabled while `isFetching`, with an `aria-label` since it is icon-only). It is a maintenance action, not a primary one.
4. `GlobalTrustRow`.
5. `ExecutionExceptionsStrip` (unchanged import, unchanged behavior: read-only, broken rows first, rows open the agent's Config tab).

WHAT IS GONE FROM THE TAB: `RuntimeSetupPanel` (its per-runtime content now lives inside the cards; the panel itself stays untouched for `RuntimeSetupDialog`'s other surfaces), `ExecutionDefaultsCard`, and `ClaudeAccountsCard`. Nothing Claude-specific remains at tab level.

FILE 2 - `apps/client/src/layers/features/settings/ui/execution-defaults/ExecutionExceptionsStrip.tsx`: add an OPTIONAL `exceptions` prop. Today the component calls `useExecutionExceptions({ checkModels: true })` unconditionally, which is exactly why it has no playground coverage. Change to: when `exceptions` is supplied, render it; otherwise fall back to the hook. Keep the hook call unconditional at the top (React rules of hooks) and just ignore its result when the prop is present, or gate the hook's `checkModels` and select between the two results. Document the prop as showcase-only injection. No behavior change for the live tab.

TESTS - `apps/client/src/layers/features/settings/__tests__/RuntimesTab.test.tsx` (rewrite the existing file):

- Three cards render for claude-code, codex and opencode, in that order.
- A registered non-primary runtime appends after them; `test-mode` never appears.
- The default runtime's card carries the `Default` pill and the others carry `Make default`.
- The global trust row renders once, below the cards.
- The exceptions strip renders nothing when the fleet all inherits and renders rows when it does not.
- The refresh affordance calls `refetch` and is disabled while fetching.
- No `default-runtime-select` combobox exists anywhere on the tab (the dropdown is gone; the default is a card state).
  Plus `ExecutionExceptionsStrip.test.tsx`: an injected `exceptions` array renders without any transport call, and the no-prop path still reads the hook.

### Task 2.10: Retire the superseded settings components

**Size:** medium · **Priority:** high · **Depends on:** 2.9 · **Parallel with:** none

No dead code, no half-migrations. Delete what the cards replaced, only now that the replacements exist and are green.

DELETE:

- `apps/client/src/layers/features/settings/ui/execution-defaults/ExecutionDefaultsCard.tsx` and `apps/client/src/layers/features/settings/__tests__/ExecutionDefaultsCard.test.tsx`. Before deleting the test, walk its cases and confirm each has an equivalent in the new suite: default-runtime write, model write, effort write, effort-unsupported-runtime, effort-unsupported-model, stranded-effort clear, gone-model selectable, autonomy consent single-request, write-failure message. Any case with no new home is a missing test, not a retired one; add it to the relevant new file first.
- `apps/client/src/layers/features/settings/ui/execution-defaults/DefaultTrustStopSection.tsx`. It is SPLIT, not deleted wholesale: the global dial became `GlobalTrustRow`, the per-runtime rows became `TrustRow`. Its `resolveConsequence` and `listRuntimes` helpers are still needed - move them to a shared place both new components import (`features/settings/lib/`), do not copy them twice.
- `apps/client/src/layers/features/settings/ui/ClaudeAccountsCard.tsx` (its internals now live in `sections/ClaudeAccountsSection.tsx`).
- `apps/client/src/layers/features/settings/ui/tabs/RuntimesTab.tsx` (replaced by `ui/runtimes/RuntimesTab.tsx`); re-point the import in `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` line 19 and its tab entry on line 38.

THEN: re-point or delete every barrel export that named the deleted files (`features/settings/index.ts`), and run `pnpm knip` (build dists first) to catch orphaned exports the deletions left behind - for example helpers that only `ExecutionDefaultsCard` used.

GREP TO CONFIRM THE SWEEP IS COMPLETE (each must return zero non-historical hits):

```
grep -rn "ExecutionDefaultsCard\\|ClaudeAccountsCard\\|DefaultTrustStopSection" apps packages | grep -v node_modules | grep -v /dist/
```

(`specs/` and `decisions/` hits are historical documents and stay. If a `contributing/` guide names a deleted component, update that line.)

Acceptance: the grep is clean outside `specs/`, `decisions/` and `changelog/`; `pnpm --filter @dorkos/client typecheck`, `lint` and the full client test run are green; `pnpm knip` reports no new unused exports.

### Task 2.11: Add playground showcases and section-registry entries for every card state

**Size:** large · **Priority:** medium · **Depends on:** 2.9, 2.10 · **Parallel with:** 2.12, 2.13

Playground parity is a HARD requirement (design decision 7): the two components being retired had zero playground coverage precisely because they were hook-coupled, and the replacements are props-first so that gap closes here.

FILE 1 - new `apps/client/src/dev/showcases/RuntimeCardShowcases.tsx` rendering `RuntimeCardView` (props-only) plus the two sections, with these showcases:

- Collapsed trio: the default card (accent pill + ring), a ready non-default card, and a not-ready card (`One sign-in away.`) side by side, so the page reads as the real status board.
- Expanded Claude Code, showing the accounts section with several accounts, one in use, and one folder that is not an account root.
- Expanded OpenCode, showing the power-source section with a provider set, and a second variant with none.
- Expanded Codex (no declared sections) so the empty-sections case is visible.
- Broken default: default pill AND the `Your default runtime isn't connected` warning AND Connect, together.
- Gone model: a configured model rendered `(no longer offered)` and still selectable.
- Stranded effort: the amber `<Effort> is saved here and does nothing - clear it` affordance.
- Runtime-level no-effort: `Not supported by OpenCode`.
- Mobile: the collapsed trio and one expanded card at a phone viewport via `ShowcaseDemo`'s responsive mode, showing inline expansion, the compressed summary, and `Make default` inside the expanded body.

FILE 2 - `apps/client/src/dev/showcases/SettingsShowcases.tsx` and `apps/client/src/dev/showcases/settings-mock-data.ts`: move the Claude Code Accounts showcase off the retired `ClaudeAccountsCard` and onto `ClaudeAccountsSection` in its new card context. Add an `ExecutionExceptionsStrip` showcase now that the component takes an injected `exceptions` prop (task 2.9) - broken rows first, mixed broken/deviating, and the all-inherits case that renders nothing.

FILE 3 - `apps/client/src/dev/sections/settings-sections.ts`: add registry entries for each new showcase (`id`, `title`, `page: 'settings'`, `category`, `keywords`). The existing `claude-code-accounts` entry keeps its id so deep links survive; retitle only if the showcase's content changed. Consider a dedicated `Runtimes` category group for the card showcases rather than burying them under `Tabs`.

FILE 4 - `apps/client/src/dev/playground-transport.ts`: its three capability objects already carry real `settings` declarations from task 1.3; extend its config/requirements fixtures so the showcases can drive ready, not-ready and broken-default without hand-mocking each one.

TESTS: rename/extend `apps/client/src/dev/__tests__/claude-accounts-showcase.test.tsx` to cover the section at its new location, keeping the four existing assertions (`claude-account-row` absent when empty, four rows when populated, `claude-account-not-ready` present, `claude-account-error` message). Add `apps/client/src/dev/__tests__/runtime-card-showcase.test.tsx` asserting each showcase renders without throwing and that the broken-default showcase shows both the pill and the warning.

Acceptance: `/dev` renders every showcase with no console errors; `pnpm vitest run apps/client/src/dev/__tests__` green; the `maintaining-dev-playground` skill's checklist is satisfied.

### Task 2.12: Sweep test ids and add the browser flow for the new tab

**Size:** medium · **Priority:** medium · **Depends on:** 2.10 · **Parallel with:** 2.11, 2.13

The old page-global test ids cannot survive three simultaneous cards. Sweep every reference and add one end-to-end flow.

AUDIT FIRST:

```
grep -rn "default-runtime-select\\|default-model-select\\|default-effort\\|claude-account-\\|execution-defaults\\|default-trust-stop" --include="*.ts" --include="*.tsx" apps | grep -v node_modules
```

Known at decompose time (re-point any newly found ones too):

- `default-runtime-select`, `default-model-select`, `default-effort-select`, `default-effort-unsupported`, `default-effort-model-unsupported`, `default-effort-clear`, `execution-defaults-timing`, `execution-defaults-error` live ONLY in `ExecutionDefaultsCard.tsx` and its test, both deleted in task 2.10. Confirm nothing else references them.
- `claude-account-*` ids are preserved byte-identically by task 2.5 and are referenced by `apps/client/src/dev/__tests__/claude-accounts-showcase.test.tsx`.
- `default-trust-stop-standing-note` must survive on `GlobalTrustRow` (task 2.7).
- `apps/e2e` has NO references to any of these today. It DOES reference `runtime-setup-panel`, `runtime-section-codex` and `runtime-section-opencode` in `apps/e2e/tests/chat-mock.spec.ts` lines 286-298, but those exercise the status-bar `Add a runtime` path through `RuntimeSetupDialog`, which this spec leaves untouched. Verify that test still passes; do NOT re-point it at the settings tab.

NEW TEST IDS: every per-card control is namespaced by runtime type (`runtime-card-<type>`, `runtime-model-select-<type>`, `runtime-effort-*-<type>`, `runtime-make-default-<type>`, `runtime-default-pill-<type>`). Document the convention in one comment at the top of `RuntimeCardView.tsx`.

NEW BROWSER TEST - add to `apps/e2e/tests/settings/settings-dialog.spec.ts` (or a new `runtimes-tab.spec.ts` in the same directory) one flow, per the `browser-testing` skill:

1. Open Settings, go to the Runtimes tab.
2. Expand the Codex card while Claude Code is still the default.
3. Set Codex's model. This is the capability hole closing: before this change it was impossible without first making Codex the default.
4. Press `Make default` on the Codex card.
5. Reload, reopen the tab, and assert the Codex card carries the `Default` pill and its collapsed summary names the chosen model.

Acceptance: the audit grep shows no dangling references; `pnpm --filter @dorkos/e2e test` (or the targeted spec) passes locally; `pnpm vitest run apps/client/src/dev/__tests__` still green.

### Task 2.13: Write the user-facing changelog fragment

**Size:** small · **Priority:** medium · **Depends on:** 2.9 · **Parallel with:** 2.11, 2.12

Write one changelog fragment for the visible half of this work. Fragments are per-change files compiled into `CHANGELOG.md` at release; never edit `CHANGELOG.md` directly.

FILENAME: `changelog/unreleased/<id>-<slug>.md` where `<id>` is a fresh timestamp id from `date -u +%y%m%d-%H%M%S` and `<slug>` is short kebab-case, e.g. `changelog/unreleased/260803-190000-runtimes-settings-cards.md`.

FRONTMATTER: a `covers:` list naming every commit subject in PR 2 (the CI fragment gate matches on these, and a squash-retitle silently breaks them, so re-check the list against the final squash subject before merge).

BODY: one `### Changed` section following the `writing-for-humans` skill. Plain enough for a smart 9th grader who does not code. No em dashes (use colons, parentheses, commas or hyphens). Describe what happens for the person, not how the system works. No hype. Reference the tracker id `(DOR-888)`.

The three things worth saying, and nothing else:

1. The Runtimes settings page now shows one card per runtime, with everything about that runtime in one place.
2. You can set the model and thinking effort for every runtime, not just the one you start with. (This is the fix people will notice: before, setting Codex's model meant making Codex your default first.)
3. You pick your default by pressing `Make default` on a card, and the card says it is the default.

Example of the voice to aim for (rewrite, do not paste):

```
### Changed

- The Runtimes settings page now gives each runtime its own card. Open a card to set the
  model it starts with, how hard it thinks, and when it stops to ask you something. You can
  set these for every runtime now, not just the one new chats start on, and you choose that
  one by pressing Make default on its card (DOR-888)
```

Acceptance: the file exists with a valid timestamp-id filename; `changelog/README.md`'s rules are followed; the `fragment-present` CI check passes on the PR; no em dashes anywhere in the body.

### Task 2.14: Verify the new tab against the mockup and open PR 2

**Size:** small · **Priority:** high · **Depends on:** 2.11, 2.12, 2.13 · **Parallel with:** none

Cross-cutting close-out for PR 2, stacked on PR 1.

COMMANDS:

1. `pnpm --filter @dorkos/client typecheck && pnpm --filter @dorkos/client lint`.
2. `pnpm test -- --run` (full suite via turbo; never a bare full `pnpm vitest run`).
3. `pnpm verify` for the affected-only pass.
4. `pnpm knip` (build dists first) for dead code left by the retirements.

ACCEPTANCE REFERENCE: the final composite mockup at `.dork/visual-companion/9035-1785779428/content/04-final-composite.html`. Open it beside the running cockpit and walk the design decisions in order: page structure (decision 1), card anatomy and its five body sections (decision 2), the single global trust row (decision 3), all-collapsed disclosure with summary lines (decision 4), the three edge states said-not-hidden (decision 5), mobile inline expansion (decision 6), playground parity (decision 7).

DRIVE IT, do not just read the diff. Boot with `pnpm dev` and confirm by hand:

- Every card starts collapsed with a `Starts with ...` summary.
- Cards expand independently; no accordion auto-close.
- Set Codex's model and effort while Claude Code is the default, reload, and confirm both stuck.
- Press `Make default` on a card and confirm the pill, the ring, and that new sessions start there.
- Move a card's trust row to Full autonomy with no standing acknowledgement and confirm the dialog appears and that accepting sends ONE request (watch the network tab).
- Disconnect the default runtime and confirm the pill and the warning appear TOGETHER.
- Resize to a phone width and confirm inline expansion, the compressed summary, `Make default` inside the expanded body, and the full-width global dial.
- Confirm the exceptions strip still opens the agent's Config tab.

CROSS-SURFACE REGRESSION (this spec must not touch them): the status-bar runtime picker, the `Run this with` menu, the session-launch popover and onboarding all still open `RuntimeSetupDialog` / `RuntimeSetupPanel` unchanged. Exercise each once.

PR: open from the worktree branch, based on `origin/main`, stacked on PR 1 (rebase onto PR 1's branch, or wait for it to land). Review the branch BEFORE opening the PR per `REVIEW.md`, and brief the reviewer by named failure mode: the split-request autonomy consent, a per-runtime write landing on the wrong config leaf, a card writing for the default runtime instead of its own, eager model fetches on tab open, and a retired component still referenced from a barrel.

## Critical path and parallelism

### Critical path

```
1.1 -> 1.2 -> 1.6 -> 1.7 -> 1.8 -> 1.11 -> 2.2 -> 2.4 -> 2.8 -> 2.9 -> 2.10 -> 2.11 -> 2.14
```

Thirteen tasks long. The phase-1 spine is the retirement chain: the interface
has to exist before adapters declare it, `describeExecutionDefaults` has to be
capability-driven before the server's effort callers can be re-pointed, and the
shared helper can only be deleted once the client callers are re-pointed too.
The phase-2 spine is the component build order: rows before the card view, card
view before the container, container before the tab, tab before the retirements,
retirements before the playground sweep.

### What runs in parallel

**Phase 1**

| Wave | Tasks                    | Note                                                       |
| ---- | ------------------------ | ---------------------------------------------------------- |
| 1    | 1.1                      | Nothing else can start                                     |
| 2    | 1.2, 1.3                 | Adapter declarations and the fixture sweep are independent |
| 3    | 1.4, 1.5, 1.6, 1.9, 1.10 | Five-way fan-out off 1.2 (1.4 also needs 1.3)              |
| 4    | 1.7 then 1.8             | Strictly sequential: 1.8 deletes what 1.7 stops using      |
| 5    | 1.11                     | Gate                                                       |

Widest point: five tasks (1.4, 1.5, 1.6, 1.9, 1.10). 1.7 and 1.8 sit on the
critical path and cannot be parallelized with each other, but 1.9 and 1.10 can
run alongside them.

**Phase 2**

| Wave | Tasks              | Note                                                                       |
| ---- | ------------------ | -------------------------------------------------------------------------- |
| 1    | 2.1, 2.2, 2.3, 2.5 | Four-way fan-out off the phase-1 gate                                      |
| 2    | 2.4, 2.6           | 2.4 needs the summary builder and the rows; 2.6 needs the accounts section |
| 3    | 2.7                | Needs the rows and the write hook                                          |
| 4    | 2.8                | The container; needs view, registry and hook                               |
| 5    | 2.9 then 2.10      | Tab recomposition, then the retirements                                    |
| 6    | 2.11, 2.12, 2.13   | Playground, test-id sweep and changelog are independent                    |
| 7    | 2.14               | Gate                                                                       |

Widest point: four tasks (2.1, 2.2, 2.3, 2.5). The three large builds (2.2 rows,
2.4 card view, 2.5 accounts relocation) are the phase's real cost; 2.2 and 2.5
can run at the same time, 2.4 cannot start until 2.2 lands.

### Sizes

| Size   | Count | Tasks                                                             |
| ------ | ----- | ----------------------------------------------------------------- |
| small  | 7     | 1.1, 1.2, 1.5, 1.10, 1.11, 2.13, 2.14                             |
| medium | 13    | 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 2.1, 2.3, 2.6, 2.7, 2.9, 2.10, 2.12 |
| large  | 5     | 2.2, 2.4, 2.5, 2.8, 2.11                                          |
| xl     | 0     | none by design; anything that grew to xl was split                |
