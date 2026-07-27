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

| Field                 | Was        | Becomes                              |
| --------------------- | ---------- | ------------------------------------ |
| `groups[].agentPaths` | `string[]` | `groups[].members: SidebarItemRef[]` |
| `pinned`              | `string[]` | `SidebarItemRef[]`                   |
| `muted`               | `string[]` | `SidebarItemRef[]`                   |

`agentPaths` is **renamed, not kept alongside**. A parallel `roomIds` array would leave manual ordering with two lists and no defined interleaving, and would compile silently — the opposite of what we want. Every other field on `SidebarPrefs` and `SidebarGroupSchema` is unchanged.

`SmartGroupRulesSchema` is unchanged. `evaluateSmartGroup` keeps returning `string[]` of agent paths; its caller wraps them into refs. Pushing the union down into the evaluator would spread agent-shaped rules across a type that cannot satisfy them.

### 1.3 Migration

Key **`'0.58.0'`**. The package is at `0.56.0` and an unreleased `'0.57.0'` migration already exists, so a separate key runs both in order for anyone upgrading across the boundary. Never edit a shipped migration (`contributing/configuration.md`).

The body maps each stored string to `{ kind: 'agent', path }` across all three fields. The mapping is total and unambiguous — every string in these arrays today _is_ an agent path — so there is no data that could be misread and no ambiguous case to decide.

Guard the body against absent or already-migrated data: a user who skipped the release and one who is fresh-installing both reach it, and it must be idempotent in both directions.

---

## 2. The pure layer

### 2.1 Prefs helpers

`entities/config/model/use-sidebar-prefs.ts` exports **27 helpers**, of which those taking a `path: string` take a `ref: SidebarItemRef` instead: `pinPath`, `unpinPath`, `moveToGroup`, `reorderWithinGroup`, `reorderPinned`, `mutePath`, `unmutePath`. Rename them off `…Path` — `pinItem`, `muteItem` — since the name is now wrong.

The retype is the safety mechanism. Every `includes`, `indexOf`, `filter` and `===` against these arrays stops compiling, so the compiler enumerates the blast radius rather than leaving a silent behaviour change. Fix each with `sameSidebarItem`; do not reintroduce a string key to make the errors go away.

### 2.2 The drag reducer

`use-sidebar-dnd.ts` is a pure reducer with three exported entry points — `classifySidebarDrop`, `applySidebarDropOp`, `buildSidebarAnnouncements` — and its descriptors carry `path: string`. They carry a `SidebarItemRef` instead. `AgentContainer` becomes `SidebarContainer` (`pinned` / `group` / `ungrouped`), unchanged in shape.

Two things must not regress:

- **The announcements are derived from the same descriptors**, which is what stops spoken feedback drifting from what the reducer did. Keep that; announcements now have to name a room as well as an agent, and "moved to Ship" must say _what_ moved.
- **`smart-group-target`** already exists as a deliberate no-op op so the UI can hint instead of silently swallowing a drop. A room dropped on a smart group resolves to it unchanged — this is reuse, not a new case.

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
- Sort modes over the union: `manual` reads the ordered `members` array; `name` compares `SidebarItem.name`; `recent` compares `lastActiveAt`, with `null` sorting last.
- `displayFilter` (`all` / `active-recently` / `needs-attention`) reads the view model, so it works for rooms with no new code.
- **Channels and Direct messages show only _ungrouped_ rooms**, matching how Agents already shows only ungrouped agents. An item lives in exactly one section.
- Pinned stays multi-presence.

**Empty states are a real trap here.** A Channels section that is empty _because everything is in groups_ must not say "No channels yet — create one to get a few agents talking in the same place." That copy is correct for a fresh install and a lie for an organised one. The same applies to Direct messages and Agents.

---

## 5. Phasing

| Phase            | Deliverable                                                                                                            | Depends on |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| **S1** (DOR-579) | `SidebarItemRef`, the `'0.58.0'` migration, prefs helpers and the drag reducer retyped. **No visible change.**         | —          |
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
