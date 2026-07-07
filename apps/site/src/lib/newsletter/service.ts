/**
 * Newsletter double opt-in service (ADR 260707-025214).
 *
 * The single place the `newsletter_subscriber` lifecycle lives: capture →
 * pending (confirm email) → confirmed (mirrored to a Resend Segment) →
 * unsubscribed. Route handlers are thin wrappers over these functions; tests
 * drive the service directly with the mailer and Resend segment mirror mocked.
 *
 * All functions are intentionally enumeration-safe at the caller boundary: the
 * subscribe route returns the same response for a new address, a duplicate
 * pending, and an already-confirmed one — this module reports what happened via
 * {@link SubscribeOutcome} for logging/tests, never to the end user.
 *
 * @module lib/newsletter/service
 */
import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { type NewsletterSource, newsletterSubscriber } from '@/db/newsletter-schema';
import { resolveBaseURL } from '@/lib/auth';
import { sendNewsletterConfirmation } from '@/lib/mailer';

import { unsubscribeContact, upsertSegmentContact } from './resend-segment';
import { generateNewsletterToken, hashNewsletterToken } from './tokens';

/** Confirm-token time-to-live: 48 hours in milliseconds. */
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;

/** What `subscribe` did, for server-side logging and tests (never shown to users). */
export type SubscribeOutcome = 'created' | 'resent' | 'already-confirmed';

/** Result of a confirm attempt. */
export type ConfirmResult = 'confirmed' | 'already-confirmed' | 'invalid';

/** Result of an unsubscribe attempt. */
export type UnsubscribeResult = 'unsubscribed' | 'already-unsubscribed' | 'invalid';

/** Normalize an email for storage and comparison (trim + lowercase). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Build the confirm URL carrying the raw token. */
function confirmUrl(rawToken: string): string {
  return `${resolveBaseURL()}/api/newsletter/confirm?token=${rawToken}`;
}

/**
 * Capture an email into the newsletter list and send (or resend) the
 * double-opt-in confirmation.
 *
 * Idempotent by email: a `pending` row has its token rotated and the email
 * resent; an already-`confirmed` row is left untouched; an `unsubscribed` row is
 * reopened as `pending` (an explicit re-subscribe). The confirmation email is
 * sent for every non-confirmed outcome. Mailer failures propagate to the caller
 * (the route swallows them so the response never leaks address state).
 *
 * @param email - The raw submitted email.
 * @param source - Which capture surface this came from.
 * @returns Which lifecycle branch was taken.
 */
export async function subscribe(
  email: string,
  source: NewsletterSource
): Promise<SubscribeOutcome> {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = await db
    .select()
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.email, normalized))
    .limit(1);

  const row = existing[0];
  if (row?.status === 'confirmed') return 'already-confirmed';

  const token = generateNewsletterToken();
  const now = new Date();
  const confirmExpiresAt = new Date(now.getTime() + CONFIRM_TTL_MS);

  if (row) {
    await db
      .update(newsletterSubscriber)
      .set({
        status: 'pending',
        source,
        confirmTokenHash: token.hash,
        confirmExpiresAt,
        unsubscribedAt: null,
        updatedAt: now,
      })
      .where(eq(newsletterSubscriber.id, row.id));
  } else {
    await db.insert(newsletterSubscriber).values({
      id: crypto.randomUUID(),
      email: normalized,
      status: 'pending',
      source,
      confirmTokenHash: token.hash,
      confirmExpiresAt,
    });
  }

  await sendNewsletterConfirmation({ to: normalized, url: confirmUrl(token.raw) });
  return row ? 'resent' : 'created';
}

/**
 * Complete the double opt-in for a confirm token.
 *
 * On success the row flips to `confirmed`, a long-lived unsubscribe token is
 * minted, and the address is mirrored into the Resend Segment. Expired or
 * unknown tokens return `invalid`; a token whose row is already confirmed
 * returns `already-confirmed` (idempotent double-click).
 *
 * @param rawToken - The raw confirm token from the URL.
 * @returns The confirm result.
 */
export async function confirm(rawToken: string): Promise<ConfirmResult> {
  if (!rawToken) return 'invalid';
  const db = getDb();
  const hash = hashNewsletterToken(rawToken);
  const rows = await db
    .select()
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.confirmTokenHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row) return 'invalid';
  if (row.status === 'confirmed') return 'already-confirmed';
  if (row.confirmExpiresAt && row.confirmExpiresAt.getTime() < Date.now()) return 'invalid';

  const unsubscribeToken = generateNewsletterToken();
  // Reactivate an existing contact (re-subscribe) or create a new one. A null
  // return means unconfigured or a transient failure, so keep any existing id
  // rather than orphaning the row (the mirror self-heals on the next confirm).
  const contactId =
    (await upsertSegmentContact({
      email: row.email,
      contactId: row.resendContactId,
    })) ?? row.resendContactId;
  const now = new Date();
  await db
    .update(newsletterSubscriber)
    .set({
      status: 'confirmed',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      unsubscribeTokenHash: unsubscribeToken.hash,
      resendContactId: contactId,
      confirmedAt: now,
      updatedAt: now,
    })
    .where(eq(newsletterSubscriber.id, row.id));

  return 'confirmed';
}

/**
 * Unsubscribe the address behind an unsubscribe token.
 *
 * Flips the row to `unsubscribed` (retained as a suppression record) and marks
 * the Resend contact `unsubscribed`. Unknown tokens return `invalid`; an
 * already-unsubscribed row returns `already-unsubscribed` (idempotent).
 *
 * @param rawToken - The raw unsubscribe token from the URL.
 * @returns The unsubscribe result.
 */
export async function unsubscribe(rawToken: string): Promise<UnsubscribeResult> {
  if (!rawToken) return 'invalid';
  const db = getDb();
  const hash = hashNewsletterToken(rawToken);
  const rows = await db
    .select()
    .from(newsletterSubscriber)
    .where(eq(newsletterSubscriber.unsubscribeTokenHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row) return 'invalid';
  if (row.status === 'unsubscribed') return 'already-unsubscribed';

  await unsubscribeContact(row.resendContactId);
  const now = new Date();
  await db
    .update(newsletterSubscriber)
    .set({ status: 'unsubscribed', unsubscribedAt: now, updatedAt: now })
    .where(eq(newsletterSubscriber.id, row.id));

  return 'unsubscribed';
}
