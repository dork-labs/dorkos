/**
 * The report beat (spec `heartbeats` §3.4, §9.3): one message up the chain
 * instead of many small ones.
 *
 * - **Skipped for free** with a quiet record line when its report queue is
 *   empty and no beat turn ran since its last report: a report says what the
 *   manager has not already seen.
 * - **An away manager is waited for.** Routine report lines never step up; the
 *   beat is skipped and runs again once they are back (`report-clock.ts`).
 * - **Otherwise a turn writes it** in the beat chat and passes it as
 *   `end_beat.report`. To a person it goes to their in-app DM at the start of
 *   their hours; to an agent manager as a `report`-kind chat message. Delivery
 *   clears the lines that went into it. `report: null`, a turn without
 *   `end_beat`, or a failed turn carries everything over to the next report.
 * - **Lines for someone else** (an old manager's reports-to line, a `report`
 *   raise that named another reader) go to that reader as their own short
 *   message when the report goes.
 *
 * @module services/heartbeats/raises/report-beat
 */
import { randomUUID } from 'node:crypto';
import type { EndBeatInput } from '@dorkos/shared/heartbeat-schemas';
import type { HeartbeatReportItemRow } from '@dorkos/db';
import type { BeatAgent, BeatWake } from '../beat-runner.js';
import {
  finish,
  runTurn,
  type BeatContext,
  type BeatCycleDeps,
  type BeatResult,
  type BeatTrack,
} from '../beat-cycle.js';
import type { BeatPlan } from '../beat-plan.js';
import type { PersonPresence } from '../outbox.js';
import { isAway } from './raise-manners.js';
import type { RaiseStore } from './raise-store.js';
import { reportMaterial } from './report-material.js';

/** What a report beat reaches beyond an ordinary beat. */
export interface ReportBeatDeps extends BeatCycleDeps {
  /** The report queue. */
  raises: RaiseStore;
  /** Who the agent reports to. */
  managerOf(agentId: string): string;
  /** Whether an account id names an agent. */
  isAgent(accountId: string): boolean;
  /** A person's hours and away state. */
  presenceOf(personAccountId: string): PersonPresence;
  /** A name for an account id, as the report's prompt says it. */
  nameOf(accountId: string): string;
}

/**
 * Run one report beat.
 *
 * @param deps - What it reaches.
 * @param plan - The agent and its `HEARTBEAT.md`, read fresh.
 * @param wake - What woke it.
 * @param track - Filled in as the beat opens things.
 */
export async function runReportBeat(
  deps: ReportBeatDeps,
  plan: BeatPlan<BeatAgent>,
  wake: BeatWake,
  track: BeatTrack
): Promise<BeatResult> {
  const { agent } = plan;
  const now = deps.clock.now();
  const startedAt = new Date(now).toISOString();
  const beatId = (deps.mintId ?? randomUUID)();
  deps.store.insertBeat({
    id: beatId,
    agentId: agent.id,
    startedAt,
    kind: 'report',
    wake: wake.wake,
  });
  // `lastBeatAt` is left alone: it paces timed beats, and a report is not one.
  track.beatId = beatId;
  const ctx: BeatContext = {
    agent,
    plan,
    wake,
    beatId,
    startedAt,
    kind: 'report',
    changes: [],
    counts: '{}',
    triage: JSON.stringify({ rung: 'none', verdict: 'report' }),
  };
  const reader = deps.managerOf(agent.id);
  const { mine, all, turns } = reportMaterial(deps.raises, {
    agentId: agent.id,
    reader,
    lastReportAt: deps.store.getState(agent.id)?.lastReportAt ?? null,
    cadence: plan.settings.report,
    now,
  });
  if (mine.length === 0 && turns.length === 0) {
    // Lines for someone else (an old manager) go now, whether or not the reader has news.
    const sent = await sendOtherLines(deps, {
      agent,
      beatId,
      sessionId: deps.store.getState(agent.id)?.beatChatId ?? '',
      reader,
      mine,
      others: all,
    });
    finish(deps, ctx, {
      outcome: 'quiet',
      summary:
        sent === 0
          ? 'Nothing new to report.'
          : 'Nothing new to report; passed its notes to their readers.',
    });
    return { outcome: 'quiet' };
  }
  if (!deps.isAgent(reader) && isAway(deps.presenceOf(reader), now)) {
    finish(deps, ctx, {
      outcome: 'skipped',
      summary: 'Its manager is away; the report waits for their return.',
    });
    return { outcome: 'skipped' };
  }
  ctx.report = {
    material: {
      readerName: deps.nameOf(reader),
      lines: mine.map((item) => item.text),
      turns,
    },
    settle: (sessionId, ended) =>
      settleReport(deps, { agent, beatId, sessionId, reader, mine, others: all }, ended),
  };
  return runTurn(deps, ctx, track);
}

