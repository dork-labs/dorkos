# Capability lists

Each file here lists what one part of DorkOS should do, one row per capability, and says how each row is proven. A census test reads each list and fails when the list and the tests disagree, so the lists cannot quietly drift.

| List                               | What it covers                                                                     | Census                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [chat.md](chat.md)                 | Every chat behavior: composing, rendering, prompts, sessions, rooms, agent conduct | `packages/test-utils/src/__tests__/chat-capabilities-census.test.ts`            |
| [harness-sync.md](harness-sync.md) | What Harness Sync projects, for every harness, source and trigger                  | `packages/harness/src/__tests__/capabilities-census.test.ts`                    |
| [runtimes.md](runtimes.md)         | What every agent runtime should do, as a capability × runtime matrix (generated)   | `apps/server/src/services/runtimes/__tests__/runtime-capability-census.test.ts` |

## The shared pattern

A fourth list should follow it.

- **Ids.** Every row has a short, stable id (`C-07`, `SK-04`, `RT-SES-03`). Never reuse a retired id.
- **Should, not only is.** A list names what the part should do, including what is not built yet. An unbuilt capability is a row with an honest state (`not built`, `planned`) and, where one exists, the ticket that will build it.
- **Honest state.** Each list says how far each row gets: built, partial, not built, or the list's own finer statuses. A state is a claim the census checks against the tests.
- **Evidence tiers.** `U` a unit or route test in CI. `E` a Playwright test against the test-mode runtime. `S` an agentic self-test against a live model (`/chat:*`). `H` or `L` a run against the real harness or backend. Only live-proven rows may be claimed in public copy.
- **Proof is a test title.** A test proves a row when its title starts with the row's id and a colon: `it('C-07: queues a message while the agent works', …)`. An id anywhere else in a title is a mention, not a claim. Several ids share one title with commas.
- **The census.** Each list has a test that parses the list and every test title under the roots that test that part. It checks that:
  - every row claiming `U` or `E` has a titled test;
  - no title names an id the list does not have;
  - no row marked not built has a test claiming it;
  - every cited file or report still exists.
- **Pending lists only shrink.** A list adopted after its tests were written keeps the rows that have no titled test yet in a pending list, held by exact equality. Titling a test removes its row from the list, and no row may join it.
- **Build cache.** A census reads files outside its own package. Its package's test task lists the document, and any foreign test roots it reads, as turbo `inputs`, so an edit to either reruns it rather than replaying a cached pass.

## Adding a row

1. Add the row with an id, the expected behavior, an honest state and its coverage.
2. Title the test that proves it with the id, or claim no `U`/`E` coverage yet.
3. Run the list's census (`pnpm vitest run <census path>`). For `runtimes.md`, edit `packages/test-utils/src/runtime-capability-matrix.ts` and run `pnpm docs:runtime-capabilities` instead of editing the file.
