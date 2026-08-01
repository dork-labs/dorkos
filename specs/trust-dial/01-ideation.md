---
slug: trust-dial
id: 260801-013351
created: 2026-08-01
status: ideation
design-session: .dork/visual-companion/34262-1785544388, .dork/visual-companion/65256-1785547360
---

# Trust Dial: permission modes redesigned

**Author:** Claude (directed by Dorian)
**Date:** 2026-08-01
**Design decisions:** [04-design-decisions.md](04-design-decisions.md)

## The problem

DorkOS shows users six engineer-words (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, `auto`) whose meanings shift per runtime. The same word makes different promises: `acceptEdits` asks before shell commands on claude-code but runs them unprompted on Codex (`workspace-write`); `default` means "prompt me" on claude-code but "read-only sandbox" on Codex. Three different UIs pick modes (session status strip, binding dialog, task form) and only one is capability-driven. The confirmation asymmetry is inverted (`auto` has a dialog, `bypassPermissions` doesn't), the dialog is client-side only, and there is no user-settable default mode.

A full investigation (architecture map, code review with ten verified findings, and a competitor analysis of OpenClaw / Paperclip / Buzz fetched via `opensrc`) preceded this design. Key inputs:

- The capability-profile seam already exists: each runtime declares `permissionModes: { supported, default, values: PermissionModeDescriptor[] }` and the session picker renders from it. Codex already declares honest labels ("Read only", "Workspace write", "Full access").
- OpenClaw is the only competitor with a real tool-approval system; its core ideas — semantics split from presentation, fail-closed fallbacks for unattended surfaces, one approval payload rendered by many surfaces — inform the substrate here.
- Client-side semantic tables keyed by mode id (`MODE_WARN`, `BYPASS_PERMISSION_MODES`) are the personalization rot this design removes.

## The direction

Collapse the user-facing choice to one human question — **"when should this agent ask me?"** — answered by a three-stop **Trust Dial**: `Ask first` · `Act, ask when risky` · `Full autonomy`. `plan` leaves the permission axis (it is a way of working, not a trust level). `auto` becomes intelligence inside the middle stop, not a sixth word. `dontAsk` is retired. Runtime differences surface through structured, runtime-declared semantics rendered by uniform rules — never runtime checks in app code.

Six design decisions were made interactively across two visual-companion sessions — including a user-configurable default trust level with Full autonomy as a permitted, consent-gated default; they are recorded with rationale in [04-design-decisions.md](04-design-decisions.md), which is the authoritative design artifact for this spec.

## Constraints carried forward

- No runtime personalization outside runtime adapter directories. All per-runtime copy, labels, and mapping detail flow through the capability profile.
- Wire and persistence keep runtime mode ids; the stop vocabulary is presentation and resolution. A PATCH carrying a mode the runtime does not declare is rejected (closes the "UI shows Auto on a read-only session" class).
- Unattended surfaces (tasks, bindings, rooms) keep separate, stricter gates; nothing in this design loosens them.
- The `agent-approval-settings` spec's standing permissions (DorkOS's own capability gate) remain a separate feature; the scope note keeps the two from being confused.
