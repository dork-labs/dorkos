import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
extendZodWithOpenApiOnce();

/**
 * The turn marks a schedule was created or last edited under (DOR-3036, `specs/turn-marks`), as
 * its approval card shows them: words from outside the owner's circle, and each teammate in a
 * shared space whose message started the chain, with the names DorkOS knew when it was written.
 */
export const ScheduleOriginMarksSchema = z
  .object({
    /** The turn read words DorkOS can't vouch for: a stranger's message, or another agent's that carried one. */
    outsider: z.literal(true).optional(),
    /** Each teammate whose message started the chain, and the space room they wrote in. */
    teammate: z
      .array(
        z.object({
          roomId: z.string(),
          authorId: z.string(),
          /** The teammate's name when the mark was written, or null when it was unknown. */
          name: z.string().nullable().default(null),
          /** The room's title when the mark was written, or null when it was unknown. */
          room: z.string().nullable().default(null),
        })
      )
      .optional(),
  })
  .openapi('ScheduleOriginMarks');

export type ScheduleOriginMarks = z.infer<typeof ScheduleOriginMarksSchema>;

/** Who approved a scheduled task, stored with its audit receipt. */
export const TaskApproverSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('person'),
      userId: z.string().nullable(),
      name: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('agent'),
      agentPath: z.string(),
      name: z.string().nullable(),
    }),
    z.object({ kind: z.literal('policy') }),
  ])
  .openapi('TaskApprover');

/** {@link TaskApproverSchema}. */
export type TaskApprover = z.infer<typeof TaskApproverSchema>;

/** The surface or policy path through which a scheduled task was approved. */
export const TaskApprovalViaSchema = z
  .enum(['inbox', 'schedules', 'home', 'created', 'agent_tool', 'trusted_agent', 'unknown'])
  .openapi('TaskApprovalVia');

/** {@link TaskApprovalViaSchema}. */
export type TaskApprovalVia = z.infer<typeof TaskApprovalViaSchema>;

/** The nullable audit receipt carried by every scheduled task row. */
export const TaskApprovalReceiptSchema = z.object({
  approvedAt: z.string().datetime().nullable(),
  approvedBy: TaskApproverSchema.nullable(),
  approvedVia: TaskApprovalViaSchema.nullable(),
});

/** Read-only folder rules for a person reviewing a schedule; never a grant. */
export const TaskFolderRulesSchema = z.object({
  status: z.enum(['approved', 'waiting', 'none', 'unavailable']),
  /** Only rules that a launch would apply; empty while approval is outstanding. */
  applied: z.array(z.string()),
  /** The filtered folder list waiting for a separate person's approval. */
  pending: z.array(z.string()),
});

/**
 * Where a parked schedule's runs would stand, read with the run's own guard
 * (`execution/run-place-guard.ts`) after the same folder chain (`execution/run-placement.ts`).
 */
export const TaskRunPlaceSchema = z
  .discriminatedUnion('kind', [
    /** The agent's own folder. */
    z.object({ kind: z.literal('agent'), path: z.string() }),
    /**
     * The agent's managed checkout. `ready` is false when it is not made yet:
     * a run makes it first, or works in the agent's own folder while making it
     * waits on a person's OK.
     */
    z.object({ kind: z.literal('agent_checkout'), ready: z.boolean() }),
    /**
     * A fixed folder that is not the agent's own: DorkOS's default folder for an
     * agent set to use it, or the folder the server runs in for a run with no agent.
     */
    z.object({ kind: z.literal('folder'), path: z.string(), of: z.enum(['default', 'server']) }),
    /** A new, empty, private folder for each run. */
    z.object({ kind: z.literal('private') }),
  ])
  .openapi('TaskRunPlace');

/** {@link TaskRunPlaceSchema}. */
export type TaskRunPlace = z.infer<typeof TaskRunPlaceSchema>;

/** Read-only facts shown beside the approval; the revision binds the person's answer. */
export const TaskReviewPresentationSchema = z.object({
  folderRules: TaskFolderRulesSchema.optional(),
  /** Person-only, and only on a parked schedule. Absent when no run could start. */
  runPlace: TaskRunPlaceSchema.optional(),
  runsAsName: z.string().nullable().optional(),
  fileCapNext: z.boolean().optional(),
  approvalRevision: z.string().optional(),
});
