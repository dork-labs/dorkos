/**
 * React bindings over the shared auth signals (`shared/lib/auth-signal`).
 *
 * `useSyncExternalStore` subscriptions so `features/auth` UI reacts to the
 * app-wide auth-required flag (flipped by `fetchJSON` on a 401) and the pending
 * owner-setup request (raised by the tunnel exposure flow in `features/settings`).
 *
 * @module features/auth/model/use-auth-signal
 */
import { useSyncExternalStore } from 'react';
import {
  getAuthRequired,
  subscribeAuthRequired,
  getOwnerSetupRequest,
  subscribeOwnerSetupRequest,
  type OwnerSetupRequest,
} from '@/layers/shared/lib';

/** Subscribe to the app-wide "login required" flag (set when a gated request 401s). */
export function useAuthRequired(): boolean {
  return useSyncExternalStore(subscribeAuthRequired, getAuthRequired, getAuthRequired);
}

/** Subscribe to the pending owner-setup request (the tunnel exposure handoff), or `null`. */
export function useOwnerSetupRequest(): OwnerSetupRequest | null {
  return useSyncExternalStore(
    subscribeOwnerSetupRequest,
    getOwnerSetupRequest,
    getOwnerSetupRequest
  );
}
