---
id: 260821-185906
title: The schedule approval moment — informed consent, not a shrug
status: implemented
completed: 2026-08-22
design-session: .dork/visual-companion/46793-1787328179
---

# Implementation record

All five spec tasks plus one review-discovered task shipped 2026-08-21/22,
seven code PRs + one docs PR, every branch adversarially reviewed per
`REVIEW.md` before its PR opened. Orchestrated by a coordinating session
with Sonnet/Opus worktree implementers and Opus reviewers.

## PR map

| Task | Issue    | PR    | What landed                                                                                                                                       |
| ---- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| spec | —        | #1157 | Spec, design decisions, ADR 260821-190444                                                                                                         |
| C2   | DOR-1395 | #1158 | Honest popover nouns + the "nothing runs until you decide" promise kept; mobile SR headings; all-clear fade                                       |
| S1   | DOR-1394 | #1160 | Provenance columns + required `reason` (both doors), proposer-titled notifications, run-once on pending, `nextRuns` preview, operating-skills v11 |
| C3   | DOR-1396 | #1162 | Activity faces + 3+ burst coalescing with ordinal expand keys; link-less rows stop being buttons                                                  |
| C4   | DOR-1397 | #1163 | One signal-id vocabulary; `deriveWaitingItems` + `useWaitingQueue`; agreement test                                                                |
| S2   | DOR-1408 | #1165 | turn.completed / session.error / ask.pending / dead-letter.created stamp `agentId`; escalation relay prefers the ask's own agent                  |
| C1   | DOR-1398 | #1168 | `ScheduleApprovalCard`: face, reason, cadence, first runs, prompt reveal, Run-it-once, A/D, receipts, deferred-delete Undo, settling hold         |

## Deviations from the specification, with reasons

- **S1 absorbed the planned run-once task** pre-dispatch: both would have
  edited `TaskSchema`, `routes/tasks.ts`, and the OpenAPI doc — a
  guaranteed queue conflict. Run-once itself needed almost no new code:
  `POST /api/tasks/:id/trigger` already existed; the work was proving it
  safe on pending rows.
- **`nextRuns` is populated only for `pending_approval` rows** (spec said
  every cron task). The reviewer measured ~1.4 ms of blocked event loop
  per cron task per list call, with no consumer outside the card.
- **The REST door also demands a reason** from untrusted callers (spec
  covered only the MCP door); the PATCH-into-pending door needs none
  because `status` is operator-only in `TASK_WRITE_POLICY` — untrusted
  callers 403 upstream (unreachability proven and documented in place).
- **DOR-1408 was added mid-programme**: C3's review proved the
  highest-volume kinds never carried `agentId`, so faces/coalescing missed
  their main target. Stamping it also improved escalation routing (a
  blocked ask now pings its own agent's chat binding), pinned by test.
- **The card moved from "Needs Attention" to "Waiting On You"** on Home:
  a decision card does not belong in the dense attention-row box, and
  "Needs Attention" keeps the one blockage that is not a decision.
- **Reject undo is a client-side deferred DELETE** (5 s window,
  module-level scheduler surviving unmount, flushing on pagehide) — no
  server-side undo. Tab-close durability is deliberately NOT claimed:
  the transport uses plain fetch, no keepalive/sendBeacon.
- **Approve receipts got a settling registry** (hold through the shared
  exit transition even though the server stops listing the task) —
  review round 1 measured the receipt dying in ~10-60 ms. Capability
  approvals inherit the same pre-existing hole; filed as DOR-1411 rather
  than widening this PR.
- **`askExitTransition` moved to `shared/lib`** (with an `ask` barrel
  re-export): the settling registry made it cross-feature timing
  vocabulary, mirroring the `waiting-kinds.ts` lift.
- **Duplicate same-name proposals deliberately stay independent rows** —
  the operator toggled grouping off in the design session.

## What the reviews caught (highlights)

Every round found something real: the C2 rework silently deleted the
"nothing runs until you decide" promise from five of seven states; S1's
composition-root seam could be severed with 527 tests staying green, and
the seeded operating-skills pack changed without a version bump (existing
workspaces would never have received the new instructions); C3's glyph
slot jittered 4 px (measured in a real browser) and its round-2 fix
introduced a group-key collision where one click expanded two bursts;
C4's byte-identical claim was fuzz-proven over 3,000 randomized
snapshots; S2's review booted a live MeshCore to prove the stamped ULID
is the roster join's key; C1's rounds caught the dying receipt, an
untested destructive path, and a timer leak in brand-new settling code
(fixed with four tests written red-first). Mutation testing ("prove the
test can fail") was demanded in every brief and every fix round.

## Follow-ups

- DOR-1411 — capability-approval receipts get the same settling hold
  (pre-existing flash, inherited precedent).
- ADR 260821-190444 sits at `proposed` awaiting `/adr:review`.

## Verification posture

Each branch: targeted suites + package typecheck/lint green before its
PR; red-proven mutation probes recorded in the agents' reports; full
client suite (997 files / 12,448 tests) green on the final card branch;
merge-queue full-monorepo gates green on every merge.
