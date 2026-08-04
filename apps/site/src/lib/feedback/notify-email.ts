/**
 * Resolve the address a feedback row's owner should be notified at
 * (feedback-pipeline Part 4, decision 260803-205035).
 *
 * A row can carry an address two ways: `reporterEmail` (resolved server-side
 * from a verified DorkOS account session, per ADR 260803-205037 — always
 * trustworthy when present) or `contact` (free text the reporter typed
 * themselves, only sometimes an email). This is the one place both triggers
 * (the receipt send in `POST /api/feedback` and the shipped send in the
 * Linear webhook) resolve "do we have somewhere to email," so the two never
 * drift on what counts as an address.
 *
 * @module lib/feedback/notify-email
 */
import { z } from 'zod';

const EmailSchema = z.string().email();

/** The row fields {@link resolveNotifyEmail} reads. */
export interface NotifyEmailSource {
  reporterEmail?: string | null;
  contact?: string | null;
}

/**
 * Return the email to notify at, or `undefined` when neither field is
 * (or looks like) one. `reporterEmail` wins when both are present — it is the
 * verified account address, `contact` is unverified free text that merely
 * happens to look like an email.
 *
 * @param row - The feedback row's `reporterEmail`/`contact` fields.
 */
export function resolveNotifyEmail(row: NotifyEmailSource): string | undefined {
  if (row.reporterEmail) return row.reporterEmail;
  if (row.contact && EmailSchema.safeParse(row.contact).success) return row.contact;
  return undefined;
}
