/**
 * The one sentence the beacon's flyout is headed with.
 *
 * It lives beside the two components rather than inside either, because BOTH
 * say it and they say it in different places: on a desktop the panel draws it
 * as its own heading, and on a phone the drawer's title carries it instead —
 * one heading per sheet. A test that mocks the panel must not take the beacon's
 * heading away with it, which is what kept this out of the panel module.
 *
 * @module widgets/remote-access/model/remote-access-copy
 */

import type { TunnelState } from '@/layers/entities/tunnel';

/**
 * The heading, in the tense of whatever is actually happening.
 *
 * Every branch is spelled out rather than falling through to "is on": the
 * beacon only opens this while a tunnel is live, but a heading that ASSUMES
 * that is one refactor away from telling somebody remote access is on while it
 * is shutting down.
 *
 * @param state - Where remote access currently is.
 */
export function remoteAccessHeading(state: TunnelState): string {
  if (state === 'connected') return 'Remote access is on';
  if (state === 'starting') return 'Connecting…';
  if (state === 'reconnecting') return 'Reconnecting…';
  if (state === 'stopping') return 'Turning off…';
  return 'Remote access';
}
