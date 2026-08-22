# Sidebar simplification — what shipped

**Spec:** `specs/sidebar-simplification` · **Umbrella:** DOR-1365 · **Close-out:** DOR-1376
**Shipped:** 2026-08-19 → 2026-08-22, eleven pull requests, all merged to `main`.

The panel that was three levels deep, listed every agent forever, showed the same agent twice, and
piled four cards at the bottom is now two levels, one header grammar, one door per agent, one card,
and it paints in a single frame from a cache. This file records what landed, where it differs from
the specification, and what was deliberately left.

## Wave by wave

| Wave | Task                         | PR    | What it did                                                                                                                                                                                                                           |
| ---- | ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —    | Docs + spec                  | #1132 | The specification, `design-decisions.md`, the task decomposition, and the three extracted ADRs.                                                                                                                                       |
| 0    | 0.2 — verbs (DOR-1367)       | #1133 | "Chat with X", "Message" and the palette's "Message Ana" became "Open session with X" / "Open session" / "Open conversation with Ana". All three already opened what they open; only the words lied.                                  |
| 0    | 0.1 — dead fields (DOR-1366) | #1134 | Dead glyph kinds and five unused `SidebarRowModel` fields removed with their producers; `liveCount` returned as the one model-provided count; `ConversationSurface` `'dm'` deleted; the second `buildSidebarItems` index removed.     |
| 1    | 1.2 — bottom slot (DOR-1369) | #1137 | One arbiter, one card, one slot pinned above the footer strip. Every card gained an ×, and dismissal moved from `localStorage` to `ui.promos.dismissedIds` on the account. "Use DorkOS on the go" gained a real trigger.              |
| 1    | 1.1 — two levels (DOR-1368)  | #1143 | The zone label / section header / row three-step collapsed to one header style and one indent, driven by `--sidebar-header-x` and `--sidebar-row-x`. Every header folds, including Heads up and Today. "Library" left the screen.     |
| 2    | 2.1 — one door (DOR-1370)    | #1159 | An agent appears once. The agent row is the only door to its conversation; the picker opens a session for one agent and a group message for two or more; a group's title follows its roster (DOR-772).                                |
| 2    | 2.2 — sections (DOR-1371)    | #1164 | "Group" became "section" in every string a person reads; sections render as peers at the top of the list and hold anything. The Show filter and Recent sort became real, Mute left smart sections, and Agents became recent + pinned. |
| 3    | 3.1 — boot gate (DOR-1372)   | #1172 | One boot gate, one skeleton, one reveal. Agent faces resolve before first paint (DOR-1143); the config query collapsed to one key; scroll-to-active latches at settle instead of chasing.                                             |
| 4    | 4.2 — perf (DOR-1375)        | #1176 | `RoomRow` memoized, the six mutation hooks moved behind the row menu, prefs reads collapsed onto one context subscription. `model/sidebar-item.ts` shrank from 333 lines to 96.                                                       |
| 3    | 3.2 — warm boot (DOR-1373)   | #1179 | The sidebar paints from a persisted TanStack Query cache in the first frame, keyed to the server origin, dropped on sign-out, version change and after a day. Attention state is deliberately never persisted.                        |
| 4    | 4.1 — motion (DOR-1374)      | #1181 | Folds spring, arriving rows slide and flash once, reordering lists slide, drags lift and settle. Nothing loops; reduced motion turns all of it off, exits included.                                                                   |

## Deviations from the specification

Each of these differs from what §D said, and each was a decision made against evidence during the
wave rather than a slip.

