/**
 * The measures (spec `heartbeats` §13, canon PROACTIVE-AGENTS §6): whether an
 * agent's work on its own helped, and what it cost people's attention.
 * Computed on read, over a window (default 7 days), from the rows
 * `measure-records.ts` reads. Every number names its source, and each target is
 * canon §6.1's starting bet, shown beside the number and never as a grade.
 *
 * - **Kept rate.** A beat acted only when it left a real mark: it raised
 *   something, posted around `end_beat` (`bypass`), or the agent did something
 *   that changes things in its beat chat during the beat (a mutating audit row:
 *   create, modify, remove, execute). A turn that only looked is not an action,
 *   and report beats are not counted. An action is kept unless a person paused
 *   the agent within an hour of it or reacted 👎 to a message it raised. Not
 *   measured yet: a person stopping the turn (no person row records it) and a
 *   revert of a commit it made (`workspace` records none). Approximate: recent
 *   work counts as kept until something undoes it, before its 7 days are up.
 * - **Useful-raise rate.** Messages delivered into the app to a person (a DM, a
 *   room post, a note that landed as a DM), answered or reacted to with
 *   anything but 👎 within 48 hours. Raises batched into one message count as
 *   one. A reply in a DM answers the agent's latest message only. One delivered
 *   under 48 hours ago with no answer yet is left out until its time is up. A
 *   note that left the app has no answer anyone can see, so it is not counted
 *   either way. Reports are not raises.
 * - **Interruptions per useful outcome.** Messages that reached a person,
 *   reports included, with raises batched into one message counted once,
 *   divided by kept actions plus useful raises.
 * - **Surprises** need the manager to say so: "not measured yet".
 * - **Mutes and pauses.** A person pausing it, setting its `wake` to `off`, or
 *   muting it (the agent or its DM) in the sidebar.
 *
 * @module services/heartbeats/measures/measures
 */
import type { HeartbeatMeasures, MeasureRate } from '@dorkos/shared/heartbeat-schemas';
import { REPORT_KEY_PREFIX } from '../raises/raise-store.js';
import { checksInBeat } from '../triage/triage-checks.js';
import type { Db } from '@dorkos/db';
import {
  readMeasureRecords,
  type MeasureAuditRow,
  type MeasureBeat,
  type MeasureRecords,
} from './measure-records.js';

/** The default window. */
export const MEASURE_WINDOW_DAYS = 7;

/** The most days a window may cover: beat rows are pruned after 90. */
export const MEASURE_WINDOW_MAX_DAYS = 90;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long after a beat turn an undo still counts against it. */
const UNDO_WINDOW_MS = 7 * DAY_MS;

/** How long after a raise a reply or reaction still makes it useful. */
const ANSWER_WINDOW_MS = 48 * HOUR_MS;

/** How soon after a beat turn a pause counts as undoing it. */
const PAUSE_WINDOW_MS = HOUR_MS;

const THUMBS_DOWN = '👎';

/** Canon §6.1 and §6.2's starting targets, in words. */
export const MEASURE_TARGETS = {
  kept: '95% or more',
  useful: '60% or more',
  interruptions: '1 or less',
  mutes: 'Trending to 0',
  quiet: '80% or more',
  commitments: '90% or more',
} as const;

/** Where each number comes from, in one plain line. */
export const MEASURE_SOURCES = {
  kept: 'Real actions only. Undone if paused within an hour or 👎. Stops, reverts not seen.',
  useful: 'Messages in the app that got a reply or a reaction other than 👎 within 48h.',
  interruptions: 'Messages and reports that reached a person, per kept action or useful message.',
  surprises: 'Not measured yet. It needs the manager to say so.',
  mutes: 'Pauses, heartbeat switched off, and mutes, by a person.',
  quiet: 'Checks that ended with nothing sent to anyone, and no post around it.',
  commitments: 'Promises due in this window, kept by their date.',
} as const;

