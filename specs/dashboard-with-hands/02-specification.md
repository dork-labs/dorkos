# Dashboard With Hands — Specification (Tier 2, DOR-418)

**Id:** 260722-120505 · **Status:** specified · **Depends on:** Tier 1 (DOR-417) — the `first-message` agent-birth seam (ADR 260722-111316) must be on main before this executes.

## Summary

Three changes to the `/` dashboard, all inside the existing section/slot architecture (`widgets/dashboard`, `dashboard-contributions.tsx`): a new composer section at the top, a new "Your agents" card section, and outcome-language rewording of the system status row. Plus one removal: the Tier 0 stopgap "New conversation" header button, which the composer supersedes.

## 1. Dashboard composer (new section, first priority)

A full-width section at the top of the dashboard body:

- Prompt heading: **"What are we building today?"** (the same question DorkBot's onboarding hand-off asks — deliberate continuity).
- A single-line composer reusing `ChatInput` (fully controlled, presentational; same reuse decision as the onboarding conversation — never `ChatInputContainer`). Placeholder: "Message {defaultAgentDisplayName}…" with the resolved default agent's display name ("Message DorkBot…" on a fresh install).
- **Submit** = the `first-message` seam end-to-end: generate a fresh session id, `useAgentBirthStore.register(sessionId, { kind: 'first-message', kickoffMessage: <text>, path: defaultAgentDir, ... })`, then `navigate({ to: '/session', search: { dir: defaultAgentDir, session: sessionId } })`. The user lands in a live session with their message already sent as their own user turn. Reuse `useDefaultAgentSession` / `resolveDefaultAgentDir` (entities/config) for the target.
- Empty submit does nothing; the composer never blocks on agent health (the session surface owns error honesty).
- FSD home: the section component lives in `widgets/dashboard` (a widget may compose features/entities); registered in `dashboard-contributions.tsx` with a priority ABOVE `NeedsAttentionSection` (composer is the hero, attention items directly under it). Verify the priority ordering renders as: composer → needs-attention → promos → status → activity.
- **Removal:** the Tier 0 "New conversation" `DashboardHeader` action button is deleted (superseded; one affordance, not two). Its test moves to the composer's suite. "Talk to DorkBot" stays in the Getting Started card (different surface, different lifecycle).

## 2. "Your agents" cards (new section, after needs-attention/promos, before system status)

- Cards for up to 6 agents ordered by: default agent first, then most-recent activity; overflow row links to `/agents` ("All agents →").
- Each card: `AgentAvatar`/`resolveAgentVisual`, display name, one-line human status derived from the existing attention model — vocabulary: `fresh` → "New — say hello", `active`/streaming → "Working now", `needs-attention` → "Needs your OK", `idle` → "Idle since {relative}", `inactive` → "Resting since {relative}" (never "Stale"/"Never"; reuse/extend the Tier 0 `lastSeenLabel`/attention vocabulary — one source of truth, no duplicate mapping tables).
- Click anywhere on the card → session with that agent (same navigation shape as the sidebar's `handleSelectAgent`: `{ to: '/session', search: { dir: agentPath } }`).
- Fresh install renders exactly one card (DorkBot, "New — say hello") — this plus the composer makes the post-onboarding dashboard self-sufficient without the sidebar.
- Data: the same agent list the sidebar consumes (entities-level hooks); no new endpoints.

## 3. System status in outcomes (reword, no data change)

`SystemStatusRow` cards keep their data, deep-links, and health signals; the copy layer changes:

- Tasks: "Nothing scheduled yet" / "{n} scheduled" (deep-link unchanged).
- Relay: "Connected to {adapter display names}" ("Connected to Claude Code"), or "No channels connected yet".
- Mesh: "{n} agent{s} ready" / "1 agent ready".
- Activity: "Quiet this week" / "{n} runs this week".
- Internal names (Relay, Mesh) may remain as small captions for operators who know them, but the primary line is the outcome. Exact mapping table lives with the component; copy follows writing-for-humans (plain, concrete, no em dashes, no jargon in the primary line).

## Tests

- Composer: renders with default-agent placeholder; submit registers a `first-message` birth record with the typed text + fresh session id and navigates (assert against the store, mock navigate); empty submit is a no-op; header button is gone (`DashboardHeader.test.tsx` updated).
- Agent cards: ordering (default first, recency next, cap 6 + overflow link); status vocabulary per attention state (exhaustive against `AttentionState` so the next widening fails the build); click navigates with the agent's dir.
- Status row: outcome copy per data shape (0/1/n cases); deep-links unchanged.

## Acceptance (browser-verified on a fresh container + a populated dev environment)

1. Fresh install: dashboard shows composer ("Message DorkBot…") + DorkBot card ("New — say hello"); typing a message lands in a live session with that message sent as the user's turn.
2. Status row reads in outcomes; no "Relay: 1 adapter" as a primary line anywhere.
3. Populated environment: cards ordered default-then-recency, capped with overflow link; every card opens the right agent's session.
4. No duplicate "New conversation" affordances on `/`.

## Execution

Single worktree, single implementing agent, after DOR-417 merges. Phased commits: (1) composer section + header-button removal, (2) agent cards, (3) status outcome language. One changelog fragment per user-facing commit. Auditor review per REVIEW.md before PR.
