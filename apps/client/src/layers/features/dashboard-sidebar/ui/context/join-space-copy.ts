/**
 * The Join dialog's words and its one bit of address arithmetic, kept beside
 * the dialog so the dialog stays about state.
 *
 * @module features/dashboard-sidebar/ui/context/join-space-copy
 */
import { describeCommunityRetryWait } from '@dorkos/shared/community-connections';
import { isCommunityInvitationUrl } from '@dorkos/shared/community-wire';

/**
 * What to say when a connection could not start.
 *
 * Four refusals get their own words, because "check the address" would send
 * the person looking for a typo in each of them:
 *
 * - `space_choice_required`: the address leads to a server holding
 *   several spaces. It is right as far as it goes; they need one space's own
 *   link, so the example is built on the server they typed.
 * - `space_name_not_found`: the server is real but knows no space by that
 *   short address. Here the spelling really is the thing to check.
 * - `rate_limited`: the server limits how often one machine may
 *   look up a name or start a connection, and this one has reached it. The
 *   address may be fine; the answer is to wait, for as long as the server said
 *   when it said.
 * - `space_server_outdated`: the space's server is older than this
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
      ? (error as { code?: unknown; retryAfterMs?: unknown })
      : {};
  switch (refusal.code) {
    case 'space_choice_required':
      return `That address has several spaces. Use one space’s own link, like ${shortAddressExample(address)}.`;
    case 'space_name_not_found':
      return 'No space uses that address. Check the spelling, or ask for its full link.';
    case 'rate_limited':
      return `Too many tries. Your address may be fine. Wait ${describeCommunityRetryWait(retrySeconds(refusal.retryAfterMs))}, then try again.`;
    case 'space_server_outdated':
      return 'This space’s server is too old for this DorkOS. Ask its owner to update it.';
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
  return code !== 'rate_limited' && code !== 'space_server_outdated';
}

/** The host's wait in whole seconds, from the refusal's `retryAfterMs`, or nothing when it named none. */
function retrySeconds(retryAfterMs: unknown): number | undefined {
  return typeof retryAfterMs === 'number' && retryAfterMs > 0
    ? Math.ceil(retryAfterMs / 1000)
    : undefined;
}

/** A short address on the server the person typed, or a generic one when it cannot be read. */
function shortAddressExample(address: string | undefined): string {
  try {
    return `${new URL(address ?? '').origin}/your-space`;
  } catch {
    return 'https://example.com/acme';
  }
}

/** What the form says when a join link can't be opened as an invitation. */
export const INCOMPLETE_INVITATION =
  'That invitation link is incomplete or isn’t secure. Copy the whole link again.';

/**
 * Whether a value is shaped like an invitation (a space's join page) without
 * being one this app may open: plain http off this machine, the invite in the
 * query instead of the fragment, or no invite at all. Such a link is refused
 * in words rather than sent on as an address, which would post it.
 *
 * @param value - What the person typed or pasted.
 */
export function isBrokenInvitation(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  return /^\/(?:c\/[^/]+\/)?join\/?$/u.test(url.pathname) && !isCommunityInvitationUrl(value);
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
