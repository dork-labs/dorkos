import { z } from 'zod';

import {
  HttpsUrlSchema,
  IdSchema,
  ONE_TIME_CREDENTIAL_META,
  SecretValueSchema,
  TimestampSchema,
} from './primitives.js';

/**
 * Wake passes: how something other than its owner may wake a person's DorkOS
 * in the cloud (a hub) while it sleeps.
 *
 * A hub asks the service for a pass for one named holder and one reason. The
 * service mints it and keeps only what it needs to check it. The hub hands the
 * pass to its holder, and may revoke one pass or all of its passes at any time.
 * The holder presents the pass to the hub's front door, which asks the service
 * to wake the hub.
 *
 * - **The service checks only what it issued.** A pass is the service's own
 *   credential. The service never holds, derives or checks a credential the
 *   hub issued, so a sleeping hub's keys never leave it.
 * - **A pass only wakes.** It grants nothing on the hub. Once the hub is awake,
 *   whatever the holder sends next is checked by the hub with the holder's own
 *   credential, exactly as while it is awake.
 * - **One mechanism.** The holder is a tagged kind with one member today, a
 *   space; the reason is a closed list with one member today, `mention`. A
 *   later use adds a holder kind and a reason here, and never a second way to
 *   wake a hub.
 * - **A space's pass** is minted for one space and handed only to it, and it
 *   wakes one hub and does nothing else. The service cannot tell who presents
 *   a pass; that it serves one space comes from the hub handing it to that
 *   space alone. A hub mints one for each team space it joins whose wake
 *   setting lets members wake it, never for the Community Space. A space never
 *   wakes a person's own computer: only a hub mints passes.
 *
 * Every use of a pass is recorded by the service with the time, the holder and
 * whether it woke the hub, never with the pass's value.
 */

/** Who holds a wake pass. A tagged kind: a later holder is a new member. */
export const WakePassHolderSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('space'),
        spaceUrl: HttpsUrlSchema.describe(
          'The space`s canonical link on its own server. Names the holder; grants nothing.'
        ),
      })
      .describe('A team space the hub joined, which may wake it when an agent there is mentioned.'),
  ])
  .describe('Who holds a wake pass: a tagged kind, so a later holder is a new member.');

/** Who holds a wake pass. */
export type WakePassHolder = z.infer<typeof WakePassHolderSchema>;

/** Why a pass may wake its hub. A closed list: a later reason is a new member. */
export const WakePassReasonSchema = z
  .enum(['mention'])
  .describe('Why a wake pass may wake its hub. A closed list: a later reason is a new member.');

/** Why a pass may wake its hub. */
export type WakePassReason = z.infer<typeof WakePassReasonSchema>;

/**
 * The shortest gap between two wakes one `mention` pass may cause, the same
 * spacing the service keeps for a hub's own next-wake
 * (`HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS`). A request sooner is still answered
 * `202` and wakes nothing.
 */
export const WAKE_PASS_MENTION_MIN_INTERVAL_SECONDS = 300 as const;

/**
 * The longest a wake pass lives, in days from when it was minted. An
 * `expiresAt` later than this, or none, gets a pass that ends at this limit or
 * sooner, so a pass the hub forgets to revoke still stops working.
 */
export const WAKE_PASS_MAX_LIFETIME_DAYS = 30 as const;

/**
 * Where a holder presents its pass: `POST` on the hub's own address, answered
 * by the hub's front door and never passed on to the hub. The reserved prefix
 * it sits under is the front door's own.
 */
export const FRONT_DOOR_WAKE_PATH = '/_dorkos/front-door/wake' as const;

/**
 * `POST /v1/hubs/self/wake-passes` — a hub asks for a wake pass for one holder
 * and one reason. The hub's own instance key only; any other caller is
 * `not_found`. Answered `201` with {@link WakePassMintResponseSchema}.
 *
 * `expiresAt` is when the hub wants the pass to stop working. The service may
 * set an earlier time, never a later one, and answers the time it set; left
 * out, the service picks it. Either way a pass ends within
 * {@link WAKE_PASS_MAX_LIFETIME_DAYS} days of being minted. A time that is
 * not in the future is refused with `malformed_request`. The hub mints a new
 * pass before the old one expires and revokes the old one, so a holder is
 * never left without one.
 */
