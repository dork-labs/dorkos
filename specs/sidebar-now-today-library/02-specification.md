---
slug: sidebar-now-today-library
id: 260809-143358
created: 2026-08-09
status: specified
design-session: .dork/visual-companion/19627-1786276365 + .dork/visual-companion/9729-1786282982
---

# Sidebar redesign: Now / Today / Library

**Status:** Approved (design decisions locked 2026-08-09; the four open items of §17 are resolved in this document)
**Author:** Claude (design session with Dorian, 2026-08-09; specified 2026-08-09)
**Date:** 2026-08-09
**Tracker:** DOR-1048

## Overview

Reorganize the cockpit sidebar from a type-organized list (nav, Jump Back In, Channels, DMs,
groups, Agents, footer) into three time-and-urgency **zones** — **Now**, **Today**,
**Library** — plus **Getting started**, which is Now's day-one life stage in the same slot.
Behind the pixels, the whole panel becomes a **pure model**: one function
`buildSidebarModel(state) → SidebarModel` decides every zone, row, order, cap, rollup and
badge, and every row it emits carries a `reason` string saying why it is there. Components
render that model and hold no rules. Three row implementations and two duplicated section
headers collapse into two shared primitives, `SidebarRow` and `SectionHeader`.

The authoritative decision record is [design-decisions.md](design-decisions.md) (18 sections).
This document formalizes it into something buildable and does not contradict it; where
interpretation was required, the section is cited inline. The visual rules come from
[`research/20260809_design-meta-2026-learnings.md`](../../research/20260809_design-meta-2026-learnings.md).
The mockups in [`mockups/`](mockups/README.md) communicate direction only — where a mockup and
`design-decisions.md` disagree, the doc wins.

## Background / Problem Statement

The sidebar answers "what exists" when the operator's question is "where am I needed."
On top of that it has accumulated a list of concrete defects, audited 2026-08-09 and
tabulated in the design-meta report: a 30px stacked left inset (12 + 8 + 10), hairline
`border-b`/`border-t` region separators, always-visible `+` and decorative chevrons,
horizontal meatball menus in a `pr-7` gutter, ALL-CAPS letterspaced section labels, three
row implementations whose recents never say whose session they are, create actions scattered
across three menus, a footer spending three rows on branding, and two near-duplicate section
header components.

The structural problem is worse than the cosmetic one. `DashboardSidebar.tsx` is 875 lines of
orchestration in which the rules live inside JSX — which sections exist, what is pinned, what
counts as recent, when the groups hint shows. There is nowhere to ask "why is this row here?"
and nowhere to unit-test the answer.

## Goals

- Reorganize around **Now / Today / Library** so the first thing on screen is what needs the
  operator, the second is what they were doing, and the third is the stable structure they
  built themselves (design-decisions §2).
- Make the sidebar's rules a **pure, tested, single-source model** with per-row provenance
  (§12), so the panel can be reasoned about and shown in the Dev Playground without a server.
- Collapse three row implementations and two header components into **one `SidebarRow` and
  one `SectionHeader`** encoding the row grammar once (§3, design-meta rules 3–5).
- **Never reorder the user's structure**: prediction is additive (Now/Today), manual structure
  (Library: pins, channels, DMs, agents, groups) stays exactly where it was put (design-meta
  rule 6).
- One honest **activity verb ladder** and one **avatar signal system** across sidebar, session
  switcher, ⌘K and the chat status strip (§5, §6).
- Turn ⌘K into a real front door for **recall** — sessions become first-class, ranking is
  blended, scope is expressed as chips (§15).
- Make mobile **a different app** — four tabs, no drawer, no hover (§9, design-meta rule 10).
- Preserve every capability the current sidebar has: dual-rendered menus, server-persisted
  prefs, smart groups, mobile auto-close semantics, accessible drag-and-drop, the
  `sidebar.body` extension takeover.

## Non-Goals

- **No workspace UI, and the word is not used.** Per §16, six concepts share the word
  "workspace"; the sidebar and ⌘K use **"project"** for the repo/cwd dimension and add no
  workspace surface. `/workspaces`' fate belongs to `specs/agent-workspace-binding`, not here.
  The header block introduced in §7 is a _switcher-in-waiting_ — one row today, more rows when
  communities ship — not a workspace manager.
- **No message-content search in ⌘K.** ⌘K finds things, not words (§15). The ⌘K/⌘F split
  recorded in `specs/rooms/02-specification.md` and `specs/message-search` stands; ⌘K's
  hand-off row points at the message-search surface and nothing more.
- **No onboarding tour.** Explicitly cut in §1 and §10 — the user count does not justify it.
  Relearning cost is accepted deliberately while the product is in beta.
