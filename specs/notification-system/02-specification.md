---
slug: notification-system
id: 260819-234124
created: 2026-08-19
status: specified
design-session: .dork/visual-companion/12683-1787180875
research: research/20260819_notification-system-review.md
---

# Unified notification system

**Status:** Approved (decisions made by Dorian 2026-08-19 in the visual-companion
session; remaining open items resolved by the orchestrating agent under
delegated authority the same evening — each resolution recorded below)
**Author:** Claude (orchestrator) with Dorian
**Date:** 2026-08-19

## Overview

One notification model for DorkOS: every message to the operator is exactly one
of four kinds — **Attention** (standing condition), **Activity** (event),
**Suggestion** (product-initiated), **Feedback** (response to your own action) —
carrying one of three tiers — **Blocking / Notable / Quiet**. One server-side
pipeline (registry → `notify()` → audience/dedupe → surfaces + channels →
per-channel delivery ledger → escalation), one Inbox with filtered lenses, and
out-of-app channels (Electron native, browser Notification + web push,
Telegram/Slack) behind an ack-based escalation ladder. Full evidence:
`research/20260819_notification-system-review.md`; decision record:
`design-decisions.md`.

## Background / Problem Statement

~14 independent attention systems, no notification system. Two attention
engines with different rules; parked schedule approvals produce zero signal;
blocked agents produce zero out-of-app signal for up to 4 h; double-toasting;
five copy-feedback implementations; prefs split across config and localStorage.
Research §2 carries file:line citations for all of this.

## Goals

- One vocabulary and one pipeline for everything the app tells the operator.
- An agent that is blocked reaches the operator wherever they are, and the
  operator can act without opening DorkOS ("answer from anywhere").
- One Inbox with read state and per-subject lenses (global / agent / session).
- Honest surfaces: everything in "needs you" is truly waiting on a person.
- Fewer, better toasts; inline feedback where the eyes already are.
- DX: adding a notification = one registry entry + one `notify()` call.

## Non-Goals

- Email/SMS channels (relay adapters remain the out-of-app transport).
- Configurable escalation matrices (one knob only).
- Snooze on activity rows (follow-up).
- iOS APNs delivery (requires a cloud relay — follow-up spec; this programme
  ships PWA readiness only).
- The "Critical" tier (reserved vocabulary, no implementation).
- Weekly shareable Shift Report artifact (follow-up; daily card ships here).

## Technical Dependencies

- `web-push` (npm) for VAPID web push — server-side only, standard library for
  the Push API. New dependency in `apps/server`.
- Electron `Notification` API (`apps/desktop`, already signed/notarized — the
  macOS prerequisite for action/reply callbacks).
- Existing: SSE `eventFanOut` (+ addressed audiences), Ask answer routes,
  `askEntitlement`, relay `resolveNotifyTarget`/`NotifyBudget`, Drizzle SQLite,
  `conf` config with semver migrations.

## Detailed Design

### Vocabulary (shared)

`packages/shared/src/notification-schemas.ts` (new):

- `NotificationTierSchema = z.enum(['blocking', 'notable', 'quiet'])`
- `NotificationKindSchema` — closed enum, v1 kinds:
  `ask.pending` (blocking; mirror of interactions — NOT stored while pending),
  `schedule.parked` (blocking), `session.error` (blocking),
  `turn.completed` (notable), `run.completed` (notable on failure, quiet on
  success), `dm.received` (notable), `mention.received` (notable),
  `agent.note` (notable; the `relay_notify_user` verb),
  `dead-letter.created` (quiet), `agent.unreachable` (quiet),
  `update.installed` (quiet), `report.daily` (quiet).
- `NotificationDTOSchema`: `{ id, kind, tier, subject: { type:
'session'|'task'|'run'|'room'|'agent'|'system', id }, agentId?, sessionId?,
roomId?, title, body?, actions?: NotificationActionDTO[], createdAt, readAt?,
resolvedAt?, outcome? }`.
- Global SSE events `notification` (upsert) and `notification_read` — **must
  join the client SessionEvent/global allowlist** (hard-won rule: new SSE
  members must be allowlisted client-side or they are dropped).

### Server: `apps/server/src/services/notifications/`

- `notification-registry.ts` — the single declaration point. Each kind:
  `{ kind, tier, subject kind, title/body builders (typed payload), actions,
channelPolicy, dedupeKey builder }`. TSDoc'd; the DX contract from the
  research §4.
