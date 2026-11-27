/**
 * Leaving one agent out of a connection's every-agent share (DOR-3961, spec
 * `agent-grant-autonomy`).
 *
 * A person can share a connected app with every agent and still leave one
 * agent out. The left-out agent keeps only the access given to it by name;
 * the share, now and as it changes later, no longer reaches it.
 *
 * Also the other per-app choice only a person makes about what agents may do there: whether an
 * agent that only read an app may write back to it without asking (DOR-4794).
 *
 * @module shared/connector-exclusion-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { nextCursorOutput } from './paging.js';

extendZodWithOpenApiOnce();

/** Path parameters of the exclusion routes for one agent on one connection. */
export const ConnectorGrantExclusionParamsSchema = z
  .object({
    /** The connection. */
    connectionId: z.string().min(1),
    /** The agent left out, or let back in. */
    agentId: z.string().min(1),
  })
  .openapi('ConnectorGrantExclusionParams');

/** One agent left out of a connection's every-agent share. */
export const ConnectorGrantExclusionSchema = z
  .object({
    /** The agent left out. */
    agentId: z.string().min(1),
    /** Its name now, or null when it is no longer registered here. */
    displayName: z.string().min(1).nullable(),
    /** When it was left out. */
    createdAt: z.string().datetime(),
  })
  .strict()
  .openapi('ConnectorGrantExclusion');
/** One agent left out of a connection's every-agent share. */
export type ConnectorGrantExclusion = z.infer<typeof ConnectorGrantExclusionSchema>;

/** The agents left out of one connection's every-agent share. */
export const ConnectorGrantExclusionListSchema = z
  .object({
    connectionId: z.string().min(1),
    exclusions: z.array(ConnectorGrantExclusionSchema),
  })
  .strict()
  .openapi('ConnectorGrantExclusionList');
/** The agents left out of one connection's every-agent share. */
export type ConnectorGrantExclusionList = z.infer<typeof ConnectorGrantExclusionListSchema>;

/** One page of the agents left out of one connection's every-agent share, newest first. */
export const ConnectorGrantExclusionPageSchema = ConnectorGrantExclusionListSchema.extend({
  nextCursor: nextCursorOutput,
}).openapi('ConnectorGrantExclusionPage');
/** One page of the agents left out of one connection's every-agent share. */
export type ConnectorGrantExclusionPage = z.infer<typeof ConnectorGrantExclusionPageSchema>;

/** What leaving an agent out, or letting it back in, did. */
export const ConnectorGrantExclusionChangeSchema = z
  .object({
    connectionId: z.string().min(1),
    agentId: z.string().min(1),
    /** Whether the agent is left out after the change. */
    excluded: z.boolean(),
    /** False when it already was. */
    changed: z.boolean(),
  })
  .strict()
  .openapi('ConnectorGrantExclusionChange');
/** What leaving an agent out, or letting it back in, did. */
export type ConnectorGrantExclusionChange = z.infer<typeof ConnectorGrantExclusionChangeSchema>;

/**
 * One access change an agent made, or a person's undo of one, as the person
 * sees it (spec `agent-grant-autonomy` §6.2). `reason` is the agent's own
 * words: show it as plain text, attributed to the agent, never as markup.
 */
