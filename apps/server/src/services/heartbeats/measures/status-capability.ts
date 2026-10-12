/**
 * `heartbeat.status` (spec `heartbeats` §10 PR 6): how an agent wakes, its
 * next beat, its last beats, how much is held for people, and its measures.
 *
 * - **Any agent may read any agent's**, so a lead reads its reports' the way a
 *   manager reads a colleague's record. Tier `observe`, `area: null`, as
 *   `commitments_list`: the record it reads is readable by everyone in the
 *   space, and a switch that blocked it would hide the record without stopping
 *   anything.
 * - **Summaries only.** It never returns the words of a held message or which
 *   chat a beat ran in: those are the owner's, in the app. Held messages are a
 *   count.
 * - **Strangers read nothing.** A turn somebody from off this machine started
 *   is refused (`OUTSIDER_TURN`): trust never extends to strangers.
 *
 * @module services/heartbeats/measures/status-capability
 */
import { z } from 'zod';
import {
  BeatKindSchema,
  BeatOutcomeSchema,
  HeartbeatMeasuresSchema,
  HeartbeatReportStatusSchema,
  HeartbeatWakeSchema,
  type HeartbeatStatus,
} from '@dorkos/shared/heartbeat-schemas';
import { defineCapability } from '../../core/capabilities/index.js';
import { MEASURE_WINDOW_DAYS, MEASURE_WINDOW_MAX_DAYS } from './measures.js';

/** The MCP tool name, exported so prose that names it reads it from here. */
export const HEARTBEAT_STATUS_TOOL = 'heartbeat_status';

/** How many past beats it lists when the caller names no number. */
const BEATS_DEFAULT = 10;

/** The most past beats it lists, as the page does. */
const BEATS_MAX = 50;

/** What the running server teaches the capability to read. */
export interface HeartbeatStatusReader {
  /**
   * An agent's status as anyone but the owner sees it, or undefined when no
   * such agent exists.
   *
   * @param agentId - The agent's Mesh id.
   * @param days - The measures' window.
   */
  status(agentId: string, days: number): Promise<HeartbeatStatus | undefined>;
  /**
   * The Mesh id of the agent living at a home folder.
   *
   * @param agentPath - The folder.
   */
  agentIdForPath(agentPath: string): string | undefined;
}

/** Set by the running server; absent, the capability says heartbeats are not running. */
let reader: HeartbeatStatusReader | undefined;

/**
 * Teach `heartbeat.status` where to read from.
 *
 * @param next - The reader, or undefined at shutdown.
 */
export function setHeartbeatStatusReader(next: HeartbeatStatusReader | undefined): void {
  reader = next;
}

/** A refusal. */
const RefusalSchema = z.object({ ok: z.literal(false), code: z.string(), error: z.string() });

/** A refusal value. */
type Refusal = z.infer<typeof RefusalSchema>;

/** One refusal. */
function refuse(code: string, error: string): Refusal {
  return { ok: false, code, error };
}

/** What an agent reads. */
const StatusViewSchema = z.object({
  ok: z.literal(true),
  agentId: z.string(),
  enabled: z.boolean(),
  wake: HeartbeatWakeSchema,
  nextBeatAt: z.string().nullable(),
  skippedReason: z.string().nullable(),
  lastBeats: z.array(
    z.object({
      startedAt: z.string(),
      kind: BeatKindSchema,
      wake: z.string(),
      outcome: BeatOutcomeSchema,
      summary: z.string(),
      raises: z.number().int(),
    })
  ),
  /** Messages to people still held for their hours. The words stay with the owner. */
  held: z.number().int(),
  report: HeartbeatReportStatusSchema,
  measures: HeartbeatMeasuresSchema,
});

/** The capability. */
export const heartbeatStatusCapability = defineCapability({
  id: 'heartbeat.status',
  title: "Read an agent's heartbeat",
  description:
    "Read how an agent works on its own: yours, or any agent's, so a lead can check on its " +
    'reports. Returns how it wakes, its next beat, its last beats (newest first, the record ' +
    'line of each), how many messages to people are held for their hours, its next report, ' +
    'and its measures over `days` (default 7): kept rate, useful-message rate, interruptions ' +
    'per useful outcome, mutes and pauses, and supporting counts. Each measure says what it ' +
    'is counted from and its starting target. A target is a bet to compare against, not a ' +
    'grade. `agentId` defaults to you.',
  tier: 'observe',
  area: null,
  areaNote: "every agent's record of beats is readable by everyone in the space",
  input: z.object({
    agentId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('The agent whose heartbeat to read. Defaults to you.'),
    days: z
      .number()
      .int()
      .min(1)
      .max(MEASURE_WINDOW_MAX_DAYS)
      .optional()
      .describe(`How many days the measures cover (default ${MEASURE_WINDOW_DAYS}).`),
    beats: z
      .number()
      .int()
      .min(1)
      .max(BEATS_MAX)
      .optional()
      .describe(`How many past beats to list (default ${BEATS_DEFAULT}).`),
  }),
  output: z.union([StatusViewSchema, RefusalSchema]),
  surfaces: {
    mcp: {
      toolName: HEARTBEAT_STATUS_TOOL,
      servers: ['in-session', 'external'],
      annotations: { idempotentHint: true },
    },
  },
  invoke: async (_deps, input, context) => {
    if (context.turnStartedByOutsider) {
      return refuse(
        'OUTSIDER_TURN',
        'Heartbeats are read by the team, and this turn was started by someone outside it, ' +
          'so nothing was read.'
      );
    }
    if (!reader) {
      return refuse('NOT_RUNNING', 'Heartbeats are not running on this server yet.');
    }
    const identity = context.identity && !context.identity.inactive ? context.identity : null;
    const agentId =
      input.agentId ?? (identity ? reader.agentIdForPath(identity.agentPath) : undefined);
    if (!agentId) {
      return refuse(
        'NO_AGENT',
        'Name the agent with `agentId`. This chat is not one of your agents.'
      );
    }
    const status = await reader.status(agentId, input.days ?? MEASURE_WINDOW_DAYS);
    if (!status) return refuse('AGENT_NOT_FOUND', `No agent with the id "${agentId}".`);
    return {
      ok: true as const,
      agentId,
      enabled: status.enabled,
      wake: status.wake,
      nextBeatAt: status.nextBeatAt,
      skippedReason: status.skippedReason,
      lastBeats: status.lastBeats.slice(0, input.beats ?? BEATS_DEFAULT).map((beat) => ({
        startedAt: beat.startedAt,
        kind: beat.kind,
        wake: beat.wake,
        outcome: beat.outcome,
        summary: beat.summary,
        raises: beat.raises,
      })),
      held: status.held.length,
      report: status.report,
      measures: status.measures,
    };
  },
});
