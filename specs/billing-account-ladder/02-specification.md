---
slug: billing-account-ladder
id: 260821-204928
created: 2026-08-21
status: specified
tracker: DOR-1407
design-session: .dork/visual-companion/6479-1787339980
---

# Billing Account Ladder: default → per-agent → per-session

**Status:** Approved (decisions frozen with Dorian, 2026-08-21 — see
[design-decisions.md](design-decisions.md))
**Author:** Claude (orchestrator), decisions by Dorian
**Date:** 2026-08-21

## Overview

Make the Claude Code billing account resolve the way runtime and model do: a
**default** set in Settings, overridable **per agent** in the agent's "Runs on"
surface, and **per session** at launch from the status bar. One ladder, resolved
once at the session-creating first message; after launch the account remains
derived from the transcript's on-disk root exactly as today.

## Background / Problem Statement

The billing account (`runtimes.claudeCode.activeAccount`, a Claude config
directory injected as `CLAUDE_CONFIG_DIR`) is global-only. Worse, the
status-bar "Account" picker on a new session silently mutates that global
default (`use-account-switch.ts` → `PATCH /api/config`), and there is no way to
pin an agent to an account. Operators mixing work and personal billing on one
machine get surprise billing.

## Goals

- A resolution ladder for the launch account:
  **session hint → agent manifest → server default → env/`~/.claude`**.
- Registry entries gain **stable ids**; agents and session hints reference
  accounts by id, never by path.
- The status-bar picker becomes **session-scoped** (no more global mutation).
- Agent profile gains an **Account** row with the standard inherit/override
  provenance UX.
- Billing overrides are visible from Settings (exceptions strip).

## Non-Goals

- Credential/provider auth (`connect-claude-code-account` stays untouched,
  ToS-gated).
- Accounts for Codex/OpenCode.
- Workspace-scoped accounts.
- Mid-session account switching (impossible by design — disk owns the account
  after launch).
- Changing how a session's account is _derived_ on read/resume (ADR
  260801-204127 stands unchanged).

## Invariants that MUST survive this change

These are properties, with the evidence bar each demands:

1. **Disk stays the per-session truth.** No new persistence of a session's
   account anywhere (no `session_metadata` column, no config echo). Resume,
   retry-as-new-session (Amendment C2 in `claude-code-accounts`), and
   `Session.account` derivation are untouched. _Evidence: existing
   session-store/launch-resolver tests still pass unmodified; no schema
   migration adds an account column._
2. **Named-by-absence holds** (ADR 260801-204128): when the resolved root is
   the default `~/.claude` and the ambient env did not name it,
   `CLAUDE_CONFIG_DIR` is left **unset**, regardless of which ladder tier
   produced that root. _Evidence: unit test resolving each tier to `~/.claude`
   asserts the env var is absent._
3. **A launch never fails on a bad account reference.** An unknown/unregistered
   id (agent or hint) falls through to the next tier with a logged warning.
   _Evidence: unit tests for unknown hint id and unknown agent id._
4. **Billing stays operator-only.** An agent cannot change any agent's
   `account` field through agent-reachable surfaces (MCP tools; any
   agent-originated manifest update path). The operator UI can. _Evidence: a
   test that the MCP agent-update surface rejects/strips `account`; the HTTP
   route used by the client accepts it._ (Match how `activeAccount`'s
   operator-only classification is enforced today; do not widen DOR-737.)
5. **The ladder runs only at launch.** The account resolver is consulted only
   when a session has no `accountRoot` yet (`session.accountRoot ??` stays the
   guard in `launch-resolver.ts`). _Evidence: test that a resumed session with
   an `accountRoot` ignores hint/agent/default._

## Detailed Design

### Data model (`packages/shared`)

- `ClaudeCodeAccountSchema` (config-schema.ts) gains `id: string` — a
  kebab-case slug, unique within the registry. Registration requires it.
