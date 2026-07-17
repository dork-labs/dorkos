---
slug: fleet-context-health
id: 260717-105542
created: 2026-07-17
status: specified
linearIssue: DOR-113
---

# Fleet-level context health: per-session context usage in the session list

**Status:** Draft (frozen for DECOMPOSE)
**Author:** Nash (SPECIFY stage, /flow drain)
**Date:** 2026-07-17
**Tracker:** DOR-113 · type task→feature · size 5 · Medium

## Overview

Kai runs ten agents. Today he can see how much context a single **open** session
has burned (the `ContextItem` gauge in the chat status bar), but nothing tells
him, at a glance across the fleet, which sessions are near their context ceiling
or which just auto-compacted. This feature adds that fleet view: a **per-row
context gauge** on every session row and a **fleet health summary bar** on the
Sessions/Overview tab. No other coding-agent cockpit offers fleet-level context
visibility — this is a mission-control differentiator.

The brief framed this as "the data already exists server-side per turn; this is
aggregation + display." That is **half true, and the untrue half is the spine of
this design.** Per-turn context usage exists in three places, but **none of them
is the session-list wire.** `GET /api/sessions` carries a per-session context
reading for **no runtime today**: the `Session.contextTokens` DTO field exists
(`schemas.ts:124`) but is populated only by the single-session `getSession` path
(`transcript-reader.ts:153`), never by any runtime's `listSessions`. So this is
aggregation + display **plus** a real (if modest) server change to get a
best-effort reading onto the list wire cheaply.

The design has two data layers, mirroring the split the fleet-liveness system
already uses:

- **Durable/closed-session layer** — extend `GET /api/sessions`. claude-code
  wires its existing tail read (`readTailStatus`) into the list so a closed-tab
  session still carries `contextTokens` (and, new, an auto-compaction marker),
  bounded by the existing mtime cache. codex and opencode carry no list reading
  and honestly render "unknown."
- **Live-freshness layer** — open/active sessions ride the shipped
  `session_status` fan-out; the client merges live over list (live wins).

Percent is derived client-side (`tokens ÷ model context window`) from the shipped
model catalog, the way `use-session-status.ts` already does it. The amber-≥80 /
red-≥95 vocabulary from `ContextItem` is reused verbatim — with the four
duplicated percent computations that exist today consolidated into **one** shared
source so the new gauge cannot become a fifth copy that drifts.

## Background / Problem Statement

Verified against the codebase (2026-07-17):

- **`Session.contextTokens` exists but the list never fills it.** `SessionSchema`
  (`schemas.ts:112-127`) carries `contextTokens: z.number().int().optional()`
  (`:124`). Only `getSession` populates it, via a tail read
  (`transcript-reader.ts:150-153`). The list path
  (`listSessions → listSessionsInDir → extractSessionMeta`,
  `transcript-reader.ts:88-135, 230-348`) reads only the file **head** (8 KB,
  `HEAD_BUFFER_BYTES`) and computes no tokens.

- **The tail-read machinery already exists and is cheap.** `readTailStatus`
  (`transcript-reader.ts:164-224`, private) reads the last 16 KB
  (`TRANSCRIPT.TAIL_BUFFER_BYTES = 16384`, `constants.ts:134`), iterates the
  JSONL lines, and computes `contextTokens` via `sumContextTokens`
  (`context-tokens.ts:25` — the single server-side token-sum SSOT, shared with
  the live result path so the two can't drift). It returns
  `{ model, permissionMode, contextTokens }` — **no `maxTokens`/window.** The
  `metaCache` (`transcript-reader.ts:32, 119-125`) is keyed by `mtimeMs`, so a
  reading recomputes only when the transcript is appended to.

- **The live path already carries a full reading.** The projector fans a
  session's full `SessionStatus` (incl. `contextUsage`, which DOES carry
  `maxTokens`) out on every lifecycle transition (`onProjectorStatusChange`,
  `session-state-projector.ts:186`; `applyStatusChange` merges `contextUsage`
  field-wise, `:436-445`); the broadcaster turns it into a `session_status`
  event on `/api/events` (`session-list-broadcaster.ts:72-75`). **Live/active
  sessions need no new server work.**

- **Compaction is persisted and queryable from the tail.** A
  `type:'system', subtype:'compact_boundary'` JSONL record
  (`transcript-parser.ts:529`) carries `compactMetadata.trigger`
  (`'manual' | 'auto'`) plus a top-level `timestamp` (`TranscriptLine.timestamp`,
  `transcript-parser.ts:33, 51-56`). `CompactBoundaryEventSchema` /
  `CompactMetadataSchema` (`schemas.ts:1048, 1511`) already model it. So
  "auto-compacted recently" is derivable from the **same 16 KB tail** the token
  read already scans — near-zero extra cost.

