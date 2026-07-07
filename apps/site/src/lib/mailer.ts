/**
 * Transactional email seam for DorkOS account flows (accounts-and-auth P2).
 *
 * This module is the **only** place Resend is touched. Better Auth's
 * `sendVerificationEmail` / `sendResetPassword` hooks (`./auth.ts`) call these
 * two functions, so tests mock this module rather than the network — no test
 * ever performs real email I/O.
 *
 * The Resend client is constructed lazily on first send so importing this module
 * (during `next build`, or when auth is wired but no mail is sent) never
 * requires `RESEND_API_KEY`. Local self-hosted DorkOS never imports this at all;
 * email is a cloud-only concern.
 *
 * @module lib/mailer
 */
import { Resend } from 'resend';

import { env } from '@/env';

/** Arguments shared by every DorkOS account email. */
interface AccountEmail {
  /** Recipient address (the account's email). */
  to: string;
  /** The action URL Better Auth generated (carries the one-time token). */
  url: string;
}

let client: Resend | null = null;

/**
 * Return the shared Resend client, constructing it on first use.
 *
 * @throws Error when `RESEND_API_KEY` is not configured.
 */
function getResend(): Resend {
  if (client) return client;
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set. Configure Resend to send DorkOS account emails.');
  }
  client = new Resend(env.RESEND_API_KEY);
  return client;
}

/**
 * Send the "verify your DorkOS account" email.
 *
 * @param args - Recipient and the Better Auth verification URL.
 */
export async function sendVerificationEmail({ to, url }: AccountEmail): Promise<void> {
  await getResend().emails.send({
    from: env.RESEND_FROM,
    to,
    subject: 'Verify your DorkOS account',
    html: [
      '<p>Welcome to DorkOS.</p>',
      '<p>Confirm your email to finish setting up your DorkOS account:</p>',
      `<p><a href="${url}">Verify your email</a></p>`,
      "<p>If you didn't create a DorkOS account, you can ignore this email.</p>",
    ].join(''),
  });
}

/**
 * Send the "reset your DorkOS account password" email.
 *
 * @param args - Recipient and the Better Auth password-reset URL.
 */
export async function sendResetPassword({ to, url }: AccountEmail): Promise<void> {
  await getResend().emails.send({
    from: env.RESEND_FROM,
    to,
    subject: 'Reset your DorkOS account password',
    html: [
      '<p>We received a request to reset your DorkOS account password.</p>',
      `<p><a href="${url}">Choose a new password</a></p>`,
      "<p>If you didn't request this, you can safely ignore this email.</p>",
    ].join(''),
  });
}

/**
 * Send the newsletter double-opt-in confirmation email (ADR 260707-025214).
 *
 * Sent by the newsletter subscribe route; the URL carries the raw confirm
 * token. Unlike the account emails, this is a marketing opt-in, so the copy
 * states the cadence and that the recipient can ignore it if they did not
 * sign up.
 *
 * @param args - Recipient and the confirmation URL (carries the confirm token).
 */
export async function sendNewsletterConfirmation({ to, url }: AccountEmail): Promise<void> {
  await getResend().emails.send({
    from: env.RESEND_FROM,
    to,
    subject: 'Confirm your DorkOS newsletter subscription',
    html: [
      '<p>Thanks for subscribing to the DorkOS newsletter.</p>',
      '<p>Confirm your email to start receiving release notes and fleet reports, about twice a month:</p>',
      `<p><a href="${url}">Confirm my subscription</a></p>`,
      "<p>If you didn't sign up, you can ignore this email and you won't be added.</p>",
    ].join(''),
  });
}

/**
 * Send the "confirm deletion of your DorkOS account" email (cloud-account-management).
 *
 * Better Auth's self-serve `deleteUser` flow calls this with a one-time
 * confirmation URL; the account is erased only after the user follows it, so a
 * hijacked session cannot silently delete an account. Deletion is irreversible.
 *
 * @param args - Recipient and the Better Auth delete-confirmation URL.
 */
export async function sendDeleteAccountVerification({ to, url }: AccountEmail): Promise<void> {
  await getResend().emails.send({
    from: env.RESEND_FROM,
    to,
    subject: 'Confirm deletion of your DorkOS account',
    html: [
      '<p>We received a request to permanently delete your DorkOS account.</p>',
      '<p>This erases your account, sign-in methods, API keys, and unlinks every',
      ' connected instance. <strong>It cannot be undone.</strong></p>',
      `<p><a href="${url}">Confirm account deletion</a></p>`,
      "<p>If you didn't request this, ignore this email and your account stays active.</p>",
    ].join(''),
  });
}
