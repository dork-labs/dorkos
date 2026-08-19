---
title: 'Notifications: full-system review and unified redesign'
date: 2026-08-19
type: review
status: current
tags:
  [
    notifications,
    attention,
    inbox,
    toasts,
    asks,
    approvals,
    escalation,
    desktop,
    web-push,
    sound,
    promos,
    ux,
  ]
related:
  - specs/notification-system
  - specs/sidebar-simplification
  - specs/feature-promo-system
  - specs/task-completion-notifications
  - specs/dashboard-content
  - specs/attention-item-detail-navigation
design-session: .dork/visual-companion/12683-1787180875
---

# Notifications: full-system review and unified redesign

**What this is.** A deep pass over every way DorkOS gets the operator's attention — asked for by Dorian on 2026-08-19 with the brief "simultaneously make our system simpler AND better," expanded mid-session to "go all out: 10x better, best on earth." Seven code traces (Needs Attention, Heads up, Scheduled approvals, the Ask system, toasts, promos/tours/celebrations, OS-level channels) plus one external research sweep (~35 sources). Mockups and options live in the visual-companion session named above (`01-notifications-review.html`).

**Decisions (2026-08-19):** **1A · 2A · 3A · 4A · 5A · 6A**, all four "moments" greenlit (Answer from anywhere · Shift Report · the knock · All clear everywhere). Decision record: `specs/notification-system/design-decisions.md`; brief: `specs/notification-system/01-ideation.md`.

---

## 1. TL;DR

DorkOS has **~14 independent attention systems and no notification system**. Two separate engines compute "needs attention" with different rules and different item sets. The event that most deserves a notification — an agent parked a scheduled task for the operator's approval — produces **zero signal anywhere** (not even an SSE broadcast on create). The moment users most want a tap on the shoulder — an agent blocked while they walked away — produces zero signal outside the app; an Ask can sit parked for 4 hours in silence (the exact mechanism DOR-1350 built to let it survive that long). Meanwhile one failed button click can produce two stacked toasts, copy-to-clipboard has five different feedback implementations, and dismissal state is split between server config and per-browser localStorage.

The redesign: **four kinds of "telling the user something" (Attention · Activity · Suggestion · Feedback), three loudness tiers (Blocking · Notable · Quiet), one server-side pipeline with a per-channel delivery ledger, one Inbox with filtered lenses, and an escalation ladder** (in-app → desktop banner with Allow/Deny/Reply → phone after N min unacknowledged; answering anywhere stops everything). This supersedes ADR 0009's ban on OS notifications.

The hardest parts already exist: the Ask system (one DTO, addressed SSE, entitlement, optimistic receipts, answer-anywhere-settles-everywhere) is the pattern the whole system promotes; the sidebar's Heads up zone has the right philosophy; the bottom-slot arbiter is already built (DOR-1369, in flight in another agent's worktree as of tonight).

---

## 2. What exists today (the inventory)

### 2.1 Two attention engines (the core duplication)

**Engine 1 — "Heads up"** (sidebar zone `now`): `entities/attention/model/derive-attention-signals.ts:152-257`, a strict allowlist of four kinds — `permission-prompt`, `question`, `error`, `idle-timeout` — with priority tiers (`rank-now-items.ts:17-46`), a cap of 3 (+rollups), one dismissible idle nudge max (`IDLE_NUDGE_LIMIT = 1`), the "All clear ✓" beat (`use-all-clear-beat.ts`, 2.5 s). Fed by `usePendingApprovals` (SSE `approval_pending`/`resolved`), `usePendingInteractions` (SSE `interaction_pending`/`resolved`), and session lifecycles. Idle-nudge dismissals are in-memory only (`idle-nudge-store.ts`, deliberately unpersisted).

