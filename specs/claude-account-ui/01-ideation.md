---
slug: claude-account-ui
id: 260926-152113
created: 2026-09-26
status: specified
tracker: DOR-2387, DOR-2388 (plus the UI parts of DOR-2379 and DOR-2382)
project: Flow CLI & Account Fleet
---

# Claude account UI: see which account a session spends, and move work off a spent one

## Intent

People who run several Claude Code accounts in DorkOS cannot see which account a session is spending. The account shows only in a tooltip on the runtime chip. When an account runs out, the session stops with no clear reason, and moving the work to another account is a manual chore.

The server track (S4, `specs/claude-account-fleet/`) makes the account something the server knows: a color, per-account usage, a `limit` on the session, and the tracker item a flow run serves. This unit (S5) is the UI for it, plus the Flow extension's Settings tab where the operator decides how flow spends the accounts.

## Decided in the visual companion (operator, 2026-09-26)

1. **Account display, option C.** A status-bar account chip, sidebar color dots and a session-header badge. Only when 2 or more Claude Code accounts are configured. (`04-design-decisions.md` §1)
2. **Settings split, option A.** Core Settings keeps each account's name, color and usage. A separate "Flow" tab, added by the Flow extension, holds roles, reserve and handoff. (§2)
3. **The "Continue on another account" picker.** A dialog listing eligible accounts. (§3)
4. **The out-of-usage notice is a banner above the composer** (option A, decided by the orchestrator for the operator) that collapses into a one-line transcript marker when resolved, and it works without flow; flow adds a recommendation, hides kept-out accounts and can move the work automatically. (§3-§4)

## Assumptions

- S4's server work lands first. Every UI task depends on the S4 task that serves its data.
- The Flow extension ships inside the flow plugin package in the marketplace repo (spec unit S6 is folded into this spec's Flow-tab tasks).
- One account behaves exactly as today.

## Codebase map

See `02-specification.md` §4 for exact files. In short: the client's Claude accounts settings, the chat status bar, the sidebar session row, the session header, the session entity's list query, and the global event stream on the core side; `packages/extension-api` and the flow plugin on the extension side.
