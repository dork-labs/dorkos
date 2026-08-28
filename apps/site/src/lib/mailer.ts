/**
 * Transactional email seam for DorkOS (accounts-and-auth P2; extended for
 * feedback-pipeline Part 4).
 *
 * This module is the **only** place Resend is touched. Better Auth's
 * `sendVerificationEmail` / `sendResetPassword` hooks (`./auth.ts`), the
 * newsletter service, and the feedback pipeline (`app/api/feedback/route.ts`,
 * `app/api/webhooks/linear/route.ts`) all call functions here, so tests mock
 * this module rather than the network — no test ever performs real email I/O.
 *
 * The Resend client is constructed lazily on first send so importing this module
 * (during `next build`, or when auth is wired but no mail is sent) never
 * requires `RESEND_API_KEY`. Local self-hosted DorkOS never imports this at all;
 * email is a cloud-only concern. The account/newsletter functions **throw** when
 * `RESEND_API_KEY` is unset (a caller-visible failure is correct there); the two
 * feedback functions instead catch and log internally — see their own doc
 * comments for why.
 *
 * @module lib/mailer
 */
import { Resend } from 'resend';

import { env } from '@/env';
import { formatShippedVersionLabel } from '@/lib/feedback/version-label';

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
      '<p>Confirm your email to start receiving release notes and agent reports, about twice a month:</p>',
      `<p><a href="${url}">Confirm my subscription</a></p>`,
      "<p>If you didn't sign up, you can ignore this email and you won't be added.</p>",
    ].join(''),
  });
}

/** Arguments for {@link sendFeedbackShipped}. */
interface FeedbackShippedDetails {
  /** The reporter's own message, so the email echoes what they actually said. */
  message: string;
  /**
   * The DorkOS version the fix/feature shipped in — or, when Linear resolved
   * this from a milestone/cycle *name* rather than an actual version, that
   * name verbatim. Rendered through {@link formatShippedVersionLabel}, which
   * only prefixes `v` when the value looks like a bare version.
   */
  shippedVersion: string;
  /** Optional link to the release notes covering this version. */
  changelogUrl?: string;
}

/** Truncate a report to a short one-line quote for the shipped email. */
function quoteFirstLine(message: string, maxLen = 140): string {
  const line = message.trim().split('\n', 1)[0] ?? '';
  return line.length > maxLen ? `${line.slice(0, maxLen - 1).trimEnd()}…` : line;
}

/**
 * Send the "we got your report" receipt email (feedback-pipeline Part 4,
 * decision 260803-205035).
 *
 * Fired once, from `POST /api/feedback` right after a successful Neon insert,
 * when the reporter has an email on file. **Never throws** — unlike the
 * account emails above, a missing `RESEND_API_KEY` or a Resend outage here
 * must not fail the request that is the caller-visible "received" guarantee,
 * so failures are caught and logged, matching every other best-effort
 * external call in this pipeline (see `lib/newsletter/resend-segment.ts`).
 *
 * @param to - The reporter's email.
 * @param trackingUrl - The public `/feedback/[id]` status page link.
 */
export async function sendFeedbackReceipt(to: string, trackingUrl: string): Promise<void> {
  try {
    await getResend().emails.send({
      from: env.RESEND_FROM,
      to,
      subject: 'We got your DorkOS report',
      html: [
        "<p>Thanks for the report. We'll take a look.</p>",
        `<p><a href="${trackingUrl}">Track its status</a></p>`,
        "<p>We'll only email you about this report.</p>",
      ].join(''),
    });
  } catch (error) {
    console.error('[mailer] sendFeedbackReceipt failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Send the "your report shipped" email (feedback-pipeline Part 4, decision
 * 260803-205035).
 *
 * Fired once, from the Linear webhook handler, the first time a mirrored
 * issue's status maps to `shipped` and the row has an email on file. Same
 * never-throws posture as {@link sendFeedbackReceipt} and for the same
 * reason: a mail failure must never fail the webhook delivery Linear is
 * waiting on.
 *
 * @param to - The reporter's email.
 * @param details - The reporter's original message, the version it shipped
 *   in, and an optional link to the release notes.
 */
export async function sendFeedbackShipped(
  to: string,
  { message, shippedVersion, changelogUrl }: FeedbackShippedDetails
): Promise<void> {
  const versionLabel = formatShippedVersionLabel(shippedVersion);
  try {
    await getResend().emails.send({
      from: env.RESEND_FROM,
      to,
      subject: `Your DorkOS report shipped in ${versionLabel}`,
      html: [
        `<p>Good news: this shipped in ${versionLabel}.</p>`,
        `<p>"${quoteFirstLine(message)}"</p>`,
        changelogUrl ? `<p><a href="${changelogUrl}">See what changed</a></p>` : '',
        "<p>We'll only email you about this report.</p>",
      ].join(''),
    });
  } catch (error) {
    console.error('[mailer] sendFeedbackShipped failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
