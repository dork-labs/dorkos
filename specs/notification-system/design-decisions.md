# Design Decisions — Unified notification system

Visual companion session: `.dork/visual-companion/12683-1787180875/` (screen
`01-notifications-review.html`). Evidence and citations:
`research/20260819_notification-system-review.md`. Every decision below was
made explicitly by Dorian on 2026-08-19.

The brief, in Dorian's words: "The end goal is to create a world-class
notification system that is simple, flexible, extensible and offers excellent
UI/UX and DX… simultaneously make our system simpler AND better." Expanded
mid-session: "go all out — 10x better, best on earth, delight and surprise
users."

---

## 1. The model: four kinds, three tiers

**Screen:** `01-notifications-review.html` §2
**Options:** 1A · Four kinds (Attention / Activity / Suggestion / Feedback) +
three plain-word tiers (Blocking / Notable / Quiet) · 1B · Apple's four-tier
vocabulary (Passive / Active / Time-Sensitive / Critical)
**Chosen:** **1A.**

What it means:

- Every message to the operator is exactly one of four kinds with one home:
  **Attention** (standing condition — mirrored everywhere, no read state,
  clears only on resolution), **Activity** (event — Inbox, per-item read
  state), **Suggestion** (product talking — bottom slot only, never pushes,
  never in the Inbox), **Feedback** (response to your own action — inline in
  the control; toast only when the consequence is off-screen).
- Tiers: **Blocking** (stopped until you act; the only tier that escalates or
  makes sound) · **Notable** (OS notification only while away, silent) ·
  **Quiet** (inbox history + unread weight; never OS, never sound).
- "Critical" is reserved vocabulary for a future destructive-action case; it
  needs no implementation today.
- Baked-in pipeline rules: never notify the user about their own action;
  presence suppresses; channels get louder one at a time; answering anywhere
  settles everywhere (the Ask discipline, promoted system-wide).

## 2. The Inbox: the pill grows into a bell, one store with lenses

**Screen:** §3 · **Options:** 2A · Bell in the header + popover + filtered
lenses · 2B · Inbox as a sidebar zone
**Chosen:** **2A.**

- The top-right `ApprovalsIndicator` becomes the bell: same spot, ghost-quiet
  when empty, amber + count when something is Blocking.
- Popover: **Needs you** pinned (amber tint, action buttons inline, no read
  state) above **Activity** (read/unread dots, server-synced). Resolved
  attention items slide into history with their outcome ("you allowed",
  "expired").
- One inbox store, N lenses: the agent profile gains a Notifications section
  (same list filtered by agent); the session view filters by session. ⌘⇧Y keeps
  working.
- "All clear ✓" plays when the pinned section drains (the sidebar beat,
  promoted).

## 3. One attention engine; idle leaves attention

**Screen:** §4 · **Options:** 3A · Idle moves to the daily digest + agent list
· 3B · Keep one dismissible idle nudge · 3C · Opt-in per agent
**Chosen:** **3A.**

- `features/dashboard-attention`'s derivation merges into
  `entities/attention` — one engine; Home / sidebar / pill / inbox become
  projections with different caps.
- New Blocking source: **parked schedule approvals** (`pending_approval`
  tasks) — today they produce zero signal anywhere; the MCP create path gains
  its missing SSE/activity events.
- Failed runs and dead letters become Activity (Notable/Quiet), not standing
  attention.