export const WakePassMintRequestSchema = z
  .object({
    holder: WakePassHolderSchema,
    reason: WakePassReasonSchema,
    expiresAt: TimestampSchema.optional().describe(
      'When the hub wants the pass to stop working. The service may set an earlier time, never a later one, and never more than WAKE_PASS_MAX_LIFETIME_DAYS days after minting.'
    ),
  })
  .describe('Ask for a wake pass for one holder and one reason. Hub instance key only.');

/** Ask for a wake pass. */
export type WakePassMintRequest = z.infer<typeof WakePassMintRequestSchema>;

/**
 * A wake pass the service minted. `pass` is the credential, returned here
 * once and never again: the hub stores it only to hand it to its holder, never
 * logs it and never shows it to a browser. The service keeps only a hash of it,
 * so it cannot hand the pass out again, and a lost pass is revoked and replaced.
 */
export const WakePassMintResponseSchema = z
  .object({
    passId: IdSchema.describe('This pass, for revoking it. Not a credential.'),
    pass: SecretValueSchema.meta({
      description:
        'The pass itself. Returned once. Hand it to the holder; never log it or show it to a browser.',
      [ONE_TIME_CREDENTIAL_META]: true,
    }),
    holder: WakePassHolderSchema,
    reason: WakePassReasonSchema,
    expiresAt: TimestampSchema.describe('When the pass stops working, as the service set it.'),
  })
  .describe(
    'A wake pass the service minted for one holder and one reason. The pass is returned once.'
  );

/** A wake pass the service minted. */
export type WakePassMintResponse = z.infer<typeof WakePassMintResponseSchema>;

/**
 * `POST /_dorkos/front-door/wake` on the hub's own address
 * ({@link FRONT_DOOR_WAKE_PATH}) — a holder asks the front door to wake the
 * hub. The body is the pass and the reason, and nothing else.
 *
 * - **A body that does not parse** (any other field, a reason it does not
 *   know, no pass) answers `400` `malformed_request` and wakes nothing. That
 *   is decided from the body's shape alone, before any pass is looked up, so
 *   it never says anything about a pass.
 * - **Always `202`, with no body,** for a well-formed request, whether or not
 *   it woke anything: an unknown, revoked or expired pass, a pass for another
 *   hub or another reason, a hub already awake, and a request within the
 *   pass's spacing all answer the same. The answer never says which, and it
 *   is sent before any wake begins, so its timing does not say either.
 * - **The spacing** for a `mention` pass is at most one wake every
 *   {@link WAKE_PASS_MENTION_MIN_INTERVAL_SECONDS}, counted for each pass the
 *   service issued, whether or not the hub was already awake: an accepted
 *   request with a valid pass spends that pass's slot. Requests that present
 *   no valid pass are never counted. The spacing is the pass's own, apart from
 *   the gap the service keeps between a hub's own scheduled wakes.
 * - **A wake grants nothing.** The holder then reaches the hub as it does
 *   while the hub is awake, with its own credential.
 */
export const FrontDoorWakeRequestSchema = z
  .strictObject({
    pass: SecretValueSchema.meta({
      description: 'The wake pass the hub handed this holder. Never log it.',
      [ONE_TIME_CREDENTIAL_META]: true,
    }),
    reason: WakePassReasonSchema,
  })
  .describe(
    'Ask the front door to wake this hub with a wake pass. The pass and the reason, nothing else. A well-formed request is answered 202 every time; one that does not parse is 400.'
  );

/** Ask the front door to wake a hub with a wake pass. */
export type FrontDoorWakeRequest = z.infer<typeof FrontDoorWakeRequestSchema>;

/*
 * Revoking:
 *
 * - `DELETE /v1/hubs/self/wake-passes/{passId}` revokes one pass, and
 *   `DELETE /v1/hubs/self/wake-passes` revokes every pass the hub holds. Both
 *   take the hub's own instance key, answer `204`, and answer `204` again for a
 *   pass already revoked, expired or unknown, so a retry is safe. A revoked
 *   pass wakes nothing from the moment the answer is sent.
 * - Ending a hub revokes all of its passes.
 */
