/**
 * The two effect handlers recovery adds to the worker (spec
 * `turns-survive-restarts` §6.2, §7.3): `continue_after_restart` and
 * `lost_work_wake`, built from the record's parts in one place.
 *
 * @module services/runs/recovery/restart-handlers
 */
import type { EffectHandlers } from '../effects/worker.js';
import {
  continueAfterRestartHandler,
  type ContinueAfterRestartDeps,
} from './continue-after-restart.js';
import { lostWorkWakeHandler, type LostWorkWakeDeps } from './lost-work.js';

/** What {@link restartHandlers} needs. */
export type RestartHandlerDeps = ContinueAfterRestartDeps & Omit<LostWorkWakeDeps, 'runs'>;

/**
 * The worker's handlers for a continuation after a restart and the wake for
 * lost background work, keyed by their effect kinds.
 *
 * @param deps - The run store and outbox, the chat's ceiling and folder, the
 *   lost-work wake and the release of its record.
 */
export function restartHandlers(deps: RestartHandlerDeps): EffectHandlers {
  const { runs, effects, ceilingOf, cwdOf, wakeLostWork, release } = deps;
  return {
    continue_after_restart: continueAfterRestartHandler({
      runs,
      effects,
      ...(ceilingOf ? { ceilingOf } : {}),
      ...(cwdOf ? { cwdOf } : {}),
    }),
    lost_work_wake: lostWorkWakeHandler({ runs, wakeLostWork, release }),
  };
}
