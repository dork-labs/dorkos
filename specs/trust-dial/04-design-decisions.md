# Design Decisions

Visual companion sessions: `.dork/visual-companion/34262-1785544388/` (decisions 1–5) and `.dork/visual-companion/65256-1785547360/` (decision 6). Mockup HTML preserved in each session's `content/`.

All six decisions were made by Dorian in interactive sessions on 2026-08-01, with mockups rendered per option. Screens are listed by filename.

## 1. The mental model

**Screen:** `mental-model.html`
**Options:** A) Refine the six-mode dropdown with honest per-runtime copy. B) The Trust Dial — three human stops. C) Two explicit axes (reach × asking) with a derived label.
**Chosen:** **B — the Trust Dial.**

Three stops: **Ask first** · **Act, ask when risky** · **Full autonomy**. `plan` leaves the permission axis entirely and moves next to the composer as a way of working. `auto` becomes the intelligence inside the middle stop (where the model supports it), not a separate mode. `dontAsk` is retired from the surfaced product. The stops are rendered as a segmented control in the session status area, replacing the six-item radio dropdown.

## 2. Where the runtime truth lives

**Screen:** `runtime-mapping.html`
**Options:** A) Fixed stops, living caption. B) Honest stops — runtimes rename stops they can't honor. C) Fixed stops + a translation matrix behind a disclosure.
**Chosen:** **A — fixed stops, living caption** (chosen over the agent's recommendation of B, after reviewing how capability profiles work).

The three stop words never change across runtimes. The caption line under the dial is the truth-teller and rewrites itself per runtime from runtime-declared data. Where a runtime's behavior diverges from the stop's canonical promise (Codex's middle stop cannot ask — `workspace-write` runs commands unprompted), the caption carries the divergence prominently (amber, explicit: "On Codex this runs edits **and shell commands** without asking. Codex can't pause to ask.").

**Substrate (applies regardless of the chosen face):** `PermissionModeDescriptor` gains structured semantics —

```ts
{
  id: string;                        // runtime mode id — wire & persistence unchanged
  stop: 'ask' | 'act' | 'autonomy';  // canonical dial position
  label: string;                     // runtime's honest word
  promise: string;                   // the caption sentence
  asks: 'always' | 'when-risky' | 'never';
  reach: 'read' | 'edit' | 'workspace' | 'everything';
  native?: string;                   // e.g. "workspace-write", for detail views
}
```

Client behavior derives from these semantics by uniform rules, never from runtime names or mode-id tables: divergence styling ← declared `asks` differs from the stop position's canonical expectation; warn/danger tier ← `asks === 'never'` (+ `reach === 'everything'`); the caption ← `promise`. The id-keyed client tables (`MODE_WARN`, `BYPASS_PERMISSION_MODES`, most of `MODE_ICONS`) are deleted; icons key off the three stops. `PATCH /api/sessions/:id` rejects a mode id the resolved runtime does not declare (400 `UNSUPPORTED_PERMISSION_MODE`).

## 3. How a session wears its trust level

**Screen:** `ambient-signal.html`
**Options:** A) Status-strip word only, refined. B) Composer hairline + word. C) Session-wide amber wash.
**Chosen:** **A — the word, refined.**

The trust signal lives in the status strip: stop icon + word, tinted by severity (Ask first is deliberately colorless — safety is the resting state). The persistent app-wide bypass banner is **retired for attended sessions**; it remains only for autonomy on unattended surfaces (bindings, tasks). Session-list rows keep a small per-row glyph so a wall of sessions scans at a glance. Tinting derives from declared semantics (`asks: 'never'`), not mode-id membership.

## 4. The approval card

**Screen:** `approval-card.html`, refined in `autonomy-entry.html` (animated settle demo)
**Options:** A) Refined card — command as hero, countdown as top-edge hairline. B) A + request→receipt lifecycle. C) Conversational message-style ask.
**Chosen:** **B — request → receipt**, with Dorian's refinement: **the pending card keeps its current position floating over the composer, and answering it animates the card up into the message list** where it settles as a permanent receipt line.

Card anatomy: monospace command as the headline; tool + workspace as the byline; countdown as a 2px draining hairline along the card's top edge, phase-colored (neutral → amber at 2:00 → red at 1:00, matching existing phases); context (cwd, args, "why am I seeing this") behind one "Details ›" disclosure. Actions: **Allow** (primary) · **Always allow** · **Deny (esc)**. Esc always means deny.

