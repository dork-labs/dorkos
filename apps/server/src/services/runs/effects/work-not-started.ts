/**
 * The owner's notice for a mini app's start that was answered and then never
 * ran (spec `turns-survive-restarts` §3.1, §7.3 steps 4 and 5; DOR-5232): the
 * launch refused it after `start()` had answered (the account rule, a paused
 * agent, its folder), it kept failing to start, or DorkOS restarted after its
 * turn began and before its agent read the words. A start the app made is never
 * dropped silently, so the person who owns the app hears it once, with the
 * app's name and why.
 *
 * Written as a `notify_person` effect in the transaction that cancels the run
 * (§6.1, "Writing"), keyed `notify:<runId>:not_started` like every notice the
 * outbox writes, so it is told once.
 *
 * @module services/runs/effects/work-not-started
 */
import { z } from 'zod';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';
import type { TurnRun } from '../run-store.js';
import type { NewEffect } from './effect-store.js';
import { NOTIFY_PERSON_NOT_AFTER_MS } from './handlers/notify-person.js';

/** The notice kind's payload. */
export interface WorkNotStartedPayloads {
  /** A chat a mini app started never ran. */
  'extension.work_not_started': {
    /** The run that never started. */
    runId: string;
    /** The chat it was for. */
    sessionId: string;
    /** The app, by id. */
    extensionId: string;
    /** Its manifest name, e.g. "Flow". */
    name: string;
    /** Why, as the run's `ending_detail` keeps it. */
    reason: string;
  };
}

/** The `notify_person` payload that carries it: references and DorkOS copy only (§6.1). */
export const WorkNotStartedPayloadSchema = z.strictObject({
  notice: z.literal('work_not_started'),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  extensionId: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
});

/** The app as a sentence names it: "The Flow app" (as `extension.stopped` does). */
function theApp(name: string): string {
  return /\bapp$/i.test(name) ? `The ${name}` : `The ${name} app`;
}

/** Why, in at most 15 plain words. */
function why(reason: string): string {
  switch (reason) {
    case 'account_not_allowed':
      return 'No account may work in that project.';
    case 'agent_paused':
      return 'Its agent is paused.';
    case 'desk_not_own':
    case 'room_session_moved':
    case 'invalid_agent_path':
      return 'It can’t run in that folder.';
    case 'unknown_runtime':
      return 'Its runtime isn’t available on this computer.';
    case 'runtime_mismatch':
      return 'Its agent runs on a different runtime here.';
    case 'expired':
      return 'It waited too long to start.';
    case 'start_failed':
      return 'It kept failing to start.';
    case 'start_lost':
      return 'Its first message was lost before it could start.';
    case 'restarted':
      return 'DorkOS restarted before its agent read the first message.';
    case 'removed':
      return 'Its message was taken off the chat’s queue.';
    case 'session_gone':
      return 'Its chat was gone before it could start.';
    case 'refused_busy':
    case 'wait_spent':
      return 'Its chat stayed busy too long.';
    default:
      // A refusal this list does not name: true, if less exact.
      return 'This computer couldn’t start it.';
  }
}

/** The entry, spread into the registry's `ENTRIES`. */
export const WORK_NOT_STARTED_ENTRIES: {
  'extension.work_not_started': NotificationRegistryEntry<'extension.work_not_started'>;
} = {
  'extension.work_not_started': {
    kind: 'extension.work_not_started',
    tier: 'notable',
    storage: 'event',
    subjectType: 'session',
    locate: (p) => ({ subjectId: p.sessionId, sessionId: p.sessionId }),
    title: (p) => `${theApp(p.name)} couldn’t start its chat`,
    body: (p) => why(p.reason),
    dedupeKey: (p) => `notify:${p.runId}:not_started`,
    relay: 'never',
  },
};

/**
 * The notice for a mini app's start that will never run.
 *
 * @param run - The run, cancelled.
 * @param app - The app that started it.
 * @param now - The clock, epoch ms.
 * @param reason - Why; what `ending_detail` keeps unless said.
 */
export function workNotStartedNotice(
  run: TurnRun,
  app: { extensionId: string; name: string },
  now: number,
  reason: string = run.endingDetail.cancelledBecause ?? 'start_failed'
): NewEffect {
  return {
    kind: 'notify_person',
    key: `notify:${run.id}:not_started`,
    runId: run.id,
    sessionId: run.sessionId,
    payload: {
      notice: 'work_not_started',
      runId: run.id,
      sessionId: run.sessionId,
      extensionId: app.extensionId,
      name: app.name,
      reason,
    } satisfies z.infer<typeof WorkNotStartedPayloadSchema>,
    delivery: 'repeatable',
    notAfter: now + NOTIFY_PERSON_NOT_AFTER_MS,
  };
}
