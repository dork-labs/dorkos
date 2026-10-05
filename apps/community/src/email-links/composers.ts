import { COMMUNITY_EMAIL_LINK_PAGES } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { accountErasureOpen, signInRefusal } from '../erasure/guards.js';
import { plainTextMail, type ComposedMail } from '../mail/messages.js';
import type { NoticeComposer, NoticeComposers } from '../mail/worker.js';
import { hashSecret, hmacSecret, randomToken } from '../security.js';
import {
  EMAIL_LINK_LIFETIME_MS,
  EMAIL_LINK_NOTICE_KIND,
  EMAIL_LINK_SEND_WINDOW_MS,
  type EmailLinkKind,
} from './model.js';
import { liveHoldFor, passwordFingerprint } from './tokens.js';

type Settings = Pick<CommunityConfig, 'publicUrl' | 'authSecret'>;

/** The plain-text message for one kind of link (spec §8). The link is the only secret in it. */
export function emailLinkMail(kind: EmailLinkKind, publicUrl: string, link: string): ComposedMail {
  const host = new URL(publicUrl).host;
  if (kind === 'password_reset')
    return plainTextMail(`Reset your password for ${host}`, [
      `Someone asked to reset the password for your account at ${publicUrl}.`,
      `To choose a new password, open this link within 30 minutes: ${link}`,
      'Resetting signs out every device and ends DorkOS connections, agent keys, invitation links and server API keys.',
      "If you didn't ask, ignore this email. Your password stays the same.",
    ]);
  if (kind === 'sign_in')
    return plainTextMail(`Your sign-in link for ${host}`, [
      `Open this link within 15 minutes to sign in to ${publicUrl}: ${link}`,
      'It works once, and only in the browser where you asked for it.',
      "If you didn't ask, ignore this email.",
    ]);
  return plainTextMail(`Confirm your email for ${host}`, [
    `Confirm this address for your account at ${publicUrl}. Open this link while signed in, within 24 hours: ${link}`,
    'Confirming signs out your other devices if the address was never confirmed.',
    "If you didn't make an account there, ignore this email. Don't forward it.",
  ]);
}

/**
 * The composer for one kind of link. It mints the link for this one send attempt:
 *
 * - a request older than its send window (an hour; a day for a confirmation) is obsolete, so a
 *   mail the server could not send for hours never arrives as a surprise;
 * - eligibility is checked again under the account's lock (same address, may sign in, not being
 *   forgotten, the hold still live, the email still unconfirmed);
 * - every live link of this kind for the account is replaced, and the new one stored only as its
 *   hash, in one transaction;
 * - the link is built from `publicUrl` only, never from a request header, with the token after
 *   `#` so it never reaches a server log.
 */
function composeEmailLink(kind: EmailLinkKind, settings: Settings): NoticeComposer {
  return async ({ pool, notice, now }) => {
    const found = await pool.query<{
      kind: EmailLinkKind;
      email_hash: string;
      pending_link_hash: string | null;
      state: string;
      created_at: Date;
    }>(
      `SELECT kind,email_hash,pending_link_hash,state,created_at FROM email_link_requests
       WHERE id=$1`,
      [notice.subjectId]
    );
    const request = found.rows[0];
    if (!request || request.kind !== kind || request.state !== 'queued') return null;
    if (now.getTime() - request.created_at.getTime() > EMAIL_LINK_SEND_WINDOW_MS[kind]) return null;
    const userId = notice.recipientUserId;
    const token = await transaction(pool, async (client) => {
      const user = await client.query<{ email: string; emailVerified: boolean }>(
        'SELECT email,"emailVerified" FROM "user" WHERE id=$1 FOR UPDATE',
        [userId]
      );
      const account = user.rows[0];
      if (!account) return null;
      if (hmacSecret(account.email.toLowerCase(), settings.authSecret) !== request.email_hash)
        return null;
      if ((await signInRefusal(client, userId)) || (await accountErasureOpen(client, userId)))
        return null;
      if (kind === 'sign_in' && !(await liveHoldFor(client, request.pending_link_hash, userId)))
        return null;
      if (kind === 'email_confirmation' && account.emailVerified) return null;
      await client.query(
        `UPDATE email_link_tokens SET superseded_at=now()
         WHERE user_id=$1 AND kind=$2 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [userId, kind]
      );
      const raw = randomToken();
      await client.query(
        `INSERT INTO email_link_tokens(token_hash,kind,user_id,request_id,outbox_id,email_hash,
           password_fingerprint,pending_link_hash,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz + $10 * interval '1 millisecond')`,
        [
          hashSecret(raw),
          kind,
          userId,
          notice.subjectId,
          notice.id,
          request.email_hash,
          kind === 'password_reset' ? await passwordFingerprint(client, userId) : null,
          kind === 'sign_in' ? request.pending_link_hash : null,
          now,
          EMAIL_LINK_LIFETIME_MS[kind],
        ]
      );
      return raw;
    });
    if (!token) return null;
    return emailLinkMail(
      kind,
      settings.publicUrl,
      `${settings.publicUrl}${COMMUNITY_EMAIL_LINK_PAGES[kind]}#${token}`
    );
  };
}

/** The composers for the three mailed links, by notice kind. */
export function emailLinkComposers(settings: Settings): NoticeComposers {
  return Object.fromEntries(
    (Object.keys(EMAIL_LINK_NOTICE_KIND) as EmailLinkKind[]).map((kind) => [
      EMAIL_LINK_NOTICE_KIND[kind],
      composeEmailLink(kind, settings),
    ])
  );
}
