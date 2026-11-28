/**
 * `lost_work_wake` (spec `turns-survive-restarts` §6.2, §7.3 step 4): today's
 * background-work wake (DOR-2065), routed through the run record and
 * unchanged for the user. After a restart, a chat whose ended turn left
 * background work running gets a new turn with the same message, under the
 * same skips: a busy chat, a room's or a task's chat, a record past the age
 * bound (`RUNS.RESTART_AGE_BOUND_MS`, the one bound recovery reads too).
 *
 * Recovery saves one effect per record that wakes, before the worker starts,
 * and only for a chat whose runtime declares `wakesForLostBackgroundWork`
 * (§7.2), read per runtime, never assumed. The handler wakes the chat through
 * the computer face's seam (`wakeChatForLostWork`), whose run carries the
 * effect's key as its `start_key` (`lost-work:<sessionId>:<since>`): a boot
 * that dies mid-wake finds that run and wakes nobody twice. A record is let
 * go once its chat is settled (woken, busy, gone); a wake that throws is tried
 * again with the worker's backoff, until the effect's hour runs out.
 *
 * @module services/runs/recovery/lost-work
 */
import { z } from 'zod';
import { RUNS } from '../../../config/constants.js';
import type { WakeOutcome } from '../../session/turn-port/index.js';
import type { NewEffect } from '../effects/effect-store.js';
import type { EffectHandler } from '../effects/worker.js';
import type { RunStore } from '../run-store.js';

/**
 * One chat a restart cut short while its ended turn held background work, as
 * the runtime that held the work recorded it (Claude Code's background-work
 * ledger writes these).
 */
export interface LostWorkRecord {
  /** The key the chat's process was filed under in the server that stopped. */
  key: string;
  /** The chat. */
  sessionId: string;
  /** The folder the chat runs in. */
  cwd: string;
  /** When the process started holding the work, epoch ms. */
  since: number;
  /** The runtime that held it, when the record says; else the chat's own. */
  runtime?: string;
}

/** The effect's payload: the record, by reference. */
const LostWorkPayloadSchema = z.strictObject({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  since: z.number(),
});

/** The key, and the wake's `start_key`, of one record's wake. */
export function lostWorkKey(record: Pick<LostWorkRecord, 'sessionId' | 'since'>): string {
  return `lost-work:${record.sessionId}:${record.since}`;
}

/**
 * The effect that wakes one record's chat.
 *
 * @param record - The record.
 * @param now - The clock, epoch ms.
 */
export function lostWorkWakeEffect(record: LostWorkRecord, now: number): NewEffect {
  return {
    kind: 'lost_work_wake',
    key: lostWorkKey(record),
    sessionId: record.sessionId,
    payload: {
      sessionId: record.sessionId,
      cwd: record.cwd,
      since: record.since,
    } satisfies z.infer<typeof LostWorkPayloadSchema>,
    delivery: 'repeatable',
    notAfter: now + RUNS.RESTART_FOLLOW_UP_MS,
  };
}

/** What the handler needs. */
export interface LostWorkWakeDeps {
  runs: RunStore;
  /** Wake one chat: the computer face's seam (`wakeChatForLostWork`). */
  wake: (chat: { sessionId: string; cwd: string; startKey: string }) => Promise<WakeOutcome>;
  /** Let a record go once its chat is settled, by the effect's key; a no-op for one this boot never read. */
  release: (key: string) => void;
}

/**
 * The handler: wake the chat once, and let its record go once settled.
 *
 * @param deps - The run store, the wake and the record's release.
 */
export function lostWorkWakeHandler(deps: LostWorkWakeDeps): EffectHandler {
  return {
    async handle(effect) {
      const parsed = LostWorkPayloadSchema.safeParse(effect.payload);
      if (!parsed.success) return { kind: 'drop', reason: 'unreadable_payload' };
      // Made already, by a boot that died before it marked this done.
      if (deps.runs.findByStartKey(effect.key)) {
        deps.release(effect.key);
        return { kind: 'done', outcome: { alreadyWoken: true } };
      }
      const { sessionId, cwd } = parsed.data;
      const outcome = await deps.wake({ sessionId, cwd, startKey: effect.key });
      if (outcome === 'failed') throw new Error('The chat could not be woken yet');
      deps.release(effect.key);
      return { kind: 'done', outcome: { wake: outcome } };
    },
  };
}
