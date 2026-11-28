/**
 * The person's notice about a turn a restart touched (spec
 * `turns-survive-restarts` §7.3 steps 4 and 5, §7.4; DOR-5161): what recovery
 * decided for a reply DorkOS restarted during, or a start that was lost before
 * it could begin. The chat shows the same case as its line (`run_update`);
 * this is the inbox row, so a person who was away still hears it once.
 *
 * Written as a `notify_person` effect in the transaction that decides the run
 * (§6.1, "Writing"), keyed `notify:<runId>:<case>` like every notice the
 * outbox writes, so it is told once. Past the age bound (§7.3, "The age
 * bound") nothing is written: nobody is waiting on news that old.
 *
 * @module services/runs/effects/restart-notices
 */
import { z } from 'zod';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';
import type { TurnRun } from '../run-store.js';
import type { NewEffect } from './effect-store.js';
import { NOTIFY_PERSON_NOT_AFTER_MS } from './handlers/notify-person.js';

/** The cases a person is told about. */
export const RESTART_NOTICE_CASES = [
  'continued',
  'not_resumable',
  'waited_on_you',
  'chain_cap',
  'start_lost',
] as const;

/** One case. See {@link RESTART_NOTICE_CASES}. */
export type RestartNoticeCase = (typeof RESTART_NOTICE_CASES)[number];

/** The notice kind's payload. */
export interface RestartNoticePayloads {
  /** DorkOS restarted during a chat's reply, or before a turn could start. */
  'turn.restarted': {
    /** The run the restart touched. */
    runId: string;
    /** Its chat. */
    sessionId: string;
    /** Which case is true. */
    case: RestartNoticeCase;
    /** The chat's agent, when it has one. */
    agentId?: string;
  };
}

/** The `notify_person` payload that carries it: references only (§6.1). */
export const RestartNoticePayloadSchema = z.strictObject({
  notice: z.literal('restart'),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  case: z.enum(RESTART_NOTICE_CASES),
  agentId: z.string().min(1).optional(),
});

/** The one line, at most 15 plain words. */
const TITLES: Record<RestartNoticeCase, string> = {
  continued: 'DorkOS restarted during a reply',
  not_resumable: 'A reply stopped when DorkOS restarted',
  waited_on_you: 'DorkOS restarted while a chat waited on you',
  chain_cap: 'A reply stopped again after another restart',
  start_lost: 'A turn didn’t start before DorkOS restarted',
};

/** The second line, at most 15 plain words. */
const BODIES: Record<RestartNoticeCase, string> = {
  continued: 'The agent is picking it back up.',
  not_resumable: 'Send a message to continue.',
  waited_on_you: 'Send a message to continue.',
  chain_cap: 'Send a message to retry.',
  start_lost: 'Its start wasn’t saved, so it won’t run.',
};

/** The entry, spread into the registry's `ENTRIES`. */
export const RESTART_NOTICE_ENTRIES: {
  'turn.restarted': NotificationRegistryEntry<'turn.restarted'>;
} = {
  'turn.restarted': {
    kind: 'turn.restarted',
    tier: 'notable',
    storage: 'event',
    subjectType: 'session',
    locate: (p) => ({
      subjectId: p.sessionId,
      sessionId: p.sessionId,
      ...(p.agentId ? { agentId: p.agentId } : {}),
    }),
    title: (p) => TITLES[p.case],
    body: (p) => BODIES[p.case],
    dedupeKey: (p) => `notify:${p.runId}:${p.case}`,
    relay: 'never',
  },
};

/**
 * The notice for a run a restart touched.
 *
 * @param run - The run.
 * @param noticeCase - Which case is true.
 * @param now - The clock, epoch ms.
 */
export function restartNotice(run: TurnRun, noticeCase: RestartNoticeCase, now: number): NewEffect {
  return {
    kind: 'notify_person',
    key: `notify:${run.id}:${noticeCase}`,
    runId: run.id,
    sessionId: run.sessionId,
    payload: {
      notice: 'restart',
      runId: run.id,
      sessionId: run.sessionId,
      case: noticeCase,
      ...(run.agentId !== null ? { agentId: run.agentId } : {}),
    } satisfies z.infer<typeof RestartNoticePayloadSchema>,
    delivery: 'repeatable',
    notAfter: now + NOTIFY_PERSON_NOT_AFTER_MS,
  };
}
