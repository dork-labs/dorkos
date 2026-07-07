/**
 * `newsletter_subscriber` — the launch newsletter / email-list table for
 * apps/site (ADR 260707-025214: Resend Broadcasts + Audiences).
 *
 * One row per email address that has entered a capture surface. Double opt-in:
 * a row starts `pending` (a confirm token is emailed) and only becomes
 * `confirmed` when the recipient clicks the link, at which point it is mirrored
 * into a Resend Audiences contact. Unsubscribing flips it to `unsubscribed`
 * (kept as a suppression record, never deleted).
 *
 * ## Isolation (privacy contract)
 *
 * This table is hard-isolated from both the Better Auth account cluster
 * (`./auth-schema.ts`) and the install-telemetry table (`./schema.ts`): **no
 * foreign keys, no join columns, no shared identifiers**. A newsletter
 * subscriber is not a DorkOS account and must never be linked to one here.
 *
 * Only the sha256 **hash** of each token is stored; the raw token lives only in
 * the emailed URL. See `src/lib/newsletter/tokens.ts`.
 *
 * @module db/newsletter-schema
 */
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Subscription lifecycle status.
 *
 * `pending` — captured, confirmation email sent, awaiting the opt-in click.
 * `confirmed` — double opt-in complete; mirrored to a Resend Audiences contact.
 * `unsubscribed` — opted out; retained as a suppression record.
 */
export type NewsletterStatus = 'pending' | 'confirmed' | 'unsubscribed';

/** Where the subscription was captured (analytics + copy tuning only). */
export type NewsletterSource = 'footer' | 'newsletter-page' | 'blog' | 'unknown';

export const newsletterSubscriber = pgTable(
  'newsletter_subscriber',
  {
    /** Random surrogate id (`crypto.randomUUID()`), not tied to any account. */
    id: text('id').primaryKey(),
    /** Lowercased, trimmed email. Unique — one row per address. */
    email: text('email').notNull().unique(),
    /** Lifecycle status — one of {@link NewsletterStatus}. */
    status: text('status').notNull().default('pending'),
    /** Capture surface — one of {@link NewsletterSource}. */
    source: text('source').notNull().default('unknown'),
    /** sha256 of the raw confirm token; nulled once confirmed. */
    confirmTokenHash: text('confirm_token_hash'),
    /** Confirm-token expiry (48h TTL). Null once confirmed. */
    confirmExpiresAt: timestamp('confirm_expires_at', { withTimezone: true }),
    /** sha256 of the raw unsubscribe token; set on confirm, long-lived. */
    unsubscribeTokenHash: text('unsubscribe_token_hash'),
    /** Resend Audiences contact id, set when the subscription is confirmed. */
    resendContactId: text('resend_contact_id'),
    /** Row creation (first capture). */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last mutation. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the double opt-in completed. Null while pending. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** When the address unsubscribed. Null unless unsubscribed. */
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_newsletter_confirm_token').on(t.confirmTokenHash),
    index('idx_newsletter_unsubscribe_token').on(t.unsubscribeTokenHash),
  ]
);

/** A row read from `newsletter_subscriber`. */
export type NewsletterSubscriber = typeof newsletterSubscriber.$inferSelect;

/** A row insertable into `newsletter_subscriber`. */
export type NewNewsletterSubscriber = typeof newsletterSubscriber.$inferInsert;