/** What one report's delivery reads. */
interface ReportDelivery {
  agent: BeatAgent;
  beatId: string;
  sessionId: string;
  reader: string;
  /** The lines that went into the report. */
  mine: readonly HeartbeatReportItemRow[];
  /** Every queued line, the reader's included. */
  others: readonly HeartbeatReportItemRow[];
}

/**
 * Deliver what the turn wrote, or carry everything over.
 *
 * @param deps - What it reaches.
 * @param report - The report's agent, beat, chat, reader and lines.
 * @param ended - What `end_beat` handed over.
 * @returns A note for the record, or null when the report went out.
 */
async function settleReport(
  deps: ReportBeatDeps,
  report: ReportDelivery,
  ended: EndBeatInput
): Promise<string | null> {
  const text = typeof ended.report === 'string' ? ended.report.trim() : '';
  if (!text) {
    return ended.report === null
      ? 'Skipped its report; everything waits for the next one.'
      : 'Ended its report beat without a report; everything waits for the next one.';
  }
  const { agent, beatId, sessionId, reader } = report;
  await deps.outbox.deliverReport({
    agent,
    beatId,
    chatSessionId: sessionId,
    to: reader,
    text,
    // Cleared only once the report reaches them (`outbox.ts`), back in the queue if dropped.
    lineIds: report.mine.map((item) => item.id),
  });
  await sendOtherLines(deps, report);
  return null;
}

/**
 * The lines meant for someone other than the report's reader, one short
 * message per reader, sent alongside the report.
 *
 * @param deps - What it reaches.
 * @param report - The report.
 * @returns How many readers were sent their lines.
 */
async function sendOtherLines(deps: ReportBeatDeps, report: ReportDelivery): Promise<number> {
  const byReader = new Map<string, HeartbeatReportItemRow[]>();
  for (const item of report.others) {
    if (item.toAccount === null || item.toAccount === report.reader) continue;
    byReader.set(item.toAccount, [...(byReader.get(item.toAccount) ?? []), item]);
  }
  let sent = 0;
  for (const [to, lines] of byReader) {
    await deps.outbox.deliverReport({
      agent: report.agent,
      beatId: report.beatId,
      chatSessionId: report.sessionId,
      to,
      text: [`From ${report.agent.name}:`, ...lines.map((line) => line.text)].join('\n'),
      lineIds: lines.map((line) => line.id),
    });
    sent += 1;
  }
  return sent;
}

/**
 * Queue the reports-to change lines (§4.2): the new manager reads "Now reports
 * to Ana." in the agent's next report, and an old manager who named it reads
 * the same line, sent to them when that report goes. An old manager who no
 * longer exists (a deleted agent) gets nothing.
 *
 * @param deps - The report queue, who the agent reports to now, and who exists.
 * @param input - The agent, its stored `reportsTo` before, and the moment.
 * @param input.agentId - The agent.
 * @param input.before - Its `reportsTo` before the change, or null.
 * @param input.id - The first line's id.
 * @param input.oldLineId - The old manager's line's id.
 * @param input.at - When (ISO 8601).
 */
export function queueManagerChange(
  deps: Pick<ReportBeatDeps, 'raises' | 'managerOf' | 'nameOf'> & {
    /** Whether an account id names an agent or person that exists now. */
    exists(accountId: string): boolean;
    /** The one id an account is known by (the owner's aliases fold into one). */
    canonical(accountId: string): string;
  },
  input: { agentId: string; before: string | null; id: string; oldLineId: string; at: string }
): void {
  const now = deps.managerOf(input.agentId);
  const text = `Now reports to ${deps.nameOf(now)}.`;
  deps.raises.queueItem(
    input.id,
    { agentId: input.agentId, kind: 'reports-to', text, key: 'reports-to' },
    input.at
  );
  if (input.before === null || !deps.exists(input.before)) return;
  if (deps.canonical(input.before) === deps.canonical(now)) return;
  deps.raises.queueItem(
    input.oldLineId,
    {
      agentId: input.agentId,
      kind: 'reports-to',
      text,
      toAccount: input.before,
      key: `reports-to:${input.before}`,
    },
    input.at
  );
}
