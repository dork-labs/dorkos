/**
 * `continue_after_restart` (spec `turns-survive-restarts` §6.2, §7.3 step 8):
 * the effect recovery saves for a turn a restart cut in the middle, when its
 * runtime declares `continuesInterruptedTurn`. Its handler makes the
 * continuation: a new run in the same chat (`attempt` + 1, `attempt_reason:
 * 'restart'`, the same chain, `opened_by: 'recovery'`, the dead run's origin)
 * with its `start_turn`, in one transaction. Safe to repeat by key: the run's
 * `start_key` is `continue:<deadRunId>` and `continues_run_id` is unique.
 *
 * **The words** are fixed DorkOS copy, never the dead turn's content (§7.4),
 * read through the `restart` word source: they name the background work that
 * died with the turn, kept on the dead run (`lost_background_json`). They
 * stay at their source, never in a composer, so no person sees them as a
 * queued message.
 *
 * The continuation goes before every waiting run of its chat: the launch gate
 * holds every other launch until it has started (§7.5).
 *
 * @module services/runs/recovery/continue-after-restart
 */
import { z } from 'zod';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { RUNS } from '../../../config/constants.js';
import type { EffectStore, NewEffect } from '../effects/effect-store.js';
import type { EffectHandler } from '../effects/worker.js';
import type { StartPayload } from '../effects/start-payload.js';
import type { RunStore, TurnRun, LostBackgroundWork } from '../run-store.js';
import type { WordSource } from '../turn-port.js';

/** The source kind a continuation's words are read under: `restart:<deadRunId>`. */
export const RESTART_SOURCE = 'restart';

/**
 * What the continuing agent is told (§7.4). Agent-facing, and shown in the
 * chat as the message that started the turn.
 *
 * @param lost - The background work that died with the turn.
 */
export function continuationWords(lost: readonly LostBackgroundWork[]): string {
  const list = lost.length === 0 ? 'none' : lost.map((work) => work.label).join(', ');
  return (
    'DorkOS restarted while you were working, so that turn was stopped. Check what you ' +
    `were doing and carry on. Background work that stopped: ${list}.`
  );
}

/**
 * The `restart` word source: a continuation's words, built from the run it
 * continues, so a restart before its turn starts loses nothing.
 *
 * @param runs - The run store.
 */
export function restartWordSource(runs: RunStore): WordSource {
  return {
    read: (deadRunId) => {
      const dead = runs.get(deadRunId);
      return dead ? continuationWords(dead.lostBackground) : undefined;
    },
  };
}

/** The effect's payload: which run it continues. */
const ContinuePayloadSchema = z.strictObject({ deadRunId: z.string().min(1) });

/**
 * The effect that continues a dead run, saved in the transaction that decides it.
 *
 * @param dead - The run a restart cut.
 * @param now - The clock, epoch ms.
 */
export function continueAfterRestartEffect(dead: TurnRun, now: number): NewEffect {
  return {
    kind: 'continue_after_restart',
    key: `continue:${dead.id}`,
    runId: dead.id,
    sessionId: dead.sessionId,
    payload: { deadRunId: dead.id } satisfies z.infer<typeof ContinuePayloadSchema>,
    delivery: 'repeatable',
    notAfter: now + RUNS.RESTART_FOLLOW_UP_MS,
  };
}

/** What the handler needs. */
export interface ContinueAfterRestartDeps {
  runs: RunStore;
  effects: EffectStore;
  /**
   * The bound a turn that picks a chat up on its own carries: the runtime's
   * default when the chat's latest turn was held (DOR-3037), else none.
   */
  ceilingOf?: (sessionId: string) => TurnPermissionCeiling | undefined;
  /** The folder a chat runs in, as this computer knows it: where the continuation runs. */
  cwdOf?: (sessionId: string) => string | undefined;
}

/**
 * The handler: make the continuation and its `start_turn`, and mark the
 * effect done, in one transaction.
 *
 * @param deps - The stores, and the bound a continuation carries.
 */
export function continueAfterRestartHandler(deps: ContinueAfterRestartDeps): EffectHandler {
  const { runs, effects } = deps;
  return {
    handle(effect, ctx) {
      const parsed = ContinuePayloadSchema.safeParse(effect.payload);
      const dead = parsed.success ? runs.get(parsed.data.deadRunId) : undefined;
      if (!dead) return { kind: 'drop', reason: 'run_gone' };
      const startKey = `continue:${dead.id}`;
      const ceiling = deps.ceilingOf?.(dead.sessionId);
      const cwd = deps.cwdOf?.(dead.sessionId);
      runs.transaction(() => {
        const made = runs.findByStartKey(startKey);
        if (made) {
          ctx.markDone({ continuationRunId: made.id, alreadyMade: true });
          return;
        }
        const run = runs.create({
          chatKey: dead.sessionId,
          status: 'queued',
          openedBy: 'recovery',
          origin: dead.origin,
          startKey,
          continues: dead,
          sourceRef: `${RESTART_SOURCE}:${dead.id}`,
          notAfter: ctx.now() + RUNS.RESTART_FOLLOW_UP_MS,
          ...(dead.agentId !== null ? { agentId: dead.agentId } : {}),
        });
        const payload: StartPayload = {
          tier: 'owner',
          ...(cwd !== undefined ? { cwd } : {}),
          ...(ceiling !== undefined ? { permissionCeiling: ceiling } : {}),
          ...(dead.runtime !== null ? { runtime: dead.runtime } : {}),
        };
        effects.insert({
          kind: 'start_turn',
          key: `start:${run.id}:${run.attempt}`,
          runId: run.id,
          // No chat to order behind: a continuation goes before every waiting
          // start of its chat (§5, item 5), which the gate holds for it.
          payload,
          delivery: 'repeatable',
          notAfter: run.notAfter,
        });
        ctx.markDone({ continuationRunId: run.id });
      });
      return { kind: 'done' };
    },
  };
}
