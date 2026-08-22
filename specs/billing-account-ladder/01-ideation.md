---
status: ideation
created: 2026-08-21
design-session: .dork/visual-companion/6479-1787339980
---

# Billing Account Ladder: default → per-agent → per-session

## Problem

The Claude Code billing account (which `CLAUDE_CONFIG_DIR` a session's SDK
subprocess points at — the thing that decides which subscription gets billed) is
global-only today. `runtimes.claudeCode.activeAccount` in `~/.dork/config.json`
governs every new session; the original `claude-code-accounts` spec listed
per-session override as an explicit non-goal.

Two behaviors surprise operators:

1. **The status-bar account picker mutates global state.** The pre-launch
   "Account" radio in the runtime chip (`RuntimeItem.tsx` →
   `use-account-switch.ts`) writes `PATCH /api/config` — picking an account for
   "this session" silently repoints every future session's billing.
2. **There is no per-agent account.** An operator running work agents and
   personal agents on one machine cannot say "this agent always bills the work
   account."

## Goal

Make the billing account work exactly like runtime and model: a **default** set
in Settings, overridable **per agent** (in the agent's "Runs on" surface), and
**per session** at launch (status bar, session-scoped). Same resolution-ladder
shape as `resolveSessionDefaults` (agent → per-runtime default → nothing).

## What stays true (load-bearing constraints)

- **A session's account is derived from disk, never stored** (ADR
  260801-204127). The account is whichever registered root the session's
  transcript lives under. This composes perfectly with a ladder: overrides only
  need to exist at **launch time**; after the first message, disk is the
  immutable source of truth (mirroring ADR-0255's first-write-wins runtime
  binding, but enforced by the filesystem instead of a DB column).
- **The default-account-by-absence rule** (ADR 260801-204128): `CLAUDE_CONFIG_DIR`
  must be truly unset (not set-to-default-path) when the resolved root is
  `~/.claude`, for Keychain naming.
- **DorkOS never touches credentials.** An account is a directory; Claude Code's
  own CLI owns sign-in.
- Billing selection stays **operator-only** (config-write-policy classification
  today).

## Design decisions (made with Dorian, 2026-08-21 visual-companion session)

See [design-decisions.md](design-decisions.md). Summary:

- **D1 = 1B:** agents reference accounts by a **stable `id`** added to the
  registry entries (`runtimes.claudeCode.accounts[]`), not by absolute path.
  Missing id degrades to the default with a visible "no longer registered"
  warning — never a failed launch.
- **D2 = 2A:** the pre-launch status-bar picker becomes **session-scoped only**
  (a launch hint, like the `runtime` hint). No "make default" shortcut. Global
  default changes only in Settings; agent default only in the agent's profile.
- **Rename:** `activeAccount` → `defaultAccount` with a config migration —
  "active" described the old global-switch semantics.
- **Security:** the new `account` field on the agent manifest is operator-only
  at the API boundary; an agent must not be able to repoint its own billing.
- **Visibility:** the Runtimes tab's execution-exceptions strip also lists
  agents whose account deviates from the default.

## Proposed resolution ladder

Resolved once, at the session-creating first message; never re-run after:

1. **Session pick** — pre-launch status-bar choice, sent as `account` (an
   account id) on the first `POST /api/sessions/:id/messages`, same shape as the
   `runtime` launch hint.
2. **Agent** — `account` (id) in the agent's `.dork/agent.json`; absent =
   inherit.
3. **Server default** — `runtimes.claudeCode.defaultAccount`.
4. **Environment** — `$CLAUDE_CONFIG_DIR`, then `~/.claude` (unchanged).

After launch: derived from the transcript's on-disk location (existing
behavior, unchanged).

## Out of scope

- Credential management / provider auth (`connect-claude-code-account`
  ideation, ToS-gated — untouched).
- Accounts for Codex/OpenCode runtimes.
- Workspace-scoped accounts.
- Mid-session account switching (impossible by design; disk owns it).

## Prior art in-repo

- `specs/claude-code-accounts/` — the shipped multi-account selector (D1–D8).
- `specs/execution-defaults/` — the model/effort ladder + inherit-chip UX this
  feature mirrors.
- ADRs 260801-204126..204129 — account = config dir; derived-from-disk;
  named-by-absence; env-pin lock.
- ADR-0255 — first-write-wins session runtime binding.
