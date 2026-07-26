import type { PermissionMode } from '@dorkos/shared/types';

/**
 * A session's effective permission mode: a change the person just made and the
 * server has not confirmed yet wins over the last row the server sent, and an
 * unknown session is treated as asking for everything.
 *
 * Pure so both the full status hook and the lightweight read-only hook resolve
 * it identically instead of each re-deriving the precedence.
 *
 * `isBypassPermissionMode` used to live here and now lives in
 * `shared/lib/permission-mode`. A channel binding is an entity and may not import
 * a sibling entity, so a definition parked here was out of reach of one of the
 * three surfaces that have to agree about what a bypass mode covers.
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
