/**
 * The words and the dot colour every remote-access surface uses for a state.
 *
 * They live in the entity rather than in any one surface because four surfaces
 * say them: the beacon, its flyout, the Control Center row and Settings
 * (DOR-2086). One table means the four cannot drift into four phrasings of the
 * same state, which is the disagreement the shared store exists to prevent.
 *
 * @module entities/tunnel/lib/remote-access-copy
 */

import type { TunnelState } from '../model/remote-access-store';

/**
 * The heading, in the tense of whatever is actually happening.
 *
 * Every branch is spelled out rather than falling through to "is on": a
 * heading that ASSUMES a live tunnel is one refactor away from telling somebody
 * remote access is on while it is shutting down.
 *
 * `asleep` says "closed for now" and nothing more. It describes the address,
 * never the computer: DorkOS cannot tell whether the computer is asleep, and
 * nothing in the app can wake one, so the words promise neither.
 *
 * @param state - Where remote access currently is.
 */
export function remoteAccessHeading(state: TunnelState): string {
  if (state === 'connected') return 'Remote access is on';
  if (state === 'starting') return 'Connecting…';
  if (state === 'reconnecting') return 'Reconnecting…';
  if (state === 'stopping') return 'Turning off…';
  if (state === 'asleep') return 'Remote access is closed for now';
  if (state === 'draining') return 'Closing…';
  if (state === 'blocked') return 'Remote access needs attention';
  return 'Remote access';
}

/**
 * The status dot's colour for a state, shared by every surface that draws one.
 *
 * Green when reachable now, amber while on its way or when a person is needed,
 * red only for a failure. A managed address that is `asleep` or `draining`
 * gets a neutral dot (DOR-2086): that is the design working, never a warning.
 *
 * @param state - Where remote access is.
 */
export function remoteAccessDotTone(state: TunnelState): string {
  if (state === 'connected') return 'bg-status-success';
  if (state === 'error') return 'bg-status-error';
  if (state === 'off' || state === 'stopping') return 'bg-muted-foreground/40';
  if (state === 'asleep' || state === 'draining') return 'bg-muted-foreground/60';
  return 'bg-status-warning-dot';
}
