/**
 * One-time notes DorkOS owes a session or agent's next turn: context warnings,
 * turn cutoffs, and release facts. Kept beside `additional-context.ts`,
 * which re-exports the types.
 *
 * @module shared/owed-notes-context
 */
import { z } from 'zod';

/**
 * The session's conversation has filled past the early-warning line (DOR-2732):
 * a one-time note on the turn after the crossing, so an agent near its limit
 * can save what matters and ask for a summary before the runtime compacts it on
 * its own terms.
 *
 * SERVER-derived from the session's own context reading — nothing a caller can
 * supply — and rendered by each runtime, so every runtime gets the same note.
 */
export interface ContextWarningData {
  /** Share of the context window in use at the crossing, 0–100. */
  percent: number;
  /**
   * Whether this session's runtime can summarize on request, so the note only
   * points at the summary tool where calling it could work.
   */
  canCompact: boolean;
}

/** Zod schema for {@link ContextWarningData}. */
export const ContextWarningDataSchema = z.object({
  percent: z.number().int().min(0).max(100),
  canCompact: z.boolean(),
});

/**
 * DorkOS ended this session's previous turn because the agent went quiet
 * (DOR-3307).
 */
export interface StalledTurnCutoff {
  /** How long the turn had gone without activity, in milliseconds. */
  windowMs: number;
  /** True when the turn never produced anything at all before the cutoff. */
  neverStarted: boolean;
}

/**
 * Another chat's agent stopped this session's previous turn (DOR-4668): with
 * `chat_stop`, or by sending it a message with `delivery: 'interrupt'`.
 * Carries no name on purpose: a delivered message already names its sender
 * inside its own fence, and this note sits outside any.
 */
export interface ChatStopCutoff {
  /** Who stopped it: another chat, never a person. */
  stoppedBy: 'chat';
  /** `interrupt` when a message runs next because of it; `stop` for `chat_stop`. */
  via: 'interrupt' | 'stop';
}

/**
 * A one-time note on a session's next turn, saying who really ended the turn
 * before it, and that no person did.
 *
 * The note exists because the runtime's own record of the stop speaks for a
 * person. Claude Code writes `[Request interrupted by user]` for any
 * interrupt, and "The user doesn't want to proceed with this tool use" over a
 * tool that was running, and agents read both as a person's stop and waited
 * hours for one. SERVER-derived from the stall guard and the chat-message
 * service; nothing a caller can supply.
 */
export type TurnCutoffData = StalledTurnCutoff | ChatStopCutoff;

/** Zod schema for {@link TurnCutoffData}. */
export const TurnCutoffDataSchema = z.union([
  z.object({
    windowMs: z.number().int().positive(),
    neverStarted: z.boolean(),
  }),
  z.object({
    stoppedBy: z.literal('chat'),
    via: z.enum(['interrupt', 'stop']),
  }),
]);

/**
 * DorkOS ended the Claude Code process this session's timers lived in
 * (DOR-3755): to free a slot for another chat, at the four-hour ceiling, or on
 * a record sweep. A session timer (CronCreate, ScheduleWakeup, /loop) fires
 * only inside a running process, and no process runs for the chat again until
 * its next turn, so a timer that came due in between did not fire, and for a
 * one-shot CronCreate nothing else tells the agent.
 *
 * Its own note, not a turn cutoff: both can be owed at once (a turn the stall
 * guard ended, whose process a reclaim then took), and the next turn needs
 * both. SERVER-derived from the Claude Code process lifecycle.
 */
export interface TimersStoppedData {
  /** How many session timers the CLI named pending at the last turn end. */
  timers: number;
  /** When the process ended, as epoch ms. */
  at: number;
}

/** Zod schema for {@link TimersStoppedData}. */
export const TimersStoppedDataSchema = z.object({
  timers: z.number().int().positive(),
  at: z.number().int().nonnegative(),
});

/** Compiled release facts owed to an agent's first ordinary turn after an update. */
export interface NewSinceData {
  previousVersion: string;
  currentVersion: string;
  lines: string[];
  omitted: number;
}

/** Schema for the bounded, server-derived release note payload. */
export const NewSinceDataSchema = z.object({
  previousVersion: z.string(),
  currentVersion: z.string(),
  lines: z
    .array(
      z
        .string()
        .max(160)
        .regex(/^[^<\r\n]+$/)
    )
    .max(8),
  omitted: z.number().int().nonnegative(),
});