- Idle sessions leave attention entirely (this was Dorian's original
  complaint: "Session idle for X minutes… honestly doesn't need my
  attention"). They surface in the Today digest ("While you were away: 2
  sessions went quiet mid-task") and the agents page's activity grouping.

## 4. Messages join the delivery layer

**Screen:** §5 · **Options:** 4A · Integrate (DM/mention = Notable, pushes
when away; channel chatter = Quiet) · 4B · Keep separate
**Chosen:** **4A.**

- A DM or @mention lands in the Inbox and pushes to desktop/phone when the
  window is unfocused — the Slack behavior Dorian asked for.
- Plain channel activity stays a bold label + unread count; never pushes,
  never sounds.
- Read cursors remain the room source of truth; the inbox row auto-reads when
  the room is read. Muting a room mutes its notifications — one switch.
- This also gives agent-initiated DMs (routed to "a dot in Today" by the
  sidebar-simplification 2A decision) a real doorbell.

## 5. Out-of-app channels + the escalation ladder

**Screen:** §6 · **Options:** 5A · Ship the ladder (Electron + desktop web
push + Telegram/Slack as the phone leg, one knob) · 5B · Electron only ·
5C · Fully configurable incident.io-style policies
**Chosen:** **5A.** This supersedes ADR 0009's Browser-Notification-API ban —
draft the superseding ADR at SPECIFY.

- Ladder (Blocking only): t=0 in-app mirrors (+tab 🔔; ends here if the
  surface is focused) → t=0 desktop notification when unfocused (agent face,
  Allow / Deny / inline Reply on the banner, one knock) → +N min phone (web
  push, or Telegram/Slack — already built — as the day-one phone leg) → the
  existing 4 h park ceiling, recorded honestly ("expired unanswered").
- One knob, not a matrix: "Escalate to my phone after 1 / 2 / 5 / 15 min /
  never" (default 2).
- Permission UX: contextual primer at the first long-running task ("Want a
  nudge when this needs you?"), never a prompt on launch.
- Tray finally tells the truth: "3 working · 1 waiting on you", amber when
  waiting; dock badge = blocking count.
- Notable-while-away = silent desktop notification; Quiet never leaves the
  app.
- iOS: requires PWA install + a cloud push relay (ntfy upstream pattern) —
  deferred to its own wave; needs an infra decision.

## 6. The toast diet

**Screen:** §7 · **Options:** 6A · Adopt strictly + enforce · 6B · Guidance
only
**Chosen:** **6A.**

The rule: **feedback lives where your eyes already are** — a toast is only for
consequences somewhere you can't see.

- One shared copy-feedback component (button morphs to ✓) replaces today's
  five implementations.
- Settings controls are their own feedback — their success toasts are deleted.
- Form/dialog problems render inline at the field, not as toasts.
- Keep: toast for off-screen consequences; toast + Undo for reversible
  destructive actions; ONE global failure toast carrying the real reason —
  every mutation must declare `meta.errorLabel` or `suppressErrorToast`, and a
  lint rule makes hand-rolled double-toasting impossible.
- Bug fixes ride along: the `toast.error`-styled success
  (`ProfileAgentActions.tsx:137`), 6 bare `toast()` successes, unawaited
  clipboard writes. Target ≈ 80 justified call sites, from 171.

## 7. Moments — all four greenlit (multi-select)

**Screen:** §8 · **Chosen:** **M1 + M2 + M3 + M4.**

1. **Answer from anywhere** — Allow/deny/reply from the macOS banner, lock
   screen, Telegram, Slack; the turn resumes without opening DorkOS. The viral
   demo. The plumbing (six answer routes, entitlement, bridged answering)
   exists.
2. **The Shift Report** — the daily "while you were away" digest grown into
   one beautiful card (shipped / waiting / failed), with a weekly shareable
   artifact. Earned, user-owned content — the professional Wrapped.
3. **The knock** — one signature sound family, identity-first. Soft
   double-knock only for Blocking; settle tone for all-clear; today's
   every-turn-end chime becomes opt-in. Sound preference moves to config.
4. **All clear, everywhere** — the sidebar beat promoted: inbox drains → one
   quiet beat; tray flashes ✓; tab title clears.

## 8. Clarifications from the terminal (2026-08-19, after selections)

- **Bottom-slot arbiter (DOR-1369) is in flight in another agent's worktree**
  (`feat/sidebar-bottom-slot`, last commit 18:16 local, uncommitted changes
  present). This spec consumes it as a dependency and must not touch it.
- **Sound today is a single generated `notification.wav`** played on every
  turn end — confirmed; the knock family (decision 7.3) replaces it.
- **Version-update notifications fold into the one system as a Suggestion
  kind** (`update.available` → bottom slot, arbiter rank #2 — exactly today's
  pill), plus a Quiet post-update Inbox row ("Updated to vX — see what's
  new"). Never toasts, never pushes.

## 9. Not decided here (open for SPECIFY)

- Inbox retention window and storage shape (rows vs event-sourced projection).
- Escalation default delay confirmation (proposed 2 min); per-category
  opt-outs for Notable-while-away on day one.
- Service-worker scope / VAPID key storage for the CLI-served SPA.
- iOS relay shape (DorkOS-hosted forwarder vs ntfy-compatible topic).
- Whether `relay_notify_user` becomes a registry kind or remains the
  agent-facing verb feeding `notify()` (leaning: registry kind, keeping its
  consent gate + budget).
- Shift Report data contract and share format.
- Snooze on Activity rows — v1 or later.
- Naming: "Inbox" vs "Activity"; `/feedback-requests` nav copy → "Product
  feedback".