- `runtimes.claudeCode.activeAccount` is **renamed `defaultAccount`**
  (same type: `string | null`, still an absolute **path**, `null` = inherit
  env/`~/.claude`). A semver-keyed config migration renames the key, carries
  the value, and backfills `id` on every existing registry entry (slugified
  from `label` if present, else the path basename; uniquified with a numeric
  suffix). Follow `contributing/configuration.md` + the `adding-config-fields`
  lifecycle. Rationale for path-not-id: the default may legitimately point at a
  root that is not a registry entry (ADR 260801-204126's "choosing adds it to
  the read set" semantics survive the rename untouched).
- **Wire schema** (`ServerConfigSchema.claudeCode`, schemas.ts): each entry in
  `accounts[]` gains `id: string | null` — the registry id, or `null` for
  synthesized rows describing unregistered roots (env root, `~/.claude`).
  Rows with `id: null` cannot be referenced by agents or hints.
- **Agent manifest** (`mesh-schemas.ts`): `account?: string` (an account id) on
  `AgentManifestSchema` with `.catch(undefined)` (bad hand-edits degrade to
  inherit, agent never vanishes from the fleet). `AgentManifestUpdate` gains
  `account?: string | null` (`null` = return to inherit). Key written to
  `agent.json` only when explicitly set, mirroring `model`/`effort`.
- **`SendMessageRequestSchema`**: `account?: string` (an account id) — a launch
  hint honored only on the session-creating first send, only for the
  claude-code runtime; ignored (with a warning log) otherwise.

### Server resolution (`apps/server`)

New helper in `services/runtimes/claude-code/claude-config-dir.ts` (or a
sibling module) — `resolveLaunchAccountRoot({ hintId, agentAccountId, config })`:

1. `hintId` → look up in `accounts[]` by id → path.
2. else `agentAccountId` → same lookup.
3. else `defaultAccount` path.
4. else existing `resolveActiveClaudeRoot` env/default behavior.

Unknown ids at tiers 1–2 log a warning and fall through. The result feeds the
existing `claudeConfigDirEnv()` (invariant 2 comes for free).

Call sites: `launch-resolver.ts` replaces `session.accountRoot ??
resolveActiveClaudeRoot()` with `session.accountRoot ?? resolveLaunchAccountRoot(…)`.
The agent's `account` id reaches it the same way agent model/effort defaults
reach launch (alongside `readAgentExecutionDefaults` /
`resolve-session-defaults` plumbing — but note the account does **not** go into
`session_metadata`; it terminates in the spawn env). The hint rides the
message-send path from `POST /api/sessions/:id/messages` the same way the
`runtime` hint does. `resolveClaudeRootSet` needs no change (agent-referenced
accounts are registered, hence already in the read set).

Rename fallout: every `resolveActiveClaudeRoot` reader of `activeAccount`
switches to `defaultAccount`; `describeClaudeCodeAccounts` adds ids;
config-write-policy + config-disclosure + safe-defaults entries follow the
rename (`defaultAccount` stays `operator-only`; `accounts[].id` classified like
its siblings).

### Client (`apps/client`)

1. **Settings → Runtimes → Claude Code card**
   (`ClaudeAccountsSection.tsx`): select relabeled **"Default account"**, copy
   "New sessions bill this account unless the agent or the session picks
   another." Writes `defaultAccount`. Registration generates the id (slugified
   label/basename, uniquified against existing ids) before the config PATCH.
2. **Agent profile "Runs on" popover** (`RunsOnPopover.tsx` /
   `AgentExecutionRows.tsx` pattern): new **Account** row, rendered only when
   the agent's runtime is claude-code AND >1 account is known. Standard
   provenance UX: amber "set here" / emerald "inherited" chip; picker footer
   "Using server default: <label> — tap to restore" writing `account: null`;
   an id no longer registered renders the amber breakage treatment (mirroring
   "no longer offered" models in `describeAgentExecution` /
   `execution-config.ts`). Writes via the existing agent PATCH.
