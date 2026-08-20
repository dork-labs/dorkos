import { sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Notification history — what DorkOS told the operator, and whether they read it
 * (spec `notification-system`, ADR 260819-234828).
 *
 * **Only two of the four notification kinds ever land here, and they land
 * differently.** An Activity notification ("a run finished") is an event, so it
 * is written the moment it happens. An Attention notification ("an agent is
 * waiting on you") is a standing condition that the domain stores already answer
 * correctly — the interaction store knows which Asks are pending, the task store
 * knows which schedules are parked — so duplicating it here while it stands would
 * create a second source of truth for the most safety-critical state in the app.
 * A standing kind therefore writes exactly one row, at the moment it RESOLVES,
 * carrying {@link notifications.resolvedAt} and {@link notifications.outcome}.
 * That is what makes the history honest: an Ask nobody answered is a row saying
 * `expired`, not an absence.
 *
 * **The table is capped, not archival.** Every write prunes to 30 days and 1000
 * rows, whichever bites first. This is a single-operator local tool; old history
 * is genuinely gone, which the ADR accepts.
 *
 * There is deliberately no user column. DorkOS is single-identity, and a
 * per-user scope here would be a column that is always the same value.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    /** ULID — lexicographically sortable, so it is also the paging cursor. */
    id: text('id').primaryKey(),

    /**
     * Which registry entry raised this. Matches `NotificationKind` in
     * `@dorkos/shared/notification-schemas`, which is the authoritative list;
     * this narrowing exists so a row that drifts fails to compile at the store.
     */
    kind: text('kind', {
      enum: [
        'ask.pending',
        'schedule.parked',
        'session.error',
        'turn.completed',
        'run.completed',
        'dm.received',
        'mention.received',
        'agent.note',
        'dead-letter.created',
        'agent.unreachable',
        'update.installed',
        'report.daily',
      ],
    }).notNull(),

    /** How loud this was allowed to be. Copied from the registry at write time. */
    tier: text('tier', { enum: ['blocking', 'notable', 'quiet'] }).notNull(),

    /** What it is about — the thing a surface opens when the row is clicked. */
    subjectType: text('subject_type', {
      enum: ['session', 'task', 'run', 'room', 'agent', 'system'],
    }).notNull(),

    /** Id of the subject within its type. */
    subjectId: text('subject_id').notNull(),

    /** Agent this concerns, when there is one. The per-agent lens key. */
    agentId: text('agent_id'),

    /** Session this concerns, when there is one. The per-session lens key. */
    sessionId: text('session_id'),

    /** Room this concerns, when there is one. */
    roomId: text('room_id'),

    /** One line, already written for a person. */
    title: text('title').notNull(),

    /** An optional second line. Never transcript content, tool input, or secrets. */
    body: text('body'),

    /**
     * The `notify()` payload as JSON, so the row can rebuild its action buttons.
     *
     * Actions are NOT stored: they are rebuilt from the registry on read, so a
     * label or an intent fixed today also fixes every row already written. That
     * only works if the payload the builders take survives, which is what this
     * column is for. Never secrets — it is the same payload the SSE event
     * carried.
     */
    dataJson: text('data_json'),

    /**
     * What makes two of these the same notification.
     *
     * Read on every `notify()` call to answer "did we already say this?", which
     * is why it is the one column with a hot index.
     */
    dedupeKey: text('dedupe_key').notNull(),

    /** When it was raised. ISO 8601 UTC. */
    createdAt: text('created_at').notNull(),

    /** When the operator read it. Null means unread. ISO 8601 UTC. */
    readAt: text('read_at'),

    /**
     * When the standing condition behind it ended. ISO 8601 UTC.
     *
     * Set exactly on the history rows described above, and null on every
     * Activity row — an event has nothing to resolve.
     */
    resolvedAt: text('resolved_at'),

    /** How it ended. Set exactly when {@link notifications.resolvedAt} is. */
    outcome: text('outcome', {
      enum: ['answered', 'expired', 'cancelled', 'approved', 'rejected', 'cleared'],
    }),
  },
  (table) => [
    // The dedupe probe runs on every notify(), so it is the one lookup worth an
    // index. Composite with `created_at` because the probe is always "same key,
    // recently" — never the key alone.
    index('idx_notifications_dedupe_key').on(table.dedupeKey, table.createdAt),
    // Prune-on-write deletes by age, also on every notify().
    index('idx_notifications_created_at').on(table.createdAt),
    // The lens filters (agentId, sessionId, kind, unread) deliberately have no
    // index: prune caps this table at 1000 rows, so a filtered scan is cheaper
    // than the writes four more indexes would cost on the hot path.
  ]
);

