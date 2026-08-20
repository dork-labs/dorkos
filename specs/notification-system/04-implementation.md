# Implementation record — Unified notification system

Programme executed 2026-08-19 → 2026-08-20 by an orchestrated fleet (one
Fable-5 orchestrator, Sonnet/Opus implementers, Opus adversarial reviewers per
REVIEW.md before every PR). All 14 tasks shipped and merged; the Linear
project "Unified notification system" (DOR-1378..DOR-1391) is completed.

## What shipped, by PR

| Task     | PR             | What landed                                                                                                        |
| -------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| DOR-1380 | #1140          | Parked schedules announce themselves (SSE + activity on MCP create; live task list)                                |
| DOR-1378 | #1141          | One failed action shows one error toast (meta contract + source-scan guard)                                        |
| DOR-1382 | #1142          | Tray says "N working · M waiting"; mobile asks get full cards                                                      |
| DOR-1381 | #1144          | One attention engine; schedule approvals everywhere; idle rows leave Home                                          |
| DOR-1379 | #1145          | One CopyFeedback component; redundant/mis-styled toasts deleted                                                    |
| DOR-1383 | #1146          | The pipeline: registry, notify(), rows + delivery ledger, addressed SSE, routes                                    |
| DOR-1386 | #1147          | Electron native notifications with Allow/Deny/Reply; ADR 0009 superseded                                           |
| DOR-1384 | #1148 (+#1149) | The Inbox: bell, popover, read state, agent/session lenses                                                         |
| DOR-1388 | #1150          | DM/@-mention → Inbox; mute suppresses server-side; read cursor auto-reads                                          |
| DOR-1385 | #1151          | Sound family (knock/settle), browser notifications, permission primer, Settings tab, config leaf                   |
| DOR-1389 | #1152          | Daily Shift Report (trailing 24h) on Home                                                                          |
| DOR-1387 | #1153          | Web push + the escalation ladder (arm/disarm/boot re-arm, VAPID, sw.js, ReachMe)                                   |
| DOR-1390 | #1154          | PWA readiness: manifest, icons, honest Add-to-Home-Screen copy                                                     |
| DOR-1391 | #1155          | Sidebar integration: schedule-approval in Heads up, idle retired into the digest, six accumulated deferrals closed |

## Deviations from the spec (each argued in its PR/ADR)

- `notify()` split into typed `notify()` (events) + `resolveStanding()`
  (standing kinds) — the compiler enforces the storage rule.
- Own-action rows store already-read instead of dropping (history stays
  complete).
- Escalation "notification read" ack removed as unreachable (standing kinds
  store no row while standing); recorded in ADR 260819-234829's notes.
- Boot re-arm capped at 4 h (implementer judgment, mutation-pinned).
- `dm.received` coalesces per room per window; mentions stay per-entry.
- Schedule-removal outcome is `cancelled` (unread) except the operator's own
  Reject (`rejected`, read).
- The Shift Report window is the trailing 24 h from composition (orchestrator
  decision after a REWORK verdict).
- The Inbox bell counts/renders its three raw queues and was deliberately not
  switched to the signal derivation (tray-answerable vs needs-you).

## Follow-ups filed (Linear, same project)

- A real person's bridged DM raises no notification (decision needed).
- iOS push relay decision (cloud infra; PWA readiness shipped without claims).
- Desktop macOS smoke: verify both Allow and Deny render as buttons on one
  banner (signed dev build; recorded in ADR 260819-234830's notes).

## Verification posture

Every branch: targeted + full-suite verification, adversarial review with
mutation testing (every review round proved at least one assertion could
fail), changelog fragments in plain language, OpenAPI docs regenerated where
routes changed. Two mid-programme incidents caught and fixed by the process:
a fixture time-bomb that briefly turned main red (#1149) and a merge-queue
e2e count drift on the final PR.