- **The honest per-runtime reality is the whole design constraint.** codex's
  `CodexSessionPatch` (`session-registry.ts:35-42`) has no `contextTokens`; its
  `list()` (`:162`) returns window-less, token-less rows; its live token count
  rides `session_status` only (`event-mapper.ts:119-143`) and it has no
  compaction concept. opencode's `mapSession` (`session-mapper.ts:126-140`)
  carries no tokens, and the sidecar `session.list` summary is code-diff stats,
  not tokens; tokens arrive only from reading a session's messages
  (`event-mapper.ts:466`). So claude-code gets a **full** list reading, codex and
  opencode get a reading **only while a session is open** (live fan-out), and
  their list rows read **"unknown."**

- **The model context window is a client-side catalog value, not a list field.**
  No runtime carries a window on its list row. The client joins the session's
  `model` against `ModelOption.contextWindow` (`schemas.ts:2280`, optional):
  codex a static `CODEX_CONTEXT_WINDOW = 272_000` (`runtime-constants.ts:81`),
  opencode `model.limit.context` (`models.ts:46`, sidecar-live only),
  claude-code SDK ModelInfo disk-cached (`runtime-cache.ts:92`) plus a live
  per-turn window (`result-event-mapper.ts:130`). `use-session-status.ts:78-95`
  is the established join: `percent = min(100, round(tokens / window * 100))`.

- **There is no single percent-derivation source today — there are four.**
  (1) `use-session-status.ts:92-94` (`tokens ÷ catalog window`), (2)
  `derive-status-bar.ts:39-43` `deriveContextPercent` (`totalTokens ÷ maxTokens`
  from live status), (3) `ContextItem.tsx:22` (prefer `contextUsage.percentage`,
  else the passed estimate), (4) `ChatStatusSection.tsx:264-269` — an inline
  **duplicate** of (3), commented "Mirrors ContextItem's own percent
  resolution." The amber/red thresholds are inline magic numbers
  (`ContextItem.tsx:24`, no named constant) plus a hand-synced dup
  (`COMPACTION_CHIP_THRESHOLD_PERCENT = 80`, `use-compaction-chip.ts:23`, with a
  comment "if the amber threshold ever moves, move this one too"). A fleet gauge
  built naively is the fifth copy waiting to drift. This spec consolidates them.

## Operator Decisions (LOCKED)

Pinned before specifying (ideation §6 + the two Open Questions resolved on the
issue); not reopened here.

