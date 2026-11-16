---
slug: session-origin-legibility
number: 260721-153518
created: 2026-07-21
status: ideation
---

# Session origin legibility — distinguish your conversations from automated sessions

**Slug:** session-origin-legibility
**Author:** Claude (orchestrator), directed by Dorian
**Date:** 2026-07-21
**Tracker:** DOR-408

---

## 1) Intent & Assumptions

- **Task brief:** The sidebar agent list shows recent sessions, but the operator cannot tell which sessions are conversations they had in the cockpit versus agent-to-agent traffic (Relay/Mesh), external channel chats (Slack/Telegram via Relay bindings), Pulse scheduled runs, or A2A calls. Returning to "my most recent conversation" routinely lands on an automated session. Add a derived `origin` to sessions and surface it in the UI: origin glyph on session rows, default session lists to human conversations with a quiet reveal of automated ones, and an origin line where session detail is shown.
- **Assumptions:**
  - Origin is a UX affordance, not a security boundary. `from` on the raw relay publish route is caller-supplied; we classify best-effort and do not treat origin as trusted.
  - Only the claude-code runtime receives relay/Pulse/A2A traffic today (it is the only runtime with a relay adapter and the Pulse dispatch target). Codex/OpenCode sessions are always operator-initiated, so they default to `user` with no per-runtime work.
  - Deriving origin at read time from the transcript head is acceptable and preferred: it is retroactive (works for every existing session), requires no migration, and cannot miss the two code paths that bypass `triggerTurn` (relay agent-handler, Pulse scheduler).
  - The existing ~8KB head-scan in `extractSessionMeta` is the right place to classify; no additional file IO is added.
- **Out of scope:**
  - Filtering sidechain/subagent transcripts from session lists (adjacent gap, separate follow-up).
  - Forwarding channel sender identity (`senderName`) into prompts/UI (separate follow-up).
  - Stamping a structured origin into `session_metadata` at creation time (hardening, phase 2 if ever needed).
  - Any change to relay delivery, `<relay_context>` format, or the stripping behavior in `transcript-parser.ts`.
  - Security/authz around who may trigger sessions.

## 2) Pre-reading Log

Four deep code studies completed 2026-07-21 (in-conversation, summarized here; file references verified at study time):

