/**
 * The one moment worth marking: a tunnel that has just come up.
 *
 * @module widgets/remote-access/model/use-connect-ripple
 */

import { useEffect, useRef, useState } from 'react';
import type { TunnelState } from '@/layers/entities/tunnel';

/**
 * Count the times remote access has become reachable while this was mounted.
 *
 * The count is a React `key`, not a number anybody reads: bumping it remounts
 * the beacon's ripple, which is a one-shot animation and so replays only when
 * it is a new element. That is the whole mechanism — no timers to clear, and no
 * infinite loop to stop.
 *
 * **It stays at zero for a tunnel that was already up.** Opening the app onto
 * remote access you turned on yesterday is not an event; rippling for it would
 * announce a change nobody made, which is the same mistake the status toasts
 * spent a release making.
 *
 * That is what `hasServerReport` is for, and it has to be the STORE's answer
 * ("the server has told us at least once") rather than the query's ("the
 * request came back"). Between those two moments the store still holds its
 * initial `off`, so a baseline seeded there would read the first real answer as
 * `off → connected` and ripple anyway — measured, and the reason this parameter
 * exists.
 *
 * @param state - The current remote-access state.
 * @param hasServerReport - Whether the server's report has been reduced yet.
 * @returns How many connections have happened since mount.
 */
export function useConnectRipple(state: TunnelState, hasServerReport: boolean): number {
  const previous = useRef<TunnelState | null>(null);
  const [connections, setConnections] = useState(0);

  useEffect(() => {
    // Nothing the server has said yet, so there is nothing to have changed.
    if (!hasServerReport) return;
    const before = previous.current;
    previous.current = state;
    // The first thing it says is not a change.
    if (before === null) return;
    if (before !== 'connected' && state === 'connected') setConnections((n) => n + 1);
  }, [state, hasServerReport]);

  return connections;
}
