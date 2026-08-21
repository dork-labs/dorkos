---
id: 260821-185906
title: The schedule approval moment — informed consent, not a shrug
status: ideation
created: 2026-08-21
design-session: .dork/visual-companion/46793-1787328179
---

# The schedule approval moment

## The problem, in the operator's words

> "Right now it doesn't let me know who requested, why they were requested,
> etc. I don't have any info to either approve or reject the request."

The operator opened the Inbox (shipped in the unified notification system,
PRs #1138–#1156), saw two pending scheduled runs — "Granola meeting sync ·
On the hour, every…" — and had literally nothing to decide with. The gate
says "Nothing runs until you approve it," then gives you nothing to approve
_with_. That is consent theater.

## Why the row is empty (evidence)

Two audits (2026-08-21, this session) established:

**Hidden, but already stored** on every pending `Task` row: the full
`prompt` (the instructions the run will execute), `description`, the exact
`cron` + `timezone`, `permissionMode`, and `createdAt`. The row renders none
of them — one CSS-truncated line.

**Missing entirely, needs plumbing:**

- Who proposed it — `scheduleParkPayload` hardcodes `proposedBy: 'An agent'`
  (`apps/server/src/services/notifications/emitters/schedule-park.ts`).
- Which conversation — `tasks_create` never receives the session id, even
  though `createDorkOsToolServer` resolves `invokingSessionId` at the same
  construction site and threads it into the capability tools
  (`services/runtimes/claude-code/mcp-tools/index.ts`).
- Why — no reason/rationale field exists anywhere in the chain.

**Rough edges in the shipped popover** (same audits): Reject is an
unconfirmed hard delete with no receipt and no undo; no A/D keyboard on
schedule rows (Ask cards have it); four lines of header/explainer chrome
before content, and "N requests are waiting for your answer" mislabels
schedules as questions; all four section headings use `hidden md:block`,
which removes them from the mobile screen-reader tree; Activity rows carry
`agentId` but draw no identity; Activity bursts never coalesce; schedule
rows vanish with no exit animation while sibling Ask cards melt; and the
popover and the sound/banner machinery derive "what's blocking" from two
separate aggregations.

## The direction

One idea with three layers, decided with the operator in the visual
companion (selections recorded; see `design-decisions.md`):

1. **Show what we have.** The proposal becomes a real card in the Ask-card
   family — face, plain-words reason, full cadence, first-run times, and a
   "show exact instructions" reveal. No new surface; the Inbox's existing
   card language.
2. **Capture what we don't.** `tasks_create` gains a `reason`; the proposing
   session and agent identity are stamped on the row; the card and the
   notification name the proposer and link back to the conversation.
3. **Approval by demonstration.** A third action — **Run it once** — executes
   the proposed prompt immediately as a single supervised run, arming no
   timer. The card updates with the result; Approve now rests on evidence
   instead of faith.

Plus the polish set the operator picked: reject receipt + undo, A/D keys,
honest one-line copy, the mobile a11y fix, Activity faces, burst
coalescing, motion parity, and one shared "what's waiting" derivation.

Explicitly rejected: grouping duplicate same-name proposals (operator
toggled it off), and a dedicated review sheet (the card makes it
unnecessary).