export const ConnectorAccessChangeSchema = z
  .object({
    changeId: z.string().min(1),
    kind: z.enum([
      'narrow_own',
      'narrow_other',
      'exclude_own',
      'exclude_other',
      'approve_read',
      'undo',
    ]),
    outcome: z.enum(['applied', 'refused']),
    refusalCode: z.string().nullable(),
    actorKind: z.enum(['person', 'agent']),
    actorId: z.string().min(1),
    targetAgentId: z.string().min(1),
    connectionId: z.string().min(1),
    reason: z.string().nullable(),
    /** On an `approve_read` row, the agent request it answered. */
    requestId: z.string().nullable(),
    undoOf: z.string().nullable(),
    undoneBy: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .openapi('ConnectorAccessChange');
/** One access change, as the person sees it. */
export type ConnectorAccessChange = z.infer<typeof ConnectorAccessChangeSchema>;

/** Access changes, newest first. */
export const ConnectorAccessChangeListSchema = z
  .object({ changes: z.array(ConnectorAccessChangeSchema) })
  .strict()
  .openapi('ConnectorAccessChangeList');
/** Access changes, newest first. */
export type ConnectorAccessChangeList = z.infer<typeof ConnectorAccessChangeListSchema>;

/** Filters for the person's list of access changes. */
export const ConnectorAccessChangeListQuerySchema = z
  .object({
    connectionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict()
  .openapi('ConnectorAccessChangeListQuery');

/** What a person's Undo did. */
export const ConnectorAccessChangeUndoSchema = z
  .object({ changeId: z.string().min(1), undoId: z.string().min(1) })
  .strict()
  .openapi('ConnectorAccessChangeUndo');
/** What a person's Undo did. */
export type ConnectorAccessChangeUndo = z.infer<typeof ConnectorAccessChangeUndoSchema>;

/**
 * Another agent's approval of a request for Read, as the request's owner sees it on the card
 * (Security M1 on #3575): the approver as it looked when it approved (name and avatar, never read
 * live), when, and when the person undid it, if they did. Read from the approval's own ledger row
 * by the request's id, so no number of other ledger rows can hide it. Owner-only: never in what
 * the asking agent reads.
 */
export const ConnectorAgentApprovalSchema = z
  .object({
    agentId: z.string().min(1),
    /** The approver's name when it approved, or `null` when the registry didn't know it then. */
    displayName: z.string().min(1).nullable(),
    color: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    approvedAt: z.string().datetime(),
    /** When the person undid it, if they did. */
    undoneAt: z.string().datetime().optional(),
  })
  .strict()
  .openapi('ConnectorAgentApproval');
/** Another agent's approval of a request for Read, as the request's owner sees it. */
export type ConnectorAgentApproval = z.infer<typeof ConnectorAgentApprovalSchema>;

/**
 * Whether an agent whose turn read only this connected app may write back to it without asking
 * (DOR-4794). Off until a person turns it on. Deletions and anything sent elsewhere still ask.
 */
export const ConnectorWritesBackSchema = z
  .object({
    connectionId: z.string().min(1),
    /** On: a write back to this app, in a turn that read only this app, runs without a card. */
    writesBackUnasked: z.boolean(),
    /**
     * When the person turned it on and confirmed the app does not copy what it holds somewhere
     * else on its own (DorkOS can't see an app's own syncs). Null while it is off.
     */
    writesBackAttestedAt: z.string().datetime().nullable(),
    /**
     * Whether DorkOS offers the switch for this app: only apps whose changes stay inside the
     * team's own workspace (Linear today). An app whose writes are sends never gets it.
     */
    supported: z.boolean(),
  })
  .strict()
  .openapi('ConnectorWritesBack');
/** Whether an agent may write back to a connected app it only read, without asking. */
export type ConnectorWritesBack = z.infer<typeof ConnectorWritesBackSchema>;

/**
 * Turning writes back on or off for one connected app. Turning it on needs the person's
 * confirmation that the app copies nothing it holds to another place on its own.
 */
export const ConnectorWritesBackChangeRequestSchema = z
  .object({
    writesBackUnasked: z.boolean(),
    /** Required, and `true`, to turn it on. Ignored when turning it off. */
    confirmsNoOutsideSync: z.literal(true).optional(),
  })
  .strict()
  .refine((body) => !body.writesBackUnasked || body.confirmsNoOutsideSync === true, {
    message: 'Confirm the app copies nothing to another place on its own before turning this on.',
    path: ['confirmsNoOutsideSync'],
  })
  .openapi('ConnectorWritesBackChangeRequest');
/** Turning writes back on or off for one connected app. */
export type ConnectorWritesBackChangeRequest = z.infer<
  typeof ConnectorWritesBackChangeRequestSchema
>;

/** What turning writes back on or off did. */
export const ConnectorWritesBackChangeSchema = ConnectorWritesBackSchema.extend({
  /** False when it already was in that state. */
  changed: z.boolean(),
})
  .strict()
  .openapi('ConnectorWritesBackChange');
/** What turning writes back on or off did. */
export type ConnectorWritesBackChange = z.infer<typeof ConnectorWritesBackChangeSchema>;
