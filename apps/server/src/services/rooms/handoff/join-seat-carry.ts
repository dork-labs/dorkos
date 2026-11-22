/**
 * Joining the carries one seat turn answers to. Kept free of runtime imports: the hand-off
 * envelope decodes with it, and the chat-message store loads that decoder, so anything heavier
 * here would loop back into the turn-power modules the store's own readers mock (DOR-3816).
 *
 * @module services/rooms/handoff/join-seat-carry
 */
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import type { AsideCarry } from '../room-trigger/aside.js';

/**
 * Union all actual bounds and flags; outside words themselves create no permission cap.
 *
 * @param values - The carries to join.
 */
export function joinSeatCarry(...values: readonly AsideCarry[]): AsideCarry {
  const bounds = values.flatMap((v): TurnPermissionBound[] =>
    v.permissionCeiling === undefined
      ? []
      : Array.isArray(v.permissionCeiling)
        ? [...(v.permissionCeiling as readonly TurnPermissionBound[])]
        : [v.permissionCeiling as TurnPermissionBound]
  );
  return {
    externalAuthor: values.some((v) => v.externalAuthor),
    ...(bounds.length ? { permissionCeiling: bounds } : {}),
    ...(values.some((v) => v.outsider) ? { outsider: true as const } : {}),
    ...(values.some((v) => v.outsideWords) ? { outsideWords: true as const } : {}),
    ...(values.some((v) => v.teammate) ? { teammate: true as const } : {}),
  };
}
