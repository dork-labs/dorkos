/**
 * The Join dialog's words and its one bit of address arithmetic, kept beside
 * the dialog so the dialog stays about state.
 *
 * @module features/dashboard-sidebar/ui/context/join-space-copy
 */
import { describeCommunityRetryWait } from '@dorkos/shared/community-connections';

/**
 * What to say when a connection could not start.
 *
 * Four refusals get their own words, because "check the address" would send
 * the person looking for a typo in each of them:
 *
 * - `COMMUNITY_SELECTION_REQUIRED`: the address leads to a server holding
 *   several spaces. It is right as far as it goes; they need one space's own
 *   link, so the example is built on the server they typed.
 * - `COMMUNITY_NAME_NOT_FOUND`: the server is real but knows no space by that
 *   short address. Here the spelling really is the thing to check.
 * - `COMMUNITY_RATE_LIMITED`: the server limits how often one machine may
 *   look up a name or start a connection, and this one has reached it. The
 *   address may be fine; the answer is to wait, for as long as the server said
 *   when it said.
 * - `COMMUNITY_UPGRADE_REQUIRED`: the space's server is older than this
 *   DorkOS can connect to. Nothing the person types fixes it; whoever runs the
 *   server has to update it.
 *
 * Every other failure keeps the general message.
 *
 * @param error - Why the start failed.
 * @param address - The address the person submitted.
 */
export function startErrorMessage(error: unknown, address: string | undefined): string {
  const refusal =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; body?: { retryAfterSeconds?: unknown } })
      : {};
  switch (refusal.code) {
    case 'COMMUNITY_SELECTION_REQUIRED':
      return `That address has more than one space on it. Enter the link for the one you want: its short address, like ${shortAddressExample(address)}, or its full link, which has /c/ in it.`;
    case 'COMMUNITY_NAME_NOT_FOUND':
      return 'No space uses that short address there. Check the spelling, or ask for the space’s full link.';
    case 'COMMUNITY_RATE_LIMITED':
      return `This DorkOS has tried that space too many times in a short while. Your address may be fine. Wait ${describeCommunityRetryWait(refusal.body?.retryAfterSeconds)}, then try again.`;
    case 'COMMUNITY_UPGRADE_REQUIRED':
      return 'This space’s server is too old to connect to this DorkOS. Ask whoever runs the space to update it, then try again.';
    default:
      return 'Couldn’t connect. Check the space’s address and try again.';
  }
}

/**
 * Whether a failed start puts the address itself in doubt. A busy server or an
 * outdated server is not the address's fault, so the field is not marked
 * invalid for those; the message is still tied to it.
 *
 * @param error - Why the start failed.
 */
export function blamesAddress(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : '';
  return code !== 'COMMUNITY_RATE_LIMITED' && code !== 'COMMUNITY_UPGRADE_REQUIRED';
}

/** A short address on the server the person typed, or a generic one when it cannot be read. */
function shortAddressExample(address: string | undefined): string {
  try {
    return `${new URL(address ?? '').origin}/your-space`;
  } catch {
    return 'https://example.com/acme';
  }
}

/**
 * The space an invitation link belongs to, as an address the connect form
 * takes: the link's origin, plus `/c/<id>` when the link names one space on a
 * server that holds several. The invite itself (the link's fragment) is left
 * out, so it is never kept here.
 *
 * @param link - A value {@link isCommunityInvitationUrl} accepted.
 */
export function spaceAddressFromInvitation(link: string): string {
  const url = new URL(link.trim());
  const scoped = /^(\/c\/[^/]+)\/join\/?$/u.exec(url.pathname);
  return scoped ? `${url.origin}${scoped[1]}` : url.origin;
}
