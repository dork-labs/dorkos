/**
 * What a turn carrying a teammate's mark gets (DOR-3036, `specs/turn-marks`), wherever it came
 * from: the room a teammate wrote in, or any hop after it (a mention, a chat message, a spin-off).
 *
 * A teammate is a space member who is not this install's owner (`rooms/limits/space-teammates.ts`).
 * The turn their message starts is held to the teammate tier and counted against the space's
 * monthly limit. Before the mark, that held only for the turn that answered them, so one agent
 * hop (Ana mentions Bo) handed Bo's turn the owner's power, unmetered. The mark rides the level a
 * turn passes on, and `applyTurnMarks` applies what is here to every marked turn, on every runtime.
 *
 * What a marked turn gets:
 *
 * - **The teammate tier.** Nobody is asked, no folders, no notes or owner profile, and its DorkOS
 *   tools reach only the room it answers, or no room at all when it answers none: a marked chat
 *   can reply in its own chat and nowhere else (`teammate-tier.ts`, `MessageOpts.teammate`).
 * - **A read-only bound** on top of whatever it carried.
 * - **Every space's limit.** It is refused before it starts when any space in its chain is at its
 *   monthly limit, and counted against every one of them when it ends (`teammate-turn-cost.ts`).
 *   Counting a turn two spaces reached against both errs toward the limit.
 * - **Only where the tier holds.** A runtime that cannot hold every bound per turn refuses it.
 *
 * @module services/core/turn-power/teammate-mark
 */
import type {
  MessageOpts,
  TeammateOrigin,
  TurnPermissionBound,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';

/**
 * The runtimes a teammate-marked turn may run on: those that honour every bound per turn (nobody
 * asked, the ceiling, the tier's tool fence). Codex and OpenCode take the ceiling but not
 * per-turn `unattended`, so a marked turn there could still raise a card; it is refused until
 * they do (DOR-2978). `test-mode` runs no tools at all, and exists only in test builds.
 */
export const TEAMMATE_TURN_RUNTIMES: ReadonlySet<string> = new Set(['claude-code', 'test-mode']);

/**
 * Whether a teammate-marked turn may run on this runtime at all ({@link TEAMMATE_TURN_RUNTIMES}).
 *
 * @param runtimeType - The runtime the turn would run on.
 */
export function runsTeammateTurns(runtimeType: string): boolean {
  return TEAMMATE_TURN_RUNTIMES.has(runtimeType);
}

/** The refusal a marked turn on a runtime that cannot hold the tier gets. */
export function teammateRuntimeRefusal(runtimeType: string): string {
  return `A teammate's message cannot start a turn on ${runtimeType} yet`;
}

/** The refusal a marked turn gets once a space in its chain is at its monthly limit. */
export const TEAMMATE_LIMIT_REFUSAL =
  'A space this work began in has reached its monthly limit for teammates, so this turn did not run.';

/** Whether a space room's monthly teammate limit still allows a turn; set at startup. */
let spaceAllows: ((roomId: string) => boolean) | null = null;

/**
 * Set how a space room's monthly limit is read, or `null` to read none (every space allowed).
 * Rooms and turns know nothing of spaces, so the space layer sets this from outside.
 *
 * @param next - Whether the space a local room copies is under its limit.
 */
export function setTeammateSpaceGate(next: ((roomId: string) => boolean) | null): void {
  spaceAllows = next;
}

/**
 * Why a teammate-marked turn may not run, or `null` when it may.
 *
 * @param runtimeType - The runtime it would run on.
 * @param origins - Where each teammate in its chain wrote.
 */
export function teammateTurnRefusal(
  runtimeType: string,
  origins: readonly TeammateOrigin[]
): string | null {
  if (!runsTeammateTurns(runtimeType)) return teammateRuntimeRefusal(runtimeType);
  const gate = spaceAllows;
  if (gate && origins.some((origin) => !gate(origin.roomId))) return TEAMMATE_LIMIT_REFUSAL;
  return null;
}

/**
 * The options a teammate-marked turn is sent with: the tier's bounds on top of the caller's.
 *
 * @param opts - The options the caller sent.
 */
export function teammateTurnOpts(opts: MessageOpts | undefined): MessageOpts {
  const { additionalDirectories: _granted, ...rest } = opts ?? {};
  return {
    ...rest,
    teammate: true,
    unattended: true,
    permissionCeiling: withReadOnly(opts?.permissionCeiling),
    ...(opts?.roomTurn
      ? { roomTurn: { ...opts.roomTurn, teammate: true, untrustedText: true } }
      : {}),
  };
}

/** A ceiling held to read access as well, keeping every bound (and mark) it had. */
function withReadOnly(ceiling: TurnPermissionCeiling | undefined): TurnPermissionCeiling {
  if (ceiling === undefined) return READ_ONLY_LEVEL;
  // An empty list vouches for no one; it stays the runtime default as well as read access.
  if (Array.isArray(ceiling) && ceiling.length === 0) return ['runtime-default', READ_ONLY_LEVEL];
  const bounds: readonly TurnPermissionBound[] = Array.isArray(ceiling)
    ? (ceiling as readonly TurnPermissionBound[])
    : [ceiling as TurnPermissionBound];
  return [...bounds, READ_ONLY_LEVEL];
}
