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