- **Obsidian `EmbedSidebar` is unchanged this programme (explicit deferral).**
  `features/session-list/ui/EmbedSidebar.tsx` is a single-view roster rendered through
  `DirectTransport` in a 300px Obsidian leaf, on a surface that bypasses the router entirely.
  Rationale for deferring: (a) three of the four zones depend on router state (active route,
  deep links, `?prompt`/`seed` params) that embedded mode does not have; (b) the mobile and
  desktop zone work is the launch-critical surface and the plugin is a staged, under-tested
  surface (AGENTS.md product state); (c) the shared primitives this programme extracts
  (`SidebarRow`, `SectionHeader`, `row-grammar`, `status-dot`, `identity-glyphs`) all land in
  `layers/shared/`, so the embed can adopt them later with no rework of this design. What this
  programme owes the embed: **do not break it**. `EmbedSidebar` keeps compiling and its tests
  keep passing; any primitive it adopts is opt-in. A follow-up work item ("EmbedSidebar adopts
  the shared row primitives") is filed at DECOMPOSE, not built here.
- **No new grouping model.** Smart groups, manual groups and their rules ship as they are,
  re-homed into Library. Row-level project context does not become a grouping dimension (§17
  resolution R4).
- **No snooze** (§18) and no per-signal settings knobs. Now clears by resolution.
- **No community/multi-tenant rows** — the switcher menu is shaped to accept them, and that is
  the whole commitment.

## Technical Dependencies

All internal. No new external libraries; `dnd-kit`, `motion`, `cmdk`, `fuse.js` are already
in the client.

**Landed or landing phase-0 capabilities this spec builds on** (branch names as of
2026-08-09; each is a prerequisite for the phase noted):

| Capability                                                             | Real API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Needed by                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Fleet-stream activity label (`feat/activity-label`, DOR-1053)          | `SessionActivity { toolName: string; target?: string }` in `packages/shared/src/session-stream.ts`, optional `SessionStatus.activity`; derived by `deriveSessionActivity(toolName, input)` in `apps/server/src/services/session/activity/derive-activity.ts`; set on `tool_call`, deleted on `turn_start`/`turn_end`/`error`/interrupt; new-activity fan-out throttled by `ACTIVITY_FANOUT_THROTTLE_MS = 2_000` (clears are immediate). Client: `useSessionActivity(sessionId)` / `selectSessionActivity(state, id)` from `@/layers/entities/session`. | P1 (types), P2 (verbs)                      |
| Seed context + prompt deep link (`feat/session-seed-prompt`, DOR-1054) | `/session` search params `prompt?: string`, `send?: '1'`, both stripped after consumption via `handleLaunchConsumed`; `SendMessageRequestSchema.seedContext` (`≤ SEED_CONTEXT_MAX_LENGTH = 10_000`) on `POST /api/sessions/:id/messages`; context kind `'seed_context'` (`packages/shared/src/additional-context.ts`) rendered by `formatSeedContext` in `apps/server/src/services/runtimes/shared/seed-context-block.ts`; `Transport.postMessage(..., { seedContext })`.                                                                              | P2 (Ask DorkBot)                            |
| Unified title derivation (`fix/title-derivation`, DOR-1055)            | `deriveSessionTitle(firstUserMessage)` in `apps/server/src/services/runtimes/shared/derive-title.ts`, `MAX_WORDS = 6`, used as the fallback-title path by all four session registries.                                                                                                                                                                                                                                                                                                                                                                 | P1 (truncation budget assumes short titles) |
| Avatar signal cleanup (`fix/avatar-signal-cleanup`, DOR-1052)          | `IdentityStatus = 'idle' \| 'working' \| 'needs-you' \| 'error'` and `StatusSignal`, `STATUS_DOT_COLOR`, `STATUS_DOT_PULSE = 'motion-safe:animate-pulse'`, `statusDotClass()` in `apps/client/src/layers/shared/ui/status-dot.ts`; `AGENT_GLYPH` / `platformGlyph(platform)` in `shared/ui/identity-glyphs.ts`; `IdentityAvatar`/`AgentAvatar`/`AgentIdentity` take `status?: IdentityStatus` (the `working` boolean and `healthStatus` ring are gone; health moved to `features/mesh/lib/health-display.ts`).                                         | P1 (primitives), P2                         |
| Palette quick wins (`fix/palette-quick-wins`, DOR-1051)                | `handleCommandSelect` / `handleSessionSelect` in `command-palette/model/use-palette-actions.ts`; `registerPaletteCommandHandler` / `unregisterPaletteCommandHandler` (`model/palette-command-handlers.ts`); `useCommands(activeCwd, sessionId, runtime)`; `useRooms({ includeArchived })` + `roomKeys.listWithArchived()`; `compareRoomsForPalette` archived ranking.                                                                                                                                                                                  | P3                                          |

**Existing machinery reused unchanged:** `SidebarPrefsSchema` + `normalizeSidebarPrefs`
(`packages/shared/src/config-schema.ts`); `useSidebarPrefs` / `useUpdateSidebarPrefs` and its
whole-section-replace + pending-head batching (`entities/config/model/use-sidebar-prefs.ts`);
`mergeJumpBackIn` / `MAX_JUMP_BACK_IN` (`entities/recents/lib/jump-back-in.ts`);
`classifySidebarDrop` / `resolveSidebarDrop` / `buildSidebarAnnouncements`
(`dashboard-sidebar/model/use-sidebar-dnd.ts`); `evaluate-smart-group.ts` and
`smart-group-presets.ts`; `useMenuCloseFocusGuard`; `SidebarMobileNavigationClose`
(`shared/ui/sidebar.tsx`); `useSidebarSlot()` in `AppShell.tsx` for `sidebar.body` takeovers;
`GET /api/sessions/recent`; the read cursors from DOR-1030; `ResponsiveDialog` /
`ResponsiveDropdownMenu` (`contributing/design-system.md` §Responsive Components); the conf
migration ladder in `apps/server/src/services/core/config-manager.ts` (`CONFIG_MIGRATIONS`).

---

## Detailed Design

### A. Architecture

#### A1. The pure model layer

**Placement (FSD justification).** `buildSidebarModel` and its rules live in
`apps/client/src/layers/features/dashboard-sidebar/model/`, **not** a new feature slice.
`.claude/rules/fsd-layers.md` forbids model/hook cross-imports between sibling features, so a
separate `features/sidebar-model` slice would be unimportable by `features/dashboard-sidebar`
— the only place that renders it. Widgets may import features, so the P4 mobile tabs widget
reaches the same model legally. The pieces that genuinely have more than one consumer are
pushed **down**, not sideways:

| Piece                                                                                                           | Home                                                  | Why                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildSidebarModel` + rules + fixtures                                                                          | `features/dashboard-sidebar/model/`                   | one renderer; widgets may import it                                                                                                                                                                                                                                                              |
| `SidebarRow`, `SectionHeader` primitives                                                                        | `layers/shared/ui/`                                   | ⌘K rows and the session switcher reuse them without a feature→feature import; they take `ReactNode` slots so `shared/` never imports `entities/`                                                                                                                                                 |
| `row-grammar.ts` (label composition, truncation budget), `activity-verb.ts` (the ladder), origin-glyph registry | `layers/shared/lib/` + `shared/ui/identity-glyphs.ts` | used by sidebar, session switcher, ⌘K, chat status strip                                                                                                                                                                                                                                         |
| `AttentionSignal` normalization (`useAttentionSignals`)                                                         | new `layers/entities/attention/`                      | today's sources live in sibling features (`features/approvals/model/use-pending-approvals.ts`, `features/dashboard-attention/model/use-attention-items.ts`) which the sidebar may not import; lifting the normalization to an entity is the correct fix and de-duplicates the home triage header |

**Signature.** One exported function, pure, synchronous, no hooks, no `Date.now()`, no
`Intl` with an implicit timezone:

```ts
/** Build the entire sidebar from a snapshot of application state. Pure. */
export function buildSidebarModel(state: SidebarState): SidebarModel;
```

Inside, one small named TSDoc'd function per rule, composed — a convention, not a framework.
A rules DSL, a config engine and a state-machine library were all explicitly rejected (§12).
Named rules (each independently unit-tested):
`selectNowItems`, `rankNowItems`, `capNowItems`, `buildWorkingRollup`, `buildGettingStarted`,
`selectTodayItems`, `orderToday`, `pinActiveAnchor`, `archiveOvernight`, `buildDigestRow`,
`buildLibrarySections`, `rollUpCollapsedSection`, `applyMuteRules`, `deriveUnreadSignal`,
`deriveProjectLabel`, `deriveRowStatus`.

**Types.** One zone type, one section type, and **one row shape** for every row in the panel
— a needs-you item, a channel, a rollup, a suggestion and the digest are all `SidebarRowModel`.
What differs is the `target` discriminant, which is what a click means.

```ts
export type SidebarZoneId = 'getting-started' | 'now' | 'today' | 'library';

/** What clicking a row does. The only discriminated union in the model. */
export type SidebarTarget =
  | { kind: 'session'; sessionId: string; agentPath: string; cwd: string | null }
  | { kind: 'room'; roomId: string; roomKind: 'channel' | 'dm' | 'thread' }
  | { kind: 'agent'; path: string }
  | { kind: 'attention'; signalId: string; deepLink: string }
  | { kind: 'rollup'; rollup: 'now-overflow' | 'working' | 'automated' | 'section-count' }
  | { kind: 'suggestion'; suggestionId: SuggestionId }
  | { kind: 'digest' }
  | { kind: 'command'; commandId: SidebarCommandId };

export interface SidebarRowModel {
  /** Stable React key and test handle: `${target.kind}:${id}`. */
  key: string;
  target: SidebarTarget;
  /** Fixed 18px leading slot. The glyph carries the type; row chrome never does. */
  glyph:
    | { kind: 'agent-avatar'; agentPath: string }
    | { kind: 'person-avatar'; memberId: string }
    | { kind: 'face-stack'; memberIds: string[] }
    | { kind: 'hash' }
    | { kind: 'icon'; icon: SidebarIconId };
  /** The "who": agent name, room name, person name. Never a title. */
  primary: string;
  /** The "what", rendered after `›`. Present iff this row is a session. */
  secondary?: string;
  /** Avatar corner dot. Derived from lifecycle, never from a verb. */
  status: IdentityStatus;
  /** True when the row reserves a second line for a live verb (see BC-24). */
  reservesVerbLine: boolean;
  /** One-line preview when there is one worth showing and no verb line. */
  preview?: string;
  /** Trailing origin mark; absent = human↔agent chat. */
  origin?: SessionOriginMark;
  unread: { tier: 'none' | 'activity' | 'directed'; count?: number };
  /** "N live" chip on an agent row with concurrent sessions. */
  liveCount?: number;
  /** Repo/project chip. Present only under BC-38. */
  projectLabel?: string;
  /** Now-only. Drives priority and the dismiss affordance. */
  attention?: { kind: NowKind; since: string; dismissible: boolean };
  muted: boolean;
  /** False for every row outside Library (BC-35). */
  draggable: boolean;
  /** Menu node ids, dual-rendered into context menu and kebab. */
  actions: SidebarActionId[];
  /** Provenance. Answers "why is this row here?" in devtools, always. */
  reason: string;
}

export interface SidebarSectionModel {
  id: SidebarSectionId;
  /** `null` = headerless body (Now and Today each have exactly one). */
  label: string | null;
  collapsible: boolean;
  collapsed: boolean;
  /** Signal that survives folding (BC-31). */
  rollup?: { unread: SidebarRowModel['unread']; workingCount: number };
  options?: { sortMode?: 'manual' | 'name' | 'recent'; displayFilter?: SidebarDisplayFilter };
  rows: SidebarRowModel[];
  /** One indent level, max (design-meta micro-convention). */
  subsections?: SidebarSectionModel[];
  reason: string;
}

export interface SidebarZoneModel {
  id: SidebarZoneId;
  label: string;
  sections: SidebarSectionModel[];
  /** Visually-hidden text for the zone's polite live region. Now only. */
  liveRegionText?: string;
  reason: string;
}

/** A zone with nothing to say is absent from `zones` — never an empty box (BC-1). */
export interface SidebarModel {
  zones: SidebarZoneModel[];
}
```

**`reason` is mandatory and non-empty** on every zone, section and row. Format
`'<namespace>:<rule>'`, e.g. `'now:permission-prompt'`, `'anchor:active-session'`,
`'today:interaction-recency'`, `'library:pinned'`, `'suggestion:agents-found'`,
`'rollup:working'`. A lint-level test asserts every emitted node has a `reason` matching
`/^[a-z-]+:[a-z-]+$/`.

**The model never contains verb text.** `SessionActivity` churns (throttled to 2s per session,
server-side) and putting it in the model would recompute the whole tree on every tool call.
Rows carry `reservesVerbLine` (derived from lifecycle: is a turn streaming) and the leaf
`SidebarRow` subscribes to `useSessionActivity(sessionId)` itself. Layout stability comes from
lifecycle; text comes from activity. This is the single most important performance decision in
the design (see Risks R1).

#### A2. The state assembly hook

One place gathers everything; nothing else in the sidebar calls a data hook.

```ts
/** Gathers every input `buildSidebarModel` needs. The only data-fetching hook in the feature. */
export function useSidebarState(): SidebarState;
```

`SidebarState` fields and their sources:

| Field                                                               | Source                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `now: number`                                                       | `useNowTick(60_000)` — one coarse clock, so relative times and the overnight boundary are testable inputs |
| `sessions: Session[]`, `workingSessionIds: string[]`                | `entities/session` (`useRecentSessions`, session-list store lifecycle)                                    |
| `sessionStatuses: Record<string, SessionLifecycle>`                 | session-list store — **lifecycle only**, never `activity`                                                 |
| `rooms: RoomSummary[]`, `threads: ThreadSummary[]`                  | `entities/room`                                                                                           |
| `agents: AgentRosterEntry[]`, `displayNames: Record<string,string>` | `entities/agent` + `entities/mesh` (`disambiguateDisplayNames` kept)                                      |
| `attention: AttentionSignal[]`                                      | new `entities/attention` (`useAttentionSignals`)                                                          |
| `recents: JumpBackInModel`                                          | `entities/recents` (`useJumpBackIn`)                                                                      |
| `prefs: SidebarPrefs`                                               | `entities/config` (`useSidebarPrefs`)                                                                     |
| `interactions: Record<string, string>`                              | unified frecency/interaction store (A4)                                                                   |
| `activeTarget: SidebarTarget \| null`                               | router state                                                                                              |
| `journey: JourneyFacts`                                             | discovery results, roster size, first-session flag, #team post count                                      |
| `digest: DigestState`                                               | `prefs.digest` + welcome-back data (team-room-home D5.2)                                                  |
| `projects: { activeCount: number; byCwd: Record<string,string> }`   | derived from sessions' `cwd`                                                                              |

`useSidebarState` returns a referentially stable object via `useMemo` over its inputs;
`buildSidebarModel` is called once in `useSidebarModel()` (`useMemo(() => buildSidebarModel(state), [state])`).

#### A3. Rendering components are pure model consumers

```
DashboardSidebar (orchestrator, target < 200 lines)
├── SidebarHeaderBlock        (workspace switcher-in-waiting, New button, ⌘K pill) — persistent chrome
├── SidebarZones              (maps model.zones → SidebarZone)
│   └── SidebarZone           (landmark; maps sections → SidebarSection)
│       └── SidebarSection    (SectionHeader + rows; one indent level for subsections)
│           └── SidebarRow    (shared primitive; subscribes to its own verb + avatar status)
└── SidebarFooterStrip        (destinations + Ask DorkBot + transient update pill) — persistent chrome
```

No component in this tree computes membership, order, caps or badges. The only per-row state a
component owns is transient interaction state (menu open, inline rename buffer, hover).

#### A4. The two shared primitives

`layers/shared/ui/sidebar-row.tsx` — `SidebarRow`. Encodes design-meta rules 3–5 once:
fixed 18px glyph slot, label line built by `row-grammar`, trailing meta slot, hover/
focus-visible vertical kebab in a narrow gutter, optional second line. Props take `ReactNode`
slots (`glyph`, `trailing`) so `shared/` never imports `entities/`. Menus are passed as a
node list and rendered into both a `ContextMenu` and a `DropdownMenu` — the pattern
`SectionHeaderMenuItems` already uses, now the only implementation of it.

`layers/shared/ui/section-header.tsx` — `SectionHeader`. Replaces **both**
`SidebarSectionHeader` and `GroupHeader`. Sentence-case 12px medium muted label; the section's
identity icon morphs into a collapse chevron on hover/focus (design-meta rule 4); the whole row
is the toggle; Alt/Option-click toggles every section; collapsed rollups render in the trailing
slot; the same dual-rendered node list as rows; `useMenuCloseFocusGuard` armed once, here,
instead of at four call sites. `GroupHeader`'s inline rename editor, delete confirmation and
smart-group rule dialog move in as _slot content_ passed by the Library section, not as
copies.

**Deleted by the consolidation:** `SidebarSectionHeader.tsx`, `GroupHeader.tsx` (its private
`GroupMenuSlots` / `CONTEXT_SLOTS` / `DROPDOWN_SLOTS` pattern goes with it),
`JumpBackInRow.tsx` (`JumpBackInSessionRow`, `JumpBackInRoomRow`, `JumpBackInRowShell`),
`AgentListItem.tsx`'s inline session panel (the component becomes a `SidebarRow` call site),
`RoomRow.tsx`'s and `ThreadRow.tsx`'s bespoke chrome (their menu models survive as node
builders). No dead code is left behind — every deletion happens in the phase that lands its
replacement.

#### A5. What is explicitly KEPT

Dual-rendered menus (one node list → context menu + kebab, now one implementation);
server-persisted prefs via `useUpdateSidebarPrefs` including its optimistic write and pending-head
batching; smart groups (rules, presets, evaluation, the "membership is rule-based" rejection
toast); mobile navigation auto-close (`SidebarMobileNavigationClose`) until P4 replaces the
drawer; accessible drag-and-drop (`KeyboardSensor`, `buildSidebarAnnouncements`, the
cancel/return announcements verbatim); the `sidebar.body` extension takeover;
`disambiguateDisplayNames`; the legacy `dorkos-pinned-agents` localStorage migration effect
(it stays until removed by its own deprecation clock, unchanged here).

---

### B. Behavioral contracts

Each contract is stated so a test can fail. Fixture names refer to the four journey fixtures
(`first-run`, `quiet`, `busy`, `power`) defined in P1.

#### Zones

- **BC-1 — Empty is absent.** `buildSidebarModel` emits no zone whose sections are all empty,
  and no section with zero rows (unless the section is collapsed and carries a rollup). An
  empty box is never rendered. (§2)
- **BC-2 — Zones never collapse.** `SidebarZoneModel` has no `collapsed` field and
  `SidebarZone` renders no toggle. Only sections inside Library are collapsible. (§2,
  design-meta micro-convention)
- **BC-3 — Zone order is fixed**: `getting-started | now` (they share one slot), then `today`,
  then `library`. Order never varies with content.
- **BC-4 — One slot for Now and Getting started.** If `selectNowItems` returns any row, the
  `now` zone renders and `getting-started` is suppressed for that build. Getting started only
  appears when Now is empty. (Interpretation of §2's "same engine, same slot", reconciled with
  §8's day-one flow.)

#### Now

- **BC-5 — Membership.** Only four things enter Now: permission prompts, agent questions,
  wedged/error sessions, idle-timeout nudges. Mentions, DMs, unread channels, automated-session
  activity and update-ready notices are excluded by construction — the model has no branch that
  can put them there. (§18, §7)
- **BC-6 — Priority.** Sorted by tier: `permission-prompt` → `question` → `error` →
  `idle-timeout`; within a tier, oldest `since` first.
- **BC-7 — Cap 3 + overflow.** At most 3 attention rows render. When more exist, a single
  `{ kind: 'rollup', rollup: 'now-overflow' }` row reads "+ N more" and navigates to the home
  surface triage header (`/`, the "Waiting on you" group from `specs/team-room-home`
  §D3.3) — the full list already lives there, so Now never grows a second list.
- **BC-8 — Now never scrolls.** Max 3 attention rows + 1 overflow row + 1 working rollup = 5
  rows, a fixed ceiling. (§2)
- **BC-9 — Working rollup.** When ≥1 session is streaming, one row reads "N working" and opens
  the session switcher scoped to live sessions — never N pulsing rows. **Exception:** when the
  only working session is the active conversation, the rollup is suppressed, because the anchor
  already shows it live and Now must not restate where the user already is. (Interpretation,
  reasoned from §4's rule that the anchor is deliberately not a Now item.)
- **BC-10 — Idle nudges are dismissible, permanently for that episode.** Dismissal is stored in
  an in-memory Zustand store keyed by episode id, **not** persisted config: an episode id does
  not survive a restart meaningfully, and persisting it would accumulate garbage in
  `~/.dork/config.json` forever. A restart may re-surface at most one nudge. (Interpretation
  of §18's "dismissal is permanent for that idle episode".)
- **BC-11 — Live region.** `liveRegionText` is set only when the _count_ of needs-you rows
  changes ("2 agents need you"), never when a verb changes.

#### Getting started

- **BC-12 — Computed, never a checklist.** Suggestions and their satisfaction predicates:

  | id                         | Shown when                                          | Retires when                            |
  | -------------------------- | --------------------------------------------------- | --------------------------------------- |
  | `suggestion:agents-found`  | discovery found ≥1 unregistered agent               | any found agent is registered or opened |
  | `suggestion:add-agent`     | discovery found none **and** roster is DorkBot only | roster gains a non-system agent         |
  | `suggestion:first-session` | ≥1 non-system agent, zero sessions ever             | first session exists                    |
  | `suggestion:say-hi-team`   | #team has no message authored by the user           | user posts in #team                     |
  | `suggestion:ask-dorkbot`   | always, until used                                  | a DorkBot session exists                |

  `suggestion:agents-found` and `suggestion:add-agent` are mutually exclusive — the latter is a
  fallback only (§8).

- **BC-13 — Retirement is permanent.** A satisfied suggestion is appended to
  `prefs.gettingStarted.retired[]` and never returns, even if the predicate becomes false again
  (an agent is deleted, a session is cleaned up).
- **BC-14 — The zone disappears when all suggestions are retired** and never comes back.

#### Today

- **BC-15 — Membership.** Sessions (conversations), channels, DMs and threads the user has
  interacted with, minus muted targets (§18), minus automated sessions (BC-19), minus
  overnight-archived rows (BC-18). Threads appear as conversation rows carrying a thread origin
  mark (§2).
- **BC-16 — Ordering is user-interaction recency, never agent activity.** The order key is
  `lastInteractionAt = max(userLastMessageAt, userLastOpenedAt)`. `userLastOpenedAt` is the
  client-side interaction store (A4/§15's unified frecency store, key `type:id`) and is always
  available; `userLastMessageAt` comes from the server where available (room read cursors from
  DOR-1030; session summaries). A `session_status` event, a tool call, or an agent post changes
  no row's position — asserted by a test that fires 100 activity events at the `busy` fixture
  and diffs the row key order (must be identical).
- **BC-17 — Reorder deferral.** Even a legitimate reorder is withheld while the pointer is
  inside the Today zone or a Today row holds focus; the pending order applies on pointer-leave
  or blur. Rows must never move under a cursor that is about to click. (Interpretation of §2's
  "rows must not jump while watched".)
- **BC-18 — Overnight archival.** A row leaves Today when `lastInteractionAt` is older than the
  most recent 04:00 local boundary that has passed, **unless** it is the anchor or carries a
  tier-2 (directed) unread. Archived rows remain findable in ⌘K by title and recency (§15) —
  archival is a Today-visibility rule and deletes nothing.
- **BC-19 — Automated sessions never claim a top-level row.** They sit behind a
  `{ rollup: 'automated' }` reveal row ("+ N automated"), origin-marked, using the existing
  `partitionSessionsByOrigin` split. If an automated session needs the user, it enters Now like
  anything else. (§4)
- **BC-20 — Soft cap ~8** visible rows before the automated reveal, matching
  `MAX_JUMP_BACK_IN = 8`. The anchor and any tier-2 unread row are exempt from the cap.
- **BC-21 — The active-conversation anchor.** The open conversation is always Today's first
  row (`reason: 'anchor:active-session'`), pinned while open, carrying live status. It is
  never placed in Now. (§4)
- **BC-22 — Morning digest.** One row ("While you were away…") at the top of Today _below_ the
  anchor, at most once per local day: shown when `prefs.digest.lastShownDate !== todayLocal`
  **and** there is real content (work that finished during the absence, per team-room-home
  D5.2 data — never invented). It dissolves when the user opens any conversation, and
  `lastShownDate` is written the moment it renders, so it is once per day per account, not per
  device.

#### Row grammar

- **BC-23 — One template**: `[glyph] [who] [› title] [trailing]`. Row chrome never varies by
  type; the glyph carries the type. Sessions always carry attribution (`Agent › title`); the
  `›` is the session marker and its absence means "the place, not a thread of it". The same
  agent with several sessions produces several rows, name repeated on purpose. (§3)
- **BC-24 — Two-line rows only when they earn it.** A second line renders only when the row
  has a live verb (`reservesVerbLine`) or a preview worth showing. Height differences carry
  meaning.
- **BC-25 — Truncation budget, CSS-first.** The `who` span is `max-width: 42%` of the text line
  with `text-overflow: ellipsis`; the title is `flex: 1 1 auto; min-width: 6ch`; the trailing
  meta slot is `flex: 0 0 auto` and is never pushed off. No JavaScript measurement — the budget
  is deterministic, cheap and browser-testable via computed style. The full `Agent › Title` is
  the row's `title` attribute and tooltip.
- **BC-26 — Origin marks** are a small muted trailing glyph, never on the avatar: none =
  human↔agent chat, timer = task/scheduled, paper plane = bridged/external, `#` = room-triggered,
  arrows = agent-to-agent. One registry (`shared/ui/identity-glyphs.ts`, extended with
  `ORIGIN_GLYPH`) serves Today, the session switcher, "+N automated", ⌘K and Activity, so they
  cannot drift. (§3, §6)
- **BC-27 — Overflow menu is a vertical kebab (⋮)**, hover/focus-revealed, in a narrow gutter.
  Horizontal meatballs are gone from the sidebar. (design-meta rule 3)

#### Library

- **BC-28 — Sections and order**: Pins, Channels, Direct messages, Agents. Groups (manual and
  smart) are sub-headers **inside** Agents, one indent level (14px). No deeper nesting exists in
  the type — `SidebarSectionModel.subsections` never contains subsections of its own, asserted
  by a test.
- **BC-29 — Click anywhere on the section row toggles.** Destinations are always leaf rows, so
  select-vs-expand is never ambiguous. (§2, click-confirmed)
- **BC-30 — Alt/Option-click** on a section header (or its chevron) collapses/expands **all**
  Library sections.
- **BC-31 — Collapsed sections keep signal.** `rollup.unread.count` = the sum of member tier-2
  counts; `rollup.unread.tier` is `'activity'` when any member is tier-1 and none is tier-2;
  `rollup.workingCount` = members currently streaming. Signal is never lost by folding.
- **BC-32 — Chrome appears by data volume, not settings.** No Direct messages section until a
  DM exists; no Pins section until something is pinned; group affordances (create group, the
  groups hint) appear at ≥8 agents or ≥2 distinct runtimes. No "advanced mode" toggle exists.
  (design-meta rule 8)
- **BC-33 — Dual presence.** A conversation that is both the anchor and a Library member renders
  in both places; the Library copy takes the active tint. This is intentional, not a bug.

#### Interaction

- **BC-34 — Clicking an agent opens its most recent human conversation** (a fresh session if
  none). An agent is a teammate, not a folder. The inline 3-session expansion panel is removed;
  depth moves to the session switcher. (§4)
- **BC-35 — The session switcher** is a `ResponsiveDialog` (dialog on desktop, bottom sheet on
  mobile) reachable from the agent row's "N live" chip, a long-press on mobile, and ⌘K. Groups:
  **Live now** (with verbs; concurrent sessions are simply multiple rows), **Recent** (one-line
  outcomes), **Automated** (collapsed, origin-marked). The current session is tagged. Footer
  hints: `↵` continue, `⌘↵` new, `⇧` fork. Rows use `SidebarRow`.
- **BC-36 — Scroll-to-active.** On conversation switch only, the anchor scrolls into view.
  Guardrails: never auto-expand a collapsed section (the Library copy just takes the active tint
  if visible — BC-33); instant jump under `prefers-reduced-motion`; never scroll while the user
  is reading (no scroll on activity, unread, or model rebuilds — only on `activeTarget` change).
- **BC-37 — The verb ladder.** `activityVerb(lifecycle, activity)` returns, in order: a specific
  verb when a live `SessionActivity` carries a recognizable `toolName` (+ `target`); `"working…"`
  when a turn is streaming and the tool is unknown; `"waiting on you"` when blocked; `null` when
  idle. **Degrade down the ladder, never guess.** The same function feeds the sidebar, the
  session switcher, ⌘K's Continue row and the chat status strip (whose randomized joke verbs are
  deleted — §14.4). (§5)
