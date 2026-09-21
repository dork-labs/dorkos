import { useMemo, useSyncExternalStore } from 'react';

/** One committed Community destination generation. */
export interface CommunityRouteEpoch {
  /** Monotonically increasing generation within this browser process. */
  epoch: number;
  /** Qualified route destination that created this generation. */
  destination: string;
  /** Return whether this exact route generation is still current. */
  isCurrent: () => boolean;
}

interface RouteSnapshot {
  epoch: number;
  destination: string;
}

type Listener = () => void;

let snapshot: RouteSnapshot = { epoch: 0, destination: 'installation' };
const listeners = new Set<Listener>();

/** Advance the route generation when the router commits a different destination. */
export function commitCommunityRouteEpoch(destination: string): void {
  if (snapshot.destination === destination) return;
  snapshot = { destination, epoch: snapshot.epoch + 1 };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RouteSnapshot {
  return snapshot;
}

function routeEpoch(current: RouteSnapshot): CommunityRouteEpoch {
  return {
    ...current,
    isCurrent: () => snapshot === current,
  };
}

/** Capture the current committed route generation outside React. */
export function getCommunityRouteEpoch(): CommunityRouteEpoch {
  return routeEpoch(snapshot);
}

/** Read the generation synchronously committed by the router's successful load boundary. */
export function useCommunityRouteEpoch(): CommunityRouteEpoch {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => routeEpoch(current), [current]);
}