- `packages/shared/src/schemas.ts:112-147` (`SessionSchema`): no origin-like field exists. Fields: id, title, createdAt, updatedAt, lastMessagePreview, permissionMode, runtime, model, effort, fastMode, contextTokens, lastAutoCompactAt, cwd.
- `packages/relay/src/adapters/claude-code/agent-handler.ts:417-444` (`formatPromptWithContext`): every relay-delivered prompt is prefixed with a `<relay_context>` XML block whose `From:` line carries the caller identity (server-injected, not LLM-supplied): a mesh agent subject, `a2a-gateway`, `relay.system.tasks.scheduler`, or a `relay.human.{slack|telegram|webhook}.*`-derived subject.
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-parser.ts:158-187`: `stripSystemTags` / `stripRelayContext` remove that block before the UI ever sees it. The origin trace exists only in raw JSONL.
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts:252-386` (`extractSessionMeta`): scans the first ~8KB of each JSONL for title derivation and already recognizes/skips relay-context and task-notification wrapper messages. This is the natural classification point.
- `apps/server/src/services/tasks/task-scheduler-service.ts:100-113, 403-580`: Pulse runs create a fresh session per run (id = run ULID). Direct branch marks via `=== TASK SCHEDULER CONTEXT ===` systemPromptAppend; relay branch marks via `<relay_context>` with `From: relay.system.tasks.scheduler`.
- `apps/server/src/services/relay/binding-router.ts:374-433, 466-519`: channel sessions keyed per binding strategy (`per-chat` default); durable `{bindingId}:chat:{chatId} → sessionId` map in `sessions.json`.
- `packages/a2a-gateway/src/dorkos-executor.ts:193-353`: A2A messages publish with `from: 'a2a-gateway'` and `conversationId: contextId` → session per A2A context.
- Client: `apps/client/src/layers/entities/session/ui/SessionRowCompact.tsx` (shows `RuntimeMark`; the pattern to follow), `RecentSessionRow.tsx` (no origin/runtime affordance at all), `entities/runtime/ui/RuntimeMark.tsx` + `entities/runtime/config/runtime-descriptors.ts` (the descriptor-registry + muted 12px icon + tooltip pattern), `features/dashboard-sidebar/ui/AgentListItem.tsx` (3-session preview), `RecentSessionsSection.tsx` (5-row cross-agent Recent).
- `research/20260707_mesh-relay-a2a-adapters-deep-review.md`: prior audit of these seams; all found defects remediated. No prior research treats session origin as a first-class concept.

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/shared/src/schemas.ts` — `SessionSchema` gains `origin` + `originLabel`.
  - `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts` — `extractSessionMeta` classifies origin during the existing head-scan.
  - `apps/client/src/layers/entities/session/` — new `OriginMark` UI + origin descriptor registry; `SessionRowCompact`, `RecentSessionRow`, `SessionRowFull` render it.
  - `apps/client/src/layers/features/dashboard-sidebar/` — `AgentListItem` preview list + `RecentSessionsSection` gain default-to-user filtering with an automated-sessions reveal.
  - Session header surface (chat screen) — origin line/chip when origin ≠ user.
- **Shared dependencies:** `RuntimeMark`/`runtime-descriptors` pattern (template), `Tooltip` from shared UI, lucide icons, `formatRelativeTime`, TanStack Query session hooks (`useRecentSessions`, `useAgentSessions`).
- **Data flow:** JSONL head (raw markers) → `extractSessionMeta` classification → `Session` wire object (`origin`, `originLabel`) → `GET /api/sessions` + `/api/sessions/recent` → TanStack Query hooks → row components + sidebar filters.
- **Feature flags/config:** none. Behavior is unconditional; `origin` is optional in the schema (absent = `user`) so other runtimes need no change.
- **Potential blast radius:**
  - Every consumer of `SessionSchema` (client, e2e, test-utils mock factories) — additive optional fields, low risk.
  - Sidebar behavior change (filtering) — the one user-visible behavior change beyond additive marks; must not hide sessions irrecoverably (reveal affordance required).
  - `extractSessionMeta` runs on every session list request — classification must stay allocation-light and within the existing head buffer.

## 4) Root Cause Analysis

Omitted — not a bug fix (the absence of origin data is a design gap, documented in §2).

## 5) Research

- **Potential solutions:**
  1. **Derive origin at read time from transcript-head markers (+ optional side-store enrichment).**
     Pros: retroactive for all existing sessions; no migration; no writes on the bypass paths; classification point already exists (`extractSessionMeta`); zero extra IO. Cons: heuristic (marker text could theoretically change; classification breaks if `<relay_context>` format changes — mitigated by colocated tests); per-runtime (claude-code only, which matches where the traffic is).
  2. **Stamp origin at creation time into `session_metadata` (first-write-wins).**
     Pros: structured, queryable, format-drift-proof going forward. Cons: not retroactive; requires touching both bypass paths (relay agent-handler in `packages/relay`, Pulse scheduler) plus the trigger path; misses every existing session; more moving parts for the same UX outcome.
  3. **Both (stamp new + derive old).** Pros: best long-term. Cons: double the surface for v1; the derive path alone already covers 100% of sessions.
- **Recommendation:** Option 1 now. Option 2 is a hardening follow-up only if marker drift ever becomes real (the markers are produced by our own code and covered by tests, so drift is controlled in-repo).

## 6) Decisions

Operator delegated decisions to the orchestrator (2026-07-21). All resolved:

| #   | Decision                                                               | Choice                                                                                                                                                                                                                                                                   | Rationale                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Origin taxonomy                                                        | `user \| agent \| channel \| task \| external`                                                                                                                                                                                                                           | Maps 1:1 to the five real pathways (cockpit, relay agent-to-agent, relay human channels, Pulse, A2A). `external` = A2A gateway; future non-A2A external ingress can reuse it. |
| 2   | Where classification lives                                             | `extractSessionMeta` head-scan in the claude-code transcript-reader                                                                                                                                                                                                      | The scan already reads the head and already recognizes the wrapper messages; retroactive; no migration; other runtimes default to `user` by omission.                         |
| 3   | Schema shape                                                           | `origin?: enum` + `originLabel?: string`, both optional; absent ⇒ `user`                                                                                                                                                                                                 | Additive and backward-compatible across client/server versions and other runtimes; no allowlist changes (no new SessionEvent members).                                        |
| 4   | Classification signals                                                 | `<relay_context>` `From:` line (parse subject → agent/channel/task/external) and `=== TASK SCHEDULER CONTEXT ===` (→ task); no marker ⇒ user                                                                                                                             | These are the only durable markers, produced by our own code; both appear within the head buffer as the first message content.                                                |
| 5   | `originLabel` fidelity (v1)                                            | Best-effort from the marker text alone: channel kind ("Telegram", "Slack", "Webhook"), task ("Scheduled task", plus job name from the task-context block when present), agent (short sender subject), external ("A2A client"). No cross-service lookups from the reader. | Keeps the reader dependency-free and fast. Friendly agent names / chat titles via mesh + binding side-stores are a labeled stretch, not v1 scope.                             |
| 6   | Row indicator                                                          | New `OriginMark` in `entities/session`, descriptor-registry pattern mirroring `RuntimeMark`; rendered ONLY when origin ≠ user                                                                                                                                            | Unmarked = you (matches `AgentActivityBadge` render-null precedent); calm-tech: automation is marked, humans are not.                                                         |
| 7   | Sidebar default filtering                                              | Agent expand preview (3 rows) and cross-agent Recent (5 rows) show `user`-origin sessions by default, with a one-line "+ N automated" reveal that expands them in place (component state, not persisted)                                                                 | Directly fixes the stated job ("my most recent conversation is the top row"); reveal keeps nothing irrecoverable; no config/persistence complexity in v1.                     |
| 8   | Session header + detail                                                | Chat session header shows a muted origin chip when origin ≠ user; `SessionRowFull` expanded panel gains an "Origin" line                                                                                                                                                 | Once opened, a session should say what it is; detail panel matches existing Runtime/Permissions lines.                                                                        |
| 9   | Sidechain filtering & sender-identity forwarding                       | Out of scope; file as follow-up tickets at DONE                                                                                                                                                                                                                          | Same user job but independent mechanisms; keeping v1 shippable in one PR-sized change per surface.                                                                            |
| 10  | Full session-history surface (`SessionSidebar` / session-list feature) | Gets `OriginMark` on rows but NOT default filtering in v1                                                                                                                                                                                                                | It is the "see everything" surface; filtering there needs grouping UX that deserves its own pass.                                                                             |

**Recommended next step:** SPECIFY — the decisions above freeze the shape; the spec enumerates exact fields, classification rules, component contracts, and test plan.