1. **Surfaces v1:** a per-row context gauge on `SessionRow` (echoing
   `ContextItem`'s amber-≥80 / red-≥95 vocabulary via one shared constant) **plus**
   a fleet health summary bar on the Sessions/Overview tab (`RelayHealthBar`
   style). The agents-dashboard tile is a **staged fast-follow, out of v1 scope**
   (the rollup selector makes it nearly free later).
2. **Data path — durable/closed:** extend `GET /api/sessions`. claude-code wires
   `readTailStatus` into the list (mtime-cached); `Session.contextTokens` (exists)
   carries the reading; percent is derived client-side (`tokens ÷ model context
window`). **Live override:** open sessions ride the existing `session_status`
   fan-out; the client merges live over list.
3. **Store:** `session-list-store` stops pruning a session's context reading on
   idle/interrupted (retain the reading); it keeps pruning the liveness/border
   signal exactly as today.
4. **"Auto-compacted recently":** v1 derives it from the claude-code JSONL tail
   (`compact_boundary` + `trigger:'auto'`); the recency window is whatever the
   tail honestly supports (the marker scrolls out as the session grows). Durable
   `lastCompactedAt` persistence is a **recorded follow-up, out of v1 scope**.
5. **Honesty:** "unknown" derives from field-absence + the ADR-0310 `warnings[]`;
   **no new `RuntimeCapabilities` flag.** codex = best-effort live-run only;
   opencode = unknown-unless-open. Never fabricate a reading.

## Goals

- claude-code's list path (`listSessionsInDir`/`extractSessionMeta`) populates
  `Session.contextTokens` from the existing tail read, mtime-cached, so a
  closed-tab session carries a best-effort reading.
- A new optional `Session.lastAutoCompactAt` carries the most recent
  auto-compaction visible in the readable tail (claude-code only).
- One shared client percent-derivation + threshold source
  (`entities/session/lib/context-health.ts`) that `ContextItem`, the compaction
  chip, the status-bar derivation, `use-session-status`, and the new fleet
  surfaces all import — the four existing copies consolidated, no fifth added.
- A per-row context gauge on `SessionRow`: quiet percent + severity color,
  a discreet auto-compacted marker, and an honest muted "unknown" state.
- A fleet health summary bar on the Sessions/Overview tab: "N near full ·
  N auto-compacted" colored counts from a `use-agent-hottest-status`-shaped
  rollup selector.
- The client merges the list reading with the live `session_status` reading
  (live wins), retaining a settled session's last reading.
- Honest per-runtime degradation via field-absence + `warnings[]` — no fabricated
  readings, no new capability flag.

## Non-Goals

- **The agents-dashboard context tile** (Decision 1) — staged fast-follow; the
  rollup selector is built v1-ready so the tile is near-free later.
- **Durable compaction persistence** (`lastCompactedAt` on the runtime-neutral
  status, surviving restart, exact recency). v1 is tail-derived (Decision 4);
  durable persistence is the recorded follow-up if tail fuzziness proves
  user-visible.
- **A codex registry patch** to capture its live token count into the in-memory
  registry row. codex stays best-effort live-run only (Decision 5); its list rows
  are "unknown."
- **opencode per-session message reads** to synthesize a closed-session reading.
  opencode is unknown-unless-open.
- **A `maxTokens`/window field on the list DTO, or server-side percent
  computation.** The window stays a client catalog join (`ModelOption.contextWindow`),
  the established method.
- **Changing single-session context rendering.** `ContextItem`, `UsageRevealPopover`,
  and the `CompactionChip` (DOR-112) are shipped and stay; the fleet view only
  reuses their vocabulary and, at most, links into a session.
- **A cost/spend fleet rollup.** That is DOR-100's `UsageStatus` lineage — a
  sibling dimension. Coordinate, don't merge.
- **A new durable per-turn context-usage store.** Session storage is
  runtime-owned (ADR-0310); this issue introduces no unified transcript store.

## Technical Dependencies

- No new external dependencies. All new types are DorkOS Zod/TS in `@dorkos/shared`.
- `@anthropic-ai/claude-agent-sdk` — the tail read stays inside
  `services/runtimes/claude-code/` (Hard Rule 2). No new SDK surface: the tail
  read (`fs`), `sumContextTokens`, and the `compact_boundary` JSONL shape all
  already exist.
- Shipped substrate consumed unchanged: the ADR-0310 aggregation
  (`aggregate-session-list.ts`, `SessionListResponse.warnings`), the projector
  `session_status` fan-out, the model catalog (`useModels`/`ModelOption.contextWindow`),
  and the fleet store.

## Detailed Design

### 1. Server — wire the tail read into the claude-code list (`services/runtimes/claude-code/sessions/transcript-reader.ts`)

Today `extractSessionMeta` reads only the head; `readTailStatus` (the tail read)
is called only by `getSession`. The change folds the tail read into the
list-producing, mtime-cached path.

- **Extend `readTailStatus`** to also return `lastAutoCompactAt`. In the same
  forward line-scan it already runs over the 16 KB tail, capture the `timestamp`
  of the most recent record where `type:'system' && subtype:'compact_boundary' &&
compactMetadata?.trigger === 'auto'`. New return shape:
  `{ model?, permissionMode?, contextTokens?, lastAutoCompactAt? }`. Manual
  compactions are ignored (they are user-driven, not a pressure signal).
- **Fold the tail read into `extractSessionMeta`** so the cached `Session`
  carries `contextTokens` and `lastAutoCompactAt` (and the tail's latest `model`
  overlaying the head's, matching what `getSession` does today). The enriched
  `Session` is stored in `metaCache` under its `mtimeMs`. Result: `listSessionsInDir`
  emits rows with a reading for every changed session, served from cache when the
  transcript hasn't grown.
- **Simplify `getSession`** to return `extractSessionMeta` directly — its
  separate `readTailStatus` overlay (`transcript-reader.ts:150-153`) is now
  redundant. No half-migration: there is exactly one tail-read code path feeding
  both list and single-session reads, and both rows are enriched identically.
- `invalidate(sessionId)` (`:39`) still drops the cache entry after a rename.

**The cache contract (spec it explicitly):**

| Situation                                | I/O per session                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `mtimeMs` unchanged (cache hit)          | `fs.stat` only (already performed to key the cache) — **no head/tail read**         |
| `mtimeMs` changed or absent (cache miss) | one head read (8 KB) **+ one tail read (16 KB)**, then cache the enriched `Session` |

So the added cost is **one 16 KB read per _changed_ claude-code session per list
call** — `O(changed files)`, not `O(all files)`. A fleet of mostly-settled
sessions pays nothing beyond the stats it already does; only appended transcripts
re-read. codex and opencode `listSessions` are unchanged (no tail concept).

### 2. DTO delta — `SessionSchema` (`packages/shared/src/schemas.ts:112-127`)

Two changes, both minimal. **Verbatim:**

```ts
export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastMessagePreview: z.string().optional(),
    permissionMode: PermissionModeSchema,
    runtime: z.string(),
    model: z.string().optional(),
    effort: EffortLevelSchema.optional(),
    fastMode: z.boolean().optional(),
    /**
     * Best-effort context-window token count for the session — the tokens
     * currently occupying the window (input + cache-read + cache-creation, per
     * `sumContextTokens`). Populated on the list wire by claude-code from its
     * JSONL tail (fresh as the last turn, mtime-cached) and on a single-session
     * read. ABSENT when no reading is available — codex/opencode closed-session
     * list rows, or an unreadable tail — in which case the client shows an
     * honest "unknown" gauge, never a fabricated 0%. Percent is derived
     * client-side against the model's context window (`ModelOption.contextWindow`).
     */
    contextTokens: z.number().int().optional(),
    /**
     * ISO-8601 timestamp of the most recent AUTO-triggered context compaction
     * visible in the session's readable transcript tail (claude-code only;
     * codex has no compaction, opencode reports it live-only). ABSENT means no
     * auto-compaction is visible in the tail — either the session never
     * auto-compacted, or the boundary has scrolled past the ~16 KB tail window
     * as the session grew (an honest, disclosed limitation; durable recency is
     * a deferred follow-up). Drives the row's discreet "auto-compacted" marker.
     */
    lastAutoCompactAt: z.string().datetime().optional(),
    cwd: z.string().optional(),
  })
  .openapi('Session');
```

- `contextTokens` — **field unchanged; TSDoc added**; semantics broadened (now a
  list-carried best-effort reading, not single-session-only).
- `lastAutoCompactAt` — **new, optional ISO datetime**. No nested `contextHealth`
  object (Decision 2 keeps `contextTokens` flat; the flat style matches the
  sibling optional fields). No `maxTokens` on the DTO (window stays a client
  catalog join). No `RuntimeCapabilities` change (Decision 5).
- OpenAPI regenerates from the Zod schema (the openapi step); `FakeAgentRuntime`
  and any list-producing fixtures gain the fields where they exercise a reading.

### 3. Live path — no server change

Open/active sessions already fan `SessionStatus.contextUsage` (with `maxTokens`)
onto `/api/events` as `session_status` on each lifecycle transition
(`session-list-broadcaster.ts:72-75`). The client consumes it as the live
override (§5–§6). Nothing new server-side. The auto-compaction marker for a live
session arrives via the list DTO too: a compaction writes the JSONL, bumping the
transcript `mtime`, so the discovery watcher re-emits `session_upserted` with a
fresh `lastAutoCompactAt`. No need to thread compaction onto `session_status`.

### 4. Client — the ONE shared percent source (`entities/session/lib/context-health.ts`, new)

The single most important client decision. Create a pure, dependency-light module
in **`entities/session`** — the lowest FSD layer every consumer can reach
(`features/status`, `features/chat`, `features/session-list`, and
`entities/session` itself all sit at or above `entities`). This resolves the
current awkwardness where `use-compaction-chip` (features/chat) _cannot_ import
the threshold from `ContextItem` (features/status, a sibling feature) and so
duplicates it — the constant now lives **below** both.

```ts
/** Context usage at/above which a session is "near full" — amber. */
export const CONTEXT_WARNING_PERCENT = 80;
/** Context usage at/above which a session is "at the ceiling" — red. */
export const CONTEXT_CRITICAL_PERCENT = 95;

/** Severity band for a context-usage percent. */
export type ContextSeverity = 'ok' | 'warning' | 'critical';

/** Map a 0-100 context-usage percent to its severity band. */
export function contextSeverity(percent: number): ContextSeverity;

/**
 * Derive context-window utilization percent (0-100), or null when either input
 * is missing/non-positive. The single formula:
 * `min(100, round(tokens / maxTokens * 100))`.
 */
export function deriveContextPercent(
  tokens: number | null | undefined,
  maxTokens: number | null | undefined
): number | null;

/**
 * Resolve the DISPLAY percent: the SDK breakdown's exact `percentage` when a
 * rich `ContextUsage` is present, else the coarser derived estimate.
 */
export function resolveDisplayContextPercent(
  estimatePercent: number | null,
  contextUsage?: ContextUsage | null
): number | null;
```

**Migrate the four existing sites onto it (de-duplication, no behavior change):**

- `ContextItem.tsx:22, 24` → `resolveDisplayContextPercent` + `contextSeverity`
  (map the band to `text-red-500`/`text-amber-500`/`''`).
- `use-compaction-chip.ts:23` → import `CONTEXT_WARNING_PERCENT`; delete the local
  `COMPACTION_CHIP_THRESHOLD_PERCENT` dup and its "move this one too" caveat.
- `derive-status-bar.ts:39-43` → `deriveContextPercent`.
- `use-session-status.ts:92-94` → `deriveContextPercent`.
- `ChatStatusSection.tsx:264-269` → `resolveDisplayContextPercent`.

Both new fleet surfaces (§8) consume this module — so there is exactly one
formula and one threshold set across every context surface. Export from the
`entities/session` barrel.

### 5. Client — retain the settled reading (`session-list-store.ts`)

`applyListEvent`'s `session_status` case prunes `statuses[id]` +
`statusCwds[id]` on `lifecycle === 'idle' | 'interrupted'` (`:160-163`) — which
drops a settled session's `contextUsage` today. Decision 3 splits the two
concerns into two maps so the liveness prune can never cross-regress the retained
reading:

- **`statuses` prune stays exactly as today** — the liveness/border signal
  remains memory-bounded (settled ⇒ no entry ⇒ no border, unchanged).
- **New `contextReadings: Record<string, SessionContextReading>`** — set on every
  `session_status` that carries `event.status.contextUsage`, and **not** pruned
  on settle (retained). Cleared on `session_removed`, on rekey-retire
  (`retiredSessionId`), and by `resetStatuses` on stream reconnect (so a stale
  reading can't survive a server restart the way `statuses` already can't).

```ts
/** A retained per-session live context reading (survives settle). */
interface SessionContextReading {
  /** The live SDK usage breakdown (carries totalTokens + maxTokens). */
  contextUsage: SessionContextUsage;
  /** Client receive time (ISO) — the live reading's freshness stamp. */
  receivedAt: string;
}
```

Add a selector `useSessionContextReading(sessionId): SessionContextReading | null`
and export from the barrel. This map is bounded by "sessions seen streaming since
connect" (reset on reconnect), far smaller than "every session ever."

### 6. Client — the merge rule (list vs live + staleness)

A per-session resolver, `useSessionContextHealth(session: Session)`
(entities/session), produces the row's reading with **live-wins** precedence:

1. **Live** — `contextReadings[session.id]` present ⇒ percent =
   `deriveContextPercent(contextUsage.totalTokens, contextUsage.maxTokens)`.
   Current; `fresh: true`.
2. **List** — else `session.contextTokens` present ⇒ percent =
   `deriveContextPercent(session.contextTokens, window)`, where `window` is
   `ModelOption.contextWindow` for `session.model` from `useModels({ runtime:
session.runtime })` (cached, deduped by query key across rows). "As of
   `session.updatedAt`"; `fresh: false`.
3. **Unknown** — neither a live reading nor `session.contextTokens`, or no window
   in the catalog ⇒ `{ status: 'unknown' }`. Never a fabricated 0%.

Returned shape:
`{ status: 'known' | 'unknown'; percent?: number; severity?: ContextSeverity;
autoCompactedAt?: string; fresh: boolean; asOf: string }`. The `severity` comes
from `contextSeverity(percent)` (§4). `autoCompactedAt` is `session.lastAutoCompactAt`.
`asOf`/`fresh` drive the staleness note in the gauge tooltip (a list reading reads
"as of {relative updatedAt}"; a live reading is current).

### 7. Client — the fleet rollup selector

`useFleetContextRollup()` (entities/session), shaped after
`use-agent-hottest-status`'s fold, composes `useSessionListSessions()` +
`contextReadings` + the per-runtime model catalogs, resolving each session via the
§6 rule and folding into counts:

```ts
interface FleetContextRollup {
  total: number; // sessions considered
  known: number; // sessions with a resolvable reading
  unknown: number; // no reading (fabricate nothing)
  warning: number; // severity 'warning' (≥80, <95)
  critical: number; // severity 'critical' (≥95)
  autoCompacted: number; // sessions with lastAutoCompactAt present
}
```

"Near full" in the summary copy = `warning + critical`. The same rollup feeds the
staged dashboard tile later (Decision 1), so it is built runtime-neutral and
surface-agnostic now.

### 8. Client — the two surfaces

**a. Per-row gauge — `SessionRow` (`entities/session/ui/SessionRowFull.tsx`).**
The row today receives only `session: Session` and derives its border via
`useSessionBorderState(session.id)`; it has no context data. Add a small
`SessionContextGauge` (entities/session/ui) fed by `useSessionContextHealth(session)`,
placed in the line-1 icon cluster (`SessionRowFull.tsx:151`, beside the
pending/bypass icons). Design-system "quiet, not alarm" (`designing-frontend`):

- **Known** — a compact percent with a **severity-tinted** treatment: `ok` is
  muted/no tint, `warning` amber, `critical` red — colors read off
  `contextSeverity` (§4), matching `ContextItem`. Prefer a small ring/bar over a
  loud badge; the gauge is glanceable, not shouting.
- **Auto-compacted marker** — when `session.lastAutoCompactAt` is present, a
  discreet glyph (e.g. a small `Layers`/recycle mark) with a tooltip
  "Auto-compacted {relative time}." Presence-in-tail _is_ the recency signal (§2);
  the tooltip shows the time so the operator judges recency.
- **Unknown** — a **muted** glyph (no number, no color), tooltip copy below.
  Never 0%.
- **a11y** — the gauge root carries `aria-label` "Context {N}% full" (known) or
  "Context usage unknown"; decorative ring/dot elements are `aria-hidden`.
  The gauge must not steal the row's click target (it is presentational within
  the `role="button"` row).

**b. Fleet summary bar — Sessions/Overview tab.** A new
`FleetContextBar` (features/session-list/ui), modeled on `RelayHealthBar`
(`features/relay/ui/RelayHealthBar.tsx`): the `border-b px-3 py-1.5 text-xs`
bar shell, a `DOT_COLORS`-style severity→dot map, and a plain-language count row.
Fed by `useFleetContextRollup()`. Placed at the top of `SessionsView`'s scroll
region (above the list, mirroring the existing `warnings` block precedent,
`SessionsView.tsx:64-70`) — or, if a bar that persists across tabs is preferred,
between `SidebarTabRow` and `SidebarContent` in `SessionSidebar` (`:85–:87`).
DECOMPOSE picks one placement; the component is placement-agnostic. Unlike
`RelayHealthBar`'s single-message form, this renders a **multi-count** row
("N near full · N auto-compacted"), so build the count row new using the same
dot-color + `aria-hidden`-dot + real-`button` (if it links to a filtered view)
patterns. Hidden entirely when the fleet has zero known readings **and** zero
near-full/compacted sessions (nothing to say ⇒ no bar).

### 9. Honesty / unknown states (Decision 5)

- **"Unknown" = field-absence**, not a flag. A row is unknown when it has no live
  reading and no `contextTokens` (codex/opencode closed sessions; a claude-code
  session whose tail is unreadable) or no model window in the catalog. No new
  `RuntimeCapabilities.supportsContextUsage` — the honest-degradation vehicle
  (`warnings[]`) and field-presence already exist.
- **Whole-runtime failure** already surfaces as an ADR-0310 `warnings[]` entry
  (`SessionListResponse.warnings`, rendered in `SessionsView`); the fleet bar
  need not re-report it.
- **codex** — list rows unknown; a reading appears only while a session is open
  (live fan-out). **opencode** — same.
- The unknown state must read as **deliberate**, not broken: a muted glyph +
  clear tooltip, never a fake 0% or a red error.

## User Experience

- **Scanning the fleet (Kai):** the session list shows a small context gauge on
  each row. Two rows sit amber ("near full"), one red ("at the ceiling"), most
  are quiet. A summary bar reads "2 near full · 1 auto-compacted" at a glance —
  he clicks into the red one to compact it (where the shipped `CompactionChip`
  owns the one-click fix).
- **A session just auto-compacted:** its row shows a discreet marker; hovering
  reads "Auto-compacted 4 minutes ago." An hour later, once the boundary scrolls
  out of the readable tail, the marker quietly disappears (disclosed limitation).
- **A codex or opencode closed session:** the gauge is a muted "unknown" glyph;
  hovering reads the honest tooltip. Opening the session lights the gauge live.
- **A settled claude-code session:** keeps its last reading (retained in the
  store and/or carried on the list DTO) instead of blanking the instant it goes
  idle.

**Empty / unknown copy (verbatim, `writing-for-humans`):**

- Unknown gauge tooltip: **"Context usage isn't available for this session yet.
  Open it to see live usage."**
- Auto-compacted marker tooltip: **"Auto-compacted {relative time} to free up
  context."**
- Summary bar, all healthy: **"All sessions have room."**
- Summary bar, with pressure: **"{n} near full · {m} auto-compacted"** (drop a
  clause when its count is 0; both 0 ⇒ the bar is hidden, not "0 near full").
- List reading staleness (known-but-not-live tooltip line): **"as of {relative
  updatedAt}."**

