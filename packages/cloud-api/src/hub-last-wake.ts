import { z } from 'zod';

import { IdSchema, TimestampSchema, UNRECOGNISED } from './primitives.js';
import { WakePassHolderSchema, WakePassReasonSchema } from './wake-pass.js';

/**
 * Why a person's DorkOS in the cloud (a hub) was woken.
 *
 * A hub is woken while it is asleep, so it never sees what woke it. It asks
 * the service instead, once it is serving, and writes the answer in its own
 * audit trail: the time, the cause, and for a wake pass the holder and the
 * reason.
 *
 * - **Only the hub, about itself.** The hub's own instance key; any other
 *   caller is `not_found`. The request names no hub.
 * - **The last wake, and only a wake.** It is the last time the service started
 *   the hub from asleep, and the service keeps only that one: a hub woken
 *   again before it read the earlier wake never reads the earlier one. A
 *   request that woke nothing (the hub was awake or already starting, a cap
 *   held, a pass was refused or revoked) is never reported: those are the
 *   service's own to record. A start that was not a wake, such as the hub's
 *   first start, leaves it as it was.
 * - **Audited once.** The hub keeps, across restarts, the last `id` it
 *   audited, and audits a wake only when the `id` it reads is new.
 * - **Recorded before the start.** The service records a wake before it starts
 *   the hub, so a hub that reads this once it is serving reads the wake that
 *   started it. When several requests ask for a sleeping hub at once, the
 *   cause is the one that started it.
 * - **The cause, and nothing about who asked beyond it.** A closed list that
 *   matches the list of what wakes a hub in `hub-wake.ts`. The service never
 *   reads what a request through the front door asks for, so an owner's
 *   request and a message for one of the hub's agents are one cause. It never
 *   carries a pass's value, a caller's address or credential, or the content
 *   of the request that woke the hub.
 * - **A later cause is a new member,** and a hub's release that does not know
 *   it reads it as `unrecognised`, with the wake's `id` and time intact, so it
 *   can still audit that a wake happened.
 */

/** What started a sleeping hub. A closed list: a later cause is a new member. */
export const HubWakeCauseSchema = z
  .discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('next_wake') })
      .describe('Its own next-wake time came due (`PUT /v1/hubs/self/next-wake`).'),
    z
      .object({ kind: z.literal('front_door') })
      .describe(
        'A request for it through its front door: its owner opening it, or a message for an agent that lives on it.'
      ),
    z
      .object({ kind: z.literal('computer') })
      .describe(
        'A request from a computer of its own (`POST /v1/instances/hub-wake`): a person`s own computer, or a cloud agent computer it works with.'
      ),
    z
      .object({ kind: z.literal('content_host') })
      .describe('A request for a page it published, on its content host.'),
    z
      .object({
        kind: z.literal('wake_pass'),
        passId: IdSchema.describe('The pass that woke it, as minted. Not a credential.'),
        holder: WakePassHolderSchema,
        reason: WakePassReasonSchema,
      })
      .describe(
        'A wake pass the hub minted, presented at its front door. Never carries the pass itself.'
      ),
  ])
  .describe('What started a sleeping hub. A closed list: a later cause is a new member.');

/** What started a sleeping hub. */
export type HubWakeCause = z.infer<typeof HubWakeCauseSchema>;

/** The causes this release knows. */
const KNOWN_CAUSES: readonly string[] = HubWakeCauseSchema.options.map(
  (option) => option.shape.kind.value
);

/**
 * A cause as a hub reads it: one its release knows, or `unrecognised` for a
 * kind it does not. A known kind that is malformed is still refused.
 */
const HubWakeCauseReadSchema = z.union([
  HubWakeCauseSchema,
  z
    .object({ kind: z.string().refine((kind) => !KNOWN_CAUSES.includes(kind)) })
    .transform((): { kind: typeof UNRECOGNISED } => ({ kind: UNRECOGNISED }))
    .describe('A cause this release does not know. It reads as unrecognised.'),
]);

/**
 * `GET /v1/hubs/self/last-wake`: why the hub was last woken. The hub's own
 * instance key only; any other caller is `not_found`. Answered `200`.
 *
 * `lastWake` is `null` until the service has woken the hub once.
 */
export const HubLastWakeResponseSchema = z
  .object({
    lastWake: z
      .object({
        id: IdSchema.describe(
          'This wake. The same on every read until the next wake, so the hub audits it once.'
        ),
        at: TimestampSchema.describe(
          'When the service recorded the wake and began starting the hub.'
        ),
        cause: HubWakeCauseReadSchema,
      })
      .nullable()
      .describe('The last time the service started the hub from asleep, or null if never.'),
  })
  .describe(
    'Why the hub was last woken, so it can audit the wake. Hub instance key only; never a pass, an address or anything about a request that woke nothing.'
  );

/** Why the hub was last woken. */
export type HubLastWakeResponse = z.infer<typeof HubLastWakeResponseSchema>;
