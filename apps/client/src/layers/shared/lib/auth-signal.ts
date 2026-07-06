/**
 * Auth signals — framework-agnostic app-wide auth state shared across FSD features.
 *
 * Lives in the base `shared` layer because it is set from two places that must not
 * import each other or a feature:
 *
 * - `fetchJSON` (this layer) flips {@link setAuthRequired} when a gated request
 *   returns `401 { code: 'AUTH_REQUIRED' }`, so the `features/auth` `AuthGuard`
 *   can render the login screen without every call site re-checking status.
 * - `features/settings` (the tunnel exposure flow) calls {@link requestOwnerSetup}
 *   when a tunnel start is rejected with `AUTH_REQUIRED_FOR_EXPOSURE`, and
 *   `features/auth` (the owner-setup host) reads it — a cross-feature handoff that
 *   would otherwise be a forbidden model-to-model import.
 *
 * Plain module signals with `useSyncExternalStore`-compatible subscribe/snapshot
 * pairs; no React and no store library, so the base layer stays dependency-free.
 *
 * @module shared/lib/auth-signal
 */

type Listener = () => void;

// ── auth-required signal ─────────────────────────────────────────────────────

let authRequired = false;
const authRequiredListeners = new Set<Listener>();

/** Whether a gated request has reported that login is required. */
export function getAuthRequired(): boolean {
  return authRequired;
}

/** Flip the app-wide auth-required state (set true on a 401 AUTH_REQUIRED, false after sign-in). */
export function setAuthRequired(value: boolean): void {
  if (authRequired === value) return;
  authRequired = value;
  authRequiredListeners.forEach((l) => l());
}

/** Subscribe to auth-required changes; returns an unsubscribe function. */
export function subscribeAuthRequired(listener: Listener): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

// ── owner-setup request signal (exposure flow) ───────────────────────────────

/** A pending request to walk the user through owner-account creation before an action. */
export interface OwnerSetupRequest {
  /** Why owner setup is being requested — currently only the tunnel/exposure gate. */
  reason: 'exposure';
  /** Screen copy explaining the requirement (e.g. "Exposing DorkOS requires a login."). */
  message: string;
  /** Invoked after the owner exists and `auth.enabled` is set, to retry the original action. */
  onComplete: () => void;
}

let ownerSetupRequest: OwnerSetupRequest | null = null;
const ownerSetupListeners = new Set<Listener>();

/** The pending owner-setup request, or `null` when none is active. */
export function getOwnerSetupRequest(): OwnerSetupRequest | null {
  return ownerSetupRequest;
}

/** Open the owner-setup flow for a blocked action (e.g. tunnel exposure). */
export function requestOwnerSetup(request: OwnerSetupRequest): void {
  ownerSetupRequest = request;
  ownerSetupListeners.forEach((l) => l());
}

/** Dismiss the pending owner-setup request (on completion or cancel). */
export function clearOwnerSetupRequest(): void {
  if (ownerSetupRequest === null) return;
  ownerSetupRequest = null;
  ownerSetupListeners.forEach((l) => l());
}

/** Subscribe to owner-setup request changes; returns an unsubscribe function. */
export function subscribeOwnerSetupRequest(listener: Listener): () => void {
  ownerSetupListeners.add(listener);
  return () => ownerSetupListeners.delete(listener);
}
