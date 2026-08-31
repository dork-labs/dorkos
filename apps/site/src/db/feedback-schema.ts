/**
 * `feedback_submission` — the durable system of record for in-app feedback
 * (feedback-pipeline, decision 260803-205035: dual-write to Linear with Neon
 * as system of record).
 *
 * One row per submission from the in-app feedback dialog (cockpit or site).
 * `POST /api/feedback` inserts a row first (`status: 'received'`) and only
 * then attempts to mirror it into Linear as an issue — the Neon insert is
 * the caller-visible "received" guarantee; Linear is best-effort on top of
 * it, so a transient Linear failure never turns an honest "received" toast
 * into a lie. A Linear webhook (PR D) later writes triage/ship status back
 * onto the same row.
 *
 * ## No foreign keys (deliberate — mirrors `audit_log`'s reasoning)
 *
 * `instanceId`, `reporterEmail`/`reporterName`, and `linearIssueId` are
 * stored as **plain text, never foreign keys**. A GDPR erasure of a `user`
 * row, a rotated/deleted Linear issue, or a regenerated per-install
 * `instanceId` must never cascade-delete or orphan a feedback record — the
 * report and its history have to survive all three. Like `audit_log`, this
 * table is therefore intentionally outside any `onDelete: cascade` cluster:
 * it references other systems only as opaque strings.
 *
 * ## What this table does — and does not — hold
 *
 * `message`/`contact`/`reporterEmail`/`reporterName` are the volunteered
 * free text this table exists to hold (the same exemption
 * `FeedbackSubmittedProperties` already documents in the telemetry mirror —
 * see `app/api/telemetry/events/route.ts`). This table does NOT carry the
 * heavier diagnostics bundle itself (server log excerpts, breadcrumbs,
 * screenshot bytes, transcript excerpts) — only enough to know one was
 * attached (`hasScreenshot`/`hasTranscript` booleans). That heavier,
 * more-identifying content goes to Linear as issue attachments/description
 * content, not into Neon: it keeps this table small and keeps the content
 * in the same system that already handles issue attachments, rather than
 * growing a second blob store here.
 *
 * ## Telemetry isolation (privacy contract)
 *
 * Hard-isolated from `marketplaceInstallEvents`/`instanceHeartbeats`
 * (`./schema.ts`) and the Better Auth account cluster (`./auth-schema.ts`):
 * no foreign key, join column, or shared identifier crosses those
 * boundaries (enforced by `__tests__/schema.test.ts`).
 *
 * @module db/feedback-schema
 */
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Submission kind, mirrors the shared `FeedbackSubmissionSchema.kind` enum. */
export type FeedbackKind = 'feedback' | 'bug' | 'idea';

/** Which app surface the submission originated from. */
export type FeedbackSurface = 'cockpit' | 'site';

/**
 * Cockpit-visible lifecycle status, driven by this route (`received` →
 * `triaged` on a successful Linear create) and later by the Linear webhook
 * (`in_progress` / `shipped` / `closed`, PR D).
 */
export type FeedbackStatus = 'received' | 'triaged' | 'in_progress' | 'shipped' | 'closed';

export const feedbackSubmission = pgTable(
  'feedback_submission',
  {
    /** Random uuid primary key. Doubles as the reporter-facing tracking id. */
    id: uuid('id').primaryKey().defaultRandom(),
    /** The per-install pseudonymous id the submission came from. Opaque text, NOT an FK. */
    instanceId: text('instance_id').notNull(),
    /** What kind of report this is — one of {@link FeedbackKind}. */
    kind: text('kind', { enum: ['feedback', 'bug', 'idea'] }).notNull(),
    /** The volunteered report body. Free text by design (see module doc). */
    message: text('message').notNull(),
    /** Optional free-text contact the reporter typed themselves (e.g. an email or handle). */
    contact: text('contact'),
    /** Resolved server-side account identity, if any. Opaque text, NOT an FK to `user`. */
    reporterEmail: text('reporter_email'),
    /** Resolved server-side account display name, if any. Opaque text, NOT an FK to `user`. */
    reporterName: text('reporter_name'),
    /** The app route the reporter was on when they submitted, if resolvable. */
    route: text('route'),
    /** Which surface the submission came from — one of {@link FeedbackSurface}. */
    surface: text('surface', { enum: ['cockpit', 'site'] }).notNull(),
    /** Whether a screenshot was attached (the bytes live in Linear, not here). */
    hasScreenshot: boolean('has_screenshot').notNull().default(false),
    /** Whether a session transcript excerpt was attached (content lives in Linear, not here). */
    hasTranscript: boolean('has_transcript').notNull().default(false),
    /** Linear issue id, once the best-effort mirror succeeds. Opaque text, NOT an FK. */
    linearIssueId: text('linear_issue_id'),
    /** Linear issue URL, once the best-effort mirror succeeds. */
    linearIssueUrl: text('linear_issue_url'),
    /** Cockpit-visible lifecycle status — one of {@link FeedbackStatus}. Starts `received`. */
    status: text('status', {
      enum: ['received', 'triaged', 'in_progress', 'shipped', 'closed'],
    })
      .notNull()
      .default('received'),
    /** DorkOS version the fix shipped in, filled by the webhook handler when Linear marks it done (PR D). */
    shippedVersion: text('shipped_version'),
    /** Row creation (submission receive time). Server clock. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last mutation (Linear create, or a later webhook status update). Server clock. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_feedback_submission_linear_issue_id').on(t.linearIssueId)]
);

/** A row read from `feedback_submission`. */
export type FeedbackSubmission = typeof feedbackSubmission.$inferSelect;

/** A row insertable into `feedback_submission`. */
export type NewFeedbackSubmission = typeof feedbackSubmission.$inferInsert;