Receipt lifecycle: on answer, the Allow/Deny button confirms (~120ms fill), the card compresses, and the receipt line rises into the transcript with one decelerating ease (~300ms; total under 450ms; instant swap under `prefers-reduced-motion`). Receipts read "✓ You allowed `pnpm install`" / "✕ You denied `rm -rf node_modules` — agent was told why" / "⏰ Expired — denied after 10:00" with a timestamp. Denials are delivered to the agent as context so it adjusts rather than hangs. If further asks are queued, the next card rises into the vacated composer slot (~80ms stagger). The transcript is thereby the audit trail — every ask and answer, permanent, in place.

Substrate: "Always allow" is **withheld with a stated reason** (shown disabled, not hidden) when the command cannot be safely generalized (`$VAR`, backticks, `$()`, subshells). The approval binds the exact command + cwd it displayed. Batch asks stack into one card with "Allow all N". One approval payload renders as the cockpit card, a room message, and Slack/Telegram buttons — option C's conversational form is effectively the chat-surface rendering of the same payload.

## 5. The door into Full autonomy

**Screen:** `autonomy-entry.html`
**Options:** A) Confirm dialog, promoted to a real server-enforced control. B) Hold-to-engage (~700ms press on the stop). C) Typed consent.
**Chosen:** **A — the dialog, promoted to a real control, plus a "Don't show this again" checkbox** (chosen over the agent's recommendation of B).

The dialog explains the consequence in plain language (runs everything without asking; covers tools inside this session only; switch back anytime — the scope note lives at the moment of choice, as today). The acknowledgement travels with the PATCH and **the server refuses autonomy without it** — no client can skip the gate.

"Don't show this again" writes a **durable user-level acknowledgement** (persisted in user config: this person has read what Full autonomy means). Thereafter the client sends the standing ack automatically and the dialog is suppressed. The server still requires an ack on every autonomy PATCH — interactive or standing — so the API contract never weakens; the checkbox trades a repeated ritual for recorded consent. It does **not** touch unattended surfaces: tasks, bindings, and rooms keep their own separate, stricter gates (e.g. the bypass clamp on file-sourced schedules).

## 6. Setting the default trust level

**Screen:** `default-stop-setting.html` (second session)
**Options:** A) Per-runtime rows in the Settings defaults card. B) One global Trust Dial in Settings with the living caption and per-runtime overrides behind a disclosure. C) In-session "Make this the default" affordance after a stop change.
**Chosen:** **B + C together.**

Settings gains a single "New sessions start in" Trust Dial in the card that already holds per-runtime default model and effort. Beneath it, Decision 2's living caption enumerates the per-runtime consequence of the selected stop (including the amber Codex divergence). "Customize per runtime ›" discloses per-runtime override rows (option A's shape) for those who want them. Additionally, after a person changes a session's stop, a quiet transient line appears under the dial — "Start every new session in ⟨stop⟩? **Make default** · Dismiss" — so the habit is noticed where it occurs instead of requiring a trip to Settings.

