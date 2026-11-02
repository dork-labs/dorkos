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

/** Read-only folder rules for a person reviewing a schedule; never a grant. */
export const TaskFolderRulesSchema = z.object({
  status: z.enum(['approved', 'waiting', 'none', 'unavailable']),
  /** Only rules that a launch would apply; empty while approval is outstanding. */
  applied: z.array(z.string()),
  /** The filtered folder list waiting for a separate person's approval. */
  pending: z.array(z.string()),
});
