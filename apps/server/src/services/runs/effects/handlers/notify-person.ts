/**
 * `notify_person` (spec `turns-survive-restarts` §6.2, DOR-5160): the effect
 * that tells the person a turn finished, so the "finished" row survives the
 * process dying between the turn's end and the row being written.
 *
 * **Which turns.** Exactly the turns today's emitter tells: the projector's
 * emitter (`notifications/emitters/session-lifecycle.ts`) still decides, at
 * the turn's own `streaming → idle` transition and with all of its own skips;
 * for a turn with a run it hands the turn to the record (`TurnNotices.claim`)
 * instead of writing the row itself.
 *
 * **When it is written** (§4.7). In the transaction that records the run's
 * ending at `turn_end`, when the agent acted, since no pause can put the turn
 * back after that: the row can be in the inbox while background work still
 * drains. When the agent had not acted, at settle, after the hold decision,
 * so a turn a pause put back is never told "finished". A run a later boot
 * retires is never told: nobody saw it finish, and it was not a completion
 * the person waited for.
 *
 * **Exactly once.** The effect's key and the row's dedupe key are both
 * `notify:<runId>:<ending>`, unique (§6.4), and the row and the effect's
 * `done` commit in one transaction, through the notification store's
 * `onStored` witness. A crash before both leaves the effect to run again; a
 * crash after both leaves nothing to run.
 *
 * Only the inbox row is the outbox's business. Outside delivery (push, chat
 * apps) stays in the escalation service's own ledger (§6.2); `turn.completed`
 * never leaves the app.
 *
 * @module services/runs/effects/handlers/notify-person
 */
import { z } from 'zod';
import { notify } from '../../../notifications/notification-service.js';
import { sessionLabelFor } from '../../../notifications/notification-copy.js';
import type { TurnRun } from '../../run-store.js';
import type { NewEffect } from '../effect-store.js';
import type { EffectHandler } from '../worker.js';

/** How long a "finished" notice may still be told (§6.2). */
export const NOTIFY_PERSON_NOT_AFTER_MS = 24 * 60 * 60 * 1000;

/** The notice's payload: references and times only (§6.1). */
const TurnFinishedPayloadSchema = z.strictObject({
  notice: z.literal('turn_finished'),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  /** The run's ending when the notice was written. */
  ending: z.string().min(1),
  /** When the turn finished: its `turn_end`, or its settle. */
  at: z.string().min(1),
  /** What to call the chat, as the emitter's folder named it: DorkOS copy, not a path. */
  sessionLabel: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
});

/**
 * The "finished" notice for a run's turn.
 *
 * @param run - The run.
 * @param ending - Its ending as recorded now.
 * @param now - The clock, epoch ms: when the turn finished.
 * @param place - The chat's folder and agent as the emitter knew them.
 */
export function turnFinishedNotice(
  run: TurnRun,
  ending: string,
  now: number,
  place: ChatPlace = {}
): NewEffect {
  const agentId = place.agentId ?? run.agentId ?? undefined;
  return {
    kind: 'notify_person',
    key: `notify:${run.id}:${ending}`,
    runId: run.id,
    sessionId: run.sessionId,
    payload: {
      notice: 'turn_finished',
      runId: run.id,
      sessionId: run.sessionId,
      ending,
      at: new Date(now).toISOString(),
      ...(place.cwd ? { sessionLabel: sessionLabelFor(place.cwd) } : {}),
      ...(agentId ? { agentId } : {}),
    } satisfies z.infer<typeof TurnFinishedPayloadSchema>,
    delivery: 'repeatable',
    notAfter: now + NOTIFY_PERSON_NOT_AFTER_MS,
  };
}

/** Where a chat runs, as far as this boot can tell, for the row's label and agent. */
export interface ChatPlace {
  /** The folder its runtime runs it in. */
  cwd?: string;
  /** The agent whose home that folder is. */
  agentId?: string;
}

/** What the handler needs from the rest of the server. */
export interface NotifyPersonDeps {
  /**
   * Where a chat runs. Handed in at startup rather than imported: the lookups
   * behind it reach the dispatcher, which reaches this domain (§3.4). Absent,
   * the row says "A chat finished".
   */
  placeOf?: (sessionId: string) => ChatPlace;
}

/**
 * The handler: write the person's "finished" row and mark the effect done in
 * the same transaction.
 *
 * @param deps - Where a chat runs.
 */
export function notifyPersonHandler(deps: NotifyPersonDeps = {}): EffectHandler {
  return {
    async handle(effect, ctx) {
      const parsed = TurnFinishedPayloadSchema.safeParse(effect.payload);
      if (!parsed.success) return { kind: 'drop', reason: 'unreadable_payload' };
      const notice = parsed.data;
      // What the emitter named, else what this boot can still find.
      const place =
        notice.sessionLabel !== undefined && notice.agentId !== undefined
          ? {}
          : (deps.placeOf?.(notice.sessionId) ?? {});
      const agentId = notice.agentId ?? place.agentId;
      let stored: string | undefined;
      const result = await notify(
        'turn.completed',
        {
          sessionId: notice.sessionId,
          sessionLabel: notice.sessionLabel ?? sessionLabelFor(place.cwd),
          completedAt: notice.at,
          runId: notice.runId,
          runEnding: notice.ending,
          ...(agentId ? { agentId } : {}),
        },
        {
          onStored: (_tx, notificationId) => {
            ctx.markDone({ notificationId });
            stored = notificationId;
          },
        }
      );
      if (stored !== undefined) return { kind: 'done' };
      // A row under this key without this effect done: impossible while both
      // share `dork.db`, and the "safe to repeat by key" case once they do not (§6.4).
      if (result.deduped) return { kind: 'done', outcome: { alreadyTold: true } };
      throw new Error('The notification was not stored');
    },
  };
}
