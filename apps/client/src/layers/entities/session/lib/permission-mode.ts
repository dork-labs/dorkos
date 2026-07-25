import type { PermissionMode } from '@dorkos/shared/types';

/**
 * Permission modes that hand the agent the keys — it runs every tool without
 * asking. `always-allow` is the test-mode runtime's spelling of the same thing;
 * modes arrive as loose strings from runtime capability profiles, so this takes
 * a string rather than the {@link PermissionMode} union.
 */
const BYPASS_PERMISSION_MODES = new Set<string>(['bypassPermissions', 'always-allow']);

/**
 * Whether a permission mode means the agent acts without asking. The ONE
 * definition of that fact — the standing banner, the status line's severity
 * ranking, and anything else that warns about it must agree, or a session can
 * warn on one surface and look ordinary on another (DOR-482, DOR-463).
 *
 * @param mode - The session's effective permission mode, if known.
 */
export function isBypassPermissionMode(mode: string | null | undefined): boolean {
  return mode != null && BYPASS_PERMISSION_MODES.has(mode);
}

/**
 * A session's effective permission mode: a change the person just made and the
 * server has not confirmed yet wins over the last row the server sent, and an
 * unknown session is treated as asking for everything.
 *
 * Pure so both the full status hook and the lightweight read-only hook resolve
 * it identically instead of each re-deriving the precedence.
 *
 * @param pending - Optimistic mode from an in-flight settings change.
 * @param confirmed - Mode from the session row the server last returned.
 */
export function resolvePermissionMode(
  pending: PermissionMode | undefined,
  confirmed: PermissionMode | undefined
): PermissionMode {
  return pending ?? confirmed ?? 'default';
}