/**
 * Where each notification was sent, and how far it got — the answer to "did this
 * actually reach me?".
 *
 * **This is the piece notification systems skip early and regret.** Escalation
 * ("get louder if nobody acknowledged") is not a timer over a notification; it is
 * a question about deliveries, per channel. Without a ledger, "seen on the
 * desktop but not on the phone" is unanswerable and every escalation rule
 * becomes a guess.
 *
 * **A delivery does not always have a notification row to hang off.** An
 * Attention condition writes nothing while it stands (see {@link notifications}),
 * and the escalation ladder's whole job is to reach somebody WHILE it stands — so
 * an escalated push or chat message is a real delivery about a subject that has
 * no row yet. Those rows carry {@link notificationDeliveries.subjectKey} and a
 * null {@link notificationDeliveries.notificationId}. Every row carries the
 * subject key, escalated or not, so "has anything about this subject reached the
 * operator?" is one query rather than two.
 */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    /** ULID. */
    id: text('id').primaryKey(),

    /**
     * The notification this delivery was for, when one exists.
     *
     * A real cascading foreign key, unlike most of this schema: prune-on-write
     * deletes notifications constantly, and a ledger outliving its notification
     * would be rows nothing can interpret. `foreign_keys` is ON for every DorkOS
     * connection, so SQLite does the cascade.
     *
     * Null for an escalation delivery raised while its subject was still
     * standing — {@link notificationDeliveries.subjectKey} is what interprets
     * those, so a null here is never an uninterpretable row.
     */
    notificationId: text('notification_id').references(() => notifications.id, {
      onDelete: 'cascade',
    }),

    /**
     * What this delivery was ABOUT, independent of whether a row exists for it.
     *
     * The same string as the raising notification's `dedupe_key` (`ask:<id>`,
     * `schedule:<id>`, …), which is what lets the escalation service ask "has
     * this subject already been escalated, or already been acknowledged?" across
     * a server restart — the idempotency the ack-based ladder is built on
     * (ADR 260819-234829).
     *
     * Nullable only because rows written before this column existed have none.
     */
    subjectKey: text('subject_key'),

    /** Which way it went out. */
    channel: text('channel', {
      enum: ['in_app', 'desktop', 'browser', 'web_push', 'telegram', 'slack', 'sound'],
    }).notNull(),

    /** When DorkOS handed it to the channel. ISO 8601 UTC. */
    sentAt: text('sent_at').notNull(),

    /** When the operator demonstrably saw it there. ISO 8601 UTC. */
    seenAt: text('seen_at'),

    /** When the operator acted on it there. ISO 8601 UTC. */
    actedAt: text('acted_at'),

    /** Channel-specific detail as JSON — a target handle, a refusal reason. */
    detailJson: text('detail_json'),
  },
  (table) => [
    index('idx_notification_deliveries_notification').on(table.notificationId),
    // The escalation service's two questions — "already escalated?" and "already
    // acknowledged?" — are both `WHERE subject_key = ?`, asked on every arm and
    // every fire. Unlike the notifications table's lens filters, this one is not
    // bounded by a 1000-row cap it can scan.
    index('idx_notification_deliveries_subject').on(table.subjectKey),
  ]
);

/**
 * Browsers that asked to be pushed to when DorkOS is not open.
 *
 * Written by the push routes (`routes/push.ts`) when somebody presses "Notify
 * this device", and read by the web-push channel when a Blocking condition has
 * gone unanswered long enough to escalate (spec `notification-system` task 4.3,
 * ADR 260819-234829).
 *
 * A subscription is a capability URL: anybody holding the endpoint can push to
 * that browser. It never leaves this machine, is never returned by any route,
 * and the payloads it carries are titles and deep links, never transcript
 * content. A push service answering `404`/`410` means the browser is gone for
 * good, and the row is deleted rather than retried.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    /** ULID. */
    id: text('id').primaryKey(),

    /** The push service URL this browser handed us. Unique — one row per browser. */
    endpoint: text('endpoint').notNull(),

    /** The `p256dh` and `auth` keys as JSON, used to encrypt each payload. */
    keysJson: text('keys_json').notNull(),

    /** When the browser subscribed. ISO 8601 UTC. */
    createdAt: text('created_at').notNull(),

    /** When a push to it last succeeded. ISO 8601 UTC. */
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [uniqueIndex('idx_push_subscriptions_endpoint').on(table.endpoint)]
);
