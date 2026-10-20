# Sidebar Model Guide

## Overview

The whole sidebar is one pure function: `buildSidebarModel(state) → SidebarModel`. Every section, row, order, rollup and badge is decided there, by a small named rule, and every node it emits carries a `reason` saying why it exists. Components render the result and hold no rules of their own.

This guide is how you change that model without breaking the thing it exists to protect. Read it before you add a rule, add a fixture, or review a PR that touches `features/dashboard-sidebar/model/`.

Three phrases recur, so they are worth pinning down once:

- **Leaf subscription** — a single row component watching one live value for itself, instead of that value living on the model and being handed down. One thing changes, one row redraws, and the rest of the panel does not.
- **Table test** — a test that feeds a list of input/expected pairs to a plain function and checks each one. It is what a rule gets instead of a mounted component tree.
- **Reason-shaped** — matching `<namespace>:<rule>`, the format described under [Reading a `reason`](#reading-a-reason). A string with an id interpolated into it is not reason-shaped.

The sections below follow `writing-developer-guides`, with one deliberate insertion: the standing rule sits third, ahead of the decision matrix, because it is the guide's reason to exist and the line a reviewer quotes.

## Key Files

| Concept                                    | Location                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| The function and every model type          | `apps/client/src/layers/features/dashboard-sidebar/model/build-sidebar-model.ts`                          |
| The snapshot it reads                      | `apps/client/src/layers/features/dashboard-sidebar/model/sidebar-state.ts`                                |
| One rule per file                          | `apps/client/src/layers/features/dashboard-sidebar/model/rules/`                                          |
| Shared spellings (keys, basenames)         | `apps/client/src/layers/features/dashboard-sidebar/model/rules/targets.ts`                                |
| The four journey fixtures                  | `apps/client/src/layers/features/dashboard-sidebar/model/fixtures/`                                       |
| Contracts that hold for all fixtures       | `apps/client/src/layers/features/dashboard-sidebar/model/__tests__/build-sidebar-model.contracts.test.ts` |
| The fixtures, drawn (`/dev/sidebar-model`) | `apps/client/src/dev/showcases/SidebarModelShowcases.tsx`                                                 |
| The same fixtures, in a browser            | `apps/e2e/tests/dashboard-sidebar/sidebar-model-showcase.spec.ts`                                         |
| Which sections exist, and in what order    | `apps/client/src/layers/features/dashboard-sidebar/model/rules/build-sections.ts`                         |
| An agent's direct message as its one row   | `apps/client/src/layers/features/dashboard-sidebar/model/rules/agent-direct-messages.ts`                  |
| The snapshot's one assembly hook           | `apps/client/src/layers/features/dashboard-sidebar/model/use-sidebar-state.ts`                            |
| The one call that builds the model         | `apps/client/src/layers/features/dashboard-sidebar/model/use-sidebar-model.ts`                            |
| The renderer (maps sections, nothing else) | `apps/client/src/layers/features/dashboard-sidebar/ui/SidebarSections.tsx`                                |
| The behavioural contracts (BC-\*)          | `specs/sidebar-now-today-library/02-specification.md` §B                                                  |
| The locked design decisions                | `specs/sidebar-now-today-library/design-decisions.md`                                                     |

## The standing rule: live verbs never enter the model

**A change that puts a verb, a countdown, or a relative timestamp into the sidebar model is a blocker in review.** Not a nit, not a follow-up — the change is rejected and the reviewer cites this line.

Here is why. A fleet of thirty agents emits an activity event roughly every two seconds per working session. If "editing RoomRow.tsx" lived on a row in the model, every one of those events would rebuild the entire tree — every section, every row — to change four words in one place. Rows would also reorder while somebody was reading them, which is the exact failure the redesign was built to remove (Risk R1 in the spec).

So the split is:

- **Layout comes from lifecycle.** A row carries `reservesVerbLine: boolean`, derived from whether a turn is streaming. The model decides whether there is a second line, not what it says.
- **Text comes from activity.** The leaf row component subscribes to the verb itself, so one event re-renders one row.
- **Relative time is the same problem wearing a different hat.** "3m ago" has to be redrawn as the clock moves. Rows carry the instants they are ordered by, and the component formats them.

The model also has no clock of its own. `state.now` is passed in — coarse on purpose — which is what makes a smart section's "active in the last N days" an ordinary table test instead of a timer mock.

Three tests enforce this, and they are written so they can actually fail:

- The pure set may only import values from a whitelist. A whitelist rather than a search for bad spellings, because `import { useInteractionStore } from '@/layers/entities/interactions'` drags in a clock without ever writing the word `Date`.
- The only two legal shapes of `Date` are `new Date(<argument>)` and `Date.parse(`. Bare `new Date`, `new Date()`, `Date.now()` and `const Clock = Date` are all caught.
- No row's visible text may match `/\d+\s?(s|m|h|d)\s?ago/i` or a verb like `working…`.

**The pure set is exactly three things: `build-sidebar-model.ts`, `sidebar-state.ts`, and every file in `rules/`.** Nothing else. The other files sitting beside them in `model/` — `sidebar-item.ts`, `section-sort-options.ts`, `smart-group-presets.ts`, `evaluate-smart-group.ts` and the `use-*` hooks — predate this model and are **not** checked, however pure they look. Being a plain function is not what puts a file in the set; living at one of those three addresses is. A new rule therefore belongs in `rules/`, not loose in `model/`, or it ships unguarded.

## When to Use What

| You want to change…                                   | Put it here                                                        | Why                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Which rows appear, and in what order                  | A rule in `model/rules/`                                           | It is a decision, and decisions are table-testable functions                          |
| What a row's live status text says                    | The row component, via a leaf subscription                         | The standing rule above                                                               |
| Anything that depends on the time                     | A rule, reading `state.now`                                        | Passing the clock in is what makes it testable                                        |
| Where a fact comes from (an API, a store, the router) | The state assembly hook, feeding `SidebarState`                    | The model reads a snapshot; it never fetches                                          |
| A colour, a size, a hover treatment                   | The component, using the tokens in `contributing/design-system.md` | The model emits semantic ids (`glyph: { kind: 'icon', icon: 'threads' }`), not styles |
| What a preference is called on disk                   | `packages/shared/src/config-schema.ts`                             | The model reads a view of prefs; `@dorkos/shared` owns the stored schema              |

## Core Patterns

### The shape

**The sidebar lists places, never sessions or threads** (DOR-3092). Every row is a channel, a direct message, a mini app's page, or a door to a page that holds the rest. Three levels, and no more:

```
SidebarModel
└── sections: SidebarSectionModel[]   // top, your sections, channels, dms, addons
    ├── label: string | null          // null = the headerless top items, and nothing else
    ├── collapsible / collapsed       // every section but the top items folds
    ├── rollup?                       // the signal that survives folding
    └── rows: SidebarRowModel[]       // a section's members. There is nothing below them
        ├── target                    // what clicking it does
        ├── glyph / primary / secondary
        ├── reservesVerbLine          // whether a second line exists, not what it says
        ├── unread                    // { tier: 'none'|'activity'|'directed', count? }
        └── reason                    // why this row is here
```

The order is fixed and never varies with content:

1. **`top`** — the doors: Threads (`/threads`) and Directory (`/team`). **A top item never shows before its page exists**, so a new door lands here only with its page.
2. **Your sections** (`group:<id>`), hand-made or rule-based, right under the doors.
3. **`channels`**, sorted by name unless the header menu says otherwise.
4. **`dms`** — always present. An agent's one-to-one direct message is drawn as the AGENT (`agent-direct-messages.ts`): its face, its name, its menu, opening its Direct chat (DOR-2997). A pinned agent with no direct message yet is here too. The last row is a door: "Message an agent or person", or "Message an agent" (Directory narrowed to agents) when the section is otherwise empty.
5. **`addons`** — one row per page a mini app lists, only once there is one.

Two rules worth knowing before you read the code:

- **A section with nothing in it is absent**, not empty — except Direct messages (its empty state is how you start one) and a section the operator made (it has to exist to be dragged into).
- **An agent is one row.** It is drawn in Direct messages, or in the section that holds it (filed by hand, or matched by a smart section's rules), never both. A smart match its section's display filter hides stays in Direct messages. Every other agent lives in the Directory.
- **A row never moves under the person using the panel.** A smart section's members change on their own, so an agent can drift between it and Direct messages. While the pointer is over the list or focus is in it, `useHeldSections` holds every row in the section it was in (`rules/hold-section-moves.ts`) and the moves land when they leave; the person's own changes (a drag, a pin) retake the snapshot and land at once. An agent row carries its key as motion's `layoutId`, so a move slides for 200 ms ease-out (instant under reduced motion).

### Reading a `reason`

Every section and row carries `reason`, formatted `<namespace>:<rule>` — lowercase letters and hyphens, exactly one colon, asserted for every node of every fixture. It is the answer to "why is this row here?" in devtools, and it is also the handle tests grab.

| Namespace   | Sits on                 | Values you will see                                                                                                |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `section:`  | a section               | `section:top`, `section:group`, `section:channels`, `section:dms`, `section:addons`                                |
| `top:`      | a door in the top items | `top:threads`, `top:directory`                                                                                     |
| `group:`    | a row in your section   | `group:member`                                                                                                     |
| `channels:` | a Channels row          | `channels:channel`                                                                                                 |
| `dms:`      | a Direct messages row   | `dms:agent`, `dms:pinned-agent`, `dms:conversation` (people or several agents), `dms:message-someone`, `dms:empty` |
| `addons:`   | an Add-ons row          | `addons:page`                                                                                                      |

`addons` rows target `{ kind: 'add-on' }` and carry a `page-icon` glyph the renderer resolves from the extension registry, because the model holds no components (spec `mini-app-placement` Part 2). They are never dragged, pinned, muted or unread, and the section is a `computed` drop target, so a row dropped on it is refused with a sentence. `useSidebarState` feeds the pages in as `SidebarState.addOns` and, on an `/x/…` address, sets `activeTarget` to the deepest listed page that holds it (`listedPageAt`), so exactly one row is current. Two listed pages with one title stay two rows: each gets `primary` = extension id and `secondary` = title, so it reads `flow › Settings`. Inside a space, `SidebarSections` replaces the panel with the space's channels but still draws this one section below them, and Alt-click there folds only it.

A hand-made section's **id** is `group:<groupId>` — a raw id, so it is not reason-shaped. Its **reason** is `section:group`. The `group` spelling is the STORED one: what a person reads says "section" everywhere (D3), and `ui.sidebar.groups` is not renamed because it is persisted.

### How the rules compose

`buildSidebarModel` is one call: `buildSections(state)`. Each rule decides one thing, and a rule that needs another rule's answer takes it as an argument instead of reaching for it. `buildSections` builds the lookup maps once (`byPath`, `rooms`, the mute index, the agents' direct messages), works out which agents and rooms are filed into a hand-made section, and then emits the sections in their fixed order.

`rules/targets.ts` is the exception to "one rule per file". It holds the spellings every rule shares — `rowKey` and `sameTarget`.

### The units, which are not all the same

Getting one of these wrong fails silently: an unparseable time reads as "never", so a section sorted by recent activity quietly falls back to key order and nothing throws.

| Field                             | Unit                          |
| --------------------------------- | ----------------------------- |
| `state.now`                       | epoch milliseconds            |
| `AgentRosterEntry.lastActivityAt` | epoch milliseconds, or `null` |
| `RoomSummary.lastActivityAt`      | **ISO-8601 string**           |

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
import { indexAgentDms } from './agent-direct-messages';

// ✅ Take the answer as an argument, or move the shared question to targets.ts.
export function myRule(rows: readonly SidebarRowModel[], dms: AgentDmIndex) { … }
```

```typescript
// ❌ Editing a shared fixture so your test passes. Several tasks read these.
busyFixture.rooms = [];

// ✅ Build the variant locally with a spread.
const state = { ...busyFixture, rooms: [] };
```

```typescript
// ❌ A reason the format check rejects, and a reader cannot decode.
reason: 'row',              // no namespace
reason: 'dms:Agent',        // uppercase
reason: `group:${group.id}` // a raw id, not a rule name

// ✅ <namespace>:<rule>, lowercase and hyphens.
reason: 'dms:agent',
```

## Adding a Rule

1. **Name the contract first.** Find the ticket or BC number your rule implements (`specs/sidebar-now-today-library/02-specification.md` §B for the older ones). If there is no contract, you are changing behaviour that was decided elsewhere — settle that before writing code.

2. **Create one file for one decision**: `model/rules/<verb>-<noun>.ts`, matching the existing names (`apply-mute-rules`, `derive-unread-signal`, `roll-up-collapsed-section`). Open it with a module docblock that says what it decides and cites the BC.

3. **Take what you need as arguments.** A selector takes `state`. A transformer takes `(rows, state)`. Never import a sibling rule to ask it a question — if two rules need the same answer, it belongs in `rules/targets.ts`.

   ```typescript
   /**
    * System agents sink to the bottom of a section (BC-nn — put the
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

4. **Obey the two purity limits.** Value imports may only be relative siblings or an entry on the whitelist (`ALLOWED_VALUE_IMPORTS`); anything else must be `import type`. Read time only from `state.now` — the only legal `Date` shapes are `new Date(<argument>)` and `Date.parse(`. The whitelist itself lives in `build-sidebar-model.contracts.test.ts`, which also asserts that leaf really imports nothing.

5. **Stamp a `reason`** on every node you create, matching `/^[a-z-]+:[a-z-]+$/`. Reuse an existing namespace from the table above unless your rule genuinely introduces a new kind of provenance.

6. **Compose it inside `buildSections`**, which is the only place the sections' intermediate lists exist. If the position in the pipeline carries meaning, say so in a comment there.

7. **Write the table test**: `sections-rules.test.ts` for what a section holds, `add-on-rules.test.ts` for Add-ons, or `derive-rules.test.ts` for the small shared derivations. Test the rule directly with literals, and assert the end-to-end effect through `buildSidebarModel` on a fixture.

8. **Verify**, in this order:

   ```bash
   pnpm vitest run apps/client/src/layers/features/dashboard-sidebar/model
   pnpm --filter @dorkos/client lint
   pnpm --filter @dorkos/client typecheck
   ```

   The contract suite runs against your new file automatically — it reads the `rules/` directory rather than a list — so a purity slip reds immediately, and so does a malformed `reason`.

## Adding a Fixture

The four journey fixtures (`first-run`, `quiet`, `busy`, `power`) are a deliverable, not test scaffolding. The same four drive three things: the model's table tests, the Dev Playground's `SidebarModelShowcases`, and the browser spec `apps/e2e/tests/dashboard-sidebar/sidebar-model-showcase.spec.ts`. So what a reviewer looks at and what CI asserts are the same states, by construction — build any new surface against these rather than seeding a fresh state beside them.

**Most of the time you do not want a new fixture — you want a variant.** Build it locally with a spread (`{ ...busyFixture, rooms: [] }`). The shared files are read by several tasks at once, and editing one turns your tweak into somebody else's failing expectation.

Add a fifth journey only when it is a genuinely different stage of the product, not a variation on an existing one. Then:

1. **Create `model/fixtures/<name>.ts`** and build it from `emptyState()` plus the factories, so it stays complete when `SidebarState` grows a field:

   ```typescript
   import type { SidebarState } from '../sidebar-state';
   import { agent, emptyState, FIXTURE_NOW, HOUR } from './factories';

   const TANGERINE = '/Users/dev/code/tangerine';

   /** An operator returning after a week away — everything is stale. */
   export const dormantFixture: SidebarState = emptyState({
     agents: [agent(TANGERINE, { lastActivityAt: FIXTURE_NOW - 9 * 24 * HOUR })],
     displayNames: { [TANGERINE]: 'tangerine' },
   });
   ```

   Use `hoursAgo()` for the ISO-8601 fields and `FIXTURE_NOW - n * HOUR` for the epoch-millisecond ones — check the units table above before you type either.

2. **Export it from `model/fixtures/index.ts`**, and add it to `SIDEBAR_FIXTURES` with the name a showcase or a test will print.

3. **Run the contract suite.** Everything in `build-sidebar-model.contracts.test.ts` walks `SIDEBAR_FIXTURES`, so your fixture is covered by every "for every fixture" assertion the moment it is in that array — no test edits required:

   ```bash
   pnpm vitest run apps/client/src/layers/features/dashboard-sidebar/model/__tests__/build-sidebar-model.contracts.test.ts
   ```

4. **It appears in the Dev Playground on its own**, so a journey can be looked at and not only asserted on. `SidebarModelShowcases` (`apps/client/src/dev/showcases/SidebarModelShowcases.tsx`, at `/dev/sidebar-model`) iterates `SIDEBAR_FIXTURES`, so a fifth entry there draws a fifth panel with no edit to the page. Check it in both themes; the browser spec's expectations are per-fixture tables that a new journey needs a row in.

Note that `FIXTURE_NOW` is a **local** instant (09:15 on 9 August 2026), not a fixed UTC epoch, so a time-dependent rule reads the same in every office.

## Troubleshooting

### `value-imports only whitelisted modules` fails

**Cause**: a pure module imports a value from somewhere outside the whitelist. Usually a store, a hook, or a helper that pulls one in.
**Fix**: if you only need the shape, make it `import type`. If you need the value, move the work out of the model — the assembly hook computes it and passes it in on `SidebarState`.

### `reads no clock it was not given` fails

**Cause**: a `Date` use that is not `new Date(<argument>)` or `Date.parse(`, or a reference to `performance`, `Math.random`, or `Intl`.
**Fix**: take the instant from `state.now`. `Intl` is banned here, and `toISOString()` answers in UTC, which would put a local boundary in the middle of somebody's evening.

### `every section and row carries a well-formed reason` fails

**Cause**: a `reason` with no colon, two colons, uppercase, or an interpolated id.
**Fix**: `<namespace>:<rule>`, both halves lowercase with hyphens. Ids belong in `key` and `id`, never in `reason`.

### An agent shows up twice

**Cause**: a new code path drew an agent row without asking whether it is already filed. Direct messages skips every agent in a hand-made section (`groupedAgents` in `build-sections.ts`), and the agent's own direct message is folded into its row rather than drawn as a room (`agentPathOf`).
**Fix**: route the new row through `directMessageRows` or `groupSection`, never beside them. `sections-rules.test.ts` holds the one-row-per-agent cases.

### The panel scrolled when nothing was opened

**Cause**: `useScrollToActive` gained a dependency beyond the anchor's key. It has exactly one on purpose: a verb, an unread change or a whole model rebuild must move nothing (BC-36).
**Fix**: keep the effect keyed on `anchorKey` alone, and keep the mount-time latch that stops arriving on a page from counting as a switch.

### The build-budget test fails

**Cause**: `build-sidebar-model.performance.test.ts` asserts the whole panel builds for a 32-agent fleet in under 5ms. A rule that sorts inside a loop, or rebuilds a `Map` per row, will cross it.
**Fix**: build lookup maps once at the top of the rule, as `buildSections` does with `byPath` and `rooms`.

## Related

- `contributing/design-system.md` — the sidebar's width, inset, tint ramp and accessibility contract
- `contributing/project-structure.md` and `.claude/rules/fsd-layers.md` — the layer rules that put the model inside the feature that renders it rather than in a slice of its own
- `contributing/state-management.md` — choosing between Zustand and TanStack Query for the sources that will feed `SidebarState`
- `specs/sidebar-now-today-library/02-specification.md` — the BC-numbered contracts each rule cites
- `specs/sidebar-now-today-library/design-decisions.md` — the locked decisions behind them
