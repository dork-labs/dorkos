---
slug: fleet-context-health
id: 260717-105542
created: 2026-07-17
status: ideation
linearIssue: DOR-113
---

# Fleet-level context health: per-session context usage in the session list / dashboard

**Slug:** fleet-context-health
**Author:** Eames (IDEATE stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-113 · type task→feature · size 5 · Medium

---

## 1) Intent & Assumptions

- **Task brief (verbatim from DOR-113):** "Kai runs 10 agents. Surface
  per-session context-usage health in the session list / dashboard so an
  operator can see at a glance which sessions are near their context ceiling
  (and which auto-compacted recently). The data already exists server-side per
  turn; this is aggregation + display. No other agent product offers fleet-level
  context visibility."

- **Triage note (2026-07-16):** context health is per-session-only today
  (`ChatStatusSection` → `ContextItem`); no fleet view. Aligned with the
  mission-control differentiator. Data exists server-side; needs UI design for
  aggregation/placement.

- **The one correction ideation must carry forward:** the brief's premise "the
  data already exists server-side per turn; this is aggregation + display" is
  **only half true.** Per-turn context usage exists in three places, but **none
  of them is the session-list wire.** `GET /api/sessions` carries a per-session
  context reading for **no runtime today** (see §3, §5). The `Session.contextTokens`
  field already exists in the DTO but is populated only by the single-session
  `getSession` path, never by `listSessions`. So this is aggregation + display
  **plus** a real (if modest) server change to get the reading onto the list
  wire cheaply. That reframing is the spine of the whole design.

- **Assumptions carried in:**
  - The fleet surfaces (session list rows, the sidebar Overview/Sessions tab,
    the agents dashboard) are the right homes — they already aggregate
    per-session liveness fleet-wide (`useAgentHottestStatus`,
    `session-list-store`). Context health is one more dimension folded into that
    existing machinery, not a new subsystem.
  - "Near the context ceiling" means the **same** threshold the shipped
    surfaces already use: amber ≥ 80%, red ≥ 95% (`ContextItem`;
    `COMPACTION_CHIP_THRESHOLD_PERCENT = 80` in `use-compaction-chip`). The
    fleet view must not invent a third threshold.
  - Cross-runtime honesty is non-negotiable (AGENTS.md demo-claim gate): the
    fleet view must degrade per runtime, not fake a reading for runtimes that
    cannot produce one. The existing `warnings[]` per-runtime degradation
    (ADR-0310) is the honest-degradation vehicle already in place.
  - Three launch runtimes: claude-code, codex, opencode.

- **Out of scope:**
  - Changing how a single live session renders context (`ContextItem` +
    `UsageRevealPopover` are shipped and stay as-is).
  - A new durable per-turn context-usage store. Session storage is runtime-owned
    (ADR-0310); there is no unified transcript store and this issue must not
    introduce one.
  - Emulated compaction / triggering compaction from the fleet view. The
    per-session `CompactionChip` (DOR-112) already owns the one-click fix; the
    fleet view is **read/visibility**, and at most links into a session.
  - Cost/spend fleet rollup (that is DOR-100's `UsageStatus` lineage, a sibling
    dimension — coordinate, don't merge; see Decisions).

## 2) Pre-reading Log

- `AGENTS.md` — mission-control differentiator ("mission control for every
  coding agent you run"); the demo-claim gate (never claim an unverified
  surface/runtime works); "describe what happens for the user"; FSD layer rule;
  per-runtime honest degradation.
- `packages/shared/src/session-stream.ts:55-162` — `SessionContextUsageSchema`
  (`totalTokens, maxTokens, outputTokens, cacheReadTokens, cacheCreationTokens`)
  and `SessionStatusSchema` (carries `contextUsage`, `usage` [DOR-100],
  `lifecycle`). This is the runtime-neutral status contract every adapter
  projects into — the natural home for a fleet reading.
- `packages/shared/src/schemas.ts:112-129` — `SessionSchema`, the list DTO.
  **Already has `contextTokens: z.number().int().optional()`** (`:124`). The
  field exists; the list path just never fills it.
- `apps/server/src/services/session/aggregate-session-list.ts` — the ADR-0310
  fan-out: `listSessions` across runtimes, 2s per-runtime budget, `warnings[]`
  degradation. Where a fleet reading rides and what it costs per runtime.
- `apps/server/src/services/session/session-state-projector.ts:154-210,436-445`
  — the live projector holds `status.contextUsage` (field-wise merged) and fans
  the **full status** out via `onProjectorStatusChange` on **lifecycle
  transitions only** (not per-chunk). So a live session's context reading is
  already on the wire at each turn boundary.
- `apps/server/src/services/session/session-list-broadcaster.ts:72-75` — turns
  each projector status transition into a `session_status` event on
  `/api/events`, carrying the full `SessionStatus` (incl. `contextUsage`).
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts`
  — the JSONL derivation. `listSessionsInDir`/`extractSessionMeta` read HEAD
  only (`:230`, ~8KB, no tokens); `getSession`/`readTailStatus` read TAIL
  (`:150-153,164-224`, ~16KB) and DO compute `contextTokens`. mtimeMs-keyed
  `metaCache` makes repeat reads cheap. **The tail machinery exists but is not
  wired into the list.**
- `apps/server/src/services/runtimes/claude-code/sdk/context-usage.ts` —
  `fetchContextBreakdown` / `mapSdkContextUsage`: the rich SDK breakdown
  (categories + `percentage` + `maxTokens`) via `query.getContextUsage()`, but
  only while the subprocess is alive (live turns).
- `apps/server/src/services/runtimes/codex/{codex-runtime.ts:563,session-registry.ts:36,162,event-mapper.ts:120-143}`
  — codex `listSessions` returns the in-memory registry; `CodexSessionPatch`
  (`:36`) has **no** `contextTokens`; the token count flows only into the live
  `session_status` event, never the registry row.
- `apps/server/src/services/runtimes/opencode/session-mapper.ts:127-140,378-389`
  — `mapSession` (list projection) carries **no** token usage; the sidecar's
  `session.list` summary has none. OpenCode tokens (`event-mapper.ts:466`) come
  only from reading a specific session's messages.
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-parser.ts:44-51,261-263,376-379`
  - `.../sdk/event-mappers/system-event-mapper.ts:170-183` +
    `packages/shared/src/schemas.ts` (`CompactBoundaryEventSchema`) — claude-code
    JSONL **persists** compaction markers: a `system`/`compact_boundary` record
    with `compactMetadata { trigger: 'manual'|'auto', pre_tokens }` and an
    `isCompactSummary` user record. Compaction history IS queryable per session
    from the transcript — including the auto-vs-manual trigger.
- `apps/client/src/layers/entities/session/model/session-list-store.ts:20-50,137-168`
  — the fleet store: `statuses[id]` from `session_status`. **Prunes** status
  when lifecycle is `idle`/`interrupted` (`:161-163`) — so a settled session's
  `contextUsage` is dropped (live-only today).
- `apps/client/src/layers/entities/session/model/use-agent-hottest-status.ts` —
  the existing fleet-aggregation pattern (folds hottest border across sessions
  by id AND cwd). The template for a fleet context rollup.
- `apps/client/src/layers/features/status/ui/ContextItem.tsx` — the per-session
  gauge: amber ≥ 80, red ≥ 95; SDK `percentage` when present, else client
  estimate. The visual vocabulary the fleet gauge must echo.
- `apps/client/src/layers/features/chat/model/status/use-compaction-chip.ts:23`
  — `COMPACTION_CHIP_THRESHOLD_PERCENT = 80`, the canonical "near ceiling"
  definition and its one-click fix (DOR-112).
- `apps/client/src/layers/entities/session/model/use-session-status.ts:79-95` —
  where the client already turns `contextTokens` + model `contextWindow` into
  `contextPercent` (the list has no `percentage`; the client computes it).
- `apps/client/src/layers/features/relay/ui/RelayHealthBar.tsx` — an existing
  "N healthy · N warning" summary-bar precedent to model the fleet health bar on.
- `apps/client/src/layers/entities/session/ui/SessionRow.tsx` +
  `.../features/session-list/ui/{SessionsView.tsx,SidebarTabRow.tsx}` — the row
  and the Overview/Sessions tabs; where a per-row gauge and a summary bar land.
- `research/20260322_agents_page_fleet_management_ux_deep_dive.md` — the fleet
  health summary bar pattern ("4 Healthy · 1 Warning · 0 Error"), Railway's
  per-row resource mini-indicator, dense-list recommendation. `specs/agents-page`
  (#157) shipped this list; context health extends it.

## 3) Codebase Map

**Primary components/modules:**

- **Server — the reading's home:** `packages/shared/src/schemas.ts:124`
  (`Session.contextTokens`, exists) and `session-stream.ts:55-162`
  (`SessionContextUsage`/`SessionStatus`, the live projection). A fleet reading
  either extends the list DTO (`Session`) with a small `contextHealth` object or
  reuses `contextTokens` + a percent computed client-side.
- **Server — the list path:** `aggregate-session-list.ts` (fan-out + budget +
  `warnings[]`) → each runtime's `listSessions`. For claude-code the change is
  wiring `readTailStatus` (already written) into `listSessionsInDir`
  (`transcript-reader.ts:103-135`), cached by mtimeMs.
- **Server — the live path:** `session-state-projector.ts` +
  `session-list-broadcaster.ts` already fan `SessionStatus.contextUsage` onto
  `/api/events` `session_status` at each lifecycle transition. Live/active
  sessions need no new server work — only the client must stop discarding it.
- **Client — the fleet store:** `session-list-store.ts` (holds `statuses[id]`;
  today prunes on idle). The one client-state change: retain a session's last
  context reading past settle so a closed-but-recently-active row keeps its gauge.
- **Client — the aggregation hook:** `use-agent-hottest-status.ts` is the shape
  to mirror for a "fleet context rollup" selector (counts near-ceiling / recently
  auto-compacted across sessions).
- **Client — the surfaces:** `SessionRow.tsx` (per-row gauge), `SessionsView.tsx`
  / `SidebarTabRow.tsx` Overview tab (summary bar), agents dashboard
  (`widgets/agents`, `features/dashboard-*`).

**Shared dependencies:** `Session`, `SessionStatus`, `SessionContextUsage` are
all `@dorkos/shared` types crossing the `Transport` boundary (Http + Direct).
`ContextItem`'s threshold vocabulary and `use-compaction-chip`'s 80% constant
are the single source of "near ceiling."

**Data flow (three sources of the same number, only one honest at list scale):**

1. **Live projector** → `session_status` on `/api/events` → `session-list-store`.
   Full breakdown incl. `percentage`. **Live/active sessions only**; pruned on
   settle today.
2. **`GET /api/sessions/:id` (single)** → claude-code tail read → `contextTokens`.
   Per-session, on demand — this is what the open chat view uses.
3. **`GET /api/sessions` (the list)** → `listSessions` → **no context reading for
   any runtime today.** This is the gap the feature fills.

**Feature flags/config:** none. Thresholds are code constants.

**Potential blast radius:**

- `Session` DTO change (if a `contextHealth` object is added) → OpenAPI schema +
  every adapter's list projection + `FakeAgentRuntime` list output + client
  consumers.
- claude-code `listSessionsInDir` gains a tail read per changed session (bounded
  by the mtimeMs cache; still O(changed files) per list call).
- `session-list-store` prune rule change → any consumer reading `statuses[id]`
  must tolerate a retained-but-settled status (borders already key off
  `lifecycle`, so this is additive).
- Two/three new UI surfaces (row gauge, summary bar, dashboard tile).

## 5) Research

### The honest per-runtime reality (this is the whole design constraint)

| Source of a fleet reading                | claude-code                                                                                                                                                                                                          | codex                                                                                                                                                                                           | opencode                                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **List path (`listSessions`) today**     | HEAD-only, no tokens (`extractSessionMeta`).                                                                                                                                                                         | in-memory registry row, no `contextTokens` (`CodexSessionPatch` lacks it).                                                                                                                      | sidecar `session.list` summary, no tokens (`mapSession`).                                                                                 |
| **Cheap list-scale reading achievable?** | **Yes** — wire the existing `readTailStatus` tail read (~16KB, mtimeMs-cached) into the list; already computes `contextTokens`.                                                                                      | **Partial** — only for sessions this server run has seen (registry is in-memory); requires the registry to also capture the live `contextTokens` it already receives. No pre-run/cold sessions. | **No cheap path** — the summary has no tokens; a reading needs a per-session message read, which defeats "without opening every session." |
| **`percentage` / `maxTokens`?**          | Tail has raw usage tokens only; percent = tokens ÷ model `contextWindow` (client already does this in `use-session-status.ts`). SDK `getContextUsage` (true `percentage`) is live-turn-only.                         | Same — no SDK context API; percent via model window, live-run only.                                                                                                                             | N/A unless live.                                                                                                                          |
| **"Auto-compacted recently" queryable?** | **Yes** — JSONL persists `compact_boundary` + `isCompactSummary` with `trigger:'auto'` (`transcript-parser.ts`). Tail-derivable, with a recency caveat (marker scrolls out of the tail window as the session grows). | **No** — codex has no compaction concept (compact intent unsupported, DOR-109).                                                                                                                 | **Live-only** — sidecar emits `session.compacted` as a live event; queryability from its store is unestablished.                          |
| **Live reading (open/active session)**   | Yes — projector fan-out.                                                                                                                                                                                             | Yes — projector fan-out (codex emits `contextTokens` on turn end).                                                                                                                              | Yes — projector fan-out.                                                                                                                  |

**Net honest story:** claude-code gets a **full** fleet reading (percent +
recent-auto-compaction) at list scale. codex gets a **best-effort live-run**
reading (percent for sessions seen this run; no compaction). opencode gets a
reading **only while a session is open/active** (live fan-out); its list rows
show **"unknown."** This is not a defect to hide — it is the honest per-runtime
degradation the mission-control brand requires, and DorkOS is still the only
product offering _any_ fleet context visibility.

### Solution options — where the fleet reading comes from

1. **Client-side aggregation from open streams only.** Read `contextUsage` from
   `session-list-store` (fed by `session_status`). **Pros:** zero server change;
   uses shipped plumbing. **Cons:** covers only sessions that are open or
   streamed this session — the CLOSED-tab / cold-start sessions Kai most needs to
   scan are exactly the ones with no live stream. Fails the brief ("at a glance
   which sessions are near their ceiling" across the whole fleet). **Rejected as
   the sole path**, but it is the correct _live-freshness_ layer.
2. **Extend `GET /api/sessions` with a per-session context reading.** claude-code
   wires the tail read; codex captures its live token count into the registry;
   opencode reports "unknown." **Pros:** serves closed-tab sessions; one DTO
   field; rides the existing ADR-0310 fan-out + `warnings[]`; the field
   (`contextTokens`) already exists. **Cons:** adds a tail read per changed
   claude-code session (bounded by the mtimeMs cache); percent is derived
   (tokens ÷ model window), not the SDK's exact `percentage`.
3. **Separate batched endpoint** (`GET /api/sessions/context-health?ids=…`).
   **Pros:** keeps the hot list lean; compute health lazily for the visible page.
   **Cons:** a second round-trip and a parallel aggregation path for one small
   field the list already has a home for; N+1-shaped unless carefully batched.
   Premature for a size-5 — revisit only if the tail-read cost proves real.

**Recommendation:** **Option 2 as the durable/closed-session layer, Option 1 as
the live-freshness layer — the same two-layer split the fleet liveness system
already uses.** The list DTO carries a best-effort reading (fresh as the JSONL
tail, per-turn granularity, stamped by `updatedAt`); open/active sessions
override it live via the `session_status` fan-out. Reject Option 3 for v1.

### Where the fleet surface lives — staged, rows first

Per `research/20260322_agents_page_fleet_management_ux_deep_dive.md` (the
dense-list + segmented health-summary-bar pattern; Railway's per-row resource
mini-indicator; Grafana's "N Healthy · N Warning" bar):

- **v1 (must-have): a per-row context gauge on `SessionRow`.** A small
  percentage/ring echoing `ContextItem`'s amber-≥80 / red-≥95 vocabulary, plus a
  discreet "auto-compacted" marker when recent. Row-level is where Kai scans "10
  agents at a glance." Degrades to a muted "unknown" glyph for runtimes/sessions
  with no reading (never a fake 0%).
- **v1 (cheap add): a fleet health summary bar** on the Sessions/Overview tab,
  modeled on `RelayHealthBar`: "N near full · N auto-compacted" as colored
  counts, computed by a `use-agent-hottest-status`-shaped rollup selector.
- **Staged (fast-follow): a dashboard tile** in the agents dashboard reusing the
  same rollup selector. Not a blocker for v1; the selector makes it nearly free.

## 6) Decisions

Resolved during ideation (brief + codebase reality). Genuine forks needing the
human are in **Open Questions**.

| #   | Decision                                                               | Choice                                                                                                                                                                                                              | Rationale                                                                                                                                               |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Primary surface                                                        | Per-row context gauge on `SessionRow` (v1), fleet health summary bar on the Sessions/Overview tab (v1), agents-dashboard tile (staged fast-follow)                                                                  | Rows are where "10 agents at a glance" is scanned; the bar and tile reuse one rollup selector, so staging them costs almost nothing.                    |
| 2   | Data path for closed/cold sessions                                     | Extend `GET /api/sessions` (Option 2): claude-code wires the existing `readTailStatus` into the list (mtimeMs-cached); reuse/extend the existing `Session.contextTokens` field                                      | The closed-tab sessions Kai must scan have no live stream; the list is the only place that serves them. The field and the tail-read code already exist. |
| 3   | Data path for open/active sessions                                     | Ride the existing `session_status` fan-out (Option 1) as a live override on top of the list reading                                                                                                                 | The projector already fans `contextUsage` out at each turn boundary; no new server work — this is the freshness layer.                                  |
| 4   | Keep a settled session's reading                                       | Stop `session-list-store` pruning `contextUsage` on `idle`/`interrupted`; retain the last reading (still prune the _liveness/border_ signal)                                                                        | A just-settled session is exactly one Kai wants a reading for; borders key off `lifecycle` and are unaffected. Additive.                                |
| 5   | "Near ceiling" thresholds                                              | Reuse amber ≥ 80 / red ≥ 95 from `ContextItem` + `COMPACTION_CHIP_THRESHOLD_PERCENT` — one shared constant, no third threshold                                                                                      | The fleet view must agree with the per-session gauge and the compaction chip; divergence would confuse.                                                 |
| 6   | Percent derivation                                                     | tokens ÷ model `contextWindow` (as `use-session-status.ts` already does), not the SDK's live-only `getContextUsage().percentage`                                                                                    | The exact SDK percentage is only available mid-turn; the derived percent is the honest list-scale value and is already the client's established method. |
| 7   | Cross-runtime honesty                                                  | Per-runtime degrade: claude-code full, codex best-effort live-run, opencode "unknown" list rows; surface "unknown" as an explicit muted state, never a fake reading; reuse `warnings[]` (ADR-0310)                  | Demo-claim gate + "honest by design." DorkOS is still the only product with any fleet context view even when some runtimes read "unknown."              |
| 8   | Relationship to DOR-100 (`UsageStatus`) and DOR-112 (`CompactionChip`) | Coordinate, don't merge: context health is the _window-pressure_ dimension (distinct from cost/spend); the fleet view is read-only and at most links into a session where the shipped `CompactionChip` owns the fix | Keeps each dimension where it lives; avoids re-implementing the one-click compaction fix in the fleet view.                                             |

### Open Questions (need the human operator — bounded, decision-ready)

- **A. "Auto-compacted recently": tail-derive vs. durable `lastCompactedAt`.**
  The brief explicitly asks to show "which auto-compacted recently." Two paths:
  **(a)** derive it from the claude-code JSONL tail (`compact_boundary` +
  `trigger:'auto'`) — no new persistence, but claude-code-only and subject to a
  recency window (the marker scrolls out of the ~16KB tail as the session grows,
  so "recently" is fuzzy and coverage is partial); or **(b)** add a durable
  `lastCompactedAt` / `lastCompactionTrigger` to the runtime-neutral status
  projection (uniform across runtimes that _can_ compact, survives restart, exact
  recency) — but that is new persistence + a schema migration, meaningfully
  larger than a size-5 display task. Recommendation leans **(a)** for v1
  (ship the near-ceiling gauge + best-effort compaction marker; the gauge is the
  90% of the value), with **(b)** as a follow-up if the recency fuzziness proves
  user-visible. **Which for v1?**

- **B. Cross-runtime honesty mechanism: explicit capability vs. field-presence.**
  Should a runtime advertise a new `RuntimeCapabilities.supportsContextUsage`
  flag that drives the "unknown" gauge state (explicit, compile-time-forced like
  `commandIntents`), or should the client infer "unknown" from the _absence_ of a
  reading on the list DTO plus the existing `warnings[]` (less code, but
  implicit)? Recommendation leans **field-presence + `warnings[]`** (no new
  capability to keep in sync; the honest-degradation vehicle already exists), but
  a first-class flag is the more self-documenting contract Priya would prefer.
  **Which?**

### Risks

- **The "data already exists" trap.** The brief says "aggregation + display";
  reality is the list wire carries no reading today. If SPECIFY scopes this as
  pure client work it will underestimate — the claude-code list tail-read and the
  DTO/adapter changes are the real work. Called out loud (Assumptions + §5).
- **Tail-read cost at fleet scale.** Adding a tail read to `listSessionsInDir`
  is O(changed files) per list call. The mtimeMs `metaCache` bounds it (only
  appended/changed transcripts re-read), but a fleet of very active sessions
  re-reads tails often. Measure before reaching for Option 3 (batched endpoint).
- **"Unknown" must read as honest, not broken.** opencode list rows (and codex
  cold sessions) showing "unknown" must look deliberate (muted glyph + tooltip
  "context usage not reported by {runtime} until a session is open"), or it reads
  as a bug and undercuts the differentiator. Copy + design detail for SPECIFY.
- **Store-prune change is subtle (Decision 4).** Retaining `contextUsage` past
  settle while still pruning the border signal means splitting one prune rule
  into two concerns in `session-list-store`. Easy to regress the border liveness
  if done carelessly — SPECIFY must keep the `lifecycle` prune intact.

### Recommended direction & next step

**Next step: move-to-specify.** The surfaces and the two-layer data path are
clear and the substrate (list fan-out, projector fan-out, tail-read machinery,
threshold constants, fleet store, rollup-hook pattern) is all shipped — but
ideation surfaced two genuine, bounded forks (Open Q A/B) and one non-obvious
reality that flips the brief's framing (the list wire carries no reading today;
this is display **plus** a modest server change) that must be resolved before a
spec is frozen. That is past "stay-in-ideation" and more than "adapt-directly."

Concretely, SPECIFY should: (1) resolve Open Q A (compaction recency source) and
B (capability vs. field-presence) with the operator; (2) pin the list DTO shape
(reuse `contextTokens` + a client-derived percent, or add a small
`contextHealth` object) and update all three adapters' list projections +
`FakeAgentRuntime`; (3) wire claude-code's `readTailStatus` into
`listSessionsInDir` and capture codex's live token count into its registry; (4)
change the `session-list-store` prune rule to retain a settled reading while
keeping the `lifecycle` border prune; (5) build the `use-agent-hottest-status`-
shaped fleet rollup selector feeding the row gauge, the summary bar, and (staged)
the dashboard tile; (6) reuse the shared 80/95 thresholds and design the honest
"unknown" state. Draft ADR candidate: "Fleet-level context health — best-effort
list reading + live override, honest per-runtime degradation" (extends ADR-0310's
per-runtime session-list degradation to a new displayed dimension).
