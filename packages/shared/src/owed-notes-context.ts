/**
 * The two one-time notes DorkOS owes a session's next turn: `context_warning`
 * (DOR-2732) and `turn_cutoff` (DOR-3307). Kept beside `additional-context.ts`,
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
 * (DOR-3307): a one-time note on the next turn, saying that DorkOS stopped it
 * and no person did.
 *
 * The note exists because the runtime's own record of the cutoff speaks for a
 * person. Claude Code writes `[Request interrupted by user]` for any
 * interrupt, and "The user doesn't want to proceed with this tool use" over a
 * tool that was running, and agents read both as a person's stop and waited
 * hours for one. SERVER-derived from the stall guard; nothing a caller can
 * supply.
 */
export interface TurnCutoffData {
  /** How long the turn had gone without activity, in milliseconds. */
  windowMs: number;
  /** True when the turn never produced anything at all before the cutoff. */
  neverStarted: boolean;
}

/** Zod schema for {@link TurnCutoffData}. */
export const TurnCutoffDataSchema = z.object({
  windowMs: z.number().int().positive(),
  neverStarted: z.boolean(),
});
