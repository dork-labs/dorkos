import { z } from 'zod';

import { TimestampSchema } from './primitives.js';

/**
 * What wakes a person's DorkOS in the cloud (a hub) while it is asleep.
 *
 * A hub may sleep when nobody is using it. Five things wake it, and nothing
 * else does:
 *
 * 1. **Its own next-wake time.** The hub says when its next schedule is due
 *    (`PUT /v1/hubs/self/next-wake`, {@link HubNextWakeRequestSchema}), and the
 *    service wakes it then.
 * 2. **A request for it from its signed-in owner**, such as opening the app on
 *    the web. It arrives through the hub's front door as a request for that hub.
 * 3. **A request for an agent that lives on it**, such as a message sent to
 *    that agent. It too arrives through the front door as a request for that
 *    hub.
 * 4. **A request from a computer of its own**, signed with that computer's
 *    own instance key (`POST /v1/instances/hub-wake`,
 *    {@link HubWakeResponseSchema}): a person's own computer, to deliver a
 *    notice or to send or call for one of its owner's published pages; or a
 *    cloud agent computer the hub works with, to deliver facts it owes the
 *    hub or to keep a live run going.
 * 5. **A request for one of its published pages**, on its content host
 *    (`contentHost` in its assignment). A page is public by its link, so this
 *    is the one wake without a person's credential, and it is capped for each
 *    hub: at most {@link HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE} a minute and
 *    {@link HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR} an hour, counted by the front
 *    door for that hub. Past either, the request answers `503` with
 *    `Retry-After` and the line "This page is starting. Try again in a
 *    minute." Only a request whose `Host` is a page's name under the content
 *    host counts; it reaches the hub's page server and nothing else.
 *
 * Nothing else a computer does wakes its hub. A computer that wants the hub's
 * list of agents reads it only while the hub is already awake. **On the hub's
 * own address, an unsigned request never wakes a hub;** the content host's
 * capped wake is the only exception, and only for a page.
 *
 * A wake grants nothing. It starts the hub and nothing more: the hub still
 * checks a computer's dial against its own pin, and every other request as it
 * does while awake. For a computer's request, the service checks only that the
 * hub is the caller's own (its account's hub, or the hub a cloud agent
 * computer works for); it never reads the sleeping hub's pins or anything else
 * the hub holds.
 *
 * What ends a hub's wake, and what keeps it awake, are in `agent-computers.ts`.
 */

/** The shortest gap the service leaves between two wakes it makes for one hub. */
export const HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS = 300 as const;

/** How far ahead, at most, a hub's next wake may be. One further out is ignored. */
export const HUB_NEXT_WAKE_MAX_AHEAD_DAYS = 31 as const;

/**
 * `PUT /v1/hubs/self/next-wake` — when the hub next has a schedule due, so a
 * hub that is asleep is woken for it. The hub's own instance key only;
 * answered `204` with no body.
 *
 * - The service wakes the hub at `at`, and at most once every
 *   {@link HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS}, however often it is asked. A
 *   hub that wakes sends its next time again before it sleeps.
 * - `at: null` means nothing is due: the service keeps no wake for the hub.
 * - An `at` more than {@link HUB_NEXT_WAKE_MAX_AHEAD_DAYS} days ahead is
 *   **ignored**, not refused: the service keeps no wake for it, as for `null`.
 *   It is ignored because a schema has no clock to refuse it with, and because
 *   a hub whose next schedule really is that far out has done nothing wrong; it
 *   sends the time again the next time it is awake. An `at` in the past wakes
 *   the hub as soon as the interval allows.
 * - It carries a time and nothing else: no agent, no schedule name, no content.
 */
export const HubNextWakeRequestSchema = z
  .object({
    at: TimestampSchema.nullable().describe(
      'When the hub next has a schedule due, or null when nothing is. More than 31 days ahead is ignored.'
    ),
  })
  .describe(
    'When a hub next needs waking for a due schedule. Hub instance key only; answered 204.'
  );