- **BC-38 — Project context (see R4).** A session row carries `projectLabel` **only** when
  `projects.activeCount > 1`; the label is the basename of the session's `cwd`, rendered as a
  muted trailing chip in the meta slot, never inside the 42% name budget. Rooms and agents never
  carry it. It changes no grouping and no ordering. The word "workspace" appears nowhere. (§16)

#### Notifications (§18, verbatim, made testable)

| Signal                                      | Model output                                                         |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Channel has new messages                    | `unread: { tier: 'activity' }` — bold label + dot. No badge.         |
| Unread DM to you                            | `unread: { tier: 'directed', count }` — numbered amber badge.        |
| @mention of you (any room)                  | `unread: { tier: 'directed', count }` on that row.                   |
| Agent working                               | `status: 'working'` + verb line. `unread` untouched.                 |
| Approval / question / wedged / idle-timeout | A Now row. The only things that enter Now.                           |
| Automated session activity                  | Nothing. No bold, no badge. Blocking states go to Now like the rest. |

- **BC-39 — Mentions and DMs never enter Now.** An agent asking a question inside a DM enters
  Now as a _question_, with `target.kind === 'attention'`, not as a DM.
- **BC-40 — Mute** kills bold, badge and Today eligibility. One exception: @mentions pierce mute
  and still render the numbered badge. Muted rooms stay out of recents (already the
  `isJumpBackInRoom` rule; it carries to Today unchanged).
