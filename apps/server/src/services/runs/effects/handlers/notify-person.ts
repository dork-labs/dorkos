/**
 * `notify_person` (spec `turns-survive-restarts` §6.2, DOR-5160): telling the
 * person a turn finished, as a follow-up of the run's `ended`, so the
 * "finished" row survives the process dying between the turn's end and the
 * row being written.
 *
 * **When it is written.** In the transaction that moves the run to `ended`
 * ({@link planTurnFinishedNotice}), for a turn that ended `completed`, the
 * ending today's "finished" row is raised for (`turn.completed`, a turn that
 * settled to idle). The turns that raise nothing today raise nothing here: a
 * turn another chat's message started, and a heartbeat's beat. Both are read
 * where today's emitter reads them, from the live registries, which the run's
 * origin backs up for a run a later boot ends. While the run record is wired,
 * this is the only writer of a run's "finished" row: the projector's emitter
 * leaves a turn with a run to it (`runTellsTurnFinished`).
 *
 * **Exactly once.** The row's dedupe key is `notify:<runId>:completed`, unique
 * in `notifications` (§6.4), and the row and the effect's `done` commit in one
 * transaction, through the notification store's `onStored` witness. A crash
 * between the two cannot happen; a crash before both leaves the effect to be
 * run again, and a crash after both leaves nothing to run.
 *
 * Only the inbox row is the outbox's business. Outside delivery (push, chat
 * apps) stays in the escalation service's own ledger, at most once (§6.2);
 * `turn.completed` never leaves the app.
 *
 * @module services/runs/effects/handlers/notify-person
 */
import { z } from 'zod';
import { isBeatTurn } from '../../../heartbeats/beat-turns.js';
import { isChatStartedTurn } from '../../../session/chat-messages/chat-started-turns.js';
import { notify } from '../../../notifications/notification-service.js';
import { sessionLabelFor } from '../../../notifications/notification-copy.js';
import type { TurnRun } from '../../run-store.js';
import type { NewEffect } from '../effect-store.js';
import type { EffectHandler } from '../worker.js';

/** How long a "finished" notice may still be told (§6.2). */
export const NOTIFY_PERSON_NOT_AFTER_MS = 24 * 60 * 60 * 1000;

/** The notice's payload: references only (§6.1). */
const TurnFinishedPayloadSchema = z.strictObject({
  notice: z.literal('turn_finished'),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  endedAt: z.string().min(1),
  agentId: z.string().min(1).optional(),
});

/** Turn origins whose finishing is not news to the person (spec `spin-off-chats` §6, `heartbeats` §7.4). */
const QUIET_ORIGINS = new Set(['chat-message', 'heartbeat']);

/**
 * The "finished" notice an `ended` run owes its person, or `undefined` when it
 * owes none. Called inside the transaction that ends the run.
 *
 * @param run - The run, as stored after its move to `ended`.
 * @param now - The clock, epoch ms.
 */
export function planTurnFinishedNotice(run: TurnRun, now: number): NewEffect | undefined {
  if (run.ending !== 'completed' || run.endedAt === null) return undefined;
  if (run.origin && QUIET_ORIGINS.has(run.origin.kind)) return undefined;
  if (isChatStartedTurn(run.sessionId) || isBeatTurn(run.sessionId)) return undefined;
  return {
    kind: 'notify_person',
    key: `notify:${run.id}:${run.ending}`,
    runId: run.id,
    sessionId: run.sessionId,
    payload: {
      notice: 'turn_finished',
      runId: run.id,
      sessionId: run.sessionId,
      endedAt: run.endedAt,
      ...(run.agentId !== null ? { agentId: run.agentId } : {}),
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
      const place = deps.placeOf?.(notice.sessionId) ?? {};
      const cwd = place.cwd;
      const agentId = notice.agentId ?? place.agentId;
      let stored: string | undefined;
      const result = await notify(
        'turn.completed',
        {
          sessionId: notice.sessionId,
          sessionLabel: sessionLabelFor(cwd),
          completedAt: notice.endedAt,
          runId: notice.runId,
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