/** When a hub next needs waking. */
export type HubNextWakeRequest = z.infer<typeof HubNextWakeRequestSchema>;

/**
 * The most wakes a hub's content host may cause in any minute, counted by the
 * front door for that hub. One more answers `503` with `Retry-After`.
 */
export const HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE = 1 as const;

/**
 * The most wakes a hub's content host may cause in any hour, counted by the
 * front door for that hub. One more answers `503` with `Retry-After`.
 */
export const HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR = 30 as const;

/**
 * The shortest gap the service leaves between two wakes it accepts from one
 * computer through `POST /v1/instances/hub-wake`. One sooner is
 * `rate_limited`.
 */
export const HUB_WAKE_REQUEST_MIN_INTERVAL_SECONDS = 60 as const;

/**
 * The most wakes the service accepts from one computer through
 * `POST /v1/instances/hub-wake` in any hour. One more is `rate_limited`.
 */
export const HUB_WAKE_REQUEST_MAX_PER_HOUR = 30 as const;

/**
 * The answer to `POST /v1/instances/hub-wake`: a computer of the hub's own
 * (a person's own computer, or a cloud agent computer the hub works with)
 * asks the service to wake the hub. Answered `202`.
 *
 * - **Who may call.** A person's own computer (an instance with the role
 *   `computer`), or a cloud agent computer, each with its own instance key. A
 *   hub, an instance linked to an organization, and a request with no key or a
 *   bad one never wake anything. A request with no key, or a key that is not
 *   valid or was revoked, is `unauthenticated`; a valid key of the wrong kind
 *   is `not_found`.
 * - **Only the caller's own hub.** The request names no hub. For a person's
 *   computer, the service wakes the hub that the calling key's own account
 *   owns; for a cloud agent computer, the hub it works for. No other. A caller
 *   with no such hub is `not_found`.
 * - **A cloud agent computer asks** only when it owes its hub facts or holds a
 *   live run, and its dial to the hub has failed for a minute. The same cap
 *   applies to it as to a person's computer, and the hub still checks its dial
 *   against the hub's own pin.
 * - **Why it may ask.** A person's own computer, to deliver a notice, or to
 *   send a published page's copy to the hub or call on one there; a cloud
 *   agent computer, to deliver facts it owes the hub or keep a live run going.
 *   Nothing else. A computer that
 *   only wants to read the hub's list waits until the hub is awake for another
 *   reason.
 * - **Nothing read, nothing granted.** The service checks only that the hub
 *   is the caller's own, as above. It does not read the hub's pins; the hub
 *   checks the computer's dial against its own pin, as it does today.
 * - **A cap for each computer.** At most one wake every
 *   {@link HUB_WAKE_REQUEST_MIN_INTERVAL_SECONDS} and
 *   {@link HUB_WAKE_REQUEST_MAX_PER_HOUR} an hour for each computer that asks.
 *   Past either, the answer is `429` with the `rate_limited` problem and its
 *   `retryAfterMs`, and the computer keeps what it meant to deliver (a
 *   notice, a page's send, or a cloud agent computer's undelivered facts).
 * - **Accepted is not awake.** `202` says the service will wake the hub, or
 *   that it is already awake. The computer then dials the hub at the address
 *   it pinned, retrying as it does today until the hub answers.
 * - **No body.** The request carries none, and the answer is only when the
 *   service accepted it. A service that does not serve this route answers
 *   `not_found`; the computer then keeps what it meant to deliver until the
 *   hub is awake for another reason.
 */
export const HubWakeResponseSchema = z
  .object({
    acceptedAt: TimestampSchema.describe('When the service accepted the request to wake the hub.'),
  })
  .describe(
    'The service will wake the caller`s own hub, or it is already awake. Answered 202; the instance key of a person`s own computer or of a cloud agent computer the hub works with, only.'
  );

/** The service will wake the caller's own hub. */
export type HubWakeResponse = z.infer<typeof HubWakeResponseSchema>;