**The autonomy cap is deliberately lifted** (revising the investigation's recommendation, per Dorian — an operator who always runs Full autonomy should not have to re-select it every session): **Full autonomy is a valid default**. What makes that safe is consent mechanics, not prohibition:

- Selecting Autonomy as the default (in Settings or via "Make default") fires Decision 5's server-enforced consent dialog **at set-time** and records the durable user-level acknowledgement — set-time is consent-time, and that standing ack satisfies the server's autonomy requirement for every session the default births.
- Settings thereafter shows a quiet standing note ("New sessions run without asking — change") so the state is findable, not buried.
- The stored value is the runtime-neutral **stop**, resolved through each runtime's capability profile; no runtime mode ids in config.
- Resolution follows the existing session-defaults ladder (seeded into `session_metadata` at first write; running sessions keep their setting).
- The default applies to **interactive sessions only** — tasks, bindings, and rooms keep their own defaults and stricter gates, including the bypass clamp on file-sourced schedules.
- The shipped default remains **Ask first**; autonomy-by-default is always an explicit, acknowledged choice.

## Final Design Summary

The permission surface collapses to one question — _when should this agent ask me?_ — answered by a three-stop segmented **Trust Dial** (Ask first · Act, ask when risky · Full autonomy) rendered in the session status area from runtime capability profiles. The stop vocabulary is fixed across runtimes (Decision 2A); a per-runtime caption beneath the dial, generated from structured runtime-declared semantics (`stop`, `asks`, `reach`, `promise`, `native`), tells the truth about what the selected stop does on this runtime, with amber emphasis when the runtime's behavior diverges from the stop's canonical promise (Codex's silent `workspace-write` being the canonical case). `plan` relocates next to the composer as a working mode; `auto` folds into the middle stop; `dontAsk` is retired.

The dial's tint appears only in the status strip and session-list glyphs (Decision 3A); Ask first is colorless; the app-wide banner survives only for unattended autonomy. Approval requests keep floating over the composer with the command as hero and the deadline as a draining top-edge hairline; answering one animates it up into the transcript where it settles as a permanent receipt line, making the transcript the audit trail (Decision 4B + settle refinement). Full autonomy is entered through a server-enforced confirmation dialog with a durable "don't show again" acknowledgement stored in user config (Decision 5A).

The default trust level for new sessions is set once in Settings via a single Trust Dial with the living caption and per-runtime overrides behind a disclosure, or in place via a transient "Make default" affordance after an in-session stop change (Decision 6, B + C). Full autonomy is a permitted default; choosing it fires the consent dialog at set-time and records the durable acknowledgement. The shipped default is Ask first.

Implementation invariants: wire/persistence keep runtime mode ids; app code contains no runtime-name checks — all per-runtime presentation flows through the capability profile; a mode the runtime doesn't declare is a 400; semantics-derived styling replaces every id-keyed client table; unattended-surface gates are untouched by all six decisions.

## Follow-ups opened by the implementation

- **The unattended-autonomy banner.** Decision 3A retires the standing bypass banner
  "except for autonomy on unattended surfaces". The retirement shipped with the Trust
  Dial; the unattended half did not. The banner that existed only ever fired for the
  session a person was looking at, so scoping it was not a narrowing but a new feature:
  it needs relay-binding and scheduled-task state the banner widget does not fetch (and
  must not fetch on every route), plus its own definition of "unattended". Until it
  exists, an agent left running without asking behind a binding or a task is signalled
  only on the surfaces that show that binding or task.

## Deliberately not decided here (open for SPECIFY)

- The **rooms** story: forwarding approval cards into rooms vs. an explicit ask-fallback declared at room configuration.
- Keyboard shortcut / command-palette entry for the dial.
- ~~Migration of the binding dialog and task form onto the shared capability-driven picker~~ — **done.** Both render the Trust Dial from a runtime capability profile; the dial itself moved to `shared/ui` so an entity and a feature can share it. Neither coerces a stored mode: one the dial has no stop for is kept, named, and replaced only on purpose. Binding and task each gate their autonomy stop with copy about what stops happening on an _unattended_ surface — the approval buttons that would have arrived in a chat, the card a run would have waited on. Two limits worth knowing: the binding dial resolves Claude Code's profile because the relay's only runtime adapter is Claude Code's (named at `BINDING_RUNTIME`), and the task dial resolves the server default because a task carries no runtime of its own.
- Trust receipts ("Ran 14 actions without asking · 2 would have paused") and learned always-allow suggestions — investigation ideas endorsed in principle, unscheduled.
- **Codex's middle stop enters without an acknowledgement.** The autonomy door (#682)
  gates the autonomy *stop*, per Decision 5. Codex's Act stop (`workspace-write`)
  declares `asks: 'never'` — it runs shell commands in the workspace with nothing to
  ask — and enters with no consent ritual. The amber divergent caption (Decision 2A)
  is the disclosure that covers it. This is design-faithful, and it is also the
  sharpest residual gap between what the door gates and what can surprise someone;
  if it ever earns a gate of its own, that is a new decision, not an oversight.
- **Implementation record.** The program shipped as twelve PRs on 2026-08-01:
  #668 (spec), #671, #672, #674, #675 (Wave 1 safety + receipts), #677 (semantics
  substrate), #678 (receipt permanence, ADR 260801-035912), #680 (the Trust Dial),
  #681 (picker unification), #682 (the autonomy door), #686 (the default trust
  level). Every code PR passed adversarial review before it was opened.