3. **Status bar pre-launch picker** (`RuntimeItem.tsx`): the account radio
   group becomes session-scoped. It no longer calls `useAccountSwitch`'s
   config PATCH (that hook's global-mutation behavior is deleted); instead the
   choice is held as a client-side launch hint for this session and sent as
   `account` on the session-creating first message (same lifecycle as the
   `runtime` launch hint through `useSessionSubmit`). Options: "Default —
   <resolved label>" (= omit) plus each registered account. Copy: "This
   session only. Locked once the first message sends." Post-launch the row
   remains the read-only derived account, unchanged.
4. **Exceptions strip** (`ExecutionExceptionsStrip.tsx`): agents whose
   `account` deviates from the default (or is broken) appear, broken ones in
   amber, linking to the agent profile — same treatment as runtime/model
   deviations.

### API changes

- `PATCH /api/config`: accepts `defaultAccount` + `accounts[]` with ids
  (rename; no new route).
- `PATCH /api/mesh/agents/:id`: accepts `account?: string | null`
  (operator-surface only, invariant 4).
- `POST /api/sessions/:id/messages`: accepts optional `account` hint.
- `GET /api/config`: `claudeCode.accounts[]` rows carry `id`.

## User Experience

See [design-decisions.md](design-decisions.md) Final Design Summary — it is the
authoritative prose walkthrough of the three surfaces, written from the
approved mockups (`billing-account-ladder.html` in the design session).

## Testing Strategy

- **Unit (server/shared):** ladder tier order; unknown-id fallthrough
  (invariant 3); named-by-absence at every tier (invariant 2); resume guard
  (invariant 5); config migration (rename + id backfill + uniquification);
  manifest `.catch` degradation; operator-only enforcement (invariant 4);
  hint ignored on non-claude-code runtime and on non-first sends.
- **Unit (client, RTL + mock Transport):** settings section writes
  `defaultAccount` and generates unique ids; RunsOnPopover row visibility
  rules, provenance chips, `null`-restore, breakage chip; status-bar picker
  produces a hint and performs **no** config PATCH; exceptions strip includes
  account deviations.
- **No new e2e** — surface behavior is covered by unit layers; existing
  claude-code-accounts tests must pass unmodified where behavior is unchanged
  (invariant 1).
- Test placement/patterns per `.claude/rules/testing.md`; scenarios via
  `@dorkos/test-utils` fakes where session routes are involved.

## Performance Considerations

Negligible — one registry lookup at launch; no new I/O on hot paths.

## Security Considerations

Invariant 4 (operator-only agent `account`). No credential material is ever
read or stored (unchanged). Config disclosure classification for new leaves
mirrors existing account leaves (`expose`).

## Documentation

- Changelog fragment per PR (`changelog/unreleased/`, `writing-for-humans`
  voice).
- `contributing/configuration.md` example refresh only if the rename breaks an
  existing example.

## Implementation Phases

- **T1 — shared + server foundation** (worktree 1, lands first): schema
  changes, config migration, resolver + ladder, launch hint plumbing,
  operator-only gating, wire schema, all server/shared tests.
- **T2 — client: settings + status bar** (worktree 2, after T1 merges):
  surfaces 1 & 3, delete the global-mutating account-switch behavior.
- **T3 — client: agent profile + exceptions strip** (worktree 3, after T1
  merges, parallel with T2): surfaces 2 & 4.

## Open Questions

~~Should `defaultAccount` hold an id instead of a path?~~ **(RESOLVED)**
Answer: path. Rationale: preserves ADR 260801-204126 semantics (a default may
name an unregistered root; choosing adds it to the read set) and makes the
migration a pure key rename.

~~How does the pre-launch picker address the implicit `~/.claude` root when it
is neither default nor registered?~~ **(RESOLVED)** Answer: it doesn't — wire
rows with `id: null` are display-only; "Default — <label>" (omit) covers the
common case. Registering the root gives it an id if explicit selection is
wanted.

## Related ADRs

- 260801-204126/27/28/29 (accounts = config dirs; derived-from-disk;
  named-by-absence; env-pin lock) — all preserved.
- ADR-0255 (first-write-wins runtime binding) — the launch-hint pattern
  mirrored here.
- Draft ADRs seeded from this spec: launch-time account ladder; account
  references by registry id.

## References

- Tracker: DOR-1407.
- `specs/claude-code-accounts/02-specification.md` (supersedes its "no
  per-session override" non-goal — this spec is the deliberate reversal).
- `specs/execution-defaults/` (the ladder + provenance UX being mirrored).
