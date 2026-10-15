import { useCallback, useId, useMemo, useSyncExternalStore } from 'react';
import { useTransport } from '@/layers/shared/model';
import { computerViewerSession } from './computer-viewer-session';

/** Observe a shared computer session while giving this presenter a unique input identity. */
export function useComputerViewer(generation: number) {
  const transport = useTransport();
  const owner = useId();
  const session = useMemo(
    () => computerViewerSession(transport, generation),
    [transport, generation]
  );
  const subscribe = useCallback(
    (notify: () => void) => session.subscribe(owner, notify),
    [session, owner]
  );
  const snapshot = useSyncExternalStore(subscribe, session.getSnapshot);
  return {
    ...snapshot,
    lease: snapshot.owner === owner ? snapshot.lease : null,
    controlledElsewhere: Boolean(snapshot.lease && snapshot.owner !== owner),
    session,
    owner,
  };
}
