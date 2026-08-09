# Sidebar Model Guide

## Overview

The whole sidebar is one pure function: `buildSidebarModel(state) → SidebarModel`. Every zone, section, row, order, cap, rollup and badge is decided there, by a small named rule, and every node it emits carries a `reason` saying why it exists. Components render the result and hold no rules of their own.

This guide is how you change that model without breaking the thing it exists to protect. Read it before you add a rule, add a fixture, or review a PR that touches `features/dashboard-sidebar/model/`.

Three phrases recur, so they are worth pinning down once:

- **Leaf subscription** — a single row component watching one live value for itself, instead of that value living on the model and being handed down. One thing changes, one row redraws, and the rest of the panel does not.
- **Table test** — a test that feeds a list of input/expected pairs to a plain function and checks each one. It is what a rule gets instead of a mounted component tree.
- **Reason-shaped** — matching `<namespace>:<rule>`, the format described under [Reading a `reason`](#reading-a-reason). A string with an id interpolated into it is not reason-shaped.

The sections below follow `writing-developer-guides`, with one deliberate insertion: the standing rule sits third, ahead of the decision matrix, because it is the guide's reason to exist and the line a reviewer quotes.

## Key Files

| Concept                              | Location                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| The function and every model type    | `apps/client/src/layers/features/dashboard-sidebar/model/build-sidebar-model.ts`                          |
| The snapshot it reads                | `apps/client/src/layers/features/dashboard-sidebar/model/sidebar-state.ts`                                |
| One rule per file                    | `apps/client/src/layers/features/dashboard-sidebar/model/rules/`                                          |
| Shared spellings (keys, basenames)   | `apps/client/src/layers/features/dashboard-sidebar/model/rules/targets.ts`                                |
| The four journey fixtures            | `apps/client/src/layers/features/dashboard-sidebar/model/fixtures/`                                       |
| Contracts that hold for all fixtures | `apps/client/src/layers/features/dashboard-sidebar/model/__tests__/build-sidebar-model.contracts.test.ts` |
| "When did I last open this?"         | `apps/client/src/layers/entities/interactions/`                                                           |
| The behavioural contracts (BC-\*)    | `specs/sidebar-now-today-library/02-specification.md` §B                                                  |
| The locked design decisions          | `specs/sidebar-now-today-library/design-decisions.md`                                                     |

## The standing rule: live verbs never enter the model

**A change that puts a verb, a countdown, or a relative timestamp into the sidebar model is a blocker in review.** Not a nit, not a follow-up — the change is rejected and the reviewer cites this line.

Here is why. A fleet of thirty agents emits an activity event roughly every two seconds per working session. If "editing RoomRow.tsx" lived on a row in the model, every one of those events would rebuild the entire tree — every zone, every section, every row — to change four words in one place. Rows would also reorder while somebody was reading them, which is the exact failure the redesign was built to remove (Risk R1 in the spec).

So the split is:

- **Layout comes from lifecycle.** A row carries `reservesVerbLine: boolean`, derived from whether a turn is streaming. The model decides whether there is a second line, not what it says.
- **Text comes from activity.** The leaf row component subscribes to the verb itself, so one event re-renders one row.
- **Relative time is the same problem wearing a different hat.** "3m ago" has to be redrawn as the clock moves. Rows carry the instants they are ordered by, and the component formats them.

The model also has no clock of its own. `state.now` is passed in — coarse on purpose — which is what makes the 4am overnight boundary and the once-a-day digest ordinary table tests instead of timer mocks.

Three tests enforce this, and they are written so they can actually fail:

- The pure set may only import values from a whitelist. A whitelist rather than a search for bad spellings, because `import { useInteractionStore } from '@/layers/entities/interactions'` drags in a clock without ever writing the word `Date`.
- The only two legal shapes of `Date` are `new Date(<argument>)` and `Date.parse(`. Bare `new Date`, `new Date()`, `Date.now()` and `const Clock = Date` are all caught.
- No row's visible text may match `/\d+\s?(s|m|h|d)\s?ago/i` or a verb like `working…`.

**The pure set is exactly three things: `build-sidebar-model.ts`, `sidebar-state.ts`, and every file in `rules/`.** Nothing else. The other files sitting beside them in `model/` — `sidebar-item.ts`, `sort-sidebar-items.ts`, `filter-sidebar-items.ts`, `sidebar-membership.ts`, `smart-group-presets.ts`, `evaluate-smart-group.ts` and the `use-*` hooks — predate this model and are **not** checked, however pure they look. Being a plain function is not what puts a file in the set; living at one of those three addresses is. A new rule therefore belongs in `rules/`, not loose in `model/`, or it ships unguarded.

## When to Use What

| You want to change…                                   | Put it here                                                        | Why                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Which rows appear, in what order, under what cap      | A rule in `model/rules/`                                           | It is a decision, and decisions are table-testable functions                        |
| What a row's live status text says                    | The row component, via a leaf subscription                         | The standing rule above                                                             |
| A time-of-day boundary or a "once per day" behaviour  | A rule, reading `state.now`                                        | Passing the clock in is what makes it testable                                      |
| Where a fact comes from (an API, a store, the router) | The state assembly hook, feeding `SidebarState`                    | The model reads a snapshot; it never fetches                                        |
| A colour, a size, a hover treatment                   | The component, using the tokens in `contributing/design-system.md` | The model emits semantic ids (`glyph: { kind: 'icon', icon: 'error' }`), not styles |
| What a preference is called on disk                   | `packages/shared/src/config-schema.ts`                             | The model reads a view of prefs; `@dorkos/shared` owns the stored schema            |

## Core Patterns

### The shape

Four levels, and no more:

```
SidebarModel
└── zones: SidebarZoneModel[]        // getting-started | now, then today, then library
    ├── label                         // a landmark heading; never a collapse control
    ├── liveRegionText?               // Now only — a count, never a verb
    └── sections: SidebarSectionModel[]
        ├── label: string | null      // null = a headerless body (Now and Today)
        ├── collapsible / collapsed   // only Library sections may fold
        ├── rollup?                   // the signal that survives folding
        ├── subsections?              // groups inside Agents. One level, never two
        └── rows: SidebarRowModel[]
            ├── target                // what clicking it does
            ├── glyph / primary / secondary
            ├── status                // an avatar dot, from lifecycle
            ├── reservesVerbLine      // whether a second line exists, not what it says
            ├── unread                // { tier: 'none'|'activity'|'directed', count? }
            └── reason                // why this row is here
```

Two shapes are worth knowing before you read the code:

- **A zone with nothing to say is absent**, not empty. `bodyZone()` returns `undefined` for an empty body, so no caller can push an empty box into `zones`.
- **`getting-started` is not a fifth zone.** It is Now's day-one life stage and shares Now's slot, which is why the two are never both present.

### Reading a `reason`

Every zone, section and row carries `reason`, formatted `<namespace>:<rule>` — lowercase letters and hyphens, exactly one colon, asserted for every node of every fixture. It is the answer to "why is this row here?" in devtools, and it is also the handle tests grab.

| Namespace          | Sits on                             | Values you will see                                                                                                                                                                                              |
| ------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zone:`            | a zone                              | `zone:now`, `zone:getting-started`, `zone:today`, `zone:library`                                                                                                                                                 |
| `now:`             | Now's body section, and its rows    | `now:body`; then `now:permission-prompt`, `now:question`, `now:error`, `now:idle-timeout`                                                                                                                        |
| `getting-started:` | the day-one body section            | `getting-started:body`                                                                                                                                                                                           |
| `today:`           | Today's body section, and most rows | `today:body`; `today:interaction-recency` (you touched it); `today:digest`                                                                                                                                       |
| `anchor:`          | one Today row                       | `anchor:active-session` — first because you have it open                                                                                                                                                         |
| `rollup:`          | a row standing for other rows       | `rollup:working`, `rollup:now-overflow`, `rollup:automated`                                                                                                                                                      |
| `suggestion:`      | a Getting-started row               | the suggestion's own id, e.g. `suggestion:agents-found`, `suggestion:ask-dorkbot`                                                                                                                                |
| `library:`         | Library's sections and rows         | sections `library:pins`, `library:channels`, `library:dms`, `library:agents`, `library:group`; rows `library:pinned`, `library:channel`, `library:dm`, `library:agent`, `library:group-member`, `library:reveal` |

Two things that look like each other and are not:

- A group sub-header's **id** is `group:<groupId>` — a raw id, so it is not reason-shaped. Its **reason** is `library:group`.
- A suggestion's reason, its row key, and the token written into `prefs.gettingStarted.retired[]` are all the same string. One spelling, so renaming a suggestion can never un-retire it.

### How the rules compose

`buildSidebarModel` reads as the order the decisions happen in. Each rule decides one thing, and a rule that needs another rule's answer takes it as an argument instead of reaching for it.

Today is the part where the order carries meaning, so it is worth reading once:

```typescript
const anchor = anchorKey(state); // what the operator has open, or null
const eligible = applyMuteRules(selectTodayItems(state), muteIndex(state.prefs), {
  dropMuted: true,
  ...(anchor === null ? {} : { exemptKey: anchor }),
});
const today = pinActiveAnchor(
  orderToday(
    archiveOvernight(eligible, state, { ...(anchor === null ? {} : { anchorKey: anchor }) }),
    state
  ),
  state
);
```

Who is eligible → what mute removes → what the overnight boundary removes → what order the rest come in → and only then which one is pinned first. The anchor is exempted at every step before the last, so nothing can mute, archive or cap the conversation you have open out of first place.

**Pass the exemption arguments or the promise silently stops being true.** `applyMuteRules`' `exemptKey` and `archiveOvernight`'s third argument are the only mechanisms that spare the anchor — `archive-overnight.ts` filters on `row.key === exemptions.anchorKey` and nothing else. Both parameters are optional (`exemptions: ArchiveExemptions = {}`), so a composition that omits them compiles, passes typecheck, and quietly archives the conversation the operator is looking at.

`rules/targets.ts` is the exception to "one rule per file". It holds the spellings every rule shares — `rowKey`, `interactionKeyOf`, `anchorKey`, `basename`, `epochMs`. `anchorKey` lives there because three rules need the answer, and a rule importing another rule to ask one question is how a cycle starts.

### The units, which are not all the same

Getting one of these wrong fails silently. `epochMs` turns an unparseable value into `null`, which the model reads as "never", so the list quietly falls back to alphabetical order and nothing throws.

| Field                             | Unit                                           |
| --------------------------------- | ---------------------------------------------- |
| `state.now`                       | epoch milliseconds                             |
| `AgentRosterEntry.lastActivityAt` | epoch milliseconds, or `null`                  |
| `state.interactions`              | **ISO-8601 strings** (`InteractionTimestamps`) |
| `state.userLastMessageAt`         | **ISO-8601 strings**                           |
| `SidebarAttentionSignal.since`    | **ISO-8601 string**                            |
| `prefs.digest.lastShownDate`      | a local date key, `YYYY-MM-DD`                 |

`SidebarState.interactions` is typed as the interaction store's own exported `InteractionTimestamps`, not as a hand-written `Record<string, string>`. Both compile; only one of them breaks the build if the store ever changes what it puts in the value. There is an end-to-end test (`__tests__/interaction-seam.test.ts`) that carries real store output into `buildSidebarModel`, plus a case proving the failure it guards against.

## Anti-Patterns

```typescript
// ❌ A verb in the model. Rebuilds the whole tree every couple of seconds.
primary: `${agent.name} — ${activity.verb}`,

// ✅ Say whether a line is reserved. The row subscribes to the text.
reservesVerbLine: lifecycle === 'streaming',
```

```typescript
// ❌ A clock of its own. Untestable, and it churns.
if (Date.now() - startedAt > IDLE_MS) …

// ✅ The only clock is the one you were handed.
if (state.now - startedAt > IDLE_MS) …
```

```typescript
// ❌ A value import that drags a store, React and a clock into a pure module.
import { useInteractionStore } from '@/layers/entities/interactions';

// ✅ Types are erased before the bundle exists, so they may come from anywhere.
import type { InteractionTimestamps } from '@/layers/entities/interactions';
```

```typescript
// ❌ Asking another rule a question. This is how an import cycle starts.
import { pinActiveAnchor } from './pin-active-anchor';

// ✅ Take the answer as an argument, or move the shared question to targets.ts.
export function myRule(rows: readonly SidebarRowModel[], anchor: string | null) { … }
```

```typescript
// ❌ Editing a shared fixture so your test passes. Several tasks read these.
busyFixture.attention = [];

// ✅ Build the variant locally with a spread.
const state = { ...busyFixture, attention: [] };
```

```typescript
// ❌ A reason the format check rejects, and a reader cannot decode.
reason: 'row',              // no namespace
reason: 'today:Recency',    // uppercase
reason: `group:${group.id}` // a raw id, not a rule name

// ✅ <namespace>:<rule>, lowercase and hyphens.
reason: 'today:interaction-recency',
```

## Adding a Rule

1. **Name the contract first.** Find the BC number your rule implements in `specs/sidebar-now-today-library/02-specification.md` §B. If there is no contract, you are changing behaviour that was decided elsewhere — settle that before writing code.

2. **Create one file for one decision**: `model/rules/<verb>-<noun>.ts`, matching the existing names (`select-now-items`, `order-today`, `derive-unread-signal`). Open it with a module docblock that says what it decides and cites the BC.

3. **Take what you need as arguments.** A selector takes `state`. A transformer takes `(rows, state)`. Never import a sibling rule to ask it a question — if two rules need the same answer, it belongs in `rules/targets.ts`.

   ```typescript
   /**
    * System agents sink to the bottom of a Library section (BC-nn — put the
    * real contract number here; the spec's run to BC-51).
    *
    * @module features/dashboard-sidebar/model/rules/demote-system-agents
    */
   import type { SidebarRowModel } from '../build-sidebar-model';
   import type { SidebarState } from '../sidebar-state';

   /**
    * The rows with every system agent moved to the end, order otherwise intact.
    *
    * @param rows - A section's rows.
    * @param state - The snapshot.
    */
   export function demoteSystemAgents(
     rows: readonly SidebarRowModel[],
     state: SidebarState
   ): SidebarRowModel[] {
     const system = new Set(
       state.agents.filter((entry) => entry.isSystem).map((entry) => entry.path)
     );
     const isSystemRow = (row: SidebarRowModel): boolean =>
       row.target.kind === 'agent' && system.has(row.target.path);
     return [...rows.filter((row) => !isSystemRow(row)), ...rows.filter(isSystemRow)];
   }
   ```

4. **Obey the two purity limits.** Value imports may only be relative siblings, `@dorkos/shared/smart-groups`, or `@/layers/entities/session`; anything else must be `import type`. Read time only from `state.now` — the only legal `Date` shapes are `new Date(<argument>)` and `Date.parse(`.

5. **Stamp a `reason`** on every node you create, matching `/^[a-z-]+:[a-z-]+$/`. Reuse an existing namespace from the table above unless your rule genuinely introduces a new kind of provenance.

6. **Compose it where its inputs are ready.** There are two composition points, and picking the wrong one is the easiest mistake to make. A rule that shapes a zone is composed in `buildSidebarModel` itself. A rule that shapes one Library section is composed inside `buildLibrarySections`, which builds Library's sections and rows and is the only place their intermediate lists exist. If the position in the pipeline carries meaning, say so in a comment there — the Today block is the worked example.

7. **Write the table test** in the `__tests__/` file for that zone: `now-rules.test.ts`, `today-rules.test.ts`, `library-rules.test.ts`, `getting-started.test.ts`, or `derive-rules.test.ts` for the small shared derivations. Test the rule directly with literals, and assert the end-to-end effect through `buildSidebarModel` on a fixture.

8. **Verify**, in this order:

   ```bash
   pnpm vitest run apps/client/src/layers/features/dashboard-sidebar/model
   pnpm --filter @dorkos/client lint
   pnpm --filter @dorkos/client typecheck
   ```

   The contract suite runs against your new file automatically — it reads the `rules/` directory rather than a list — so a purity slip reds immediately, and so does a malformed `reason`.

## Adding a Fixture

The four journey fixtures (`first-run`, `quiet`, `busy`, `power`) are a deliverable, not test scaffolding. Today they drive the model's table tests, and nothing else imports them. The intent is that the same four also drive the Dev Playground showcases and the browser tests, so that what a reviewer looks at and what CI asserts are the same states — build any new surface against these rather than seeding a fresh state beside them.

**Most of the time you do not want a new fixture — you want a variant.** Build it locally with a spread (`{ ...busyFixture, attention: [] }`). The shared files are read by several tasks at once, and editing one turns your tweak into somebody else's failing expectation.

Add a fifth journey only when it is a genuinely different stage of the product, not a variation on an existing one. Then:

1. **Create `model/fixtures/<name>.ts`** and build it from `emptyState()` plus the factories, so it stays complete when `SidebarState` grows a field:

   ```typescript
   import type { SidebarState } from '../sidebar-state';
   import { agent, emptyState, hoursAgo, session } from './factories';

   const TANGERINE = '/Users/dev/code/tangerine';

   /** An operator returning after a week away — everything is stale. */
   export const dormantFixture: SidebarState = emptyState({
     agents: [agent(TANGERINE, { lastActivityAt: null })],
     sessions: [session({ id: 'ses-old', title: 'Ship the parser', cwd: TANGERINE })],
     displayNames: { [TANGERINE]: 'tangerine' },
     interactions: { 'session:ses-old': hoursAgo(9 * 24) },
   });
   ```

   Use `hoursAgo()` for the ISO-8601 fields and `FIXTURE_NOW - n * HOUR` for the epoch-millisecond ones — check the units table above before you type either.

2. **Export it from `model/fixtures/index.ts`**, and add it to `SIDEBAR_FIXTURES` with the name a showcase or a test will print.

3. **Run the contract suite.** Everything in `build-sidebar-model.contracts.test.ts` walks `SIDEBAR_FIXTURES`, so your fixture is covered by every "for every fixture" assertion the moment it is in that array — no test edits required:

   ```bash
   pnpm vitest run apps/client/src/layers/features/dashboard-sidebar/model/__tests__/build-sidebar-model.contracts.test.ts
   ```

4. **Once a sidebar-model showcase exists in the Dev Playground, add it there too**, so a journey can be looked at and not only asserted on. There is no such showcase yet; the `maintaining-dev-playground` skill covers where one lives and how to register it.

Note that `FIXTURE_NOW` is a **local** instant (09:15 on 9 August 2026), not a fixed UTC epoch. Every time-dependent rule is stated in local terms — the 4am boundary, the calendar day the digest is once per — so a fixture pinned to UTC would archive different rows in Auckland than in California, and the same test would pass in one office and fail in the other.

## Troubleshooting

### `value-imports only whitelisted modules` fails

**Cause**: a pure module imports a value from somewhere outside the whitelist. Usually a store, a hook, or a helper that pulls one in.
**Fix**: if you only need the shape, make it `import type`. If you need the value, move the work out of the model — the assembly hook computes it and passes it in on `SidebarState`.

### `reads no clock it was not given` fails

**Cause**: a `Date` use that is not `new Date(<argument>)` or `Date.parse(`, or a reference to `performance`, `Math.random`, or `Intl`.
**Fix**: take the instant from `state.now`. For a calendar day, use `localDateKey(state.now)` — `Intl` is banned here and `toISOString()` answers in UTC, which would roll the digest over in the middle of somebody's evening.

### `every zone, section and row carries a well-formed reason` fails

**Cause**: a `reason` with no colon, two colons, uppercase, or an interpolated id.
**Fix**: `<namespace>:<rule>`, both halves lowercase with hyphens. Ids belong in `key` and `id`, never in `reason`.

### Today comes out alphabetical instead of by recency

**Cause**: almost always a unit mismatch. `state.interactions` and `state.userLastMessageAt` hold ISO-8601 strings; epoch milliseconds satisfy the `string` type, parse to `NaN`, and are read as "never opened".
**Fix**: emit ISO. `__tests__/interaction-seam.test.ts` is the test that proves both directions of this.

### The build-budget test fails

**Cause**: `build-sidebar-model.performance.test.ts` asserts the whole panel builds for a 32-agent fleet in under 5ms. A rule that sorts inside a loop, or rebuilds a `Map` per row, will cross it.
**Fix**: build lookup maps once at the top of the rule, as `buildLibrarySections` does with `byPath` and `rooms`.

## Related

- `contributing/design-system.md` — the sidebar's width, inset, tint ramp and accessibility contract
- `contributing/project-structure.md` and `.claude/rules/fsd-layers.md` — the layer rules that put the model inside the feature that renders it rather than in a slice of its own
- `contributing/state-management.md` — choosing between Zustand and TanStack Query for the sources that will feed `SidebarState`
- `specs/sidebar-now-today-library/02-specification.md` — the BC-numbered contracts each rule cites
- `specs/sidebar-now-today-library/design-decisions.md` — the locked decisions behind them
