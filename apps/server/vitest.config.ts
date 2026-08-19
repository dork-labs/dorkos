import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve a few `@dorkos/shared` subpaths to the package's SOURCE, not its
    // built `dist/`.
    //
    // The `exports` map points `default` at `dist/`, so without this a stale dist
    // silently tests yesterday's module. That is a false PASS, not a loud
    // failure. `pnpm test` is safe (turbo's `^build`), but the targeted
    // `pnpm vitest run <path>` loop AGENTS.md prescribes is not, and that is
    // where the next author actually stands.
    //
    // Every entry below is here because it backs a DRIFT GUARD — a test whose
    // whole job is to notice that a table grew a row. Those are exactly the tests
    // a stale dist turns into decoration, because the guard reads the old table,
    // finds it consistent, and reports success:
    //
    // - `config-schema` backs the config-disclosure guard, which enumerates the
    //   leaves of `UserConfigSchema` to prove every config field has been
    //   classified for the tokenless `config_get` surface. Against a stale dist a
    //   newly added field reads as "already classified".
    // - `mcp-tool-groups` backs the tool-group guards, which decide what the cockpit
    //   shows for each toggle and which groups no toggle gates. Measured against a
    //   stale dist, back when this table also fed the SDK's `allowedTools`: moving
    //   `tasks_delete` into an always-on group, making a destructive tool permanently
    //   auto-approved, passed all 85 targeted tests AND `tsc`, because the type-level
    //   assertions only compare key SETS and the keys had not changed. Nothing feeds
    //   `allowedTools` anymore (DOR-519), so that exact edit no longer bypasses a
    //   prompt, but the guard is still the only thing that notices the table moved,
    //   and a stale dist still turns it into decoration. With the alias the same edit
    //   fails immediately.
    // - `@dorkos/operating-skills` backs the two pack-prose guards, which read the
    //   SKILL TEXT agents are seeded with and check it against server reality:
    //   `services/core/__tests__/operating-skills-tier-consistency.test.ts` against
    //   everything that declares a `destructive` tier, and
    //   `services/runtimes/shared/__tests__/dorkos-context-block-vs-pack.test.ts`
    //   against the `<dorkos_context>` block the docs-lookup skill parses (DOR-661).
    //   Their whole subject is the text of that package, so a dist copy is the wrong
    //   text by construction: reintroducing "carries no gate of its own" in `src/`
    //   would pass against a dist built before the edit. That is the DOR-509 bug
    //   itself, checked by a test that cannot see it.
    // - `schemas` backs two enumerations of `PermissionModeSchema.options` — the
    //   permission-mode firewall proves a behaviour for EVERY mode, and
    //   `interactive-handlers` pins the decided set against it — plus
    //   `task-write-policy`, which reads `Create/UpdateTaskRequestSchema.shape` to
    //   prove every writable task field has a policy. A mode or a field added in
    //   `src/` and read from a stale `dist/` is a guard that never sees the thing
    //   it exists to see.
    // - `additional-context` backs the two `CONTEXT_TAG` guards
    //   (`transcript-parser`, `context-roundtrip`). It also comes along for free —
    //   `schemas` and `additional-context` import each other, so aliasing either one
    //   resolves the pair from `src/`; naming both keeps that explicit instead of
    //   accidental.
    //
    //   A note on the two `it.each` guards above (`permission-mode-firewall` and
    //   `transcript-parser`), because a first reading calls them tautological and
    //   they are not. Neither reddens when a member is merely ADDED — correctly, since
    //   each asserts a property that holds for any member. They redden on the
    //   REALISTIC regression, which is the code under test ceasing to be exhaustive,
    //   and both were measured: adding a 7th permission mode AND letting
    //   `enforceCapabilityTier` return `allowed` for it fails 1 of 7 with the alias and
    //   passes green with the alias removed; adding a `ContextKind` AND replacing
    //   `stripSystemTags`' `Object.values(CONTEXT_TAG)` loop with a hardcoded 5-name
    //   array fails 1 of 55 with the alias and passes green without it. The generated
    //   case IS the catch, and the alias is what generates it. Load-bearing, not
    //   decorative.
    // - `untrusted-text` backs the room-context fence tests, and it is the entry
    //   that makes the pattern behind this list explicit rather than incidental:
    //   it is not a drift guard, it is a SANITIZER, and a stale copy of one is
    //   the same false pass by a different route. Measured: mutating
    //   `defuseSystemTags` in `src/` reddened 0 of 2310 server tests without this
    //   alias and 14 with it. So the rule this list actually follows is "a module
    //   whose SOURCE TEXT is the subject of the test", which covers drift guards,
    //   skill prose and security functions alike. Deriving the list from the
    //   `exports` map was considered and does not work: aliasing all 43 subpaths
    //   was measured at ~51s to ~110s on the suite, so the list has to stay
    //   scoped, and no rule in the map distinguishes a subpath whose text is the
    //   subject from one that is merely imported. What CAN be automated is the
    //   cheap half — `vitest-config.test.ts` asserts every entry here resolves to
    //   a real file, so a rename cannot silently turn an alias into a no-op that
    //   falls back to `dist/`. Choosing which module earns an entry stays a
    //   judgement, and this is the fourth time that judgement has been made late.
    //
    // ONE SYMPTOM TO RECOGNISE, because nothing watches for it. A broken alias
    // does not only weaken assertions — it changes what COLLECTS. Measured while
    // verifying the entry above: with the path broken, the run gathered 2,033
    // tests against 2,301 with it, because a module that fails to resolve takes
    // its whole file out of the run and `it.each` over a stale table generates
    // fewer cases. So a suite that suddenly reports several hundred FEWER tests
    // and stays green is an alias symptom, not a cleanup. The existence check
    // above catches the rename that caused it here; it cannot catch every route
    // to the same state, so recognising the shape is still worth something.
    // - `session-stream` backs the approval-receipt gate. `approvalOutcomeOf` is
    //   the single definition of which resolved interaction earns a permanent
    //   record, and both server halves that write one — the log-backed history
    //   fold and the overlay onto claude-code's JSONL — assert its NEGATIVE
    //   cases (a resolved question earns nothing, a withdrawn ask earns
    //   nothing). Same family as `untrusted-text`: a pure gate whose source text
    //   is the subject. Measured: deleting the `kind` gate in `src/` reddened 0
    //   of the 27 server approval tests without this alias — they read the dist
    //   and passed — and 2 with it, while the client's copy of the same
    //   assertion caught it immediately. Cost re-measured back to back in one
    //   session over the full server suite: aliased 35.1s (transform 19.1s)
    //   against un-aliased 38.9s (transform 21.0s). The aliased run being the
    //   faster one is the point — that spread is machine noise, so read it as
    //   "no measurable cost", not as an improvement.
    // - `permission-semantics` backs the cross-runtime pins in
    //   `services/runtimes/__tests__/permission-semantics.test.ts`, which run EVERY
    //   declared mode of all four runtime profiles through the real derivation
    //   rules — including `isAutonomyStop`, the single rule the session PATCH's
    //   autonomy door consults to decide whether a mode change needs the person's
    //   acknowledgement. Same family as `session-stream` and `untrusted-text`: a
    //   pure gate whose source text is the subject. Measured: forcing
    //   `isAutonomyStop` to `return false` in `src/` reddened 0 of the 85 tests in
    //   that file without this alias — they read the dist and passed — and 5 with
    //   it, one of them the door's own gating pin. Without the alias the guard
    //   cannot see a source change until somebody remembers to rebuild.
    // - `constants` backs `model-catalog-labels`, which asserts every runtime's
    //   model display name fits inside `STATUS_VALUE_MAX_CHARS`. Shrink the budget
    //   in `src/` and a stale dist measures against the old, roomier one.
    // - `trait-renderer` backs the `DEFAULT_TRAITS` pins in `routes/__tests__/
    //   agents-conventions.test.ts` and `agents-creation.test.ts`, which assert the
    //   scaffolder is called with a SIX-KEY literal (`{ verbosity: 3, … spice: 3 }`).
    //   The client twin of this alias was here from the start; the server twin was
    //   missed in the DOR-541 sweep because the import reads as a fixture. It is not:
    //   a hardcoded literal compared against a shared table is a drift guard by
    //   construction. Measured both ways with the same seed (a 7th key on
    //   `DEFAULT_TRAITS` in `src/`, `dist` left stale): with this alias, 5 failed
    //   across the two files; with the alias removed, all green.
    // - `relay-schemas` backs the two subject pins for run stop requests
    //   (`routes/__tests__/tasks.test.ts`, `tasks/__tests__/task-scheduler-service.test.ts`),
    //   which assert the literal `relay.control.task-cancel.{runId}` the adapter
    //   subscribes to on the other side of the bus. Same family as the others: a
    //   hardcoded literal checked against a shared constant is a drift guard, and it
    //   only guards anything if the constant under test comes from `src/`. The wire
    //   subject is load-bearing beyond formatting — moving it back under
    //   `relay.system.` puts it inside the pattern `GET /api/relay/stream` will
    //   accept, where a passive watcher makes every Stop report success (DOR-808).
    //   Measured: changing the prefix in `src/` with `dist/` left stale reddens 2 with
    //   this alias and 0 without it.
    // - `@dorkos/relay/approver-allowlist` backs `mayApprove`, the single answer to
    //   "may this platform user authorize a tool call" — read by `askEntitlement`
    //   and by the bridged Ask card's audience predicate, and the only thing
    //   between a chat button and a shell command on the operator's machine.
    //   Same family as `untrusted-text` and `session-stream`: a pure gate whose
    //   source text is the subject. Measured on review: replacing the whole body
    //   with `return true` in `src/` reddened 0 of 127 server tests without this
    //   alias — every one of them read `dist/` — and 12 with it. The subpath is
    //   a single self-contained module with no imports at all, which is why the
    //   alias costs nothing measurable.
    // - `@dorkos/marketplace/package-types` backs `install-roots`, which iterates
    //   `PackageTypeSchema.options` to prove no package type installs somewhere the
    //   scanners never look. The test used to import the schema from the package
    //   ROOT; it now takes the narrow subpath so the alias can be a single
    //   zod-only module instead of the whole package index.
    //
    // Scoped to these modules on purpose. Aliasing all 43 subpaths made every
    // worker re-transform the whole package and took the suite from ~51s to
    // ~110s (transform 97s); scoped, it costs nothing measurable. Adding the
    // second entry was re-measured in one session, back to back: 50.7s to 52.9s
    // total, transform 18.9s to 19.4s. Both runs were dominated by a 45s flaky
    // watcher integration test, so treat transform time as the signal here and
    // total time as noise, and re-measure in ONE session rather than comparing
    // against a number written down on a different day.
    //
    // DOR-541 added the five entries below and re-measured the same way, on a box
    // under heavy concurrent load: aliased 129.0s (transform 68.6s) against an
    // un-aliased 158.2s (transform 86.7s) and an earlier un-aliased 134.7s
    // (transform 136.6s) in the same session, over the same test set. The aliased
    // run being the FAST one is the point: on this machine the spread between two
    // runs of the SAME config is wider than any delta these aliases produce, so the
    // honest reading is "no measurable cost", not "an improvement". If a future
    // author sees a real regression, widen the suspicion to `shared/schemas` first —
    // it is by far the largest of the five. The trade-off is
    // that other `dist/*.js` files reach these modules by relative imports, which
    // this alias does not rewrite, so a test process can hold both the src and
    // dist copies. That is safe for these modules and only because of what they
    // are: no mutable state, and they export only Zod schemas, plain constants,
    // and pure functions over them, nothing whose identity is ever compared. Do
    // not widen this alias without re-measuring.
    alias: [
      {
        find: '@dorkos/shared/config-schema',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/config-schema.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/mcp-tool-groups',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/mcp-tool-groups.ts', import.meta.url)
        ),
      },
      {
        // Anchored, unlike the two above. A bare string `find` is a PREFIX match
        // in Vite, and the two entries above happen to be safe because they are
        // already full subpaths with nothing beneath them. This one is a package
        // ROOT: as a bare string it would also swallow a future
        // `@dorkos/operating-skills/seed` and rewrite it to `.../src/index.ts/seed`,
        // which resolves to nothing. The package exports only `.` today, so the
        // regex is what keeps that a build error instead of a silent one later.
        find: /^@dorkos\/operating-skills$/,
        replacement: fileURLToPath(
          new URL('../../packages/operating-skills/src/index.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/schemas',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/schemas.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/additional-context',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/additional-context.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/untrusted-text',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/untrusted-text.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/constants',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/constants.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/trait-renderer',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/trait-renderer.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/session-stream',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/session-stream.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/permission-semantics',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/permission-semantics.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/shared/relay-schemas',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/relay-schemas.ts', import.meta.url)
        ),
      },
      {
        // Not a drift guard — a memory guard. `interaction-events` imports
        // `./schemas.js`, and `schemas` is aliased to SOURCE above; left on
        // `dist/`, this subpath drags in a SECOND copy of the whole `schemas`
        // module (the dist one), and every `vi.resetModules()` re-evaluates
        // both. `routes/__tests__/config.test.ts` re-imports the router 91
        // times and went from 91 green to a heap OOM at test 90 the day
        // `session-list-broadcaster` gained this import (DOR-1330 landing).
        // The rule this entry states: a shared subpath whose module imports
        // another aliased subpath's file must be aliased to source too, or the
        // two resolutions load the same module twice.
        find: '@dorkos/shared/interaction-events',
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/interaction-events.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/marketplace/package-types',
        replacement: fileURLToPath(
          new URL('../../packages/marketplace/src/package-types.ts', import.meta.url)
        ),
      },
      {
        find: '@dorkos/relay/approver-allowlist',
        replacement: fileURLToPath(
          new URL('../../packages/relay/src/adapters/approver-allowlist.ts', import.meta.url)
        ),
      },
    ],
  },
  test: {
    environment: 'node',
    // Vitest 4 no longer auto-excludes dist/, and `tsc` emits compiled
    // *.test.js there — scope discovery to source like every other package.
    include: ['src/**/__tests__/**/*.test.ts'],
    // The lefthook pre-push gate sets VITEST_RETRY to absorb timing flake in
    // integration tests on a developer machine already busy with other agents.
    // CI deliberately does NOT set it (see .github/workflows/test.yml): a
    // runner is not contended the same way, and a retry budget there would turn
    // a real intermittent failure into a green check. It rides turbo's
    // globalPassThroughEnv, so it never forks the cache key; dev runs get
    // retry: 0 and surface flake loudly.
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/test-utils/**'],
    },
  },
});