/** What the computation needs beside the rows. */
export interface MeasureContext {
  /** The agent's home folder: how the sidebar names it when muted. */
  agentPath: string;
  /** Whether an account id names an agent, so only people are counted as interrupted. */
  isAgent(accountId: string): boolean;
  /** How many days back the window reaches. */
  windowDays: number;
  /** Where the window starts (ISO 8601). */
  since: string;
  /** Now (epoch ms). */
  now: number;
}

/**
 * A share, null when there was nothing to count.
 *
 * @param part - What counted.
 * @param whole - Out of how many.
 * @param target - The starting target.
 * @param source - Where it comes from.
 */
function rate(part: number, whole: number, target: string, source: string): MeasureRate {
  return { value: whole === 0 ? null : part / whole, part, whole, target, source };
}

/** Milliseconds of an ISO time, or NaN. */
const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** Whether `at` falls within `[from, from + span]`. */
function within(at: number, from: number, span: number): boolean {
  return at >= from && at <= from + span;
}

/**
 * Whether a beat acted: it raised something, posted around `end_beat`, or the
 * agent did something that changes things in its beat chat while it ran. A
 * report beat is the report, not work, and a turn that only looked did nothing.
 *
 * @param beat - The beat.
 * @param records - The rows, for the agent's actions.
 */
function acted(beat: MeasureBeat, records: MeasureRecords): boolean {
  if (beat.kind === 'report' || beat.outcome !== 'worked') return false;
  if (beat.raises > 0 || beat.bypass > 0) return true;
  const started = ms(beat.startedAt);
  const ended = ms(beat.endedAt);
  return records.agentActions.some(
    (action) =>
      action.sessionId === beat.turnSessionId && within(ms(action.at), started, ended - started)
  );
}

/**
 * The beats that acted and were not undone.
 *
 * @param records - The rows.
 * @param agentId - The agent, as audit rows name it.
 */
function keptActions(records: MeasureRecords, agentId: string): { kept: number; acted: number } {
  const actions = records.beats.filter((beat) => acted(beat, records));
  const pauses = records.audit.filter(
    (row) => row.action === 'agent.paused' && row.targetId === agentId
  );
  const disliked = new Set<string>();
  for (const row of records.deliveries) {
    const answer = row.deliveredEntryId ? records.answers.get(row.deliveredEntryId) : undefined;
    const sentAt = ms(row.closedAt);
    const thumbsDown = answer?.reactions.some(
      (r) => r.emoji === THUMBS_DOWN && within(ms(r.at), sentAt, UNDO_WINDOW_MS)
    );
    if (thumbsDown) disliked.add(row.beatId);
  }
  const undone = (beat: MeasureBeat): boolean => {
    if (disliked.has(beat.id)) return true;
    const started = ms(beat.startedAt);
    const ended = ms(beat.endedAt);
    return pauses.some((row) => within(ms(row.at), started, ended - started + PAUSE_WINDOW_MS));
  };
  return { kept: actions.filter((beat) => !undone(beat)).length, acted: actions.length };
}

/**
 * Whether a settings change muted this agent or its DM: a sidebar `muted` list
 * that, after the change, names the agent or its DM where it did not before.
 *
 * @param row - A `config.changed` row.
 * @param ctx - The agent's path.
 * @param dmRoomIds - Its DM rooms.
 */
function mutedIt(row: MeasureAuditRow, ctx: MeasureContext, dmRoomIds: string[]): boolean {
  // The agent's own entries in a `muted` list: `agent:<path>` and `room:<dm id>`.
  const itsRefs = (value: unknown): Set<string> => {
    const refs = new Set<string>();
    if (!Array.isArray(value)) return refs;
    for (const ref of value) {
      const item = (typeof ref === 'string' ? { kind: 'agent', path: ref } : ref) as {
        kind?: string;
        path?: string;
        roomId?: string;
      } | null;
      if (item?.kind === 'agent' && item.path === ctx.agentPath) refs.add(`agent:${item.path}`);
      if (item?.kind === 'room' && dmRoomIds.includes(item.roomId ?? '')) {
        refs.add(`room:${item.roomId}`);
      }
    }
    return refs;
  };
  return row.change.some((change) => {
    if (!/(^|\.)muted$/.test(change.field)) return false;
    const before = itsRefs(change.before);
    return [...itsRefs(change.after)].some((ref) => !before.has(ref));
  });
}