## API / data model changes

- **`@dorkos/shared`** (`schemas.ts`): `SessionSchema` gains `lastAutoCompactAt?`
  and a documented `contextTokens?`; OpenAPI regenerated. No `RuntimeCapabilities`
  change, no `conf` migration, no SQLite change.
- **Server** (`services/runtimes/claude-code/sessions/transcript-reader.ts`):
  `readTailStatus` returns `lastAutoCompactAt`; `extractSessionMeta` folds the
  tail read (mtime-cached); `getSession` simplified. No codex/opencode adapter
  change.
- **Client:** new `entities/session/lib/context-health.ts` (+ barrel); four
  existing percent sites migrated onto it; `session-list-store` gains
  `contextReadings` + selector; new `useSessionContextHealth`,
  `useFleetContextRollup`, `SessionContextGauge`, `FleetContextBar`.

## Testing Strategy

- **Server — tail read + cache (`transcript-reader` tests):** a listed
  claude-code session carries `contextTokens` from a tail with `usage`; a tail
  with a `compact_boundary`+`trigger:'auto'` yields `lastAutoCompactAt` (and a
  `trigger:'manual'`-only tail yields none); the mtime cache serves a second
  list call with **no** re-read (assert via a read spy) and re-reads after an
  mtime bump; a session with no tail tokens omits `contextTokens` (⇒ unknown).
