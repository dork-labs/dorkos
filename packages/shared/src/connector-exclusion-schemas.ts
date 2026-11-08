/**
 * Leaving one agent out of a connection's every-agent share (DOR-3961, spec
 * `agent-grant-autonomy`).
 *
 * A person can share a connected app with every agent and still leave one
 * agent out. The left-out agent keeps only the access given to it by name;
 * the share, now and as it changes later, no longer reaches it.
 *
 * @module shared/connector-exclusion-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

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
    kind: z.enum(['narrow_own', 'narrow_other', 'exclude_own', 'exclude_other', 'undo']),
    outcome: z.enum(['applied', 'refused']),
    refusalCode: z.string().nullable(),
    actorKind: z.enum(['person', 'agent']),
    actorId: z.string().min(1),
    targetAgentId: z.string().min(1),
    connectionId: z.string().min(1),
    reason: z.string().nullable(),
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
