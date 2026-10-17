# Doc Channel takeover from Codex

**Date:** 2026-10-17
**Issue:** DOR-2665
**New owner:** DorkOS (Claude Code), started from the coordinating chat on Dorian's request.
**Why:** Codex ran out of usage. The built-in canvas type "Stage" needs task 3.2
(frame bridge) and task 5.2 (route controls), so the programme can't wait.

## Liveness check

Nobody else was writing when this takeover started (2026-10-17, ~21:00 UTC):

- No running `codex` process (only the ChatGPT Chrome extension host and the
  cmux helper, neither of which writes to a checkout).
- The newest uncommitted change in any Codex worktree is from 2026-10-15
  (`doc-room34-verify`).
- No open PR touches these files except Codex's own draft #2673 and the
  unrelated managed-browser draft #2686.

## Inventory and saved work

Every Codex worktree's uncommitted changes and local-only commits are saved to
a pushed `wip/<worktree>` branch. They were saved with a temporary git index
(`GIT_INDEX_FILE` + `commit-tree`), so the worktrees themselves, their index and
their `HEAD` are untouched. No worktree was deleted. Ahead/behind is against
`origin/main` at `92793bc2f4`.

| Worktree (`~/.codex/worktrees/<name>/dorkos`) | Branch                             | Behind / ahead | Uncommitted            | Saved to                         | Verdict                                                                                               |
| --------------------------------------------- | ---------------------------------- | -------------- | ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| doc-channel-metrics-http                      | codex/doc-channel-metrics-http     | 532 / 1        | 7 files                | wip/doc-channel-metrics-http     | Superseded by #2471                                                                                   |
| doc-channel-recovery                          | codex/doc-channel-authority        | 537 / 1        | 3 files (spec journal) | wip/doc-channel-recovery         | Spec journal only; history                                                                            |
| doc-checkbox-authority                        | codex/doc-checkbox-authority       | 520 / 0        | 22 files               | wip/doc-checkbox-authority       | Superseded by #2507                                                                                   |
| doc-checkbox-identity                         | codex/doc-checkbox-identity        | 534 / 0        | 3 files                | wip/doc-checkbox-identity        | Superseded by #2507                                                                                   |
| doc-events-sdk-boundary                       | codex/doc-events-sdk-boundary      | 533 / 2        | 5 files                | wip/doc-events-sdk-boundary      | Superseded by #2471, #2913                                                                            |
| doc-frame-lifetime                            | detached at 501d3ca1a6             | 520 / 0        | 12 files               | wip/doc-frame-lifetime           | Superseded by main + frame host bridge                                                                |
| doc-installation-mutations                    | codex/doc-installation-mutations   | 530 / 0        | 1 dir                  | wip/doc-installation-mutations   | Not on main (`confined-namespace.ts`, `installation-mutations.ts`, `mutation-roots.ts`); input to 4.3 |
| doc-intent-reservations                       | detached at 9e4e3edf54             | 526 / 0        | 3 files                | wip/doc-intent-reservations      | Superseded by #2507                                                                                   |
| doc-room-app-ack                              | codex/doc-room-app-ack             | 320 / 0        | 197 files              | wip/doc-room-app-ack             | Older snapshot of #2673's room work (2.6/2.8)                                                         |
| doc-room34-verify                             | codex/doc-room34-verify (PR #2673) | 112 / 74       | 3 files                | wip/doc-room34-verify            | Consumer e2e bootstrap fix on top of #2673                                                            |
| doc-runtime-principal                         | codex/doc-runtime-principal        | 320 / 0        | 5 files                | wip/doc-runtime-principal        | Superseded by #2913                                                                                   |
| doc-runtime-room-integration                  | codex/doc-runtime-room-integration | 121 / 71       | none                   | wip/doc-runtime-room-integration | Room responder protocol for 2.8; local-only commits, now pushed                                       |
| doc-streams-current-main                      | codex/doc-streams-current-main     | 520 / 3        | 53 files               | wip/doc-streams-current-main     | Superseded by #2522                                                                                   |
| (DorkOS) doc-frame-host-bridge                | wip/doc-frame-host-bridge          | 61 / 1         | saved earlier          | wip/doc-frame-host-bridge        | The 3.2 host bridge; base for the 3.2 PR                                                              |

Codex's evidence checkout `~/Keep/dork-os/.workspace/doc-channel-evidence/`
is left as it is. Many of its `REVIEW.json` files are static reviews
(`nativeExecuted: false`): treat a "review passed" there as unverified until the
tests are run again.

## PR #2673

Closed in favour of smaller PRs. The branch stays on origin as source material.

- It is 74 commits ahead and 112 behind main, changes 1,273 files
  (+227k / −30k lines), and `git merge-tree` reports 60 conflicting files.
- The automated reviewer could not read it (over GitHub's 300-file limit).
- Its own body calls it a frozen preservation draft to keep out of the queue.
- Seven slices were already extracted and merged: #2909, #2910, #2913, #2920,
  #2922, #2936, #2945.

What's left in it is extracted one task at a time, each as its own reviewed PR,
in the order below.

## Task state at takeover

Checked against the code on main at `92793bc2f4`, not against chat notes.
`03-tasks.json` carries the same statuses.

| Task                               | Status      | On main                                                                                 | Left to do                                                 |
| ---------------------------------- | ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1.1 Contracts + storage            | completed   | schemas, 7 tables, store                                                                | —                                                          |
| 1.2 Authority + lifecycle          | completed   | `doc-channel/authorization.ts`, `lifecycle.ts`                                          | —                                                          |
| 2.1 Declarations + grants          | in_progress | grants, manifest, 3 in-session MCP tools                                                | room-native authority (needs 2.6); HTTP management surface |
| 2.2 Ingest + retention             | completed   | ingest, coalescer, retention, replay                                                    | —                                                          |
| 2.3 HTTP + Transport               | completed   | `apps/server/src/routes/canvas-doc-events.ts`, client `transport/canvas-doc-methods.ts` | —                                                          |
| 2.4 Admission + doc context        | in_progress | `document_event_batch` source, `doc_events` context in every runtime                    | re-run the restart/rekey acceptance on main and close      |
| 2.5 Durable waits + receipts       | in_progress | delivery pump, runner, warnings, metrics                                                | review and replay of expired / in-doubt work               |
| 2.6 Room app events (DOR-2669)     | in_progress | nothing; `room:self` is refused                                                         | extract from #2673, prove one launch per action            |
| 2.7 Relay delivery                 | in_progress | only the `relay.doc.<id>` label                                                         | needs DOR-2660; extract from #2673                         |
| 2.8 Downstream state + acks        | in_progress | `canvas_send`, `canvas_patch_state`, `app.ack`                                          | room responder acks (with 2.6)                             |
| 3.1 Replay over streams            | in_progress | scope stream, live buffer, client `useDocChannel`                                       | SSE/WebSocket parity check, then close                     |
| 3.2 Frame SDK                      | in_progress | page shim + injection, client lifetime/handshake libs                                   | **host bridge: nothing connects a frame yet**              |
| 3.3 Native widget emit             | in_progress | `kind:"emit"` actions, `WidgetChannelStatus`, e2e                                       | confirm approved/unapproved normalization, then close      |
| 3.4 Writer consumer proof          | in_progress | nothing                                                                                 | extract after 2.6, 3.2, 4.3                                |
| 4.1 MCP Apps extension             | in_progress | nothing                                                                                 | extract from #2673                                         |
| 4.2 Editor lifecycle               | in_progress | Blintz callbacks, `doc.saved` receipts                                                  | `selection.ask` / `md.task.toggled` producers              |
| 4.3 Checkbox writes (DOR-2670)     | in_progress | server leaf, not mounted                                                                | route + UI, crash proofs                                   |
| 4.4 Presence                       | in_progress | nothing                                                                                 | extract from #2673                                         |
| 4.5 MCP + native proof             | pending     | nothing                                                                                 | after 4.1, 4.3, 4.4                                        |
| 5.1 Bearer tokens + SSE            | in_progress | token schemas only                                                                      | everything server-side                                     |
| 5.2 Route controls + bound widgets | in_progress | widget `bind` (JSON pointers)                                                           | **header controls: see, approve, revoke, replay**          |
| 6.1 Final proof + docs             | in_progress | nothing                                                                                 | last                                                       |

## What Stage needs, and what it doesn't

- An agent's route to **itself** (`agent:owner`, or `log`) needs no person's
  approval: `approve_doc_route` grants it straight away to the verified opener
  (`grants.ts`, `kind: 'verified_opener'`). Two conditions: the document was
  opened by that agent (a document a person opened has no agent opener), and
  the route carries no write binding (a route with `write` always needs a
  person). Routes to another agent or a room
  need a person's approval, which today only shows up in the generic approvals
  list. So Stage is unblocked by 3.2 alone; 5.2 adds the place a person sees
  and revokes routes, and approves non-self ones with the details shown.
- The page side of 3.2 is already on main: `window.dorkos.channel` is injected
  into served and preview pages. What's missing is the host half that answers
  the page's handshake.

## Plan, in order

1. This PR: takeover record and honest statuses.
2. **3.2** frame host bridge, from `wip/doc-frame-host-bridge`, rebased on main,
   reviewed and browser-tested.
3. **5.2** route controls, split in two: (a) see, approve and revoke routes in
   the canvas header, which Stage uses now; (b) token mint/revoke, which needs
   5.1 first.
4. Close the audited tasks (2.4, 3.1, 3.3) once their acceptance is re-run.
5. Then, in dependency order, each extracted from #2673 as its own PR:
   2.5 replay review → 5.1 tokens → 4.4 presence → 4.3 checkbox route + UI
   (with `wip/doc-installation-mutations`) → 4.2 selection → 4.1 MCP Apps →
   2.6 + 2.8 room events and acks → 2.7 Relay (after DOR-2660) → 3.4 and 4.5
   proofs → 6.1 docs.

Anything that can't be finished gets a ticket with a clear next step.

## Security lines that hold throughout

- The per-frame nonce and generation binding (DOR-2662) and the CSP sandbox on
  served pages (DOR-2663) stay intact. Page scripts are untrusted; a frame never
  receives an API token or grant.
- Routes to anyone but the opener need a person's approval. Silence never
  creates a route.
- The turns-per-hour caps stay.
