---
slug: session-origin-legibility
number: 260721-153518
created: 2026-07-21
status: specified
---

# Session origin legibility — distinguish your conversations from automated sessions

**Status:** Approved
**Author:** Claude (orchestrator), directed by Dorian
**Date:** 2026-07-21
**Tracker:** DOR-408

## Overview

Add a derived `origin` classification to sessions (`user | agent | channel | task | external`) plus a human-readable `originLabel`, computed server-side from markers that already exist in every transcript head, and surface it in the client: a muted `OriginMark` glyph on session rows (rendered only for non-user origins), default-to-user filtering with a quiet "+ N automated" reveal in the sidebar's session lists, and an origin line in the session header and session detail panel.

## Background / Problem Statement

Every session-creating pathway (cockpit chat, Relay agent-to-agent, Slack/Telegram/webhook channel bindings, Pulse scheduled runs, A2A gateway calls) converges on the same runtime session store, and `SessionSchema` carries no origin information. In the sidebar, an operator returning to "my most recent conversation" routinely lands on an automated session instead. The origin trace exists today only as literal text in the raw JSONL head — the `<relay_context>` block (whose `From:` line is server-injected and names the caller) and the Pulse `=== TASK SCHEDULER CONTEXT ===` append — and `transcript-parser.ts` strips it before any UI surface sees it.

Full research: `specs/session-origin-legibility/01-ideation.md` §2 (four code studies, 2026-07-21). All ten design decisions are resolved in ideation §6.

## Goals

- An operator can tell at a glance which sessions in the sidebar are their own conversations versus automated ones.
- The most recent _conversation_ is the top row of the sidebar session lists by default; automated sessions remain one click away, never hidden irrecoverably.
- An opened session identifies its origin in the header.
- Classification is retroactive: existing sessions classify correctly with no migration and no new writes.

## Non-Goals

- Sidechain/subagent transcript filtering (follow-up ticket at DONE).
- Forwarding channel sender identity (`senderName`) into prompts or UI (follow-up ticket at DONE).
- Creation-time origin stamping into `session_metadata` (hardening; only if marker drift ever becomes real).
- Any change to relay delivery, the `<relay_context>` format, or transcript-parser stripping.
- Origin as a security boundary (it is a UX affordance; `from` on the raw relay publish route is caller-suppliable).
- Default filtering on the full session-history surface (`features/session-list` / `SessionSidebar`) — it gets marks only (ideation decision 10).

## Technical Dependencies

None new. Uses existing: Zod (+ `.openapi()`), lucide-react icons, shared `Tooltip`, TanStack Query hooks, Drizzle read of the existing `pulseRuns` table.

## Detailed Design

### Data model (`packages/shared`)

Add to `SessionSchema` (`packages/shared/src/schemas.ts`, after `lastAutoCompactAt`), both optional so the change is wire-compatible in both directions and other runtimes need no changes:

```ts
export const SessionOriginSchema = z
  .enum(['user', 'agent', 'channel', 'task', 'external'])
  .openapi('SessionOrigin');
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;

// on SessionSchema:
/**
 * Best-effort classification of what initiated this session, derived from
 * durable markers in the transcript head (never persisted, never trusted as
 * a security boundary). ABSENT means user-initiated — the unmarked default —
 * so runtimes that never receive automated traffic need no changes.
 */
origin: SessionOriginSchema.optional(),
/**
 * Short human-readable origin descriptor for non-user origins, e.g.
 * "Telegram", "warden (agent)", "Scheduled task · daily-digest", "A2A client".
 * Absent when `origin` is absent or no better label than the kind exists.
 */
originLabel: z.string().optional(),
```

Semantics: absent `origin` ⇒ `user`. Client resolves via a tiny helper `sessionOrigin(session): SessionOrigin` (defaults `'user'`).

### Server classification — step 1: transcript head (claude-code runtime)

New pure function `classifyOrigin(firstUserMessageRaw: string): { origin?: SessionOrigin; originLabel?: string }` in a new file `apps/server/src/services/runtimes/claude-code/sessions/classify-origin.ts`, called from `extractSessionMeta` in `transcript-reader.ts`.