- `notification-service.ts` — `notify(kind, payload, opts?)`:
  1. Build DTO from registry; compute `dedupeKey` (idempotent within window).
  2. **Never notify the actor about their own action** — `opts.actorPrincipal`
     matching the operator drops operator-facing delivery.
  3. Audience: single-operator today; Ask-derived kinds reuse
     `askEntitlement`-addressed broadcast (the DOR-1356 pattern) for SSE.
  4. Persist an `notifications` row for Activity kinds. Attention kinds
     (`ask.pending`, `schedule.parked`, `session.error`) are NOT stored while
     standing — they stay derived (existing stores). On resolution the service
     writes a **history row** with `resolvedAt` + `outcome` (answered /
     expired / approved / rejected / cleared).
  5. Broadcast SSE; dispatch channels per policy + config; write
     `notification_deliveries` ledger rows.
- `escalation-service.ts` — Blocking kinds arm a timer
  (`config.notifications.escalation.phoneAfterMinutes`, default 2; `never`
  disarms). **Ack-based, not presence-based**: any of (interaction resolved,
  schedule approved/rejected, a `seen`/`acted` ledger mark from any channel,
  notification read) cancels. On fire: web-push to all subscriptions + relay
  leg (`resolveNotifyTarget`, respecting `canInitiate` + `NotifyBudget`).
  Timers are in-memory; on boot, re-arm from still-pending interactions/parked
  tasks older than the delay (idempotent via ledger).
- `channels/web-push.ts` — VAPID keys generated on first use, stored at
  `<dorkHome>/push/vapid.json` (via `lib/dork-home.ts` — never `os.homedir()`);
  subscriptions in SQLite; payload = DTO subset + deep link; prune dead
  subscriptions on 404/410.
- `channels/relay.ts` — folds `TaskCompletionNotifier` and the
  `relay_notify_user` tool into the pipeline: the MCP tool keeps its surface,
  consent gate and budget, but internally emits `notify('agent.note', …)`;
  the task notifier becomes the `run.completed` registry kind (per-binding
  `notifyOnTaskComplete` respected as channel policy).
- Routes (`routes/notifications.ts`): `GET /api/notifications` (cursor, filters
  `agentId`/`sessionId`/`kind`/`unread`), `PATCH /api/notifications/:id/read`,
  `POST /api/notifications/read-all`, `GET /api/push/vapid-public-key`,
  `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions/:id`.
  Mutations behind the operator guard (`requirePersonToAnswer` pattern);
  agent principals get `see: none`.
- Emitter wiring (small patches at existing seams): projector interaction
  pending/resolved; `tasks_create` MCP handler (also gains its missing
  `tasks_changed` SSE + activity event — W0); run-terminal broadcaster;
  room-entry write path (directed detection: DM room or mention of operator);
  update check (post-update `update.installed`); mesh liveness; dead letters.

### Data model (`packages/db`)

- `notifications`: id (ULID), kind, tier, subjectType, subjectId, agentId?,
  sessionId?, roomId?, title, body?, dataJson, dedupeKey (indexed), createdAt,
  readAt?, resolvedAt?, outcome?.
- `notification_deliveries`: id, notificationId (FK), channel
  (`in_app`|`desktop`|`browser`|`web_push`|`telegram`|`slack`|`sound`),
  sentAt, seenAt?, actedAt?, detailJson.
- `push_subscriptions`: id, endpoint (unique), keysJson, createdAt, lastSeenAt.
- **Retention (RESOLVED):** stored rows, not event-sourced; prune on write to
  30 days AND max 1000 rows (whichever is smaller). Single-operator system —
  no per-user scoping.

### Client

- `entities/notifications`: `useNotifications(lens?)` (query + SSE upserts,
  one store, filter lenses), `useMarkRead`, `useUnreadCount`; pinned
  needs-you section composes the EXISTING `entities/attention` store (asks +
  approvals + schedule-parked + errors) — the inbox does not re-derive it.
- `widgets/inbox-bell` — the `ApprovalsIndicator` grown up (same mount, far
  right of header): ghost-quiet when empty, amber + count when Blocking,
  neutral count for unread Notable. Popover: **Needs you** (pinned, tinted,
  inline Allow/Deny/Approve/Reject/Open via existing `useAnswerAsk` + task
  mutations) above **Activity** (read dots, mark-all). ⌘⇧Y retargets to it.
  "All clear ✓" beat when the pinned section drains (reuse the sidebar's
  pattern, component-local).
- Lenses: agent profile gains a **Notifications** section
  (`useNotifications({ agentId })`); the session view header menu gains "View
  notifications" filtered likewise.
