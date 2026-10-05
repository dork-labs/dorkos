import type { CommunityWireEmailLinkKind } from '@dorkos/shared/community-wire';
import type { CommunityConfig } from '../config.js';
import type { NoticeKind } from '../mail/outbox.js';
import type { NoticeComposers } from '../mail/worker.js';
import { ApiError } from '../http.js';

/** One kind of mailed link: reset a password, sign in, or confirm an email. */
export type EmailLinkKind = CommunityWireEmailLinkKind;

/** The notice each kind of link is mailed as. */
export const EMAIL_LINK_NOTICE_KIND = {
  password_reset: 'account.password_reset',
  sign_in: 'account.sign_in_link',
  email_confirmation: 'account.email_confirmation',
} as const satisfies Record<EmailLinkKind, NoticeKind>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a link works, from the moment its mail is composed. */
export const EMAIL_LINK_LIFETIME_MS: Record<EmailLinkKind, number> = {
  password_reset: 30 * MINUTE_MS,
  sign_in: 15 * MINUTE_MS,
  email_confirmation: 24 * HOUR_MS,
};

/**
 * How long after its request a link may still be mailed. A mail the server could not send for
 * longer than this is dropped (`NOTICE_OBSOLETE`) rather than arrive as a surprise.
 */
export const EMAIL_LINK_SEND_WINDOW_MS: Record<EmailLinkKind, number> = {
  password_reset: HOUR_MS,
  sign_in: HOUR_MS,
  email_confirmation: 24 * HOUR_MS,
};

/** Fixed caps, not settings. */
export const EMAIL_LINK_CAPS = {
  /** Mails queued to one address in any hour, across every kind. */
  perAddressPerHour: 3,
  /** Mails queued to one address in any 24 hours, across every kind. */
  perAddressPerDay: 10,
  /** Sign-in or confirmation requests one account may make in an hour, per kind. */
  perAccountPerHour: 3,
  /** Requests one caller address (an IPv6 /64) may make in an hour, beside the minute setting. */
  perCallerPerHour: 20,
  /** Uses (peek, reset, sign-in, confirm) one caller may make a minute, per request allowed. */
  useMultiplier: 4,
} as const;

/**
 * Whether this server mails links at all: mail is set up and the worker can compose all three
 * kinds. There is no separate switch; without mail, none of the three exists and the screens
 * keep telling people to ask the person running the space.
 */
export function emailLinksOn(
  config: Pick<CommunityConfig, 'mail'>,
  composers: NoticeComposers
): boolean {
  return (
    config.mail !== null &&
    Object.values(EMAIL_LINK_NOTICE_KIND).every((kind) => composers[kind] !== undefined)
  );
}

/** The refusal every mailed-link route gives on a server without mail. */
export function emailLinksUnavailable(): ApiError {
  return new ApiError(
    409,
    'NOTICE_DELIVERY_UNAVAILABLE',
    "This space can't send email. Ask the person running it for help."
  );
}

/** What a reset or a confirmation ends on any account: every derived way in. */
export const ACCESS_CLEARS = [
  'sessions',
  'connections',
  'agent_credentials',
  'pairings',
  'invites',
  'host_api_keys',
] as const;
/** What mailbox proof ends on an account whose email was never confirmed: everything. */
export const EVERYTHING_CLEARS = [...ACCESS_CLEARS, 'password', 'sign_in_links'] as const;

/**
 * What using a link ends, by key, so the page can list it before the person submits. A reset
 * on a confirmed account ends derived access and keeps provider sign-ins; on a never-confirmed
 * account it ends everything. A sign-in link ends nothing on a confirmed account. Confirming a
 * never-confirmed email ends derived access, with `sessions` meaning other devices.
 */
export function clearsFor(kind: EmailLinkKind, confirmed: boolean): string[] {
  if (kind === 'password_reset') return [...(confirmed ? ACCESS_CLEARS : EVERYTHING_CLEARS)];
  if (confirmed) return [];
  return [...(kind === 'sign_in' ? EVERYTHING_CLEARS : ACCESS_CLEARS)];
}