- **BC-41 — Bold clears on read** through the cross-device read cursors from DOR-1030. The
  sidebar reads cursors; it never writes its own watermark.
- **BC-42 — No snooze in v1.** Now items clear only by resolution or (idle nudges only) by
  dismissal.

#### Chrome

- **BC-43 — The header block** shows the workspace name (`"<Operator>'s team"`, from the profile
  display name) and is a button from day one, opening a menu with Workspace settings, Account,
  and a quiet version line (`"v0.58.0 beta · Check for updates"`). When communities ship they
  become additional rows in this same menu — the menu gets longer, nothing relayouts. (§7)
- **BC-44 — The version number leaves the chrome.** It lives in that menu and in DorkBot's
  seeded context. Update-ready renders as a **transient footer pill** ("Update ready — Restart")
  that exists only while true and never enters Now. (§7)
- **BC-45 — One New button** is the only create surface: Session (`⌘N`; `↵` = last-used agent),
  Channel, Direct message, Agent…, Agent group. A section's hover `+` deep-links into this same
  menu with the relevant item pre-selected. Every other create entry point in the sidebar is
  deleted (`AddAgentMenu`, per-section `+` handlers, the inline group-create trigger keeps its
  inline editor but is reached through New). (§7)
- **BC-46 — The ⌘K pill** ("Jump to anything…") sits under the header.
- **BC-47 — The footer is one slim tinted strip**: destination icons (Home, Team, Marketplace,
  Connections) + Ask DorkBot ✦. No logo block, no version line, no border — separation by tint.
- **BC-48 — Ask DorkBot** opens a fresh DorkBot session pre-seeded with context. Mechanism:
  navigate to `/session` for DorkBot with a new enumerated search param `seed=dorkbot-help`;
  the chat model builds the seed string locally (current page, fleet size, recent errors,
  version) and passes it as `postMessage(..., { seedContext })` on the **first** send only, then
  strips the param exactly as `prompt`/`send` are stripped by `handleLaunchConsumed`. The
  composer stays empty and focused — the seed is a hidden server-side preamble, not typed text.
  (§7 + `feat/session-seed-prompt`)

#### Moments (§10)

- **BC-49 — Welcome-back glow.** A row whose work finished while the user was away glows amber
  once on first paint (`motion-safe` only; nothing under reduced motion). Absence threshold
  reuses team-room-home's `welcomeBack.absenceThresholdMinutes`.
- **BC-50 — The all-clear beat.** When Now's last item resolves, the zone shows "All clear ✓"
  for 2.5s and then folds away. Under `prefers-reduced-motion` the zone simply disappears.