**Engine 2 — "Needs Attention"** (Home triage header): `features/dashboard-attention/model/use-attention-items.ts:59-190`, a _different_ set of four kinds — `stalled-session` (idle 30 min–24 h, the "Session idle for X minutes" rows Dorian flagged as noise), `failed-run`, `dead-letter`, `offline-agent` — capped at 8, computed client-side on a 60 s clock tick. Rendered by `PinnedTriageHeaderView.tsx:384-394`. Only `dead-letter` has a real dismiss (server-side `DELETE /dead-letters`); the rest self-resolve or age out. A fifth type, `tool-approval`, was designed and never shipped (`specs/dashboard-content/02-specification.md:172,192`).

Both engines invented an idle rule independently; a third near-namesake (`entities/session/model/agent-attention.ts` `ATTENTION_THRESHOLDS`, 1 h/7 d) powers the agents-list grouping. `forward-look.ts:17-23` documents the 24 h/8-row blindspot in engine 2 as a known gap.

### 2.2 The Ask system (the pattern worth promoting)

Three kinds, one wire shape: `approval` / `question` / `elicitation` in `PendingInteractionDTOSchema` (`packages/shared/src/schemas.ts:1170`). Server: `SessionStateProjector` → `SessionListBroadcaster.broadcastInteraction` (`session-list-broadcaster.ts:572-603`) with **addressed** fan-out (`askEntitlement`, DOR-1356, ADR 260819-022912); park at 10 min, expire at 4 h (DOR-1350; `interaction-wait.ts`); six answer routes behind one guard (`requirePersonToAnswer`); a conformance test keeps list and answer routes agreeing. Client: one hook (`use-pending-interactions.ts:70-156`) merging fleet SSE with the attached session's stream so no two surfaces can disagree on a countdown; `useAnswerAsk` with optimistic receipts; `settleAsk` holds an answered card 1.2 s on every surface simultaneously.

One `interaction_pending` for a background session simultaneously lights: the header pill (`ApprovalsIndicator`, mounted `AppShell.tsx:645` — this is the "top-right alert"), a sidebar Heads up row, the session row's amber `needs-you` dot, plus (conditionally) a Home "Waiting On You" card, a room live-lane card, and the in-composer prompt. Minimum 3 mirrors, up to 6 — deliberate ("one DTO serves every path"), and safe because of the shared store + receipts. Known asymmetries: mobile's Now tab gives capability approvals a full card but Asks only a row (`MobileNowApprovals.tsx:37-46` reads only `usePendingApprovals`); capability-approval events are broadcast **unaddressed** (`approval-events.ts:22-68`) — the half DOR-1356 didn't touch.

**Two unrelated "approval" systems share the word**: SDK tool-call approvals (Asks) vs capability approvals (`approval_pending`, destructive-tier MCP gate). And `/feedback-requests` is a third false friend — it tracks product feedback sent to the DorkOS team, nothing to do with agents needing you.

### 2.3 Scheduled-task approvals: the zero-signal gap

Agents create schedules via `tasks_create` (`task-tools.ts:133-167`), which always parks them `pending_approval` (DOR-504 security fix — an agent must not arm its own unattended cron). Approve = `PATCH {status:'active'}`; reject = DELETE. **Nothing announces a parked task**: no badge on the tab (`HomeTabBar.tsx:56-165` renders none), not an attention item in either engine, the MCP create path emits no activity event and no `tasks_changed` SSE, and `useTasks` has no subscription or poll anyway. A completed-run badge hook exists with zero consumers (`use-completed-task-run-badge.ts` — dead code). The only discovery path is wandering into `/tasks`.

### 2.4 Toasts: 171 call sites, four defect classes

Sonner, mounted bare (`sonner.tsx:12-37`; `App.tsx:208`, `AppShell.tsx:708`) — no position/duration/richColors config anywhere; one call site overrides duration. Defects:

1. **Systemic double-toasting**: `query-client.ts:98-154`'s global `MutationCache.onError` toasts every failed mutation _in addition to_ any feature-level `onError` toast unless `meta.suppressErrorToast`/`meta.errorLabel` is set — verified stacking in ~10 flows (create agent, create channel/DM, all binding CRUD in `IntegrationsTab`, adapter toggle, rename session, onboarding/tours patches).
2. **Copy-to-clipboard has five implementations**: inline-only `useCopyFeedback`; the same hook _plus_ a redundant toast; unawaited `writeText` + unconditional success toast; `.then/.catch` toasts; error-only toast.
3. **A success styled as an error**: `ProfileAgentActions.tsx:137` — `toast.error(\`Deleted ${name}…\`)` on a successful delete.
4. **Redundant success toasts** for state the control already shows (`SettingFieldRenderers.tsx:66,123,183,231`, `ExtensionsSettingsTab.tsx:61`), plus 6 bare `toast()` calls that are semantically successes.

The one consistently great pattern: **toast + Undo** on reversible destructive actions (archive/leave room, remove member, unregister agent). The toast/banner boundary is already articulated in `banner.tsx:8-13` ("a success is a transient event… a banner marks a standing condition") — vocabulary to keep.

### 2.5 The Suggestion layer (banners, promos, tours, celebrations)

Four systems, **no cross-coordinator** — on a fresh install the telemetry banner + a promo card + a tour spotlight + confetti can all be present at once:

- **App banner** (`AppBannerSlot.tsx`, priority ladder in `banner-descriptor.ts`): telemetry consent (no dismiss — must decide; server config `telemetry.userHasDecided`) vs unattended-autonomy warning; single-winner, warning beats neutral. Its doc records a removed bypass-permission banner: "two alarms for one fact teach people to read neither."
- **Promos** (`promo-registry.ts:39-108`): 4 units; `remote-access` is `shouldShow: () => true`; sidebar card has no ×; dismissal in localStorage (`dorkos-dismissed-promo-ids`). Being fixed by the bottom-slot arbiter (DOR-1369, branch `feat/sidebar-bottom-slot`, active worktree — one card at a time, × always, `ui.promos.dismissedIds` in config).
- **Tours** (occasion-driven 0→1 detectors, `use-tour-occasions.ts:27-99`; `tours.seen/declined` in server config; single-flight).
- **Celebrations** (`celebration-engine.ts`): ~30% probabilistic mini per task completion, major confetti when a session's list finishes; `dorkos-show-task-celebrations` in localStorage. Not actually first-time-gated; the only true first-time moment is onboarding's dissolve (`OnboardingConversation.tsx:203-236`).

### 2.6 Out-of-app: deliberately nothing (ADR 0009)

- **No Electron `Notification` anywhere**; the tray is explicitly "a control panel, not a notification farm" (`tray.ts:6-17`) and **counts blocked sessions as "working"** (`agent-activity.ts:34-37` lumps `streaming`+`blocked`), so it cannot say "waiting on you."
- **No web push / service worker / PWA manifest / `Notification.requestPermission`** in the client. ADR `0009-calm-tech-notification-layers.md` explicitly excluded the Browser Notification API; `specs/notification-sound/01-ideation.md:26` scoped OS notifications out.
- In-tab signals that do exist and are quietly great: favicon animation (`use-favicon.ts`), tab-title `(N) 🔔 🏁` prefixes while hidden (`use-document-title.ts:111-196`), one notification sound (`notification-sound.ts`, `/notification.wav`, played on every `onStreamingDone`, localStorage toggle).
- The only out-of-app path: **Relay → Telegram/Slack** — `relay_notify_user` (consent-gated `canInitiate`, 10/agent/hour budget, DM-room fallback via `notify-dm.ts`) and the system `TaskCompletionNotifier` (`notifyOnTaskComplete` per binding). Email is cloud-site-only by design (`apps/site/src/lib/mailer.ts`).
- **No notification preferences, no quiet hours, no DND concept anywhere.** `enableNotificationSound` is per-browser localStorage.

### 2.7 Unread messages

