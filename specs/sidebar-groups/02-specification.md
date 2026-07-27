# Specification: Sidebar groups hold anything, not just agents

**id** 260727-115434 · **epic** DOR-578 · **phases** DOR-579 / DOR-580 / DOR-581
**Ideation** [`01-ideation.md`](01-ideation.md)

Slack-style sections, generalised from the agent-only groups DorkOS already ships. Channels and DMs become organisable alongside agents, without losing smart groups, display filters, per-group mute, or drag and drop.

---

## 1. Schema

### 1.1 The member reference

```ts
export const SidebarItemRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), path: z.string().min(1) }),
  z.object({ kind: z.literal('room'), roomId: z.string().min(1) }),
]);
export type SidebarItemRef = z.infer<typeof SidebarItemRefSchema>;
```

A discriminated union rather than a `"agent:<path>"` string, for the two reasons in §Ideation: the stringly-typed ban in `.claude/rules/conventions.md`, and colons being legal in POSIX paths.

Ships with an equality helper next to the schema, because a union has no structural identity and every membership test needs one:

```ts
export function sameSidebarItem(a: SidebarItemRef, b: SidebarItemRef): boolean;
```

Do **not** reach for `JSON.stringify` comparison — key order is not guaranteed across the code paths that construct these.

### 1.2 What changes in `SidebarPrefs`

| Field                 | Was        | Becomes                            |
| --------------------- | ---------- | ---------------------------------- |
| `groups[].agentPaths` | `string[]` | `groups[].items: SidebarItemRef[]` |
| `pinned`              | `string[]` | `SidebarItemRef[]`                 |
| `muted`               | `string[]` | `SidebarItemRef[]`                 |

`agentPaths` is **renamed, not kept alongside**. A parallel `roomIds` array would leave manual ordering with two lists and no defined interleaving, and would compile silently — the opposite of what we want. Every other field on `SidebarPrefs` and `SidebarGroupSchema` is unchanged.

`SmartGroupRulesSchema` is unchanged. `evaluateSmartGroup` keeps returning `string[]` of agent paths; its caller wraps them into refs. Pushing the union down into the evaluator would spread agent-shaped rules across a type that cannot satisfy them.

### 1.3 Migration

**Compose a new idempotent backfill into the existing `'0.57.0'` block** in `config-manager.ts:1161`. Do not add a `'0.58.0'` key.

An earlier draft of this section said `'0.58.0'`, reasoning that `'0.57.0'` already existed and shipped migrations must never be edited. That reasoning was wrong in a way that loses data, so it is worth stating rather than quietly fixing:

- `'0.57.0'` is **not shipped**. `0.56.0` is the tagged version, and the comment above that block states the convention outright — DOR-452, DOR-501, DOR-516 and DOR-525 all target "the next unreleased version" and compose into one key in insertion order, because an object literal cannot repeat a key. `/system:release` reconciles the key at tag time if the real release number differs.
- A migration keyed `'0.58.0'` **would not run on 0.57.0**, which is the release that would carry this schema. `conf` only runs migrations where `key > storedVersion && key <= projectVersion`. So every existing user would launch 0.57.0 with a schema expecting `items`, find it absent, take the Zod default of `[]`, and **silently lose every group membership they had** — with the source data still sitting in an `agentPaths` key nothing reads.

The rule that matters is therefore not "never edit a migration" but **"key it to the version that actually ships the code"**. Editing a _shipped_ migration is what is forbidden; extending the next unreleased one is the established convention here.

The body maps each stored string to `{ kind: 'agent', path }` across all three fields. The mapping is total and unambiguous — every string in these arrays today _is_ an agent path — so there is no data that could be misread and no ambiguous case to decide.

Guard it against absent and already-migrated data. A fresh install, a user upgrading with groups, and a re-run must all be safe, because the composite block runs as one unit and its siblings are each independently idempotent.

**It must also `delete` the old `agentPaths` key rather than leaving it beside `items`.** Found empirically while implementing: the generated JSON Schema emits `additionalProperties: false` on each group object, so a leftover key hard-fails `conf`'s post-migration validation. "Leave the old key, it is harmless" is the intuitive choice here and it is the one that breaks.

### 1.4 Correctness must not depend on the migration running

The migration being right is not enough, and this was the most serious defect the programme produced. Found in review of S1:

**A skipped migration destroys the entire config file, not just the sidebar.** This is the first change here that is a _rename/retype_ rather than an additive backfill. Every prior sibling degraded safely — skip it, Zod defaults fill in, nothing breaks. This one leaves a stored shape that the new schema rejects, so `new Conf(...)` throws, and `ConfigManager`'s corrupt-recovery branch backs the file up and **replaces it with defaults**. Observed on a real boot: `telemetry.userHasDecided` went `true → false` and `install`/`heartbeat` went `false → true` — **a privacy opt-out silently reverted to opt-in**, with `mesh.scanRoots`, `approvals`, `runtimes`, `cloud` and `onboarding` reset alongside. Tracked as DOR-584 and DOR-585.