- **BC-51 — No tour.** No tour component, no tour anchors added, no "meet your new sidebar"
  copy anywhere. (§1, §10)

---

### C. Resolutions for the §17 open items

#### R1 — Dark-mode calibration of tint-based separation

**Resolved: reuse the `--sidebar-accent` ramp for every level of separation; introduce no new
color, and never use `--muted` inside the sidebar.**

The measured reason (`apps/client/src/index.css`): `--sidebar` is `0 0% 91%` light and
`0 0% 10%` dark, while `--muted` is `0 0% 96%` light and `0 0% 9%` dark. A zone tinted with
`--muted` is _lighter_ than its panel in light mode and _darker_ in dark mode — the separation
flips direction between themes, which is exactly the calibration failure §17 anticipated.
`--sidebar-accent` is `0 0% 86%` light (−5%) and `0 0% 16%` dark (+6%): it moves away from the
panel in the same perceptual direction in both themes, at the 5–10% delta design-meta rule 2
asks for.

| Level       | Class                                                                      | Both-theme behavior                   |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------- |
| Zone card   | `bg-sidebar-accent/40`                                                     | recessive tint, ~2–3% effective delta |
| Row hover   | `bg-sidebar-accent/70`                                                     | reads on top of the zone tint         |
| Row active  | `bg-sidebar-accent` + `text-sidebar-accent-foreground`                     | the strongest step                    |
| Panel edges | scroll-edge shadow (appears only once content scrolls under header/footer) | replaces `border-b`/`border-t`        |

Status color stays on the existing semantic tokens, which are already calibrated per theme and
are already what `status-dot.ts` uses: `bg-status-success` (working), `bg-status-warning`
(needs-you, directed badges), `bg-status-error` (error/wedged), `bg-status-info` (unseen). No
raw hex, no new `--sidebar-zone-*` variable — one ramp is the point.

**Removed by this resolution:** the `border-b` on `SidebarHeader` (`SidebarNavHeader` renders
`className="border-b p-3"` today), the `border-t` above the footer, and every hairline between
sections.

**Verification (mandatory gate):** the `SidebarModelShowcases` playground page renders all four
journey fixtures, and P1's acceptance requires a **both-themes screenshot pair** captured
through `apps/e2e` (light and dark, same fixture) attached to the PR. A reviewer who cannot see
both screenshots blocks the phase. Contrast of label-on-zone-tint must meet 4.5:1 in both themes
(design-system §Accessibility) — asserted by an axe-core check in the browser test over the
showcase page, which fails on contrast violations rather than being eyeballed.

#### R2 — Accessibility spec

**Resolved as follows; all of it is P1/P2 acceptance criteria, not a later pass.**

- **Landmarks.** The panel root is `<nav aria-label="Sidebar">`. Each zone is
  `<section aria-labelledby="sidebar-zone-{id}">` with a visible `<h2>` label. Library sections
  are `<h3>` containing a `<button aria-expanded aria-controls>`; group sub-headers are `<h4>`.
  Zone labels are headings, never buttons (BC-2).
- **Roving tabindex, per section.** Each section exposes exactly one tab stop — the active row
  if the section contains it, otherwise the first row. `ArrowDown`/`ArrowUp` move within the
  section, `Home`/`End` jump to its ends, `ArrowLeft`/`ArrowRight` on a section header
  collapse/expand. `Tab` moves between sections and zones, so a 60-agent Library is 4 tab stops,
  not 60. Implemented once as `useRovingFocus` in `shared/model`, unit-tested there.
