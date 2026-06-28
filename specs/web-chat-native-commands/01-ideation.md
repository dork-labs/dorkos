---
slug: web-chat-native-commands
number: 265
created: 2026-06-26
status: ideation
linearIssue: DOR-128
---

# Web Chat Native Commands (client-side `/rename`)

**Slug:** web-chat-native-commands
**Author:** Dorian Collier
**Date:** 2026-06-26
**Tracker:** DOR-128 (Universal Command Interface project)

---

## 1) Intent & Assumptions

- **Task brief:** Add a client-side `/rename` slash command to the DorkOS web chat
  that renames the current session by reusing the existing rename capability
  (DOR-80), without routing the command to the runtime/model. More broadly:
  establish the missing seam for client-side ("DorkOS-native") chat commands,
  commands DorkOS executes locally and never sends to the agent. `/rename` is the
  first such command.
- **Assumptions:**
  - The rename capability (`useRenameSession` -> `transport.updateSession(sessionId, { title }, cwd)`)
    is complete and correct; this work only triggers it from a new surface.
  - DorkOS-native commands are a distinct category from runtime commands (the SDK
    `supportedCommands()` set, spec #133) and from Cmd+K palette actions (specs
    #85/#87). They never reach the runtime.
  - This seam is independent of DOR-109 (runtime command aliasing: compact/clear/context)
    and DOR-104 (agent->client `ui_command`); `/rename` is deliberately outside
    DOR-109's canonical intent set.
- **Out of scope:**
  - Other local commands (`/usage`, `/resume`, `/export`, `/model`, ...).
  - Runtime command aliasing / cross-agent intents (DOR-109).
  - Unifying with the Cmd+K command palette (explicitly rejected, see Decisions).
  - A chat-panel session-title header (none exists today; not added here).
  - A no-arg inline-rename UI (dropped, see Decision 2).

## 2) Pre-reading Log

- **DOR-128 (issue):** full brief, scope, acceptance criteria, and the "wiring gap"
  design note that flagged the missing client-side dispatch seam. Source of intent.
- `apps/client/src/layers/features/chat/model/use-session-submit.ts:240` —
  `handleSubmit` passes trimmed input straight to `executeSubmission` ->
  `transport.postMessage` (~line 159). No slash interception exists. This is the
  interception point.
- `packages/shared/src/schemas.ts` (`CommandEntrySchema`) +
  `apps/client/src/layers/entities/command/` — runtime command metadata
  (name/description/argumentHint/aliases); carries **no executor**.
- `apps/client/src/layers/features/chat/model/use-command-palette.ts:80`
  (`handleCommandSelect`) + `use-input-autocomplete.ts` — autocomplete selection
  returns **text to insert**; there is no per-command action/dispatch.
- `apps/client/src/layers/entities/session/model/use-rename-session.ts:15` — the
  capability to reuse: `mutate({ sessionId, title })` -> `transport.updateSession(...)`,
  with optimistic update + rollback + error toast.
- `apps/client/src/layers/features/command-palette/` (specs #85/#87, ADR-0063) —
  Cmd+K palette: `CommandPaletteContribution` with a hardcoded `action` switch
  (`use-palette-actions.ts`). Separate system; its non-goals explicitly exclude
  inline slash commands and agent-registered actions.
- `packages/shared/src/schemas.ts` (`UiCommandSchema`, DOR-104) — agent->client UI
  control; opposite direction, not user slash commands.
- specs/sdk-command-discovery (#133) — the runtime command-source contract.

## 3) Codebase Map

- **Primary components/modules:**
  - `features/chat/model/use-session-submit.ts` — the send path; the interception
    branch lands here.
  - `entities/command/` (or a new `entities/native-command/`) — proposed home for
    the native-command registry.
  - `features/chat/model/use-input-autocomplete.ts` + `use-command-palette.ts` —
    autocomplete population + selection; blend native entries here.
  - `entities/session/model/use-rename-session.ts` — the executor's dependency.
- **Shared dependencies:** `transport` (`updateSession`, `postMessage`); TanStack
  Query cache; toast.
- **Data flow (proposed):** user types `/rename X` -> `handleSubmit` -> native-command
  dispatch (parse token, look up registry, run executor `useRenameSession.mutate`)
  -> **return early** (no `postMessage`, no user bubble, no model turn). An
  unregistered `/...` falls through to the runtime exactly as today.
- **Feature flags/config:** none.
- **Potential blast radius:** the chat send path (every message passes through
  `handleSubmit`). The interception must be a precise early-return that triggers
  **only** for registered native commands and never swallows a runtime command.

## 5) Research

**Potential solutions (the architectural fork):**

1. **Minimal extensible native-command registry [CHOSEN].** A small client-side
   registry; each entry `{ name, description, argHint, run(args, ctx) }`. The
   send-path interception parses a leading-slash token, looks it up, runs the
   executor, returns early. Autocomplete blends native entries with runtime
   `CommandEntry`s. _Pros:_ gives native commands a real home; extensible (next
   command is one entry); isolates native-vs-runtime concerns; small (~3 files);
   independent of DOR-109/104. _Cons:_ introduces a small new abstraction.
2. **One-off `/rename` branch.** A single hardcoded interception + one synthetic
   autocomplete entry. _Pros:_ least code. _Cons:_ not reusable; the next
   client-only command repeats the plumbing; leaves the "where do native commands
   live" gap unsolved.
3. **Unify with the Cmd+K palette.** Extend palette contributions to drive chat
   slash commands. _Pros:_ one command system. _Cons:_ most work; reverses the
   deliberate #85/#87 separation; mixes app-nav actions with chat-input argument
   parsing; palette items (agents/sessions) are irrelevant to chat.

**Recommendation:** Option 1.

## 6) Decisions

| #   | Decision                                        | Choice                                                                                                                                   | Rationale                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where client-side native commands live + extent | Minimal extensible registry (new client-side native-command registry + send-path interception + autocomplete blend); ship `/rename` only | Gives native commands a real home (the gap DOR-128 flagged) without over-building; next native command is a one-liner; stays independent of DOR-109 (runtime aliasing) and DOR-104 (agent->client `ui_command`); rejects palette unification to preserve the #85/#87 separation |
| 2   | `/rename` with no argument                      | Require an argument: no-arg is a no-op with a usage hint (`usage: /rename <title>`); only `/rename <title>` renames                      | "Less, but better": no chat-panel title header exists today, so an inline no-arg affordance would add UI scope for marginal value. **Overrides DOR-128's acceptance criterion "no-arg opens the inline rename UI"; ACs to be updated in SPECIFY.**                              |
| 3   | Execution semantics                             | `/rename <title>` calls the existing `useRenameSession` mutation and returns early before `postMessage` (no user bubble, no model turn)  | Reuse the DOR-80 path (optimistic update + rollback + toast already handled); satisfies "must never reach the model"                                                                                                                                                            |
| 4   | Empty / whitespace title                        | Rejected gracefully (no-op + hint), matching sidebar behavior                                                                            | Acceptance criterion; consistent with sidebar validation                                                                                                                                                                                                                        |

**Recommended next step:** SPECIFY (`/flow:specify`). During SPECIFY, update the
DOR-128 acceptance criteria to reflect Decision 2 (no-arg requires an argument).