Two triggers, both live: **dev trees run no migrations at all** (`SERVER_VERSION` falls back to `0.0.0`, and `conf` runs a key only when `key <= projectVersion`), and **a patch release** (`0.56.1`) skips the key for every user.

Three facts that shape the fix, each verified rather than assumed:

- **All three lists are independently fatal**, not just `agentPaths`. `pinned: ['/a']` alone condemns the file, because those fields changed element _type_. A fix that tolerates only the renamed key closes one hole of three.
- **Ajv is the only validator on the read path.** `ConfigManager.getAll()` returns `this.store.store` raw; nothing runs Zod over a stored object. So a Zod `.preprocess` cannot rescue a file Ajv has already rejected — and `z.toJSONSchema` emits a pipe's **output** schema, so a preprocess would not widen what Ajv sees even if it did run.
- **`conf` builds Ajv with `useDefaults`, and Zod marks a defaulted field `required`.** So Ajv _writes in_ `items: []` before any read-time conversion can look for `agentPaths`, and the conversion then correctly prefers the present-but-empty field. Tolerance must drop both the `default` and the `required` entry, or the two encodings are not distinguishable at all.

So the tolerance goes in **`z.toJSONSchema`'s `override` hook**, not in the Zod schema. Widening `pinned` to `(string | SidebarItemRef)[]` in the schema would widen the exported type and destroy the compiler-enumerates-the-blast-radius property that makes this whole refactor safe. The override keeps exported types strict, keeps the legacy encoding out of the operator disclosure walker and the OpenAPI export, and confines the back-compat surface to one deletable function.

The read-time conversion (`normalizeSidebarPrefs`) is applied where `ui.sidebar` is first interpreted semantically, returns its input unchanged when already canonical, and holds identity stable via a `WeakMap` keyed on the stored object — every consumer memoizes on `prefs.pinned` / `prefs.groups`.

**Both are back-compat for exactly one release** and say so, with the removal trigger named (DOR-588).

**The reason none of this was visible:** all nine migration tests go through `createMockStore`, so not one crosses the `conf`/Ajv seam where the irreversible failure lives. `UserConfigSchema.parse` cannot substitute — **Zod strips unknown keys where Ajv rejects them** — so the test literally named _"produces a shape the schema accepts verbatim"_ stays green under a mutation that deliberately leaves the legacy key behind. **Any future migration that renames or retypes needs a real-`ConfigManager` test**, and `contributing/configuration.md` now says so.

### Beyond the config file

A schema change of this shape is not only a migration. `CONFIG_DISCLOSURE` and `CONFIG_WRITE_POLICY` (`apps/server/src/services/core/operator/`) carry a drift guard that fails the build until **every** schema leaf has a verdict, and the union turns three leaf paths into nine (`kind` / `path` / `roomId` across three lists). The disclosure test's dot-path reader also has to descend _every_ array element rather than element zero — with a union, an exposed path lives in some element, not all of them.

---

## 2. The pure layer

### 2.1 Prefs helpers

`entities/config/model/use-sidebar-prefs.ts` exports **27 helpers**, of which those taking a `path: string` take a `ref: SidebarItemRef` instead: `pinPath`, `unpinPath`, `moveToGroup`, `mutePath`, `unmutePath`. Rename them off `…Path` — `pinItem`, `muteItem` — since the name is now wrong.

`reorderWithinGroup(groupId, from, to)` and `reorderPinned(from, to)` are **index-based and keep their signatures** — only their bodies retype. An earlier draft listed them among the path-takers; that was wrong. `convertSmartGroupToManual` does change, though the earlier draft missed it: its `currentMembers` parameter becomes `SidebarItemRef[]`, and `GroupHeader` wraps `evaluateSmartGroup`'s paths at the call site, which is where §1.2 says the wrapping belongs.

The retype is the safety mechanism. Every `includes`, `indexOf`, `filter` and `===` against these arrays stops compiling, so the compiler enumerates the blast radius rather than leaving a silent behaviour change. Fix each with `sameSidebarItem`; do not reintroduce a string key to make the errors go away.

### 2.2 The drag reducer

`use-sidebar-dnd.ts` is a pure reducer whose exported entry points are `classifySidebarDrop`, `resolveSidebarDrop` and `buildSidebarAnnouncements`, plus the node-data converters. Their descriptors carry `path: string`; they carry a `SidebarItemRef` instead. `AgentContainer` becomes `SidebarContainer` (`pinned` / `group` / `ungrouped`), unchanged in shape.