- **Live region.** One visually-hidden `aria-live="polite" aria-atomic="true"` element inside
  the Now zone carries `liveRegionText`. It announces **count changes only** ("2 agents need
  you"), debounced 1s. Verbs, activity and unread changes are never announced — a fleet of
  agents would otherwise turn a screen reader into a siren.
- **Motion.** Only "working" animates. The dot uses the shared
  `STATUS_DOT_PULSE = 'motion-safe:animate-pulse'`; the ping halo carries `motion-reduce:hidden`.
  Scroll-to-active uses `behavior: 'auto'` under `prefers-reduced-motion` (BC-36). The
  welcome-back glow and the all-clear beat do not render at all under reduced motion (BC-49,
  BC-50).
- **Hover-revealed chrome always has two other paths**: `focus-visible` reveals it on the
  keyboard, and on touch it is either always visible or reachable by long-press (design-system
  §Hover Pattern Mobile Alternatives).
- **WCAG 2.5.7 (dragging movements): every drag has a keyboard and pointer alternate.** Reorder,
  pin/unpin and move-to-group are all reachable from the row kebab and the context menu on every
  platform; `KeyboardSensor` + `sortableKeyboardCoordinates` stay wired; the existing
  `buildSidebarAnnouncements` strings (pickup / drag-over / drop / "Movement cancelled. Item
  returned to its place.") are preserved verbatim. A test asserts that for every draggable row,
  the menu node list contains a move action.
- **Color is never the sole indicator.** Every status dot is paired with a verb line, a tooltip
  or an `aria-label`; the unread tiers differ in weight (bold) and shape (dot vs numbered
  badge), not only hue.

#### R3 — Drag-and-drop scope

**Resolved: Library only.**

- Draggable: pins (reorder within Pins), group order, membership moves (agent or room into a
  group), reorder within a manual group, reorder within Agents when `sortMode === 'manual'`.
- **Never draggable: every row in Now, Today and Getting started.** These zones are computed;
  dragging them would be a lie about what the user controls (design-meta rule 6). Enforced in
  the **model** — `buildSidebarModel` sets `draggable: false` on every row whose zone is not
  `library` — not in the UI, so no future call site can re-enable it by accident.
- `classifySidebarDrop` gains one rejection reason for a non-Library container, surfaced with
  the same toast mechanism as the existing smart-group rejection: _"Now and Today are computed —
  pin it to Library to keep it in place."_ The smart-group rejection ("Membership is rule-based —
  edit rules instead.") is unchanged.
- `resolveSidebarDrop` (the pure prefs reducer) and its 36 existing tests survive intact; the
  new rejection adds cases, changes none.
- Mobile keeps drag disabled entirely (`SidebarDnd` already renders children without a
  `DndContext` on mobile); long-press context menus are the only reordering path there, which
  P4 makes explicit rather than accidental.

#### R4 — Project (repo) context in row grammar

**Resolved: secondary-line chip on session rows, only for multi-project operators, sourced from
`cwd`, with no grouping change.**

- A session row carries `projectLabel` **only when `projects.activeCount > 1`** — an operator
  running everything in one repo never sees the chip (progressive disclosure by data volume,
  design-meta rule 8).
- The value is the basename of the session's `cwd` (the `projectKey` dimension §16 says already
  exists). It renders as a muted trailing chip in the meta slot, outside the 42% name budget
  (BC-25), so it can never eat the agent name or the title.
- Rooms, DMs and agent rows never carry it: a room is not in a repo, and an agent's project is a
  property of its sessions.
- **No grouping change this programme.** Project does not become a section, a filter or a sort
  key. §16 is explicit that the naming consolidation belongs to `specs/agent-workspace-binding`;
  shipping a project _grouping_ now would prejudge it.
- The word "workspace" does not appear in any string this programme adds.

---

### D. Prefs migration

Every existing `ui.sidebar` field is accounted for. Nothing is silently dropped, and the two
retirements are data whose meaning no longer exists.

| Existing field              | New home                                             | Migration                                                                                                              |
| --------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pinned: SidebarItemRef[]`  | Library ▸ **Pins** section                           | none — same shape, same semantics                                                                                      |
| `groups: SidebarGroup[]`    | Library ▸ **Agents** ▸ group sub-headers             | none — `SidebarGroupSchema` unchanged (`sortMode`, `collapsed`, `displayFilter`, `muted`, `kind`, `rules` all survive) |
| `ungroupedCollapsed`        | `sections.agents.collapsed`                          | copy                                                                                                                   |
| `channelsCollapsed`         | `sections.channels.collapsed`                        | copy                                                                                                                   |
| `dmsCollapsed`              | `sections.dms.collapsed`                             | copy                                                                                                                   |
| `threadsCollapsed`          | **retired**                                          | threads become Today rows with a thread origin mark (§2); there is no Threads section to collapse                      |
| `recentsCollapsed`          | **retired**                                          | recents become the Today _zone_, and zones never collapse (BC-2)                                                       |
| `ungroupedSortMode`         | `sections.agents.sortMode`                           | copy                                                                                                                   |
| `ungroupedDisplayFilter`    | `sections.agents.displayFilter`                      | copy                                                                                                                   |
| `groupsHintDismissed: true` | `gettingStarted.retired += 'suggestion:groups-hint'` | translate; `false` writes nothing                                                                                      |
| `muted: SidebarItemRef[]`   | unchanged                                            | none — semantics now defined by BC-40 (kills bold, badge, Today eligibility; @mentions pierce)                         |

**New fields** on `SidebarPrefsSchema`:

```ts
sections: z.record(SidebarSectionIdSchema, z.object({
  collapsed: z.boolean().default(false),
  sortMode: z.enum(['manual', 'name', 'recent']).optional(),
  displayFilter: SidebarDisplayFilterSchema.optional(),
})).default({}),
gettingStarted: z.object({ retired: z.array(z.string()).default([]) }).default({ retired: [] }),
digest: z.object({ lastShownDate: z.string().optional() }).default({}),
```

**Not persisted (deliberate):** idle-nudge dismissals (BC-10, in-memory Zustand),
`userLastOpenedAt` interaction timestamps (client-local store, shared with ⌘K frecency — a
per-device notion by definition), scroll position, transient moment state.

**Mechanics.** This is a schema break and therefore requires a **semver-keyed conf migration**
appended to `CONFIG_MIGRATIONS` in `apps/server/src/services/core/config-manager.ts`, following
`contributing/configuration.md` and the `adding-config-fields` skill end-to-end (Zod field →
defaults → migration → docs → test). The migration:

1. reads the five collapse/sort/filter flags and writes `sections`;
2. translates `groupsHintDismissed`;
3. deletes `recentsCollapsed`, `threadsCollapsed`, `ungroupedCollapsed`, `channelsCollapsed`,
   `dmsCollapsed`, `ungroupedSortMode`, `ungroupedDisplayFilter`, `groupsHintDismissed` from the
   store.

The removed keys leave `SidebarPrefsSchema` in the same release — no lingering legacy fields, no
dual-read path (AGENTS.md: when something is superseded, remove it). `normalizeSidebarPrefs` in
`@dorkos/shared` keeps its tolerance for the pre-DOR-579 bare-path encoding and gains none for
the removed keys; the conf migration is the only compatibility surface, which is what
`migration-safety.test.ts` exists to police. `useUpdateSidebarPrefs`'s whole-section-replace
write is unchanged and still correct: the new fields are part of the same object.

---

### E. Code structure (primary touch points)

**New**

```
apps/client/src/layers/shared/ui/sidebar-row.tsx            SidebarRow primitive
apps/client/src/layers/shared/ui/section-header.tsx         SectionHeader primitive
apps/client/src/layers/shared/lib/row-grammar.ts            label composition + truncation classes
apps/client/src/layers/shared/lib/activity-verb.ts          the verb ladder (BC-37)
apps/client/src/layers/shared/model/use-roving-focus.ts     roving tabindex (R2)
apps/client/src/layers/entities/attention/                  useAttentionSignals + AttentionSignal
apps/client/src/layers/entities/interactions/               unified frecency/interaction store (type:id)
apps/client/src/layers/features/dashboard-sidebar/model/
    build-sidebar-model.ts        types + composition root
    rules/*.ts                    one file per named rule
    fixtures/*.ts                 first-run | quiet | busy | power
    use-sidebar-state.ts          the single assembly hook
    use-sidebar-model.ts          memoized build
apps/client/src/layers/features/dashboard-sidebar/ui/
    SidebarZones.tsx SidebarZone.tsx SidebarSection.tsx
    SidebarHeaderBlock.tsx NewMenu.tsx SidebarFooterStrip.tsx
    SessionSwitcher.tsx
apps/client/src/dev/showcases/SidebarModelShowcases.tsx
contributing/sidebar-model.md
```

**Changed**

```
apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx   875 → target < 200 lines
apps/client/src/layers/features/dashboard-sidebar/ui/rooms/*                menu node builders kept, chrome deleted
apps/client/src/layers/features/dashboard-sidebar/model/use-sidebar-dnd.ts  + non-Library rejection
apps/client/src/layers/entities/config/model/use-sidebar-prefs.ts           section-keyed collapse helpers
apps/client/src/layers/entities/recents/lib/jump-back-in.ts                 interaction-recency key (BC-16)
apps/client/src/AppShell.tsx                                                header/footer stay outside the slot swap
packages/shared/src/config-schema.ts                                        SidebarPrefsSchema (§D)
apps/server/src/services/core/config-manager.ts                             CONFIG_MIGRATIONS entry
apps/client/src/layers/features/chat/...StatusStrip                         align to the shared ladder fn (verbs already real since DOR-1053)
apps/client/src/dev/showcases/{Sidebar,JumpBackIn,IdentityMatrix,Status,Navigation}Showcases.tsx
```

**Deleted** (each in the phase that lands its replacement)

```
ui/SidebarSectionHeader.tsx  ui/GroupHeader.tsx  ui/JumpBackInRow.tsx  ui/JumpBackInSection.tsx
ui/PinnedSection.tsx  ui/UngroupedSection.tsx  ui/SidebarGroupSection.tsx  ui/GroupsHintCard.tsx
ui/AddAgentMenu.tsx  ui/rooms/{Channels,DirectMessages,Threads}Section.tsx
AgentListItem's inline session panel (MAX_PREVIEW_SESSIONS et al.)
```

### F. API and data-model changes

- **No new server routes.** Now/Today/Library are client-side derivations of data the client
  already fetches.
- `GET /api/sessions/recent` gains `lastUserMessageAt` where a runtime can supply it cheaply
  (BC-16). **If a runtime cannot, the field is omitted and the client's `userLastOpenedAt`
  alone governs** — omission, never a guess (the same honesty rule as the verb ladder). This is
  the only server-side change in the programme and it is additive and optional.
- `/session` search schema gains `seed?: 'dorkbot-help'` (enumerated literal, `.catch(undefined)`
  like `send`), stripped after consumption (BC-48).
- Config: `SidebarPrefsSchema` per §D + one `CONFIG_MIGRATIONS` entry.
- No database schema changes.

### G. User Experience

- **Open the app with something waiting** → Now sits at the top: "tangerines needs permission",
  "cardamom asked a question", "3 working". Nothing else competes for that space.
- **Open the app on a quiet morning** → no Now zone at all. Today opens with the welcome-back
  digest, then yesterday's conversations. Absence is the calm signal.
- **Day one** → Getting started: "Meet the 4 agents we found", "Say hi in #team", "Ask DorkBot
  anything". Each retires as it is done, and the zone becomes Now as real signals arrive.
- **Working with one agent** → the conversation is Today's first row, pinned, showing "editing
  RoomRow.tsx" while it works. The 40-rows-down problem disappears without new UI.
- **Running 30 agents** → Now caps at 3 + "+ 5 more"; Library collapsed rows read "32 · 6
  working". Density scales; chrome does not.
- **Creating anything** → one New button. **Finding anything** → ⌘K. **Getting help** → ✦ Ask
  DorkBot, which opens a DorkBot session that already knows what page you were on and how many
  agents you run.
- **Error paths** — the honest ones: a runtime that cannot report activity shows "working…", not
  an invented verb; a session list that fails per-runtime degrades that runtime's rows and says
  so (ADR-0310 `warnings[]`), rather than emptying Today; a failed prefs write rolls back
  optimistically and toasts, exactly as today.

### H. Testing Strategy

- **Model (the bulk).** Table-driven tests over the four fixtures for every BC above:
  zone presence/absence (BC-1), Now priority and cap (BC-6/7/8), the working-rollup suppression
  case (BC-9), suggestion retirement (BC-13), Today order stability under 100 injected activity
  events (BC-16 — the highest-value test in the programme), overnight boundary math with an
  injected `now` (BC-18), archival exemptions, collapsed rollup arithmetic (BC-31), mute
  semantics including the @mention piercing case (BC-40), `draggable === false` for every
  non-Library row (R3), `projectLabel` presence/absence across `activeCount` 1 and 2 (BC-38), and
  a structural test that every emitted node carries a well-formed `reason`.
- **Primitives (RTL).** `SidebarRow`: dual-rendered menus produce identical action sets in
  context menu and kebab; kebab hidden at rest and revealed on `focus-visible`; two-line layout
  only when `reservesVerbLine` or `preview`; `title` attribute carries the full `Agent › Title`.
  `SectionHeader`: whole-row toggle, Alt-click toggles all, rollup renders when collapsed,
  `aria-expanded`/`aria-controls` correct.
- **Hooks.** `useRovingFocus` (one tab stop per section; arrow traversal; Home/End);
  `useSidebarState` memo stability (an activity event must not produce a new state object).
- **Browser (`apps/e2e`).** Zone presence across fixtures via the playground route; scroll-to-active
  on conversation switch **and** its three guardrails (no auto-expand, no scroll while reading,
  instant under reduced motion); the truncation budget asserted from computed styles at 272px
  and at a narrow window; keyboard-only reorder in Library with announcements; axe-core over the
  showcase page in **both themes** (R1). Existing specs that must be updated rather than deleted:
  `tests/dashboard-sidebar/sidebar-groups.spec.ts`,
  `tests/dashboard-sidebar/mobile-sidebar-navigation.spec.ts`,
  `tests/home-surface/jump-back-in.spec.ts`, `tests/rooms/room-presence-sidebar.spec.ts`, and
  the `DashboardSidebarPage` page object.
- **Playground is a deliverable, not a nicety** (§13): `SidebarModelShowcases` (four journey
  fixtures × both themes), plus updates to `SidebarShowcases`, `JumpBackInShowcases`,
  `AgentSidebarShowcases`, `IdentityMatrixShowcases`, `StatusShowcases`, `NavigationShowcases`,
  a session-switcher showcase and a verb-ladder state showcase. Per the
  `maintaining-dev-playground` skill, a phase is not done until its showcases render.
- **Regression sweep.** The 23 component tests and 9 model tests under
  `dashboard-sidebar/__tests__/` are the safety net for the consolidation: tests for deleted
  components move to the primitive that absorbed their behavior; none are deleted without their
  assertion landing somewhere. `packages/shared/src/__tests__/config-schema.test.ts` and
  `apps/server/src/services/core/__tests__/migration-safety.test.ts` cover §D.

### I. Performance Considerations

- `buildSidebarModel` runs on a memoized state object; its inputs change on data events, not on
  render. Target: < 2ms for the `power` fixture (30+ agents, 60 rooms, 40 sessions) — asserted
  by a benchmark-style test that fails above 5ms, so the ceiling is enforced rather than hoped for.
- **Activity churn is the real risk and is designed out**: verbs are not model inputs (A1), so a
  `session_status` activity event re-renders exactly one `SidebarRow` through
  `useSessionActivity(sessionId)`. Server-side throttling
  (`ACTIVITY_FANOUT_THROTTLE_MS = 2_000`) is the second line of defense, not the first.
- The Today order is recomputed only when a `lastInteractionAt` changes, and application is
  deferred while the pointer is over the zone (BC-17) — so the common case costs nothing.
- Net query count is unchanged: the same entity hooks are called, once, in `useSidebarState`
  instead of scattered through an 875-line component.

### J. Security Considerations

Nothing here adds a write surface or a data path. Three notes:

- **Seed context is user-authored context, not privilege.** `buildDorkBotSeedContext` composes
  from client-visible state only (current route, roster size, recent error count, version) and
  rides the existing `seedContext` field, bounded at `SEED_CONTEXT_MAX_LENGTH = 10_000` and
  rendered inside the runtime's untrusted-content fence like any other context block.
- **Row content is untrusted text.** Agent names, room names, session titles and activity
  targets are rendered as text, never as markup; `SessionActivity.target` is already clamped to
  `ACTIVITY_TARGET_MAX_LENGTH = 40` server-side, and `row-grammar` clamps again for layout.
- **Prefs are per-user local config.** The migration touches only `ui.sidebar`; `SENSITIVE_CONFIG_KEYS`
  is untouched.

### K. Documentation

- **New `contributing/sidebar-model.md`** (P1, required by §12): the model's shape, the rule
  functions, how to read a `reason`, how to add a rule, how to add a fixture, and the standing
  rule that verbs never enter the model. Written per `writing-developer-guides`; registered in
  `contributing/INDEX.md`.
- `contributing/design-system.md`: the Sidebar section's 320px/240–280px contradiction is closed
  at **272px** (§11); Zones and Sections gains the resolved a11y contract (R2); the tint ramp
  from R1 is documented as the control-surface separation recipe.
- `contributing/architecture.md`: the `sidebar.body` takeover paragraph gains the persistent-chrome
  rule (header and footer survive a takeover; only the body swaps).
- `docs/` (Fumadocs, `writing-for-humans` register): a short "your sidebar" concept page — what
  Now, Today and Library mean, why things move in and out, and where the things that used to be
  in the sidebar went. This is the substitute for the tour we deliberately cut.
- Changelog fragment per PR (`changelog/unreleased/<id>-<slug>.md`), and the P2 fragment must
  carry the what-moved-where note for existing users.
- `capturing-product-media` re-shoot as a **DONE-stage step** (§14.8, Risk R3).

---

## Implementation Phases

Four phases. **P1 → P2 → P4** is the critical path; **P3 depends only on P1** and runs in
parallel with P2 in its own worktree.

### P1 — Model layer, primitives, fixtures, playground, guide

**Scope.** `build-sidebar-model.ts` + `rules/` + four fixtures; `SidebarRow` and `SectionHeader`
in `shared/ui`; `row-grammar.ts` and `activity-verb.ts` in `shared/lib`; `ORIGIN_GLYPH` added to
`identity-glyphs.ts`; `useRovingFocus`; `SidebarModelShowcases`; `contributing/sidebar-model.md`.
**In the same phase, the existing sidebar adopts the primitives and the visual language** —
`AgentListItem`, `RoomRow`, `ThreadRow` and the Jump Back In rows become `SidebarRow` call sites;
`SidebarSectionHeader` and `GroupHeader` become `SectionHeader` call sites; the 16px inset,
272px width, sentence-case labels, vertical kebab, hover-reveal and the R1 tint ramp land. The
zone structure does **not** change yet.

**Dependencies:** `fix/avatar-signal-cleanup` merged (status props), `fix/title-derivation`
merged (short titles make the 42% budget honest).

**Acceptance criteria**

1. `buildSidebarModel` is pure: no imports of React, no `Date.now()`, no `new Date()` without an
   argument — asserted by a lint-style test over the module's source.
2. Every zone, section and row emitted from every fixture carries a `reason` matching
   `/^[a-z-]+:[a-z-]+$/`.
3. `SidebarRow` and `SectionHeader` are the **only** row and header implementations in
   `features/dashboard-sidebar/` — a test greps the feature for a second `ContextMenu` +
   `DropdownMenu` pair and fails if one exists.
4. Zero visual regressions in structure: the sections rendered before and after P1 are the same
   set, in the same order (the existing `DashboardSidebar.test.tsx` suite passes with only
   selector updates, no assertion deletions).
5. Left inset measures 16px and panel width 272px in a browser test; no `border-b`/`border-t`
   remains in the sidebar tree (asserted by a DOM query for those classes).
6. Both-themes screenshot pair from `SidebarModelShowcases` attached to the PR, and axe-core
   passes with zero contrast violations in both themes (R1).
7. `contributing/sidebar-model.md` exists, is listed in `contributing/INDEX.md`, and an agent
   following it can add a rule + fixture without reading the source.
8. `pnpm verify` green; playground renders all four fixtures.

**Test strategy:** model table tests on fixtures; RTL for both primitives (including the
dual-render equality test); browser test for inset/width/truncation/contrast; the existing 32
sidebar test files pass.

**Rollback:** P1 is one PR; revert restores the previous rows verbatim. **Standing condition:**
`buildSidebarModel` ships consumed by the playground and tests only. If P2 does not land within
one release of P1, P1's model layer is reverted rather than left unwired — no dormant machinery
(AGENTS.md).

### P2 — Desktop zones and chrome

**Scope.** `SidebarZones` / `SidebarZone` / `SidebarSection` replacing the section list;
Now (BC-5→11), Getting started (BC-12→14), Today (BC-15→22), Library (BC-28→33); the
active-conversation anchor and scroll-to-active (BC-21, BC-36); the session switcher (BC-35) and
removal of `AgentListItem`'s inline panel (BC-34); header block + New menu + ⌘K pill
(BC-43→46); footer strip + version relocation + update pill + Ask DorkBot (BC-44, BC-47, BC-48);
moments (BC-49, BC-50); the verb ladder wired to `SessionActivity` for sidebar rows, switcher and
⌘K Continue (the strip already ships it since DOR-1053) (BC-37); `entities/attention` extraction; the R3 dnd rejection; the §D prefs
migration.

**Dependencies:** P1; `feat/activity-label` merged (verbs); `feat/session-seed-prompt` merged
(Ask DorkBot); DOR-1030 read cursors (BC-41).

**Work units for DECOMPOSE (parallelizable inside the phase):** P2.1 zones shell + Library;
P2.2 Now + `entities/attention`; P2.3 Today + anchor + archival + digest; P2.4 header/New/⌘K
pill; P2.5 footer/update pill/Ask DorkBot; P2.6 session switcher; P2.7 verbs + status wiring;
P2.8 prefs schema + conf migration.

**Acceptance criteria**

1. On a fixture with no attention items and no working sessions, the Now zone renders **zero
   DOM nodes** (BC-1).
2. Firing 100 `session_status` activity events changes no Today row's position and re-renders at
   most the rows whose sessions those events belong to (BC-16, R1 perf).
3. The active conversation is Today's first row on every route change, and switching
   conversations scrolls it into view without expanding any collapsed Library section (BC-21,
   BC-36).
4. Clicking an agent opens its most recent human conversation; the inline 3-session panel no
   longer exists anywhere in the tree (BC-34).
5. The Now zone contains no row sourced from a mention, DM, unread channel, automated-session
   activity or update-ready state, across all four fixtures (BC-5, BC-39, BC-44).
6. Every existing user's prefs survive the conf migration with `sections` populated and the eight
   removed keys gone; `migration-safety.test.ts` extended and green (§D).
7. Exactly one create surface exists: a source-level test finds no create action outside the New
   menu's node list (BC-45).
8. A marketplace `sidebar.body` takeover still swaps only the body — the header block and footer
   strip remain mounted (`app-shell-slots.test.tsx` extended).
9. Keyboard-only: reach and open any Library row, collapse a section, reorder a pin, and hear the
   announcements — no pointer (R2, R3).
10. `pnpm verify` green; the four e2e specs listed in §H updated and passing; playground showcases
    updated.

**Test strategy:** model tests extended per BC; RTL for zones/anchor/switcher/New/footer; browser
tests for anchor + scroll guardrails + keyboard reorder + zone presence; server tests for the conf
migration.

**Rollback:** the zone renderer is a swap at `DashboardSidebar`'s body — reverting P2's UI commit
restores P1's structure. The conf migration is **not** reversible; it ships in its own commit and
is written to be idempotent so a re-run after a revert is a no-op.

### P3 — ⌘K upgrade (parallel with P2)

**Scope, per §15.** Sessions become first-class palette items using the row grammar (avatar +
`Agent › title` + origin mark + time), fed by `GET /api/sessions/recent`. One ranked list:
Fuse relevance × frecency × recency blended across types with a "Best match" section on top —
scores stop being discarded in favor of fixed group order. Zero-query becomes a command center:
Continue (live, with verb) → Recent (frecency-blended mix, archived items labeled) → New actions
→ prefix legend. Scope chips (`@agent`, `#channel` resolve into visible chips; residual query
searches within scope; Backspace pops the chip) — no `agent:foo before:bar` query language.
One frecency store for all types (`entities/interactions`, key `type:id`), migrating
`dorkos:agent-frecency-v2` on read. Inline shortcut hints on rows (`↵` open, `⌘↵` new session).
The hand-off row ("Search messages for 'x'…") renders **only when a message-search surface
exists**; until DOR-672 ships it is omitted rather than dead.

**Dependencies:** P1 (row grammar, `activity-verb`); `fix/palette-quick-wins` merged. Independent
of P2.

**Acceptance criteria**

1. Typing a session title finds the session; opening it records frecency under `session:<id>`.
2. One ranked list: a test asserts a high-relevance room can outrank a low-relevance agent
   (impossible today under fixed group order).
3. `@agent` produces a visible chip, filters results to that agent's items, and Backspace pops
   the chip without clearing the residual query.
4. The frecency store migrates existing `dorkos:agent-frecency-v2` records with no loss of
   ranking for agents the user already uses.
5. Archived rooms appear labeled (from `fix/palette-quick-wins`) and rank below live ones.
6. No message-content search anywhere in the palette; the hand-off row is absent when no search
   surface exists.
7. `pnpm verify` green; palette showcases updated.

**Test strategy:** unit tests for the blended scorer (a fixed corpus with asserted ordering) and
the frecency migration; RTL for chips and keyboard flow; one browser test for open-session-by-title.

**Rollback:** self-contained in `features/command-palette/` + `entities/interactions`; revert is
clean, except that P2's Today ordering reads `userLastOpenedAt` from `entities/interactions` — so
the store lands in P1/P2 and P3 only extends it.

### P4 — Mobile tabs

**Scope, per §9.** The drawer dies: on mobile the cockpit renders a `MobileTabsLayout` widget
instead of the sidebar Sheet. Four bottom tabs — **Home** (Now + Today; badged with the Now
count), **Library**, **DorkBot**, **You**. No FAB; New stays in the header. Long-press replaces
hover for every context menu (the dual-render menu system already guarantees they exist). Rows
grow to 40–44px. A "Catch up" bulk action tops Today. Approvals render inline in Now
(approve-from-anywhere). Library carries no badge — it is the calm surface. `sidebar.body`
takeover contributions render inside the Library tab on mobile.

**Dependencies:** P2 (the zones being tabbed).

**Acceptance criteria**

1. At 390×844 there is no drawer and no `SidebarProvider` Sheet in the cockpit tree; navigation
   between tabs never unmounts the Home tab's scroll position.
2. The Home tab badge equals the Now needs-you count exactly (BC-11's number, not a different
   one); the Library tab has no badge.
3. Long-press on any row opens the same action set the desktop kebab shows (asserted against the
   shared node list).
4. Every row's touch target is ≥40px; "Catch up" marks every Today row read in one action.
5. An approval can be resolved from the Home tab without navigating.
6. `mobile-sidebar-navigation.spec.ts` is rewritten for tabs (auto-close semantics no longer
   apply) and passes; the Obsidian `EmbedSidebar` tests still pass untouched.
7. `pnpm verify` green; mobile showcases updated.

**Test strategy:** RTL at mobile viewport for tab state and badges; browser tests at 390×844 for
long-press, catch-up and inline approval.

**Rollback:** `MobileTabsLayout` is selected by `useIsMobile()` at one call site in `AppShell`;
reverting that selection restores the Sheet, which stays in `shared/ui/sidebar.tsx` for the
Obsidian embed regardless.

---

## Risks

**R1 — Model recompute and activity churn.** A fleet of 30 agents can emit an activity event
every 2 seconds per working session. Mitigation is architectural, not incidental: verbs are
excluded from the model (A1), so activity re-renders one leaf row via
`useSessionActivity(sessionId)`; `buildSidebarModel` depends only on lifecycle, prefs, roster and
interaction timestamps; the `power` fixture carries a < 5ms build assertion; BC-17 defers even
legitimate reorders while the pointer is in the zone. **Failure mode to watch in review:** any PR
that adds a verb, a countdown, or a relative timestamp _into_ the model reintroduces the churn —
the guide (`contributing/sidebar-model.md`) states this as a standing rule and the reviewer
rubric should treat it as a blocker.

**R2 — The `sidebar.body` takeover.** `useSidebarSlot()` in `AppShell.tsx` swaps the body when a
contribution's `visibleWhen` matches (the marketplace facet panel on `/marketplace`). The new
header block and footer strip are **persistent chrome outside the swap region** — matching
today's behavior, where `SidebarNavHeader` and `SidebarFooterBar` survive a takeover. A takeover
must keep working with zones present and absent, on desktop and (P4) inside the mobile Library
tab. Covered by an extended `app-shell-slots.test.tsx` and a browser test that navigates to
`/marketplace` and back.

**R3 — e2e and product-media staleness.** Four browser specs and the `DashboardSidebarPage` page
object encode the current structure; they are updated inside the phase that breaks them, never
deleted to go green (`verification-before-completion`). Every marketing screenshot and loop that
contains the sidebar goes stale at P2 — a `capturing-product-media` re-shoot plus registry/archive
update is a **required DONE-stage step** for the programme, not an afterthought (§14.8).

**R4 — Relearning cost, with no tour.** Accepted deliberately (§1). The mitigations are the docs
concept page (§K), a changelog fragment that says plainly what moved where, and the fact that
Library preserves the spatial memory that matters — pins, channels, DMs, agents and groups stay
exactly where the user put them.

**R5 — Phase-0 branch slippage.** P2 hard-depends on `feat/activity-label` and
`feat/session-seed-prompt`. If either misses, P2 ships with the ladder degraded to
`"working…"` (which the ladder is designed to do) or with Ask DorkBot opening an unseeded DorkBot
session. Neither blocks the zones. What P2 must **not** do is invent a verb or fake a seed.

## Open Questions

All items from §17 are resolved above and none remain open.

- ~~Dark-mode calibration of tint-based separation~~ **(RESOLVED — R1)** `--sidebar-accent` ramp at
  40/70/100; `--muted` is banned inside the sidebar because it inverts direction between themes;
  both-theme screenshots + axe-core contrast are a phase gate.
- ~~Accessibility spec~~ **(RESOLVED — R2)** `nav`/`section` landmarks with headings; roving
  tabindex per section; polite live region for Now _count_ changes only; motion-safe rules; keyboard
  and menu alternates for every drag (WCAG 2.5.7).
- ~~Drag-and-drop scope~~ **(RESOLVED — R3)** Library manual order and pins only; Now/Today/Getting
  started never draggable, enforced in the model; existing keyboard announcements preserved verbatim.
- ~~Obsidian `EmbedSidebar` mapping~~ **(RESOLVED — Non-Goals)** Explicitly deferred with rationale;
  the shared primitives land in `shared/` so the embed can adopt them later; a follow-up item is
  filed at DECOMPOSE.
- ~~Multi-project (repo) context in row grammar~~ **(RESOLVED — R4)** Secondary-line chip on session
  rows only, only when the operator has more than one active project, sourced from `cwd`; no grouping
  change; the word "workspace" is not used.
- ~~Where does "+ N more" in Now lead?~~ **(RESOLVED — BC-7)** The home surface triage header, which
  already holds the full list; Now never grows a second list.
- ~~What orders Today when the server cannot say when the user last spoke?~~ **(RESOLVED — BC-16)**
  The client-side `userLastOpenedAt` alone; `lastUserMessageAt` is additive and optional, and a
  runtime that cannot supply it omits it rather than guessing.

## Related ADRs

**Draft, seeded by this spec** (to be extracted at DONE per `/adr:from-spec`):

1. _The sidebar is a pure model rendered by dumb rows_ — `buildSidebarModel` as a convention, the
   mandatory `reason` provenance field, and the standing rule that live verbs never enter the model.
2. _Zones are computed, structure is manual_ — prediction is additive; Now/Today are never
   draggable and never reorder Library.
3. _One row grammar primitive for every control surface_ — `SidebarRow`/`SectionHeader` in
   `shared/ui`, and why the primitives (not the model) are what ⌘K and the switcher share.

**Constraining existing ADRs:** ADR-0310 (runtime-owned session storage — session data is
aggregated with per-runtime degradation, so Today must survive a degraded runtime); ADR 260728-022013
(a thread is a relation between entries — threads render as conversations, not a separate section);
ADR 260726-170125 (a room is a membership-scoped durable stream); ADR 260807-173219 (the compound
composer family — Ask DorkBot consumes it, never forks it); ADR-0043 (agent storage — the roster's
source of truth).

## References

- `specs/sidebar-now-today-library/01-ideation.md` and `design-decisions.md` (authoritative, 18 sections)
- `specs/sidebar-now-today-library/mockups/README.md` (direction only)
- `research/20260809_design-meta-2026-learnings.md` (the ten rules and the audit table)
- `research/20260716_slack_sidebar_organization_ux.md`,
  `research/20260716_cross_app_sidebar_organization_patterns.md` (NN/g spatial memory)
- `specs/team-room-home/02-specification.md` (the home triage header Now overflows into; the
  welcome-back data the digest reads; the 7→4 nav shrink this builds on)
- `specs/message-search/` + DOR-672 (the ⌘K/⌘F split and the hand-off row's precondition)
- `specs/agent-workspace-binding/` (owns the "workspace" naming consolidation §16 defers to)
- `specs/sidebar-groups/02-specification.md` (the groups/pins model Library inherits)
- `contributing/architecture.md`, `contributing/state-management.md`, `contributing/design-system.md`,
  `.claude/rules/fsd-layers.md`, `.claude/rules/testing.md`
- Linear: DOR-1048 (this programme), DOR-1051 palette quick wins, DOR-1052 avatar signal cleanup,
  DOR-1053 activity label, DOR-1054 seed prompt, DOR-1055 title derivation, DOR-1030 read cursors
