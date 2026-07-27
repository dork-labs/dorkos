# Ideation: Sidebar groups hold anything, not just agents

**id** 260727-115434 · **epic** DOR-578 · **created** 2026-07-27

## The ask

> "Slack has sections, we call them groups. In Slack you can organize DMs, channels, apps, etc. into sections. I'd like to do something similar with our groups. I'd like to be able to organize all of the items that appear in the left sidebar into our groups."

## What is actually there

More than the framing suggests. Groups are not a thin feature to be widened — they already carry four capabilities, and every one of them has to survive:

|                                               | Where                                                   |
| --------------------------------------------- | ------------------------------------------------------- |
| Manual groups with a hand-ordered membership  | `SidebarGroupSchema.agentPaths`, `sortMode: 'manual'`   |
| **Smart groups** with rule-derived membership | `SmartGroupRulesSchema`, `evaluateSmartGroup` (DOR-338) |
| Per-group display filter and mute             | `displayFilter`, `muted` (DOR-339)                      |
| Drag and drop, as a pure reducer              | `use-sidebar-dnd.ts` (DOR-329)                          |

The drag layer being a **pure reducer** — `classifySidebarDrop` names the operation, `applySidebarDropOp` applies it, `buildSidebarAnnouncements` derives the ARIA from the same descriptors — is what makes this tractable at all. The semantics are unit-testable without synthetic pointer events, so the risky part of a generalisation is testable without a browser.

## The actual obstacle

`SidebarPrefs` keys three separate things on an agent's `projectPath`, as a bare `string`:

```ts
pinned: z.array(z.string()); // :252
groups: [{ agentPaths: z.array(z.string()) }]; // :196
muted: z.array(z.string()); // :268
```

A room has no `projectPath`. It has a ULID. So there is nowhere to put one.

## Why this is more urgent than it looks

**R6b (DOR-572) is queued to add room mute.** As specified, that means a second, room-only muted list keyed on room id, sitting beside an agent-only one keyed on path. Two mute concepts, and unifying them later costs a _second_ config migration on top of this one — the exact "tolerated legacy pattern" AGENTS.md forbids.

Generalising `muted` here makes room mute fall out for free. **This has to land before DOR-572**, which reorders the room programme.

## The shape

A discriminated union, not a prefixed string:

```ts
type SidebarItemRef = { kind: 'agent'; path: string } | { kind: 'room'; roomId: string };
```

`"agent:<path>"` is tempting because migration becomes a one-line `map`. Two things kill it. `.claude/rules/conventions.md` bans stringly-typed code as a hard no. And an agent `projectPath` can legally contain a colon on macOS and Linux, so the scheme needs a parse-on-**first**-colon rule that reads fine and breaks on the one path that has one.

## Open questions, and where they land

**Do sessions belong in groups?** The ask says "all of the items that appear in the left sidebar", and Recent holds sessions.

Recommendation: **not in v1**. Sessions are numerous, short-lived and already ordered by recency; a hand-curated group of them goes stale within a day, and Slack — the model being asked for — does not group threads either. The union is precisely what makes `kind: 'session'` a later addition rather than a redesign, so deferring costs almost nothing and shipping it costs a curation surface nobody has asked to maintain. Recorded here rather than silently narrowed, because it is a real reading of the ask.

**Can a room go in a smart group?** No, and it is not a limitation to apologise for. Every rule in `SmartGroupRulesSchema` — `runtimes`, `namespaces`, `statuses`, `lastActiveWithinMs`, `pathPrefix` — is an agent attribute. A room satisfies none, so a smart group holding rooms would need a second, disjoint rule vocabulary, which is a feature and not a generalisation. Rooms go in manual groups.

The interaction is already modelled: `SidebarDropOp` carries a `smart-group-target` kind whose apply is a deliberate no-op so the UI can show a hint rather than silently swallow the drop. A room dropped on a smart group reuses that path exactly.

**What happens to the Channels and Direct messages sections?** Slack's rule: an item lives in exactly one place. A channel dragged into a group leaves the Channels section, the way an agent in a group already leaves Agents. Pinned stays multi-presence — that is deliberate today and the schema says so at `:251`.

## Risk

The retype from `string[]` to `SidebarItemRef[]` is the whole risk, and it is a **good** risk: a discriminated union has no structural identity, so every `includes`, `indexOf`, `filter` and `===` on these arrays stops compiling. The compiler enumerates the blast radius rather than leaving a silent behaviour change. The dangerous version of this change would have been adding `roomIds` beside `agentPaths`, where nothing breaks and manual ordering quietly has two lists and no defined interleaving.

The migration is the other risk, and it is genuinely low: every stored string today _is_ an agent path, so the mapping is total and unambiguous. There is no data that could be misread.
