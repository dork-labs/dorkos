/**
 * Provenance markers a Community launch attaches to what it creates, and the gate on trusting them.
 *
 * Before each create, the launcher records a random marker in the journal and sends it with the
 * create: as the Fly app's private network name and as the Neon role name. Reading the marker back
 * later proves the run made that resource. The markers are not secret; they prove where a resource
 * came from and are never credentials.
 *
 * @module commands/community-deploy/provenance/provenance-gate
 */
import { randomBytes } from 'node:crypto';

/**
 * Services whose marker round trip a live-gate receipt has shown. Flip only in a PR that cites the
 * receipt.
 *
 * While a flag is `false`, nothing may treat that service's marker readback as proof that a run
 * created a resource. There is deliberately no environment variable or CLI flag that overrides it:
 * callers take it as an injected dependency with this value as the default, so only unit tests can
 * substitute another value and a packaged CLI always uses the committed one.
 */
export const PROVENANCE_ROUND_TRIP_PROVED = { fly: false, neon: false } as const;

/** Margin either side of the create window, for clock skew between this machine and a service. */
const CREATE_WINDOW_MARGIN_MS = 2 * 60 * 1000;

/** Create a fresh 128-bit marker as 32 lowercase hex characters. */
export function createProvenanceMarker(): string {
  return randomBytes(16).toString('hex');
}

/** The Fly private network name that carries a run's marker. */
export function flyProvenanceNetwork(marker: string): string {
  return `dorkos-${marker}`;
}

/** The Neon role name that carries a run's marker. */
export function neonProvenanceRole(marker: string): string {
  return `community_${marker}`;
}

/**
 * Whether a resource's service-reported creation time falls inside the run's create window.
 *
 * The window runs from two minutes before the recorded request time to two minutes after the create
 * deadline. A missing or unreadable time on either side is never inside it, so a resource whose
 * creation time cannot be read can never be proved.
 *
 * @param createdAt - Creation time the service reported, when it reported one.
 * @param requestedAt - Time the journal recorded with the creation intent.
 * @param createDeadlineMs - Deadline the create request ran under.
 */
export function isCreatedWithinWindow(
  createdAt: string | undefined,
  requestedAt: string | undefined,
  createDeadlineMs: number
): boolean {
  if (createdAt === undefined || requestedAt === undefined) return false;
  const created = Date.parse(createdAt);
  const requested = Date.parse(requestedAt);
  if (!Number.isFinite(created) || !Number.isFinite(requested)) return false;
  if (!Number.isFinite(createDeadlineMs) || createDeadlineMs < 0) return false;
  return (
    created >= requested - CREATE_WINDOW_MARGIN_MS &&
    created <= requested + createDeadlineMs + CREATE_WINDOW_MARGIN_MS
  );
}