- Attention engine merge: `features/dashboard-attention/use-attention-items`
  is deleted; `entities/attention` becomes the only derivation and gains
  `schedule-approval` (from a new `usePendingScheduleApprovals` over
  `pending_approval` tasks + `tasks_changed`), keeps `error`; **drops
  `idle-timeout` at the source**; failed-run/dead-letter/offline-agent move to
  Activity kinds (server-emitted). Home's triage header renders from the one
  engine (Blocking pinned + today's Activity).
- Toast diet (W0, exact rules in research §5.4): one `CopyFeedback` shared
  component (button morphs to ✓, handles clipboard failure inline) replacing
  the five implementations; settings success-toasts deleted; form errors
  inline; every mutation declares `meta.errorLabel` or `suppressErrorToast`
  (contract test in the style of `one-create-surface.test.ts` scans for
  violations); bug fixes: `ProfileAgentActions.tsx:137` red success, 6 bare
  `toast()` successes, unawaited clipboard writes.
- Browser leg (no SW needed): when `document.hidden` and permission granted,
  Blocking + Notable fire an in-page `new Notification()` (title = agent name,
  body, click focuses + deep-links). Permission via a **contextual primer**
  card shown at the first long-running turn ("Want a nudge when this needs
  you?"), never on launch. `PermissionPrimer` in `features/notifications`.
- Sounds: generated assets (extend the existing generator script) — `knock`
  (Blocking arrival, default on), `settle` (all-clear, default on),
  `turn-end` (existing wav, **default off** — was on for every turn).
  Preferences move to config (see below); localStorage key migrated one-time.
- Web push subscription UI in Settings → Notifications tab (subscribe this
  browser, list/remove devices, escalation knob, sound toggles, per-kind
  Notable toggles deferred — one global "notify me when a turn finishes while
  I'm away" boolean in v1).

### Desktop (`apps/desktop`)

- `main/notifications.ts`: consume the global SSE stream (the
  `agent-activity.ts` precedent), show native `Notification` for Blocking
  (+Notable when no window focused): agent name/emoji, body, actions
  **Allow/Deny** (approvals), **Reply…** (`hasReply`, questions), click →
  focus + deep-link. Actions call the existing answer routes over localhost
  (same-origin fetch from main; when remote auth is enabled and main lacks a
  cookie, fall back to focus+deep-link).
- Tray truth: `agent-activity.ts` splits `blocked` from `streaming`; title
  "3 working · 1 waiting"; waiting > 0 → amber dot on the icon; dock badge =
  blocking count. (Tray copy stays one quiet sentence — the "control panel,
  not a notification farm" doc comment is updated, not deleted.)

### Config (`UserConfigSchema`, semver migration per `adding-config-fields`)

```
notifications: {
  escalation: { phoneAfterMinutes: 1|2|5|15|'never' (default 2) },
  sounds: { knock: true, allClear: true, turnEnd: false },
  notifyOnTurnCompleteWhileAway: true,
  browserPermissionPrimerDismissed: false,
}
```

Disclosure/write-policy tables updated (agent-readable, operator-writable).
Do NOT touch `ui.promos.dismissedIds` — DOR-1369 owns it (in flight).

### Sequencing constraint (operator-mandated, 2026-08-19)

**Another agent owns the left sidebar** (sidebar-simplification + DOR-1369).
No task in this spec edits `features/dashboard-sidebar` or
`features/feature-promos` until the final integration task, which runs after
everything else: pull latest main, review the landed sidebar work, then (a)
add `schedule-approval` to the sidebar's `NOW_KINDS` + glyph, (b) add the
idle-sessions fact to the Today digest, (c) register `update.installed` /
bottom-slot touchpoints with the landed arbiter, (d) reconcile any drift.
Until then, dropping `idle-timeout` at `entities/attention` is sidebar-safe
(the sidebar's allowlist simply stops receiving those signals), and new signal
kinds are additive (unknown kinds are ignored by the sidebar's allowlist).

## User Experience

See mockups in the design session (`01-notifications-review.html` §3, §6).
Entry points: the bell (every route), agent profile section, session menu,
OS notifications, Telegram/Slack. Error paths: expired asks recorded as
"expired unanswered" history rows; push failures prune subscriptions silently;
permission denied → primer never re-prompts (config flag).

## Testing Strategy

- **Unit:** registry (every kind builds a valid DTO; dedupe keys stable);
  notification-service (own-action drop, attention-vs-activity storage rule,
  history-on-resolve); escalation (arms/cancels on each ack path, re-arms on
  boot, `never` disarms); web-push channel (prune on 410); toast contract test
  (no mutation onError toast without meta); copy-feedback component.
- **Integration:** SSE `notification` events via `collectDurableEvents`;
  routes (list/read/read-all, operator guard refuses agent principals — the
  `ask-answer-conformance` style); schedule-parked end-to-end (MCP create →
  SSE + notify → approve from inbox → cron registered).
- **E2E (mock leg):** bell shows amber on interaction_pending; answering from
  the popover settles everywhere; inbox lens filters by agent.
- **Mocking:** `web-push` mocked at module boundary; Electron `Notification`
  behind a thin injectable wrapper.

## Performance Considerations

Prune-on-write keeps the table ≤1000 rows; SSE reuses the existing fan-out;
inbox queries are cursor-paged (25); escalation timers O(pending blocking)
which is single digits in practice.

## Security Considerations

Notification mutations operator-gated; SSE stays addressed for ask-derived
detail (DOR-1356 discipline — capability-approval events also become
addressed in W2, closing the noted asymmetry); web-push payloads carry titles
and deep links, never tool inputs or transcript content; VAPID private key at
`<dorkHome>/push/` (0600); relay legs keep `canInitiate` + budget.

## Documentation

`docs/` guide "Notifications" (user-facing, writing-for-humans); update
`docs/guides/action-approvals.mdx` (bell rename); `contributing/` note in the
architecture guide for the registry pattern; changelog fragments per PR.

## Implementation Phases

Waves (each PR ships alone; sidebar-deferred items noted):

- **W0** — T1 toast meta contract + double-toast sweep · T2 CopyFeedback +
  toast bug fixes · T3 task signal quick wins (MCP create SSE/activity event,
  `useTasks` subscribes, dead badge hook deleted, `/feedback-requests` copy →
  "Product feedback").
- **W1** — T4 one attention engine (merge, `schedule-approval` kind, idle
  dropped at source, Home renders from it) · T5 desktop tray truth + mobile
  Now-tab ask cards.
- **W2** — T6 server notification domain (schemas, tables, registry, service,
  routes, SSE + allowlist, emitters, ledger; capability-approval events become
  addressed) · T7 client inbox (entities, bell, popover, lenses, read state,
  all-clear).
- **W3** — T8 config leaf + sounds + browser Notification + primer ·
  T9 Electron native notifications + ADR-0009 supersession ·
  T10 web push + escalation service + relay fold-in.
- **W4** — T11 messages → pipeline (dm/mention, mute + read-cursor
  integration) · T12 daily Shift Report card.
- **W5** — T13 PWA readiness (manifest + installability) — descoped from push.
- **W-final** — T14 sidebar integration (after the sidebar agent lands; pull,
  review, then wire NOW_KINDS, digest idle fact, bottom-slot touchpoints).

## Open Questions

- ~~Inbox retention/storage~~ (RESOLVED) — rows in SQLite, prune-on-write 30
  d/1000 rows. Rationale: single operator, no scale concern; rows keep the
  query/read model trivial.
- ~~Escalation default + Notable granularity~~ (RESOLVED) — 2 min default;
  one global while-away boolean in v1. Rationale: one knob was the decided
  posture (5A); per-kind matrices are the anti-pattern the research flagged.
- ~~SW scope / VAPID storage~~ (RESOLVED) — no SW needed for the desktop
  browser leg (in-page Notification while hidden); SW + VAPID only for the
  escalated push leg; keys in `<dorkHome>/push/vapid.json`. Rationale:
  smallest thing that ships the ladder.
- ~~iOS relay~~ (RESOLVED) — out of this programme; W5 ships PWA readiness;
  follow-up ticket for the relay decision. Rationale: infra/pricing decision
  the operator should make awake.
- ~~relay_notify_user~~ (RESOLVED) — becomes the `agent.note` registry kind;
  tool surface, consent gate, budget unchanged.
- ~~Shift Report contract~~ (RESOLVED) — daily card from existing queries
  (sessions touched, runs, asks answered/expired, PRs if derivable from
  activity); weekly shareable deferred.
- ~~Snooze~~ (RESOLVED) — deferred, follow-up ticket.
- ~~Naming~~ (RESOLVED) — "Inbox"; `/feedback-requests` nav copy → "Product
  feedback".

## Related ADRs

Seeded as drafts by this spec: four-kinds/three-tiers model · notifications
row store + delivery ledger · ack-based one-knob escalation · supersession of
ADR 0009. Constraining: 260819-022912 (addressed Ask events), 0192
(relay_notify_user), 260711-031624 (task-completion notifier), 260819-210153
(bottom slot, in flight), 0006 (sonner), 0285/DOR-504 (schedule approval
gates).

## References

`research/20260819_notification-system-review.md` (all file:line evidence and
external sources) · `design-decisions.md` · visual companion
`.dork/visual-companion/12683-1787180875/`.
