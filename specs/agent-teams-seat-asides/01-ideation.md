---
slug: agent-teams-seat-asides
number: 261115-194346
created: 2026-11-15
status: ideation
---

# Private messages into room seats

**Slug:** agent-teams-seat-asides
**Author:** Codex workhorse `/root/trust_reconciliation`
**Date:** 2026-11-15

## 1) Intent & Assumptions

- **Task brief:** DOR-4472 Parts B+C. A registered local agent can answer a seat's DM and send it an unsolicited private message. Both run only through a room seat aside. Each unsolicited accepted write leaves a body-free room trace.
- **Final decisions:** D1 yes, D2 yes, D3 no Telegram/Slack switch, D4 no change to schedules/beats. The user superseded the earlier proposed general origin setting.
- **Sequencing:** DOR-3817 Part A then DOR-4468 must be independently reviewed/opened first. This worktree prepares design only until root authorizes implementation.
- **Pinned code base:** a23056f0a528393a9f3eea312c516ed8660f77b6; seed 51947d1dd320ff6bac0741b72a6d00e2d41f6e63. Canonical CLAIMS entry verified by parent; no competing PR found.
- **Out of scope:** broad chat-origin policy, bridge enable switch, schedule/beat writes, plain seat dispatch/steer/interrupt, seat chat_stop authority, prompt project-lead rollout, DOR-4148 implementation, paid/live tests, arming/releases.

## 2) Pre-reading Log

- `plans/2026-11-15-agent-teams-seat-asides.md` and copied coordination README/security design: final D1-D4 and M2-M9 plus moved-room refusal/current freshness invariant.
- AGENTS.md, rules conventions/testing/server-structure/safe-defaults/room-conduct, `meta/agent-etiquette.md`, room-participation specification: mechanical budgets and quiet shared-room behavior remain.
- Flow IDEATE/SPECIFY/DECOMPOSE doc templates and proof-test methodology: self-contained tasks, red proof for each Must, exact base/head independent reviews.
- `chat-target.ts`: ordinary origins are denied by default; agent-id targets already resolve to DM; replyTargetOf currently validates recipient only, so new seat reply validation must additionally bind the row's sender to that seat.
- `chat-message-service.ts`: ordinary delivery may steer, interrupt or batch in dispatcher queue. None of those operations may become seat delivery.
- `seat-report.ts`: report asides work but are same-agent-only, process-local and chained without a queue bound; do not simply remove the same-agent check.
- `seat-carry.ts`: carryFrom and withRoomMarks preserve sender and room restrictions; outside flags must remain separate from level caps.
- `room-trigger/aside.ts`: real seat/session placement, budget reservation, aside claim and no inherited cascade root already exist. An explicit untrustedText input is missing.
- `limits/teammate-turn.ts`: untrustedText propagates to roomTurn independently of permissionCeiling.
- `chat-message-current.ts`, chat-message-wiring, rooms factory: narrow composition ports can separate this route from auto-reports.
- Existing room budget, session ledger and chat_messages: reuse durable receipts and identity; new explicit route/scope metadata avoids unsafe normal-queue recovery.

## 3) Codebase Map

Verified caller → target classification → immutable seat snapshot and optional validated reply → durable receipt/route plus system trace → bounded per-seat inbox → revalidation/carry join/defused batch → askAside → normal seat runner → explicit status settlement. Only a later explicit post_to_room may put agent body text into the room.

Primary owners: session/chat-messages routing/receipt storage, rooms/handoff private seat-message collaborator, rooms aside/mark helpers, rooms and session composition; narrow DB route metadata and focused tests. No client redesign or config setting required.

## 4) Root Cause Analysis

A seat can DM an agent, but an answer addressed to that seat's chat id fails roomBound in assertChatSendable. A normal dispatch exception would bypass room placement, turn budgets, freshness/cascade and current room marks. The existing aside is safe infrastructure, but report delivery is neither a general peer inbox nor bounded batching.

## 5) Research

1. Extend ordinary origin allowlist: rejected; opens unintended bridged/unattended paths and cannot express room/seat-specific launch requirements.
2. Remove same-agent report guard: rejected; does not validate reply claims, bound queue, persist route ownership, or trace unsolicited writes.
3. Dedicated seat-message inbox behind a narrow chat delivery port: recommended; reuse askAside, carry helpers and receipt UI while retaining an independent admission/queue/recovery lifecycle.

Resource defaults proposed and approved as bounded assumptions, not measured ideal values: 25 pending messages per seat, 1,000 pending globally, existing one-hour wait deadline and recheck/release behavior. Rendered batch cap is exactly 5 × CHAT_MESSAGE_MAX including fences/separators/defusing.

## 6) Decisions

| Decision                                | Choice                                                                                      | Rationale                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Explicit bad replyTo                    | NOT_ALLOWED, never reclassify as unsolicited                                                | D2 must not silently validate a spoofed reply claim.                   |
| No replyTo and no outstanding valid ask | Unsolicited route with trace                                                                | D2 grants this reach without forging conversation history.             |
| Target identity                         | Pin room/author/membership epoch; recheck before launch                                     | No stale chat id may silently reach another room or replacement agent. |
| Seat session rekey                      | Same room/member identity allowed after fresh validation                                    | Native runtime ids can change without changing the authorized seat.    |
| Requested steer/interrupt               | Queue and explain downgrade                                                                 | New path is always an aside and never takes over another turn.         |
| Queue durability                        | Persist delivery route and seat scope on chat_messages; fail interrupted rows after restart | Avoid orphan receipts or adoption by normal dispatch. No auto replay.  |
| Trace                                   | One body-free local system notice per accepted unsolicited message                          | Shared room can see private prompting without leaking words.           |
| Next                                    | Root review of complete spec; source remains on hold                                        | First two slices finish review/opening first.                          |