Rooms have real read cursors (server-side, SSE `read_cursor`) and a two-tier unread vocabulary (`derive-unread-signal.ts:46-58`): `activity` = bold label only; `directed` (DM or mention) = numbered badge, pierces mute. Never pushes, never sounds — even a DM addressed to you while the window is unfocused.

---

## 3. External research (what the best systems do)

Full agent report retained in the session; load-bearing findings:

1. **Canonical data model**: Event → Notification (the decision, with idempotency key + category) → **Delivery record per channel** (sent/seen/acted) → Preference. The delivery ledger is the piece systems skip early and regret — it is the prerequisite for attention-aware escalation and "did I see this?" ([MagicBell notification-system-design](https://www.magicbell.com/blog/notification-system-design)).
2. **Linear's Inbox** is the joy benchmark: narrow auto-subscribe, category bundling (not a giant matrix), snooze as first-class, and **email fires only if the in-app notification was never read** — channels as fallbacks, not duplicates. Critique worth heeding: a flat inbox "treats attention as abundant"; rank blocked-on-you above finished above FYI ([Linear docs](https://linear.app/docs/notifications)).
3. **Slack's decision tree**, properly factored (per Sophie Alpert's critique), is one linear gate: muted? → prefs? → DND? → presence picks the channel → email self-disables once a better channel exists. Slack's reframe: "when does the user _want_ their attention drawn?"
4. **GitHub is the chore benchmark**: watching floods, no blocking-vs-FYI distinction, and it notifies you about your own actions — the cardinal sin. **Never notify on the user's own action.**
5. **Apple's interruption tiers** (Passive/Active/Time-Sensitive/Critical) map ~1:1 to agent states — borrowed as Blocking/Notable/Quiet in plain words (decision 1A).
6. **Escalation ladders** exist only in incident tooling (PagerDuty one-target-at-a-time; incident.io priority-branched paths with per-channel DND bypass). **No consumer/dev product runs one for personal notifications — genuine white space.**
7. **AI-agent competitive scan**: Cursor has native banners but no phone push (a paid third-party ecosystem — Pushary $9.99/mo, ntfy hooks, AI Done Now — exists purely to fill the gap); OpenAI Codex mobile ships approve-from-lock-screen and frames the phone as "a control surface for a remote agent"; Linear Agents make `awaitingInput` a first-class session state. The universal user complaint: _"came back to find it stuck on a yes/no question for half an hour"_ — fire on **waiting-for-input, not just completion**.
8. **Delight guardrails**: Robinhood's confetti died under regulatory scrutiny (celebration serving the platform); Duolingo's guilt-streaks are the manufactured-urgency anti-pattern. Shareable moments must be **earned artifacts about the user's own output** (Wrapped works because the content is 100% the user). Arc: delight compounds from small consistent craft, not spectacle.
9. **Web push mechanics 2026**: localhost is a secure context (SW + Push API work), but delivery requires the server to reach Google/Mozilla/Apple push endpoints — outbound internet, fine for typical installs, impossible airgapped. **iOS delivers push only to installed PWAs** and a self-hosted origin has no APNs path without a cloud relay (ntfy's `upstream-base-url` relay mode is the precedent). Electron needs none of this — native `Notification` with `actions` + `hasReply` (inline reply), and DorkOS desktop is already signed, which is the macOS prerequisite for action callbacks.
10. **Permission UX**: never prompt on launch; contextual primer at the moment of concrete benefit ("Want a nudge when this needs you?" as the first long task starts), OS dialog only after the primer.
11. **Sound**: one notification sound ≈ the distraction cost of a phone call (FSU study). Sound is an escalation-tier resource: silent for routine, one soft knock for Blocking, nothing else.

---

## 4. The model (decided)

Every message to the operator is exactly one of four kinds, each with one home:

| Kind           | Definition                                                                        | Home                                                                          | Read state                                                                      |
| -------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Attention**  | Standing condition: something needs you (Ask, permission, parked schedule, error) | Mirrored everywhere at once (pill/bell, sidebar Heads up, Home, inbox-pinned) | **None — clears only on resolution**, then slides into history with its outcome |
| **Activity**   | Event: something happened (turn finished, run completed, DM/mention, dead letter) | The **Inbox**, with per-item read/unread synced server-side                   | Yes                                                                             |
| **Suggestion** | The product talking (promo, tour, profile nudge, update available)                | The **bottom slot** (DOR-1369 arbiter)                                        | Dismissal in config                                                             |
| **Feedback**   | Response to your own action (saved/copied/failed)                                 | **Inline in the control**; toast only when the consequence is off-screen      | n/a                                                                             |

Tiers on Attention/Activity items: **Blocking** (stopped until you act — the only tier that escalates or makes sound) · **Notable** (worth knowing soon; OS notification only while away, silent) · **Quiet** (ambient; inbox history + unread weight only, never OS, never sound).

Pipeline (server): domain events that already exist (`interaction_pending`, task parked, run terminal, room message, lifecycle) → one linear notify gate (kind → tier → audience via the `askEntitlement` pattern → muted? → **own action? drop** → presence picks channels) → surfaces + channels (in-app SSE mirrors, Inbox row in SQLite, Electron notification, web push, Telegram/Slack, sound) → **delivery ledger** per channel (sent/seen/acted) → escalation for unacknowledged Blocking. Baked-in rules: never notify on the user's own action; presence suppresses (viewing the thing = no ping for it); channels get louder one at a time; answering anywhere settles everywhere.

The escalation ladder (Blocking only): t=0 in-app mirrors + tab 🔔 (ends here if that surface is focused) → t=0 desktop notification when unfocused (agent face, Allow/Deny/inline-Reply on the banner, one knock) → +N min (default 2, one knob: 1/2/5/15/never) phone via web push or Telegram/Slack → 4 h park ceiling (existing) with an honest "expired unanswered" history row.

DX contract: adding a notification = one registry entry (`{kind, tier, subject, title, actions}`) + one `notify(kind, payload)` call. Fan-out, audience, presence, dedupe, ledger, escalation, every surface and channel: handled.

---

## 5. Answers to the operator's direct questions

1. **Global view + per-agent view**: one inbox store, N lenses. The bell popover is the global lens; the agent profile gains a Notifications section = the same list filtered by subject agent; the session view filters by session.
2. **"Have I seen this?"**: yes for Activity (per-item read, server-synced) and per-channel in the ledger; deliberately **no** for Attention — a standing condition is resolved, not read.
3. **Unread messages join at the delivery layer** (decision 4A): DM/@mention = Notable → pushes when unfocused, Slack-style; channel chatter = Quiet, never pushes. Read cursors stay the room source of truth; the inbox row auto-reads with the room. Muting a room mutes its notifications — one switch.
4. **Toast vs inline** (decision 6A): _feedback lives where your eyes already are._ Inline morph for copy (ONE shared component replaces five) and settings controls; inline errors for form problems; toast only for off-screen consequences, undoable-destructive (+Undo), and the single global failure handler (every mutation must declare `meta.errorLabel` or `suppressErrorToast`; a lint rule makes double-toasting impossible). Standing conditions → banner/attention, never toast. "Something happened while away" → notification, no longer sonner's job. Target ≈ 80 justified call sites, from 171.
5. **Version updates fold in as a Suggestion kind** (`update.available` → bottom slot, exactly today's pill, arbiter rank #2), plus a Quiet post-update inbox row ("Updated to vX — see what's new"). Never toasts, never pushes.

---

## 6. Bugs and quick wins (independent of the redesign)

| #   | What                                                                        | Where                                                        |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Double-toast on mutation errors (~10 verified flows)                        | `query-client.ts:98-154` + feature `onError`s without `meta` |
| 2   | Success styled as error                                                     | `ProfileAgentActions.tsx:137`                                |
| 3   | Five copy-feedback implementations                                          | see §2.4                                                     |
| 4   | Redundant success toasts beside self-evident controls                       | `SettingFieldRenderers.tsx`, `ExtensionsSettingsTab.tsx:61`  |
| 5   | 6 bare `toast()` calls that are semantically successes                      | `OnboardingFlow.tsx:62`, `TaskRow.tsx:100/110`, etc.         |
| 6   | Parked schedule = zero signal; MCP create path emits no SSE/activity event  | `task-tools.ts:133-167`, `routes/tasks.ts:307-317`           |
| 7   | `useTasks` has no live subscription (nothing consumes `tasks_changed`)      | `use-tasks.ts:12-20`                                         |
| 8   | Dead badge hook, zero consumers                                             | `use-completed-task-run-badge.ts`                            |
| 9   | Tray lumps `blocked` into "working"                                         | `agent-activity.ts:34-37`, `tray.ts:108-111`                 |
| 10  | Mobile Now tab: approvals get cards, Asks only rows                         | `MobileNowApprovals.tsx:37-46`                               |
| 11  | Capability-approval events broadcast unaddressed (Ask events are addressed) | `approval-events.ts:22-68`                                   |
| 12  | Sound plays on every turn-end; pref in localStorage                         | `ChatPanel.tsx:266-267`, `app-store-preferences.ts:40-98`    |
| 13  | Celebrations/promo prefs in localStorage (don't sync)                       | `app-store-helpers.ts`                                       |
| 14  | "approval" means two systems; `/feedback-requests` reads as agent-feedback  | vocabulary                                                   |

---

## 7. Program (waves; each ships alone)

- **W0 — honesty + diet**: the §6 bug list; toast policy + lint; one copy-feedback component. Depends on nothing. (Bottom-slot arbiter is NOT ours — DOR-1369 is actively in flight in another worktree as of 2026-08-19 evening; consume it.)
- **W1 — one attention engine**: merge `dashboard-attention` into `entities/attention`; add `schedule.parked` as Blocking (+ SSE on MCP create); failed runs/dead letters become Activity; idle leaves attention → digest (3A); tray says "N working · M waiting on you"; fix mobile asymmetry.
- **W2 — the Inbox**: server notification store + delivery ledger + `notification` SSE; bell (the pill, grown up: ghost when empty, amber+count when Blocking); popover with pinned Needs-you + Activity; read state; agent-profile and session lenses; "All clear" beat on drain.
- **W3 — channels + ladder**: supersede ADR 0009; Electron native notifications with Allow/Deny/Reply; desktop web push (VAPID); Telegram/Slack unified as channels of the same pipeline; presence suppression; the one escalation knob; contextual permission primer; the knock + settle sound family (turn-end sound becomes opt-in); prefs to config.
- **W4 — messages + Shift Report**: DM/mention → Notable with push-when-away; daily Shift Report card (digest, grown up) + weekly shareable artifact.
- **W5 — iOS**: PWA manifest + install moment + cloud push relay (ntfy pattern) — needs an infra decision.

---

## 8. Open items (for SPECIFY)

- Inbox retention window and storage shape (per-notification rows vs event-sourced projection).
- Escalation default delay (proposed 2 min) and whether Notable-while-away desktop notifications are per-category opt-outs on day one.
- Web-push service worker scope on the CLI-served SPA; VAPID keypair storage in `~/.dork/`.
- iOS relay: DorkOS-hosted push forwarder vs ntfy-compatible topic — pricing/privacy posture.
- Whether `relay_notify_user` folds into `notify()` or remains the agent-facing verb that feeds it (leaning: it becomes a registry kind, keeping its consent gate + budget).
- Shift Report data contract (what counts as "shipped") and share format.
- Snooze: Linear-style "not now" on Activity rows — v1 or later.
- Naming: "Inbox" vs "Activity"; rename `/feedback-requests` nav copy to "Product feedback".