/**
 * Times a person paused the agent, switched its heartbeat off, or muted it.
 *
 * @param records - The rows.
 * @param ctx - The window and the agent.
 * @param agentId - The agent.
 */
function mutesAndPauses(records: MeasureRecords, ctx: MeasureContext, agentId: string) {
  let pauses = 0;
  let wakeOff = 0;
  let mutes = 0;
  for (const row of records.audit) {
    if (row.action === 'agent.paused' && row.targetId === agentId) pauses += 1;
    if (
      row.action === 'heartbeat.config_changed' &&
      row.targetId === agentId &&
      row.change.some((c) => c.field === 'wake' && c.after === 'off' && c.before !== 'off')
    ) {
      wakeOff += 1;
    }
    if (row.action === 'config.changed' && mutedIt(row, ctx, records.dmRoomIds)) mutes += 1;
  }
  return { pauses, wakeOff, mutes, total: pauses + wakeOff + mutes };
}

/** Tokens a beat turn's usage reports, or null when it reported none. */
function turnTokens(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const usage = JSON.parse(raw) as { inputTokens?: unknown; outputTokens?: unknown };
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const total = count(usage.inputTokens) + count(usage.outputTokens);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * Compute an agent's measures from its records.
 *
 * @param agentId - The agent's Mesh id.
 * @param records - Its rows over the window.
 * @param ctx - The window, and who is a person.
 */
export function computeMeasures(
  agentId: string,
  records: MeasureRecords,
  ctx: MeasureContext
): HeartbeatMeasures {
  const toPerson = records.deliveries.filter((row) => !ctx.isAgent(row.toAccount));
  const reached = toPerson.filter((row) => row.state !== 'held');
  // Raises, not reports, that landed somewhere a person can answer them.
  const raisesInApp = reached.filter(
    (row) => row.rung !== 'report' && !row.key.startsWith(REPORT_KEY_PREFIX) && row.deliveredEntryId
  );
  // One message per entry: raises batched together were one message to answer.
  const raiseMessages = new Map<string, number>();
  for (const row of raisesInApp) raiseMessages.set(row.deliveredEntryId!, ms(row.closedAt));
  let useful = 0;
  let judged = 0;
  for (const [entryId, sentAt] of raiseMessages) {
    const answer = records.answers.get(entryId);
    const answered =
      answer !== undefined &&
      ((answer.firstReplyAt !== null &&
        within(ms(answer.firstReplyAt), sentAt, ANSWER_WINDOW_MS)) ||
        answer.reactions.some(
          (r) => r.emoji !== THUMBS_DOWN && within(ms(r.at), sentAt, ANSWER_WINDOW_MS)
        ));
    if (answered) useful += 1;
    // Unanswered and still inside its 48 hours: too early to call.
    if (answered || ctx.now - sentAt > ANSWER_WINDOW_MS) judged += 1;
  }
  // Raises batched into one message landed as one entry: one interruption.
  const messages = new Set(
    reached.map((row) => row.deliveredEntryId ?? `${row.rung}|${row.toAccount}|${row.closedAt}`)
  ).size;
  const { kept, acted } = keptActions(records, agentId);
  const usefulOutcomes = kept + useful;
  const ran = records.beats.filter((beat) => beat.outcome !== 'skipped');
  const turns = records.beats.filter((beat) => beat.turnSessionId !== null);
  const reportedTokens = turns.map((beat) => turnTokens(beat.turnUsage)).filter((n) => n !== null);
  let checks = 0;
  let tokens = 0;
  for (const beat of records.beats) {
    const used = checksInBeat(beat.triage);
    checks += used.checks;
    tokens += used.tokens;
  }
  const onTime = records.commitments.filter(
    (c) => c.state === 'kept' && c.closedAt !== null && ms(c.closedAt) <= ms(c.dueAt)
  ).length;
  const counted = records.commitments.filter(
    (c) => c.state !== 'dropped' && ms(c.dueAt) <= ctx.now
  ).length;
  return {
    windowDays: ctx.windowDays,
    since: ctx.since,
    keptRate: rate(kept, acted, MEASURE_TARGETS.kept, MEASURE_SOURCES.kept),
    usefulRaiseRate: rate(useful, judged, MEASURE_TARGETS.useful, MEASURE_SOURCES.useful),
    interruptions: {
      value: usefulOutcomes === 0 ? null : messages / usefulOutcomes,
      messages,
      usefulOutcomes,
      target: MEASURE_TARGETS.interruptions,
      source: MEASURE_SOURCES.interruptions,
    },
    surprises: { measured: false, source: MEASURE_SOURCES.surprises },
    mutesAndPauses: {
      ...mutesAndPauses(records, ctx, agentId),
      target: MEASURE_TARGETS.mutes,
      source: MEASURE_SOURCES.mutes,
    },
    supporting: {
      beats: ran.length,
      quietBeats: rate(
        // A beat with no end_beat is unknown, not quiet; one that posted around it spoke.
        ran.filter(
          (beat) => beat.outcome !== 'no-end-beat' && beat.raises === 0 && beat.bypass === 0
        ).length,
        ran.filter((beat) => beat.outcome !== 'no-end-beat').length,
        MEASURE_TARGETS.quiet,
        MEASURE_SOURCES.quiet
      ),
      commitmentsOnTime: rate(
        onTime,
        counted,
        MEASURE_TARGETS.commitments,
        MEASURE_SOURCES.commitments
      ),
      noEndBeat: records.beats.filter((beat) => beat.outcome === 'no-end-beat').length,
      triage: { checks, tokens },
      turns: {
        count: turns.length,
        tokensPerTurn:
          reportedTokens.length === 0
            ? null
            : reportedTokens.reduce((sum, n) => sum + n, 0) / reportedTokens.length,
      },
      bypass: records.beats.reduce((sum, beat) => sum + beat.bypass, 0),
      held: toPerson.filter((row) => row.state === 'held').length,
    },
  };
}

/**
 * Clamp a requested window to whole days the record still holds.
 *
 * @param days - The days asked for, if any.
 */
export function measureWindowDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return MEASURE_WINDOW_DAYS;
  return Math.min(MEASURE_WINDOW_MAX_DAYS, Math.max(1, Math.floor(days)));
}

/**
 * Read and compute one agent's measures over the last `days` days.
 *
 * @param db - The server's database.
 * @param input - The agent, who is a person, now, and the window.
 * @param input.agentId - Its Mesh id.
 * @param input.agentPath - Its home folder.
 * @param input.isAgent - Whether an account id names an agent.
 * @param input.now - Now (epoch ms).
 * @param input.days - How many days back; defaults to {@link MEASURE_WINDOW_DAYS}.
 */
export function measureAgent(
  db: Db,
  input: {
    agentId: string;
    agentPath: string;
    isAgent(accountId: string): boolean;
    now: number;
    days?: number;
  }
): HeartbeatMeasures {
  const windowDays = measureWindowDays(input.days);
  const since = new Date(input.now - windowDays * DAY_MS).toISOString();
  const records = readMeasureRecords(db, {
    agentId: input.agentId,
    agentPath: input.agentPath,
    since,
    now: new Date(input.now).toISOString(),
  });
  return computeMeasures(input.agentId, records, {
    agentPath: input.agentPath,
    isAgent: input.isAgent,
    windowDays,
    since,
    now: input.now,
  });
}