- **Server — aggregation/degradation (`FakeAgentRuntime` + scenarios,
  `aggregate-session-list`):** with a claude-code runtime producing readings and
  codex/opencode producing token-less rows, the merged list carries readings only
  for claude-code and the others' rows omit `contextTokens`; a rejecting runtime
  contributes a `warnings[]` entry and zero rows (ADR-0310), never failing the
  aggregate. Use `runtimeConformance` to confirm no adapter is forced to produce
  a reading.
- **Client — shared source (`context-health` tests):** `deriveContextPercent`
  (formula, null on missing/zero window, 100 cap); `contextSeverity` boundaries
  (79/80/94/95); `resolveDisplayContextPercent` prefers SDK `percentage`.
  Regression: `ContextItem` and the compaction chip still color/threshold
  identically after migration (they now share the constant).
- **Client — merge rule (`useSessionContextHealth`, RTL/hook):** live wins over
  list; list-only resolves via the model catalog window and is marked `fresh:false`
  "as of updatedAt"; no live + no `contextTokens` ⇒ `unknown`; a model absent
  from the catalog ⇒ `unknown` (not 0%).
- **Client — store retention (`session-list-store` tests):** a `session_status`
  with `contextUsage` populates `contextReadings`; a following
  `idle`/`interrupted` prunes `statuses[id]` but **retains** `contextReadings[id]`;
  `session_removed`, rekey-retire, and `resetStatuses` clear it.
