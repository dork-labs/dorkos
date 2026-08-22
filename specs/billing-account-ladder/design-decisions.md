# Design Decisions

Visual companion session: `.dork/visual-companion/6479-1787339980/`
Participants: Dorian (decisions), Claude (options + mockups). 2026-08-21.

## 1. How does an agent reference its billing account?

**Screen:** `billing-account-ladder.html`
**Options:**

- A) Store the absolute config-dir path in `agent.json` — zero registry
  changes, but manifests become machine-local and a moved/renamed directory
  silently breaks every agent pointing at it.
- B) Add a stable `id` slug to registry entries
  (`runtimes.claudeCode.accounts[]`); agents store `"account": "<id>"` and
  resolution looks the id up in the registry.

**Chosen: B** — paths stay in exactly one operator-controlled place; a deleted
or unregistered id degrades to the default with an amber "no longer registered"
chip (the same graceful-breakage pattern as a model that is "no longer
offered"), instead of breaking silently.

## 2. What does the pre-launch status-bar account picker do?

**Screen:** `billing-account-ladder.html`
**Options:**

- A) Session-scoped only — picking an account affects only this session, a
  launch hint exactly like picking a runtime. Global default changes only in
  Settings.
- B) Session-scoped plus a "Set as default" shortcut in the popover.

**Chosen: A.** Dorian probed what "default" in option B would even mean
(global? per-agent?) — that ambiguity in a billing surface is disqualifying.
One concept per surface: global default in Settings → Runtimes, agent default
in the agent's "Runs on" popover, session pick in the status bar. Runtime and
model pickers offer no "make default" shortcut either, so A is also the
consistent choice.

## 3. Supporting calls (presented as recommendations, accepted without objection)

- The agent manifest's `account` field is **operator-only** at the API
  boundary — an agent must not be able to repoint its own billing by patching
  its manifest. (Noted: the existing DOR-737 config write-policy array gap is
  adjacent, not widened by this work.)
- The **execution-exceptions strip** under the runtime cards also lists agents
  whose account deviates from the default, so billing overrides are visible
  from Settings.
- **Rename** `activeAccount` → `defaultAccount` with a config migration;
  "active" described the retired global-switch semantics.

## Final Design Summary

One resolution ladder, resolved once at the session-creating first message:
session launch hint (`account` id on the first `POST /messages`) → agent
manifest `account` id → `runtimes.claudeCode.defaultAccount` →
`$CLAUDE_CONFIG_DIR` / `~/.claude`. After launch the account is derived from
the transcript's on-disk root exactly as today (ADR 260801-204127) — no new
per-session storage.

Surfaces:

1. **Settings → Runtimes → Claude Code card:** the existing "Billing account"
   section's select is relabeled **Default account** with copy "New sessions
   bill this account unless the agent or the session picks another." Registered
   accounts gain stable ids (backfilled by migration from label/path basename,
   uniquified).
2. **Agent profile → "Runs on" popover:** a new **Account** row using the
   existing `ExecutionRow` pattern — amber "set here" / emerald "inherited"
   provenance chips, footer "Using server default: <label> — tap to restore"
   writing `account: null`. Row renders only when the agent's runtime is
   Claude Code and more than one account is registered. An id that is no
   longer registered shows the amber breakage chip.
3. **Status bar (pre-launch):** the account radio group in the runtime chip
   becomes session-scoped — it no longer writes `PATCH /api/config`; it holds a
   client-side launch hint sent with the first message. Copy: "This session
   only. Locked once the first message sends." Post-launch the account is a
   read-only fact (unchanged).
