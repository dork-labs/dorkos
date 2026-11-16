/**
 * Zod schemas for the team page's list of wakers that cannot wake: every
 * schedule and heartbeat that is switched off or parked, since when, and the
 * person it waits on (DOR-3641, PM scope of Nov 2). A waker that is off can then
 * never go unnoticed.
 *
 * @module shared/waker-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/**
 * Why a waker cannot wake: switched `off`, `waiting` for a person's approval,
 * or `paused` by DorkOS (its file is gone) or by a person (its agent is paused).
 */
export const WakerOffStateSchema = z.enum(['off', 'waiting', 'paused']).openapi('WakerOffState');

/** Why a waker cannot wake. */
export type WakerOffState = z.infer<typeof WakerOffStateSchema>;

/** One schedule or heartbeat that cannot wake now. */
export const WakerOffSchema = z
  .object({
    /** A scheduled task, or an agent's heartbeat. */
    kind: z.enum(['schedule', 'heartbeat']),
    /** The schedule's id, the agent's id for its heartbeat, or `all` for every heartbeat. */
    id: z.string(),
    /** What a person calls it: the schedule's or the agent's name. */
    name: z.string(),
    /** The agent it wakes, or null for a global schedule or every heartbeat. */
    agentId: z.string().nullable(),
    /** Why it cannot wake. */
    state: WakerOffStateSchema,
    /** When it stopped, ISO 8601 UTC, or null when DorkOS does not know. */
    offSince: z.string().nullable(),
    /** The person who can turn it back on: the one its agent reports up to, or who paused it. */
    waitingOn: z.object({
      /** Their account id. */
      accountId: z.string(),
      /** Their name, or null when DorkOS knows them only by id. */
      name: z.string().nullable(),
    }),
  })
  .openapi('WakerOff');

/** One schedule or heartbeat that cannot wake now. */
export type WakerOff = z.infer<typeof WakerOffSchema>;

/** The answer to `GET /api/heartbeats/wakers-off`, longest off first. */
export const WakersOffSchema = z.object({ wakers: z.array(WakerOffSchema) }).openapi('WakersOff');

/** The answer to `GET /api/heartbeats/wakers-off`. */
export type WakersOff = z.infer<typeof WakersOffSchema>;