- **Client — rollup (`useFleetContextRollup`, RTL):** counts across a mixed fleet
  (known/warning/critical/unknown/auto-compacted); "near full" = warning+critical;
  unknown never counted as a reading.
- **Client — surfaces (RTL):** `SessionContextGauge` renders known (severity
  color), unknown (muted glyph + tooltip copy), and the auto-compacted marker;
  `FleetContextBar` renders the count row, the all-healthy copy, and hides when
  nothing to say; a11y labels present.
- **E2E (`apps/e2e`, optional):** in the cockpit (test-mode runtime), a session
  list shows a gauge on rows and a summary bar; an "unknown" row reads muted, not
  broken.

Each test carries a purpose comment; no always-pass tests.

## Performance Considerations

- **Tail-read cost** is the one real cost (§1). It is `O(changed claude-code
sessions)` per list call, bounded by the `mtimeMs` cache: settled transcripts
  are served from cache with no head/tail read. Each changed session adds one
  file open + a 16 KB read + a ~forty-line JSON scan (sub-millisecond). **Measure**
  under a fleet of many active sessions before reaching for the deferred batched
  endpoint (ideation Option 3, `GET /api/sessions/context-health?ids=…`); it is
  premature for a size-5 and is not built here.
- **Client** is negligible: `deriveContextPercent` is arithmetic; `useModels` is
  cached (`staleTime` 30 min) and deduped by query key across rows; the rollup is
  a fold over the already-in-memory session list + store. `contextReadings` is
  bounded (reset on reconnect).