`applySidebarDropOp` is **module-private** and stays that way — an earlier draft called it an exported entry point. Exporting it to match a spec sentence would add public surface with no caller, which `knip` would flag as dead.

Two things must not regress:

- **The announcements are derived from the same descriptors**, which is what stops spoken feedback drifting from what the reducer did. Keep that; announcements now have to name a room as well as an agent, and "moved to Ship" must say _what_ moved.
- **`reject-smart-group`** already exists as a deliberate no-op op so the UI can hint instead of silently swallowing a drop. A room dropped on a smart group resolves to it unchanged — this is reuse, not a new case. (An earlier draft called it `smart-group-target`; that name is not in the code.)

---

## 3. The item view model

One shape, two producers. This is what the whole feature rests on: sort, filter and mute operate on it, never on the underlying entity.

```ts
interface SidebarItem {
  ref: SidebarItemRef;
  name: string; // agent display name | roomDisplayTitle(room)
  lastActiveAt: number | null;
  needsAttention: boolean;
  muted: boolean;
}
```

Mappings:

|                  | Agent           | Room               |
| ---------------- | --------------- | ------------------ |
| `name`           | display name    | `roomDisplayTitle` |
| `lastActiveAt`   | last activity   | `lastActivityAt`   |
| `needsAttention` | attention state | `unreadCount > 0`  |

`unreadCount` is `null` for a non-member, which is "not applicable" and not zero — collapsing the two would mark every room the operator has looked at. The existing `hasUnread` helper already encodes this; use it rather than re-deriving.

**FSD placement matters.** The producers read `entities/agent` and `entities/room`, which may not import each other. The view model therefore lives at the **feature** layer (`features/dashboard-sidebar/model/`), where both entities are legal imports — the same constraint that produced the duplicate avatar system in the rooms work (`specs/rooms/02-specification.md` §12.2). Do not solve it by moving room code into the agent entity.

---

## 4. Rendering

- Group bodies dispatch on `ref.kind` to the existing `AgentListItem` or `RoomRow`. Neither is forked.
- Sort modes over the union: `manual` reads the ordered `items` array; `name` compares `SidebarItem.name`; `recent` compares `lastActiveAt`, with `null` sorting last.
- `displayFilter` (`all` / `active-recently` / `needs-attention`) reads the view model, so it works for rooms with no new code.
- **Channels and Direct messages show only _ungrouped_ rooms**, matching how Agents already shows only ungrouped agents. An item lives in exactly one section.
- Pinned stays multi-presence.

**Empty states are a real trap here.** A Channels section that is empty _because everything is in groups_ must not say "No channels yet — create one to get a few agents talking in the same place." That copy is correct for a fresh install and a lie for an organised one. The same applies to Direct messages and Agents.

---

## 5. Phasing

| Phase            | Deliverable                                                                                                            | Depends on |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| **S1** (DOR-579) | `SidebarItemRef`, the `'0.57.0'` migration, prefs helpers and the drag reducer retyped. **No visible change.**         | —          |
| **S2** (DOR-580) | The view model, mixed group rendering, sorts and filters over the union, default sections showing only ungrouped items | S1         |
| **S3** (DOR-581) | Rooms draggable into groups, "Move to group ▸" in the room menu, room mute through the generalised list                | S2         |

S1 shipping with **no visible change** is deliberate: agents-only behaviour must be byte-identical afterwards, so any regression shows up as agent behaviour drifting rather than hiding behind new UI nobody has a baseline for.

### Interaction with the rooms programme

**DOR-572 (R6b) now depends on S3.** Its room context menu needs "Move to group ▸", and its mute must be the generalised one. Building R6b first means a second room-only mute list and a second migration to unify them later. The room programme reorders: R6a → S1 → S2 → S3 → R6b → R9.

---

## 6. Testing

- The prefs helpers and the drag reducer are pure and already unit-tested without synthetic pointer events. Keep it that way — this is why the generalisation is tractable at all.
- **The migration needs a test with real prior-shape data**, asserting all three fields convert and that a second run is a no-op. Migrations are the one thing that cannot be fixed forward for a user who has already run them.
- Mixed-group ordering needs a test where an agent and a room tie on `lastActiveAt`, with a deterministic tiebreak. The rooms work has already been bitten once by an unstable sort over tied rows (`specs/rooms/02-specification.md` §12.2 fix round).
- **S3 requires browser verification, not jsdom.** Drag-and-drop geometry and menu→inline-editor focus are both invisible to jsdom, and this repo has already shipped a Radix menu focus race that only a browser could see.
