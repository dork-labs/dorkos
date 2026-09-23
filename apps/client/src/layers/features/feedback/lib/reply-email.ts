/**
 * The email a signed-out reporter gives so the DorkOS team can write back
 * (DOR-2232).
 *
 * With login off there is no account to resolve an address from, so the only
 * way a report can ever be answered is an address typed into the form. It rides
 * the submission's existing `contact` field, which the site already treats as
 * the notify address when it looks like an email (`resolveNotifyEmail` in
 * `apps/site/src/lib/feedback/notify-email.ts`).
 *
 * It is remembered in `localStorage` as a per-browser convenience, so the next
 * report starts with it filled in. Every read and write is wrapped: private
 * windows, blocked site data and quota errors all throw, and the form has to
 * work the same without it.
 *
 * @module features/feedback/lib/reply-email
 */
import { z } from 'zod';

/** Where the address is remembered. Per browser, never synced. */
export const REPLY_EMAIL_STORAGE_KEY = 'dorkos-feedback-reply-email';

/**
 * The same check the site runs before it emails anyone (`z.string().email()`),
 * so the thank-you toast never promises an email the site will not send.
 */
const EmailSchema = z.string().email();

/**
 * Whether a typed value is an address the team can write back to.
 *
 * @param value - What was typed, untrimmed.
 */
export function looksLikeEmail(value: string): boolean {
  return EmailSchema.safeParse(value.trim()).success;
}

/** The remembered address, or an empty string when there is none or storage is unavailable. */
export function readReplyEmail(): string {
  try {
    return localStorage.getItem(REPLY_EMAIL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Remember the address for next time, or forget it when the field was cleared.
 * Only an email-shaped value is kept, so a typo is not offered back forever.
 *
 * @param value - What was sent in the field, untrimmed.
 */
export function rememberReplyEmail(value: string): void {
  const trimmed = value.trim();
  try {
    if (looksLikeEmail(trimmed)) localStorage.setItem(REPLY_EMAIL_STORAGE_KEY, trimmed);
    else if (!trimmed) localStorage.removeItem(REPLY_EMAIL_STORAGE_KEY);
  } catch {
    // Storage is a convenience here; the report has already gone.
  }
}