1. **DOR-1105 was overstated, and the record is corrected.** The specification's context paragraph
   and `research/20260819_sidebar-simplification-review.md` both said four roll-up rows were
   pressable and inert. Only `section-count` ("N inactive") was. `now-overflow`, `working` and
   `automated` already navigated or toggled on `main` before the programme (`SidebarChrome.tsx:339-352`,
   PRs #922/#942). Wave 0 verified those three rather than building them; wave 4 replaced the one
   inert row with `All N agents →`. Corrected in place on 2026-08-22 with dated notes, not rewritten.

2. **§D8(e)'s slow/fast model split was evaluated and rejected** (#1176). Splitting
   `buildSidebarModel` into a slow structural pass and a fast activity pass was measured against the
   memoization it would replace and did not pay: the row-level `React.memo` plus the menu-deferred
   hooks already removed the re-render cost the split was aimed at, and the split would have bought
   a second source of truth for the same tree. The rejection is recorded rather than silently skipped.

3. **Cache persistence is opt-in, because the e2e suite boots a cold world** (#1179). The spec
   assumed the persister could simply be on. The browser suite starts every spec against an empty
   profile, so an always-on persister makes the first spec in a shard race a cache that is not there
   yet. The persister is therefore enabled by explicit opt-in, which keeps production warm and keeps
   the suite deterministic.

4. **The boot gate widened from the specified membership to 10 members** (#1172). The spec named a
   smaller truth table; the honest gate needed every read the first paint draws from, and stopping
   short of any one of them reintroduced the pop-in the wave existed to remove.

5. **Today gained a suppressed-DM-with-unread clause** (#1159). Collapsing the duplicate DM row into
   the agent row would otherwise have made an unread hand-made 1:1 invisible in Today. The clause
   keeps such a conversation surfacing there even though its standing row is gone.

6. **BC-26, BC-38 and BC-49 were retired outright** rather than amended. Origin marks (BC-26) and the
   project chip (BC-38) had no consumer once the dead row fields went (#1134); the welcome-back glow
   (BC-49) was fully built and wired to nothing, so wave 3 removed it instead of wiring it up.

7. **The sync-restore claim was corrected by a production probe** (#1179). The design assumed
   TanStack Query's restore was synchronous enough to paint from. It is not, in the shape the spec
   described; the implementation was changed to match the measured behaviour rather than the
   assumption.

## Accepted gaps

Known, deliberate, and not defects to be filed as regressions.

- **An untouched agent-initiated 1:1 DM has no Today row.** Existing Today rules only admit what you
  touched. The signals that cover it are the dot on the agent's row and the notification Inbox
  (DOR-1388, which landed alongside). Changing this needs a Today-rule decision of its own.
- **A section title does not re-derive when a member is REMOVED.** Only `addMember` re-derives, per
  the specification. Removing an agent from a group message leaves the title as it was.
- **The Obsidian embed persists neither dismissals nor the boot cache.** `updateConfig` is a no-op
  there, so a dismissed card unions a session-local set with the server list instead of writing
  through, and the embed boots cold every time.

## Follow-up tickets

Filed at close-out; none blocks this programme.

- **DOR-1415** — `agent-columns.tsx`: `onNavigate` and `onStartSession` are identical, and
  `onStartSession`'s TSDoc says "start" where it resumes.
- **DOR-1416** — Align `SessionSwitcher`'s "Live now" grouping onto the live chip's definition
  (chip counts streaming; the list counts open, blocked included). Kept split deliberately for now.
- **DOR-1417** — Delete or codemod the 41 remaining partial `vi.mock('motion/react')` shadows in
  client specs; each one shadows the complete `test-setup.ts` mock and breaks an arbitrary subset at
  collection when a new import edge reaches gen-ui.
- **DOR-1418** — Nested-interactive axe violation (serious): dnd-kit's `div[role=button]` wraps the
  real row button. Pre-existing on agent rows, widened to channel and section rows by wave 2.
- **DOR-1419** — Isolate the four sidebar browser specs. Run concurrently against one server they
  cross-contaminate; one spec's channel was dragged into another's section.
- **DOR-1420** — `TeamPage.tsx:78-90` renders an empty grid transiently during the restore pause
  (`isLoading` false while data is undefined) — the same shape wave 3 fixed in onboarding.
- **DOR-1421** — Guard against `tsc -b` in `apps/client` emitting 11k+ `.js` files beside sources;
  Vite and vitest then resolve the stale `.js` ahead of the `.tsx`.
- **DOR-1422** — `apps/e2e/manifest.json` source mapping is coarser than the files it names after
  wave 0 (also DOR-654's stale path).
- **Product media re-capture is still outstanding.** A full `capture --shards 3` run on 2026-08-22
  recorded 33 of 34 raws, including both desktop sidebar assets (`multi-session-light.png` and
  `multi-session-dark.webm`), but `mobile-sessions-light` failed its drive:
  `page.waitForSelector('[data-testid="app-shell"]')` timed out after 20s at mobile width.
  `assertPublishedSetComplete` then aborted the process phase, so nothing was published and the
  working tree was restored. Worth noting for whoever picks this up: `mobile-approval` and
  `mobile-chat` both captured cleanly on other shards, so mobile rendering is not broadly broken —
  it is the mobile SIDEBAR surface specifically, which is also the surface wave 3 changed most.
  Wave 3.2 made the shell wait for real settings before deciding whether to show the first-run
  wizard, so a timing regression in when `app-shell` becomes visible is the first hypothesis to
  test.

## Decisions extracted

Three ADRs, all accepted 2026-08-22:

- `260819-210151` — The agent row is the one door to an agent; one agent opens a session, two or
  more open a group message. Implemented by #1159.
- `260819-210153` — One bottom-slot arbiter chooses among the sidebar's cards; dismissal lives in
  user config, not localStorage. Implemented by #1137.
- `260819-210154` — The sidebar boots from a persisted query cache, gated by one boot state and one
  reveal. Implemented by #1172 and #1179.

## Documentation touched

`docs/concepts/sidebar.mdx` (rewritten against the shipped panel), `docs/guides/sidebar-settings.mdx`
(group → section, the honest Show filter, the short Agents list), `docs/concepts/rooms.mdx` (the one-door
paragraph, wave 2), `contributing/design-system.md` (the two inset tokens; `--sidebar-nested-x`
removed with its last consumer), `contributing/sidebar-model.md` and `contributing/configuration.md`.

Amended specs: `sidebar-now-today-library` (BC-1/2 fold, BC-26/38/49 retired, BC-28/30/32/34/45
amended, R3), `sidebar-groups` and `smart-agent-groups` (the section rename), `rooms` (§8.5 resolved,
§14.4's `cwd` correction).