Hook point: the head-scan loop in `extractSessionMeta` already sees the first `type: 'user'` message and currently `continue`s past ones starting with `<relay_context>`. Capture the FIRST user message's raw text (before the skip-for-title logic) into a `firstRawUserMessage` variable on first encounter, and after the loop call `classifyOrigin(firstRawUserMessage)`. Title derivation is unchanged.

Classification rules (first match wins), applied only when the raw text starts with `<relay_context>` (else, if it starts with `=== TASK SCHEDULER CONTEXT ===` handling per below; else return `{}` ⇒ user):

Parse the `From: <value>` line inside the `<relay_context>` block (the block format is produced by `formatPromptWithContext` in `packages/relay/src/adapters/claude-code/agent-handler.ts:417-444`; colocated tests pin the coupling). Match on `<value>`:

| `From:` value                                                                          | origin          | originLabel                                                                                                   |
| -------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `a2a-gateway`                                                                          | `external`      | `A2A client`                                                                                                  |
| `relay.external.mcp`                                                                   | `external`      | `External MCP client`                                                                                         |
| `relay.system.tasks.scheduler` (or any `relay.system.tasks.*`)                         | `task`          | `Scheduled task` (overlaid with the task name in step 2)                                                      |
| `relay.human.console`                                                                  | `user` (absent) | — (operator via Relay console is still the operator)                                                          |
| contains `telegram` (e.g. `telegram:12345`, `relay.human.telegram.*`, `telegram….bot`) | `channel`       | `Telegram`                                                                                                    |
| contains `slack`                                                                       | `channel`       | `Slack`                                                                                                       |
| contains `webhook` or `relay.human.*` (unrecognized channel type)                      | `channel`       | `Webhook` / `Channel`                                                                                         |
| `relay.agent.*` or `relay.session.*`                                                   | `agent`         | last subject segment, e.g. `01H8… (agent)` → label is the trailing segment truncated to 24 chars + ` (agent)` |
| anything else                                                                          | `external`      | `Relay`                                                                                                       |

`=== TASK SCHEDULER CONTEXT ===`: the direct (relay-disabled) Pulse branch injects this via `systemPromptAppend` (`buildTaskAppend`, `task-scheduler-service.ts:100-116`), which may not appear in JSONL user messages at all. Do NOT rely on it: direct-branch Pulse sessions are covered by step 2. If the marker does happen to appear in a head user message, classify `task`.

Classification runs inside the existing 8KB head read — no additional IO. Results ride the existing mtime cache in `listSessionsInDir`.

### Server classification — step 2: Pulse overlay (runtime-agnostic, aggregation layer)

Pulse runs record their session id durably (`pulseRuns.sessionId`, written via `TaskStore.updateRun`). At the session aggregation layer (`apps/server/src/services/session/aggregate-session-list.ts` / where list results are assembled before the wire), overlay task origin:

