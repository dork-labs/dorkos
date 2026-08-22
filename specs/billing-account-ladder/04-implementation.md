# Implementation

Shipped 2026-08-22 in three PRs, each adversarially reviewed pre-PR against
REVIEW.md (nine review rounds total across the program; every finding closed
and independently re-verified, key behaviors mutation-tested):

| PR    | Branch                           | Scope                                                                                                                                                                                                                                                  |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1166 | `feat/billing-account-ladder-p1` | Shared + server foundation: registry ids, `activeAccount` → `defaultAccount` migration with two-layer legacy tolerance, `resolveLaunchAccountRoot` ladder, `SendMessageRequest.account` hint, operator-only agent field, `agents.account` cache column |
| #1183 | `feat/billing-account-ladder-p3` | Agent "Runs on" Account row, exceptions-strip billing deviations, sidebar Needs-attention on broken references, `accountsUnavailable` wire flag (unreadable registry ≠ empty registry)                                                                 |
| #1185 | `feat/billing-account-ladder-p2` | Settings "Default account" copy, session-scoped status-bar picker (global mutation deleted), agent-aware "Default — ⟨label⟩", session-keyed pending picks (account and runtime)                                                                        |

## Where the implementation deliberately went beyond the spec

- **Legacy tolerance became two-layer and rename-aware.** The spec's migration
  invariants forced it: a pre-0.65.0 install must keep its config file, its
  billing choice, an explicit clear-to-default, and working ladder rungs — all
  without the migration having run. (Review rounds 1–4 of P1; the v0.63.0
  release cut one day later is exactly the protected population.)
- **Pending launch picks are session-keyed data**, not lifecycle-cleared state
  (`PendingLaunchPick` carries its `sessionId`; every reader requires a match).
  Applied to `pendingRuntime` too, which had the identical cross-session leak.
- **A third surface**: a broken billing reference lights the sidebar's
  Needs-attention badge (deliberate, tested, in the changelog).
- **`accountsUnavailable`**: a config-read failure suppresses account
  judgments instead of declaring the fleet broken.

## Deliberate consistency choices (pinned by tests)

- One registered account beside an unregistered default hides the per-agent
  Account row and the session picker (matches `isMultiAccount` semantics).
- An agent moved off claude-code keeps an invisible `account` that would
  reapply if moved back; the rules stay silent while it cannot apply.

## Follow-ups

- DOR-1410 — server-suite load flakes (five distinct instances observed during
  this program's verify cycles, all in untouched files, all green in
  isolation).
