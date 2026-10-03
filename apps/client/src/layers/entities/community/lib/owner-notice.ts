/**
 * What the owner of a community reads in DorkOS about a request to make someone else its owner
 * (DOR-2543): the banner on the community's page and the dot on its row. The one-time
 * notifications are written on the server, in the notification registry. Every sentence offers
 * only what this owner can do now, from the options the Community sent.
 *
 * @module entities/community/lib/owner-notice
 */
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import { communityPath } from '@dorkos/shared/community-wire';

/** An open request to replace the owner, as the owner's connection carries it. */
export type OpenOwnerNotice = Extract<CommunityConnectionOwnerNotice, { state: 'open' }>;

/** How dates are written, so tests can pin a locale and zone. */
export interface OwnerNoticeDateFormat {
  locale?: string;
  timeZone?: string;
}

/**
 * The request still running on this connection, or `null` when there is none.
 *
 * @param connection - The connection, as the local server reported it.
 */
export function openOwnerNotice(
  connection: CommunityConnectionDescriptor | undefined
): OpenOwnerNotice | null {
  return connection?.ownerNotice?.state === 'open' ? connection.ownerNotice : null;
}

function formatDate(iso: string, format: OwnerNoticeDateFormat = {}): string {
  return new Intl.DateTimeFormat(format.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: format.timeZone,
  }).format(new Date(iso));
}

/**
 * When the new owner could take over, as the rest of a sentence: "on or after <date>", "at any
 * time now", or, while the owner's notice is still being sent and no date is set, "in 7 days
 * or more" (the shortest wait a Community allows).
 */
function when(notice: OpenOwnerNotice, format?: OwnerNoticeDateFormat): string {
  if (notice.requestState === 'claimable') return 'at any time now';
  if (notice.claimableAfter) return `on or after ${formatDate(notice.claimableAfter, format)}`;
  return 'in 7 days or more';
}

/**
 * The banner's lines, in order: the headline, when the change can happen, what this owner can
 * do about it (one short line each), and, when the host sent the new owner's link again, when
 * it did.
 *
 * @param notice - The open request.
 * @param lifecycle - The community's lifecycle as last confirmed, which decides whether handing
 *   it to someone is possible at all once the owner has a password.
 * @param format - Locale and zone for dates; the viewer's own by default.
 */
export function ownerNoticeBanner(
  notice: OpenOwnerNotice,
  lifecycle: string | undefined,
  format?: OwnerNoticeDateFormat
): string[] {
  const { options } = notice;
  const lines = [
    'Someone asked to replace you as owner',
    `That can happen ${when(notice, format)}, unless you keep ownership.`,
    'Open the space to keep ownership.',
  ];
  if (options.transfer && options.delete) lines.push('You can also hand it over, or delete it.');
  else if (options.transfer) lines.push('You can also hand it over yourself.');
  else if (options.delete) lines.push('You can also delete it.');
  if (options.needsPassword)
    lines.push(
      lifecycle === 'active'
        ? 'To hand it over or delete it, add a password to your account.'
        : 'To delete it, add a password to your account.'
    );
  if (notice.claimReissuedAt)
    lines.push(
      `The new owner’s link was sent again on ${formatDate(notice.claimReissuedAt, format)}.`
    );
  return lines;
}

/**
 * The community's own page in the browser, where the owner keeps ownership. Only ever the
 * connection's pinned origin: the one host this connection has talked to.
 *
 * @param connection - The owner's connection.
 */
export function communityPageUrl(
  connection: Pick<CommunityConnectionDescriptor, 'pinnedOrigin' | 'remoteCommunityId'>
): string {
  return new URL(communityPath(connection.remoteCommunityId), connection.pinnedOrigin).toString();
}