## Security Considerations

None new. `contextTokens` and `lastAutoCompactAt` are non-sensitive counts/
timestamps derived from transcripts the operator already owns; the tail read
stays within the existing boundary-validated transcript directory. No new route,
no new auth surface, no new external fetch.

## Documentation

- Inline TSDoc on every new export (Hard Rule 4) — the shared `context-health`
  module, the new DTO field, the store selector, the hooks, the components.
- A short user-facing note (docs/ session or cockpit page, where session-list
  features are described) that context health now appears per-row and as a fleet
  summary, and that some runtimes show "unknown" until a session is open — framed
  honestly (do not claim codex/opencode fleet readings that don't exist).
- Changelog fragment (`changelog/unreleased/`, timestamp-id + slug): "See which
  agents are near their context ceiling at a glance," in `writing-for-humans`
  voice; note the honest per-runtime coverage.
- The proposed ADR (see Related ADRs).

## Implementation Phases

- **Phase 1 — shared client source:** `entities/session/lib/context-health.ts`
  (formula + thresholds + severity + display resolver) and migrate the four
  existing percent sites + the chip threshold onto it. Pure, isolated, compiles
  standalone; regression tests prove no behavior change. **This lands first so no
  later phase adds a fifth copy.**
- **Phase 2 — server + DTO:** `SessionSchema` (`lastAutoCompactAt` + documented
  `contextTokens`), OpenAPI regen; extend `readTailStatus`; fold the tail read
  into `extractSessionMeta`; simplify `getSession`; `FakeAgentRuntime`/fixtures;
  server + aggregation tests.
- **Phase 3 — client data + merge:** `session-list-store` `contextReadings`
  retention + selector; `useSessionContextHealth` merge rule; `useFleetContextRollup`;
  store + hook tests.
- **Phase 4 — surfaces:** `SessionContextGauge` on `SessionRow`; `FleetContextBar`
  on the Sessions/Overview tab; honest unknown/auto-compacted states + copy; RTL
  - optional e2e; docs + changelog + draft ADR.

## Acceptance Criteria

- [ ] A listed claude-code session carries `Session.contextTokens` from the tail
      read, mtime-cached (no re-read on an unchanged transcript); codex/opencode
      closed-session rows omit it.
- [ ] A claude-code session that auto-compacted (boundary in the readable tail)
      carries `Session.lastAutoCompactAt`; a manual-only or scrolled-out
      compaction carries none.
- [ ] Exactly **one** client percent-derivation + threshold source exists
      (`context-health.ts`); `ContextItem`, the compaction chip,
      `derive-status-bar`, `use-session-status`, and both new surfaces import it;
      the old inline thresholds and duplicate formulas are gone.
- [ ] Each session row shows a quiet context gauge: severity-tinted percent when
      known (amber ≥80, red ≥95, matching `ContextItem`), a muted "unknown" glyph
      otherwise (never a fake 0%), and a discreet auto-compacted marker when
      `lastAutoCompactAt` is present.
- [ ] The Sessions/Overview tab shows a fleet summary bar ("N near full ·
      N auto-compacted"), hidden when there is nothing to report; counts come from
      the rollup selector and exclude unknown rows.
- [ ] Live wins over list: an open session's `session_status` reading overrides
      its list reading; a settled session retains its last reading
      (`session-list-store` keeps `contextReadings` while still pruning the
      liveness/border signal).
- [ ] Percent is derived client-side from the model catalog window; a model with
      no catalog window resolves to "unknown," not 0%.
- [ ] No `RuntimeCapabilities` change, no `conf` migration, no SQLite change;
      whole-runtime failure still degrades via `warnings[]` (ADR-0310);
      `runtimeConformance` passes for every runtime.
- [ ] The dashboard tile, durable compaction persistence, a codex registry patch,
      and opencode sidecar message reads are **not** implemented (out of scope).

## Open Questions

Both ideation Open Questions were resolved by the LOCKED operator decisions.

- ~~**A. "Auto-compacted recently" — tail-derive vs. durable `lastCompactedAt`.**~~
  **(RESOLVED — Decision 4.)** v1 tail-derives from `compact_boundary` +
  `trigger:'auto'` (`Session.lastAutoCompactAt`); the recency window is the
  readable tail, and the cutoff behavior (the marker disappears once the boundary
  scrolls out of the ~16 KB tail) is disclosed. Durable persistence is a recorded
  follow-up, not v1. Rationale: the near-ceiling gauge is ~90% of the value; the
  marker is a cheap, honest add on the tail read that already runs; durable
  persistence is a schema/migration that overruns a size-5.
- ~~**B. Cross-runtime honesty — explicit capability vs. field-presence.**~~
  **(RESOLVED — Decision 5.)** Field-presence + `warnings[]`; **no** new
  `RuntimeCapabilities.supportsContextUsage`. Rationale: no capability to keep in
  sync across four caps constants; the absence of a reading (plus the shipped
  per-runtime warning) is itself the honest signal, and "unknown" is rendered as
  a deliberate muted state.

No floor-level blockers remain — direction is fully pinned.

## Related ADRs

- **ADR-0310** (runtime-owned storage + per-runtime session-list degradation) —
  the aggregation this feature rides; the `warnings[]` vehicle carries whole-
  runtime degradation and field-absence carries per-session "unknown."
- **ADR-0263 / ADR-0264** (durable session projection + single delivery) — the
  `session_status` fan-out that supplies the live-freshness override.
- **DOR-112** (`CompactionChip`) — the one-click compaction fix the fleet view
  links into; the review that forced the chip to agree with `ContextItem`'s
  threshold is honored and _hardened_ here by extracting the shared constant.
- **DOR-100** (`UsageStatus`) — the cost/spend sibling dimension; coordinated,
  not merged.
- **Proposed ADR (extract at `/adr:from-spec`):** _"Fleet-level context health —
  best-effort list reading + live override, honest per-runtime degradation"_ —
  the two-layer data path (tail-read list reading + `session_status` live
  override), the client-side percent derivation against the model catalog with a
  single shared source, and the field-absence + `warnings[]` honesty model that
  extends ADR-0310's per-runtime degradation to a new displayed dimension.

## References

- DOR-113 (issue) — the work item.
- `specs/fleet-context-health/01-ideation.md` — ideation, decisions, blast radius.
- `packages/shared/src/schemas.ts:112-127` (`SessionSchema`), `:401-430`
  (`SessionListWarning`/`SessionListResponse`), `:769-779` (`ContextUsage`),
  `:1048-1061` (`CompactBoundaryEvent`), `:1511-1525` (`CompactMetadata`),
  `:2274-2323` (`ModelOption`).
- `packages/shared/src/session-stream.ts:55-162` (`SessionContextUsage` /
  `SessionStatus`).
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts:88-224`
  (list/head/tail reads + `metaCache`), `.../sdk/context-tokens.ts:25`
  (`sumContextTokens`), `.../sessions/transcript-parser.ts:33,51-56,529`
  (compaction record).
- `apps/server/src/services/session/aggregate-session-list.ts` (ADR-0310 fan-out),
  `session-state-projector.ts:186,436-445`, `session-list-broadcaster.ts:72-75`.
- `apps/server/src/services/runtimes/codex/{session-registry.ts:35-42,162,codex-runtime.ts:563,event-mapper.ts:119-143,runtime-constants.ts:81}`.
- `apps/server/src/services/runtimes/opencode/{session-mapper.ts:126-140,event-mapper.ts:466,models.ts:46}`.
- `apps/client/src/layers/entities/session/model/{use-session-status.ts:77-95,use-models.ts,session-list-store.ts:137-168,use-agent-hottest-status.ts}`.
- `apps/client/src/layers/features/status/ui/ContextItem.tsx:22-24`,
  `.../features/chat/model/status/use-compaction-chip.ts:23`,
  `.../features/chat/model/stream/derive-status-bar.ts:39-43`,
  `.../features/chat/ui/status/ChatStatusSection.tsx:264-269`,
  `.../features/relay/ui/RelayHealthBar.tsx`,
  `.../entities/session/ui/SessionRowFull.tsx:151`,
  `.../features/session-list/ui/{SessionsView.tsx:64-70,SessionSidebar.tsx:85-87}`.
