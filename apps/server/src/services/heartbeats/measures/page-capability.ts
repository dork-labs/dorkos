/**
 * `heartbeat.view_page` (spec `heartbeats` §7.6, §13; DOR-4978): what an
 * agent's Heartbeat page shows, served on `GET /api/agents/{id}/heartbeat`.
 * How it wakes, its next beat, its last 50 beats from the record, the raises
 * held for people's hours, its checks, and its measures over `days` (default 7,
 * at most 90).
 *
 * **Person-only** (`http.audience: 'person'`), with no MCP surface. The page
 * carries more than an agent reads about another agent: every held raise and
 * its recipient, the file's own error and the checks. An agent reads a
 * heartbeat with `heartbeat_status` (`status-capability.ts`), which gives a
 * count where this gives the list. Only the install's owner sees a held raise's
 * words and which chat a beat ran in (the owner bar, read from `context.request`).
 *
 * @module services/heartbeats/measures/page-capability
 */
import { z } from 'zod';
import { HeartbeatStatusSchema, type HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import {
  defineCapability,
  CapabilityToolError,
} from '../../core/capabilities/capability-definition.js';
import { MEASURE_WINDOW_MAX_DAYS } from './measures.js';

/** What the running server teaches the page read to read. */
export interface HeartbeatPageReader {
  /**
   * The agent's status, or undefined when no such agent exists.
   *
   * @param agentId - The agent's Mesh id.
   * @param viewerIsOwner - Whether the caller owns this install: only they see
   *   held raises' words and which chat a beat ran in.
   * @param days - The measures' window, when the caller named one.
   */
  status(
    agentId: string,
    viewerIsOwner: boolean,
    days?: number
  ): Promise<HeartbeatStatus | undefined>;
}

let reader: HeartbeatPageReader | undefined;

/**
 * Teach `heartbeat.view_page` where to read from.
 *
 * @param next - The reader, or undefined at shutdown.
 */
export function setHeartbeatPageReader(next: HeartbeatPageReader | undefined): void {
  reader = next;
}

/** What a `days` outside the window reads. */
const DAYS_RULE = 'must be a whole number from 1 to 90';

/** The person-only read behind an agent's Heartbeat page, on `GET /api/agents/{id}/heartbeat`. */
export const heartbeatPageCapability = defineCapability({
  id: 'heartbeat.view_page',
  title: 'Read an agent’s Heartbeat page',
  description:
    'How the agent wakes on its own, when its next timed beat is due, its last 50 beats ' +
    'from the record, the messages to people still held for their working hours, and its ' +
    'measures: whether its work on its own helped, each with its source and starting target. ' +
    'Only a person reads the page; agents read a heartbeat with heartbeat_status.',
  tier: 'observe',
  area: null,
  areaNote: 'a person’s page; agents read a heartbeat with heartbeat_status',
  input: z.object({
    id: z.string().min(1).max(200).describe('The agent’s id.'),
    days: z.coerce
      .number({ error: DAYS_RULE })
      .int({ error: DAYS_RULE })
      .min(1, { error: DAYS_RULE })
      .max(MEASURE_WINDOW_MAX_DAYS, { error: DAYS_RULE })
      .optional()
      .describe('How many days the measures cover. Defaults to 7.'),
  }),
  output: HeartbeatStatusSchema,
  surfaces: {
    http: {
      method: 'get',
      path: '/api/agents/{id}/heartbeat',
      audience: 'person',
      agentsUse: 'Agents read a heartbeat with heartbeat_status.',
    },
  },
  invoke: async (_deps, input, context) => {
    if (!reader) {
      throw new CapabilityToolError({
        code: 'HEARTBEATS_UNAVAILABLE',
        error: 'Heartbeats are not running on this server yet.',
      });
    }
    const status = await reader.status(
      input.id,
      context.request?.accountOwner === true,
      input.days
    );
    if (!status) {
      throw new CapabilityToolError({
        code: 'HEARTBEAT_AGENT_NOT_FOUND',
        error: 'No agent with that id.',
      });
    }
    return status;
  },
});
