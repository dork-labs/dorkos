/**
 * The `direct_notes` context kind (rule S12, DOR-2997): what reached an agent's
 * Direct chat without being a turn there. Kept beside `additional-context.ts`,
 * which re-exports the types.
 *
 * @module shared/direct-notes-context
 */
import { z } from 'zod';

/** One message in an agent's Direct chat that never reached this session as a turn. */
export interface DirectNote {
  /** When it was posted. ISO 8601 UTC. */
  at: string;
  /** The name of whoever wrote it, as the chat shows it. */
  from: string;
  /** True when this agent wrote it, from one of its other chats. */
  fromYou: boolean;
  /** The words. */
  text: string;
}

/**
 * What arrived in an agent's Direct chat with the person since its last turn
 * there, without ever being a turn of its own (rule S12, DOR-2997).
 *
 * A Direct chat is the agent's standing 1:1 with the person. Its pings
 * (`relay_notify_user` from the agent's other chats) are written beside the
 * session, never into it, because writing them in would start a turn. So the
 * session would never learn what it told the person, and a "yes, do it" after a
 * ping would read as a sentence with no subject. This carries those messages
 * into the next turn, once.
 *
 * SERVER-derived from the room log under the Direct chat; nothing a caller can
 * supply.
 */
export interface DirectNotesData {
  /** The person this Direct chat is with. */
  withName: string;
  /** The messages, oldest first. */
  notes: DirectNote[];
  /** How many older unseen messages were left out to keep the block short. */
  omitted: number;
}

/** Zod schema for {@link DirectNotesData}. */
export const DirectNotesDataSchema = z.object({
  withName: z.string().min(1),
  notes: z
    .array(
      z.object({
        at: z.string().min(1),
        from: z.string().min(1),
        fromYou: z.boolean(),
        text: z.string(),
      })
    )
    .min(1),
  omitted: z.number().int().nonnegative(),
});
