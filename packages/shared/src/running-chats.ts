/**
 * The running-chats read: every chat with a live turn right now, per agent,
 * spin-offs included (DOR-3460). One shape for `GET /api/sessions/running` and
 * the `running_chats` tool.
 *
 * @module shared/running-chats
 */
import { z } from 'zod';

/** An unattended start has no reclaimable session record. */
export const SESSION_CAPACITY_CODE = 'session_capacity_reached';

/** The same actionable refusal in chat, tools and the capacity read. */
export function sessionCapacityMessage(limit: number): string {
  return `All ${limit} chats are busy. Wait for one to finish, then try again.`;
}

/** Refusal only after every record was checked for idle reclamation. */
export class SessionCapacityError extends Error {
  readonly code = SESSION_CAPACITY_CODE;
  constructor(readonly limit: number) {
    super(sessionCapacityMessage(limit));
    this.name = 'SessionCapacityError';
  }
}

/** Admission capacity, counting only records with work as unavailable. No chat identities. */
export const SessionCapacitySchema = z.object({
  runtime: z.string(),
  limit: z.number().int().positive(),
  records: z.number().int().nonnegative(),
  live: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  message: z.string().nullable(),
});

export type SessionCapacity = z.infer<typeof SessionCapacitySchema>;

/** Where a running chat is: working, or holding its turn until someone answers. */
export const RunningChatStateSchema = z.enum(['running', 'needs-you']);

/** Where a running chat is. */
export type RunningChatState = z.infer<typeof RunningChatStateSchema>;

/** One chat with a live turn. */
export const RunningChatSchema = z.object({
  /** The chat's id. */
  id: z.string(),
  /** Its title, or null when it has none yet. */
  title: z.string().nullable(),
  /** A ready markdown link to the chat. */
  link: z.string(),
  /** Working, or waiting on an answer. */
  state: RunningChatStateSchema,
  /** Another chat started this one. */
  spinOff: z.boolean(),
  /** The chat that started it, when the reader may see that chat. */
  startedBy: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});

/** One chat with a live turn. */
export type RunningChat = z.infer<typeof RunningChatSchema>;

/** What one agent, or no agent, has running. */
const RunningChatsGroupShape = {
  /** Every live chat here, the private ones included. */
  count: z.number().int().nonnegative(),
  /** How many of `count` are private to a person, so left out of `chats`. */
  privateCount: z.number().int().nonnegative(),
  /** The live chats this reader may see, in a stable order. */
  chats: z.array(RunningChatSchema),
};

/** One registered agent and what it has running, zero included. */
export const RunningChatsAgentSchema = z.object({
  /** The agent's id. */
  agentId: z.string(),
  /** Its display name. */
  name: z.string(),
  /** Its folder. */
  projectPath: z.string(),
  ...RunningChatsGroupShape,
});

/** One registered agent and what it has running. */
export type RunningChatsAgent = z.infer<typeof RunningChatsAgentSchema>;

/** The whole read. */
export const RunningChatsResponseSchema = z.object({
  /** Capped backends report reclaimable slots and a plain refusal when every record is live. */
  capacity: z.array(SessionCapacitySchema).optional(),
  /** Every live chat on this server. Always the sum of the groups' counts. */
  total: z.number().int().nonnegative(),
  /** Every registered agent, busiest first. */
  agents: z.array(RunningChatsAgentSchema),
  /** Live chats no registered agent owns. */
  unassigned: z.object(RunningChatsGroupShape),
});

/** The whole read. */
export type RunningChatsResponse = z.infer<typeof RunningChatsResponseSchema>;