- Inject an optional `resolveTaskOrigins(sessionIds: string[]): Map<sessionId, { taskName: string }>` capability (backed by one batched `TaskStore` query over `pulseRuns` joined to `pulseSchedules` — `WHERE sessionId IN (…)`).
- For each listed session present in the map: set `origin = 'task'`, `originLabel = 'Scheduled task · <taskName>'` (overwriting step 1's generic `Scheduled task` label; also catching direct-branch runs step 1 cannot see).
- Single-session reads (`GET /api/sessions/:id`) apply the same overlay.

This keeps `transcript-reader` dependency-free and makes task classification runtime-agnostic. If wiring `TaskStore` into the aggregation site proves awkward, an acceptable fallback is a narrow injected function defined at server composition root (`index.ts`) — but no import of tasks services from inside a runtime adapter.

### API

No new endpoints. `GET /api/sessions`, `GET /api/sessions/recent`, and single-session reads carry the new optional fields automatically. Regenerate the OpenAPI snapshot (the `openapi-fresh` CI check) after the schema change.

### Client (`apps/client`)

**Origin descriptor registry** — `src/layers/entities/session/config/origin-descriptors.ts`, mirroring `runtime-descriptors.ts`:

```ts
export interface OriginDescriptor {
  origin: SessionOrigin;
  label: string; // fallback when session.originLabel is absent
  icon: ComponentType<{ size?: number; className?: string }>;
  accent: string; // CSS var
}
```

Registry (lucide icons, muted accents): `agent` → `Bot`, `var(--color-violet-500)`; `channel` → `MessagesSquare`, `var(--color-sky-500)`; `task` → `CalendarClock`, `var(--color-amber-500)`; `external` → `Globe`, `var(--color-teal-500)`. `user` has no descriptor entry — it is never marked. `getOriginDescriptor(origin)` returns `undefined` for `user`/unknown.

**`OriginMark`** — `src/layers/entities/session/ui/OriginMark.tsx`, mirroring `RuntimeMark` (non-interactive span, `Tooltip`, default `size={12}`, `text-muted-foreground/50`): props `{ origin?: string; label?: string; size?; className? }`. Returns `null` when resolved origin is `user`/absent (the `AgentActivityBadge` render-null precedent). Tooltip text: `originLabel ?? descriptor.label`. `aria-label="Origin: <text>"`.

**Row rendering:**

- `SessionRowCompact.tsx`: render `<OriginMark …/>` immediately before `RuntimeMark`.
- `RecentSessionRow.tsx` (`features/dashboard-sidebar`): render `OriginMark` between title and timestamp. (Still no runtime mark here — out of scope.)
- `SessionRowFull.tsx`: `OriginMark` beside `RuntimeMark` on line 2; expanded detail panel gains an `Origin` row (value: `originLabel ?? descriptor.label ?? 'You'`) alongside the existing Runtime/Permissions rows.

**Default-to-user filtering (dashboard sidebar only):**

Shared pure selector in `entities/session/lib/partition-sessions-by-origin.ts`: `partitionSessionsByOrigin(sessions) → { conversations, automated }` (conversation = resolved origin `user`).

- `AgentListItem` expand preview: partition the agent's sessions BEFORE the 3-row slice; render up to `MAX_PREVIEW_SESSIONS` from `conversations`. When `automated.length > 0`, render a final quiet row `+ N automated` (`text-muted-foreground`, same row height); clicking toggles inline expansion listing the automated sessions (same `SessionRow` compact rendering, capped at `MAX_PREVIEW_SESSIONS`). Toggle is component state (`useState`), not persisted.
- `RecentSessionsSection`: same partition before `MAX_RECENT_ROWS` slice; same `+ N automated` reveal row. Membership/glyph lookups unchanged.
- Empty conversations + non-empty automated: show the reveal row (never an empty section pretending there are no sessions).

**Session header (chat screen):** locate the surface that renders the active session's title in the chat view; add a muted origin chip (icon + `originLabel`) rendered only when origin ≠ user, following the header's existing chip/marker conventions. (Implementer discovers the exact component; it lives in the session/chat feature or widget layer. If the header proves contested/complex, the `SessionRowFull` detail-panel Origin line is the required minimum and the header chip must still ship in this PR — it is small.)

### FSD compliance

`OriginMark`, descriptors, and the partition selector live in `entities/session` (imports from `shared` only). `features/dashboard-sidebar` imports them via the `entities/session` barrel `index.ts`. No new cross-layer edges.

## User Experience

- Sidebar, agent expanded: you see your last 3 conversations; a quiet `+ 2 automated` line reveals the relay/task sessions when you want them. Your most recent conversation is always the top row.
- Cross-agent Recent: same behavior across agents.
- Any session row for a non-user session carries a small muted glyph; hover names it ("Telegram", "Scheduled task · daily-digest", "01H8…X4 (agent)", "A2A client").
- Opening a session: the header shows the same origin identity; the row detail panel lists Origin explicitly.
- Human conversations stay visually unmarked — automation is marked, not people (calm-tech).

## Testing Strategy

- **Unit (server):** `classify-origin.test.ts` — table-driven over every `From:` row above plus: no marker ⇒ `{}`; malformed `<relay_context>` without `From:` ⇒ `external`/`Relay`; `relay.human.console` ⇒ user; task-context marker ⇒ task. A coupling test builds a real `formatPromptWithContext`-shaped block (copied fixture with a comment pointing at `agent-handler.ts`) so format drift fails a test.
- **Unit (server):** `transcript-reader` tests extend existing fixtures: a JSONL whose first user message is a relay-context block classifies `agent` and still derives its title from the first REAL user message (existing skip logic unchanged); a plain session yields absent `origin`.
- **Unit (server):** aggregation overlay — fake `resolveTaskOrigins` returning a mapping; assert `origin: 'task'` + label overlay, and that non-matching sessions pass through untouched.
- **Unit (client, RTL):** `OriginMark` renders null for user/absent/unknown; renders icon + tooltip label for each origin; `partitionSessionsByOrigin` pure tests; `AgentListItem`/`RecentSessionsSection` — conversations first, reveal row appears only when automated exist, toggle reveals automated rows; `SessionRowFull` detail shows Origin line.
- **Mock factories:** extend `@dorkos/test-utils` session factory with optional `origin`/`originLabel` passthrough.
- **E2E:** none required (no new routes; behavior covered by RTL). Existing e2e must stay green (fields optional).

## Performance Considerations

Classification is string inspection of an already-read 8KB buffer, cached under file mtime — zero added IO on the list path. The Pulse overlay adds one batched SQLite query per list assembly (indexed `IN` over ≤ list size ids); measure nothing, it is trivially cheap.

## Security Considerations

Origin is best-effort and advisory. The raw relay publish route lets callers assert `from` (gated only against reserved principals), so a malicious local caller can influence classification — acceptable for a single-operator local cockpit; documented in code TSDoc. No new attack surface: no new endpoints, no new writes.

## Documentation

- Changelog fragment (`changelog/unreleased/<id>-session-origin.md`) — user-facing, `writing-for-humans` register.
- TSDoc on all new exports (hard rule 4).
- `docs/` guide touch-up only if a session-list guide already exists (check `docs/`; do not create a new page for this).

## Implementation Phases

- **Phase 1 — server truth:** shared schema fields + `classifyOrigin` + `extractSessionMeta` hook + Pulse overlay + OpenAPI regen + tests + factory updates.
- **Phase 2 — client surfaces:** origin descriptors + `OriginMark` + row integrations + sidebar partition/reveal + session header chip + detail-panel line + RTL tests.
- Single PR from one worktree (cohesive feature, all additive; size 5).

## Open Questions

~~1. Is the `=== TASK SCHEDULER CONTEXT ===` append visible in JSONL user messages for direct-branch Pulse runs? **(RESOLVED)**~~ — Answer: treat as unknown and do not depend on it; the Pulse DB overlay (step 2) classifies task sessions deterministically for both branches. Rationale: `systemPromptAppend` likely never appears as a user message; the side-store is authoritative either way.

No other open questions — all design decisions resolved in ideation §6 under delegated authority.

## Related ADRs

- New draft: `decisions/` — "Derive session origin at read time from transcript-head markers" (extracted from this spec).
- ADR-0076 (mesh ULID vs SDK UUID dual-id), ADR-0255/0260 (session metadata first-write-wins), ADR-0310 (runtime-owned session storage), ADR-0273 (structured context prepend), ADR 0046/0130/0131 (binding router), 0224 (channels vocabulary).

## References

- DOR-408; `specs/session-origin-legibility/01-ideation.md` (research + decisions).
- Key code: `packages/shared/src/schemas.ts` (SessionSchema), `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts` (`extractSessionMeta`), `packages/relay/src/adapters/claude-code/agent-handler.ts` (`formatPromptWithContext`), `apps/server/src/services/tasks/task-scheduler-service.ts` (`buildTaskAppend`), `apps/server/src/services/session/aggregate-session-list.ts`, client `entities/runtime/ui/RuntimeMark.tsx`, `entities/runtime/config/runtime-descriptors.ts`, `entities/session/ui/SessionRow*.tsx`, `features/dashboard-sidebar/ui/{AgentListItem,RecentSessionsSection,RecentSessionRow}.tsx`.
- `research/20260707_mesh-relay-a2a-adapters-deep-review.md`.
