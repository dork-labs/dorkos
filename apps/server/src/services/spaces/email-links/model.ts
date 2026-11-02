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
  /** Mails of one kind queued to one address in any hour. */
  perAddressPerHour: 3,
  /**
   * Mails of one kind queued to one address in any 24 hours: a backstop no faster than the hourly
   * cap (3 × 24), so someone staying under that cap never blocks a person for a day. Counted per
   * kind, so anonymous reset requests never use up a person's sign-in or confirmation mail.
   */
  perAddressPerDay: 72,
  /** Sign-in or confirmation requests one account may make in an hour, per kind. */
  perAccountPerHour: 3,
  /** Requests one caller address (an IPv6 /64) may make in an hour, beside the minute setting. */
  perCallerPerHour: 20,
  /** Uses (peek, reset, sign-in, confirm) one caller may make a minute, per request allowed. */
  useMultiplier: 4,
  /**
   * Mails an invitation's sign-up may queue to one address in any hour, the finishing link and
   * the existing-account notice together (DOR-2730), so a stranger cannot mail one person over
   * and over by signing up with their address.
   */
  invitePerAddressPerHour: 1,
} as const;

/**
 * What an invitation's sign-up or Resend records for an address whose account is in use, confirmed
 * or not (migration 0049, DOR-2730): a plain notice that names the space and carries no token.
 */
export const EXISTING_ACCOUNT_REQUEST = 'existing_account';

/** Every kind of request the mail worker's resolver decides: the three links and the notice. */
export type EmailRequestKind = EmailLinkKind | typeof EXISTING_ACCOUNT_REQUEST;

/** The notice each kind of request is mailed as. */
export const EMAIL_REQUEST_NOTICE_KIND = {
  ...EMAIL_LINK_NOTICE_KIND,
  existing_account: 'account.existing_account',
} as const satisfies Record<EmailRequestKind, NoticeKind>;

/** How long an invitation's finishing link works: longer than a reset, as joining takes a while. */
export const INVITE_LINK_LIFETIME_MS = HOUR_MS;

/**
 * Whether this server mails links at all: mail is set up and the worker can compose every kind,
 * the existing-account notice included. There is no separate switch; without mail, none of them
 * exists and the screens keep telling people to ask the person running the space.
 */
export function emailLinksOn(
  config: Pick<CommunityConfig, 'mail'>,
  composers: NoticeComposers
): boolean {
  return (
    config.mail !== null &&
    Object.values(EMAIL_REQUEST_NOTICE_KIND).every((kind) => composers[kind] !== undefined)
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
 * never-confirmed email ends everything too, with `sessions` meaning other devices.
 */
export function clearsFor(kind: EmailLinkKind, confirmed: boolean): string[] {
  if (kind === 'password_reset') return [...(confirmed ? ACCESS_CLEARS : EVERYTHING_CLEARS)];
  if (confirmed) return [];
  return [...EVERYTHING_CLEARS];
}
