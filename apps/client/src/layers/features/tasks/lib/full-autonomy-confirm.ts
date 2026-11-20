/**
 * When saving a schedule takes one confirm first (DOR-3841).
 *
 * A new schedule opens at the operator's own stop, which on the Trusted default
 * is Full autonomy (ADR 261006-225605). That default stays. What changes is that
 * a person saving a schedule at a level that acts without asking says so with
 * one more click, in the app. The confirm lives only in the form: no request
 * field carries it, so nothing an agent sends can skip or fake it, and an
 * agent's own schedules keep the server's caps unchanged.
 *
 * @module features/tasks/lib/full-autonomy-confirm
 */
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import {
  actsWithoutAsking,
  isBypassPermissionMode,
  permissionModeLabel,
} from '@/layers/shared/lib';
import { CANONICAL_TRUST_STOPS } from '@/layers/shared/ui';

/** The part of a schedule's form values the rule reads. */
interface AutonomyValues {
  permissionMode: string;
  /** The runtime override; empty follows the agent. */
  runtime: string;
}

/** What {@link autonomyToConfirm} is asked about. */
export interface AutonomyToConfirmInput {
  /** The values being saved. */
  value: AutonomyValues;
  /** The values an edit opened with; absent for a new schedule. */
  opening?: AutonomyValues;
  /** The modes the runtime this schedule will run on declared; empty while unknown. */
  descriptors: readonly PermissionModeDescriptor[];
}

/**
 * The mode a save must confirm first, or `null` when it saves straight away.
 *
 * - **Which levels:** any mode that acts without asking (`actsWithoutAsking`),
 *   the same rule that opens the chat-binding confirm. That is the Full
 *   autonomy stop, and also a middle stop that never asks, such as Codex's
 *   workspace write. Every level that asks saves with no confirm.
 * - **Which saves:** a new schedule (a copy of a package's schedule included),
 *   and an edit that changes the mode or where it runs. An edit that leaves both
 *   as they were does not ask again: re-saving a Full schedule to fix a typo
 *   is not a new choice.
 * - **No runtime profile yet:** the mode's id is the only evidence, so a known
 *   Full autonomy id still asks, in the dial's own words for that stop.
 *
 * @param input - The values being saved, the values an edit opened with, and
 *   the runtime's declared modes.
 */
export function autonomyToConfirm({
  value,
  opening,
  descriptors,
}: AutonomyToConfirmInput): PermissionModeDescriptor | null {
  if (
    opening !== undefined &&
    opening.permissionMode === value.permissionMode &&
    opening.runtime === value.runtime
  ) {
    return null;
  }
  const declared = descriptors.find((d) => d.id === value.permissionMode);
  if (declared) return actsWithoutAsking(declared) ? declared : null;
  if (!isBypassPermissionMode(value.permissionMode)) return null;
  const autonomy = CANONICAL_TRUST_STOPS.find((d) => d.stop === 'autonomy');
  return autonomy
    ? {
        ...autonomy,
        id: value.permissionMode,
        label: permissionModeLabel(value.permissionMode),
      }
    : null;
}
