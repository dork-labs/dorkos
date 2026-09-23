/**
 * Synchronous local-owner authority generation shared by auth and Community features.
 *
 * The server remains authoritative for the opaque owner key. Invalidating this
 * state first makes every older read and stream generation unusable before a
 * credential transition or an auth-required screen can expose another owner.
 *
 * @module shared/lib/community-authority-state
 */

/** Confirmed local-owner authority for Community browser data. */
export interface CommunityAuthoritySnapshot {
  /** Monotonically increasing boundary for auth and owner changes. */
  epoch: number;
  /** Server-resolved owner, or null until the current epoch is confirmed. */
  ownerKey: string | null;
}

/** Authority snapshot whose owner has been confirmed by the local server. */
export interface ConfirmedCommunityAuthority extends CommunityAuthoritySnapshot {
  ownerKey: string;
}

type Listener = () => void;
type Cleanup = () => void;

let snapshot: CommunityAuthoritySnapshot = { epoch: 0, ownerKey: null };
const listeners = new Set<Listener>();
let cleanup: Cleanup | null = null;

/** Read the current immutable authority snapshot. */
export function getCommunityAuthority(): CommunityAuthoritySnapshot {
  return snapshot;
}

/** Return whether a captured confirmed authority is still current. */
export function isCommunityAuthorityCurrent(expected: ConfirmedCommunityAuthority): boolean {
  return snapshot.epoch === expected.epoch && snapshot.ownerKey === expected.ownerKey;
}

/** Subscribe to authority changes. */
export function subscribeCommunityAuthority(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Register the app-owned protected-cache cleanup invoked during invalidation.
 * Returns a disposer so isolated hosts and tests cannot leave a stale handler.
 */
export function registerCommunityAuthorityCleanup(handler: Cleanup): () => void {
  cleanup = handler;
  return () => {
    if (cleanup === handler) cleanup = null;
  };
}

/** Invalidate authority before credentials, protected caches, or UI state change. */
export function invalidateCommunityAuthority(): CommunityAuthoritySnapshot {
  snapshot = { epoch: snapshot.epoch + 1, ownerKey: null };
  cleanup?.();
  listeners.forEach((listener) => listener());
  return snapshot;
}

/**
 * Confirm the server-resolved owner only when the bootstrap response still
 * belongs to the current epoch. A late response can never revive old authority.
 */
export function confirmCommunityAuthority(epoch: number, ownerKey: string): boolean {
  if (snapshot.epoch !== epoch) return false;
  if (snapshot.ownerKey === ownerKey) return true;
  if (snapshot.ownerKey !== null) return false;
  snapshot = { epoch, ownerKey };
  listeners.forEach((listener) => listener());
  return true;
}

/*
 * Per-connection generations.
 *
 * The owner epoch above fences a whole local owner. Losing ONE Community — a
 * disconnect here, a membership removed on its host, a revoked grant — must
 * fence that Community's work without touching another Community or the
 * installation (spec: "Cleanup for A never touches B"). So each connection ref
 * carries its own counter, and content captured under an older counter is
 * discarded on arrival, even after the route later returns to the same ref.
 */
let connectionGenerations: ReadonlyMap<string, number> = new Map();
const connectionListeners = new Set<Listener>();

/** Read the current generation of one Community connection ref. */
export function getCommunityConnectionGeneration(ref: string): number {
  return connectionGenerations.get(ref) ?? 0;
}

/** Subscribe to per-connection generation changes. */
export function subscribeCommunityConnectionGenerations(listener: Listener): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

/**
 * Tombstone one Community connection's current generation.
 *
 * Call this FIRST when that connection is authoritatively removed or revoked,
 * before closing its streams or clearing its caches: every read, event, receipt
 * and retry captured under the old generation then fails its guard, so nothing
 * in flight can repopulate what the cleanup is about to erase.
 *
 * @param ref - The local connection ref being removed or revoked.
 * @returns The new generation for that ref.
 */
export function tombstoneCommunityConnection(ref: string): number {
  const next = getCommunityConnectionGeneration(ref) + 1;
  const updated = new Map(connectionGenerations);
  updated.set(ref, next);
  connectionGenerations = updated;
  connectionListeners.forEach((listener) => listener());
  return next;
}
