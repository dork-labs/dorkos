/**
 * The wire contract for the person's view of the load gate's waiting line
 * (DOR-4209), under `/api/system/load-gate`: the heavy shell jobs waiting for
 * the computer to be less busy, and a person's three actions on one of them.
 *
 * Nothing here is command text. A job is named by its program alone (`pnpm`,
 * `tsc`), and by the agent and chat it is for only when this DorkOS server
 * queued it.
 *
 * @module shared/load-gate-queue
 */
import { z } from 'zod';

/** A waiting job's id: 16 hex characters. */
export const LoadGateJobIdSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** One waiting heavy job, as the person's list shows it. */
export const LoadGateWaitingJobSchema = z.object({
  /** The job's id, for the actions below. */
  id: LoadGateJobIdSchema,
  /** Its place in line, counting from 1. */
  position: z.number().int().positive(),
  /**
   * Whether this DorkOS server queued it. When false, another DorkOS app on
   * this computer did, and `agentName` and `chatTitle` are absent.
   */
  ownedHere: z.boolean(),
  /** The agent it is for, when this server knows. */
  agentName: z.string().optional(),
  /** The chat it is for, when this server knows. */
  chatTitle: z.string().optional(),
  /** The program it runs, such as `pnpm`. Never its arguments. */
  label: z.string(),
  /** When it started waiting, in epoch milliseconds. */
  waitingSinceMs: z.number(),
  /** Whether it is ahead of every normal job. */
  urgent: z.boolean(),
  /** Whether a person moved it to the front of the line. */
  front: z.boolean(),
  /** Whether a person let it through; it starts on its next check. */
  letThrough: z.boolean(),
});

/** One waiting heavy job, as the person's list shows it. */
export type LoadGateWaitingJob = z.infer<typeof LoadGateWaitingJobSchema>;

/** The waiting line, first in line first. */
export const LoadGateWaitingLineSchema = z.object({
  jobs: z.array(LoadGateWaitingJobSchema),
});

/** The waiting line, first in line first. */
export type LoadGateWaitingLine = z.infer<typeof LoadGateWaitingLineSchema>;

/** A person's actions on one waiting job: run it now, mark it urgent, or move it to the front. */
export const LOAD_GATE_JOB_ACTIONS = ['let-through', 'urgent', 'front'] as const;

/** A person's action on one waiting job. */
export type LoadGateJobAction = (typeof LOAD_GATE_JOB_ACTIONS)[number];
