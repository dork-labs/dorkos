import { z } from 'zod';

import { TimestampSchema } from './primitives.js';

/**
 * What wakes a person's DorkOS in the cloud (a hub) while it is asleep, how
 * often each may start it, and what happens when it stops.
 *
 * **When a hub may sleep.** A hub may sleep when nobody is using it, but never
 * within `HUB_AWAKE_AFTER_LAST_REQUEST_SECONDS` of the last request it
 * served, and never while a request is in flight (`front-door.ts` says what
 * counts as in flight). What ends a hub's wake, and what keeps it awake, are in
 * `agent-computers.ts`; this floor holds whatever the hub's own idle rule says.
 *
 * **What wakes it.** Six things, and nothing else:
 *
 * 1. **Its own next-wake time.** The hub says when its next schedule is due
 *    (`PUT /v1/hubs/self/next-wake`, {@link HubNextWakeRequestSchema}), and the
 *    service wakes it then.
 * 2. **A request for it from its signed-in owner**, such as opening the app on
 *    the web. It arrives through the hub's front door as a request for that hub.
 * 3. **A request for an agent that lives on it, from its signed-in owner**,
 *    such as a message sent to that agent. It too arrives through the front door as a request for that hub. The same
 *    request from any other caller wakes nothing: while the hub sleeps it is
 *    answered `503` with `Retry-After` (the `hub_unavailable` problem). Such a
 *    caller carries a credential that only the hub itself issued and can
 *    check, and the front door never holds or checks a credential a hub
 *    issued, so it cannot tell that caller from anybody. Such a caller has no
 *    door through the front door yet, awake or asleep (`FRONT_DOOR_UNSIGNED_PATHS`
 *    says what reaches a hub without the owner's sign-in); a later contract
 *    step adds one, and a way for it to wake the hub.
 * 4. **A request from a computer of its own**, signed with that computer's
 *    own instance key (`POST /v1/instances/hub-wake`,
 *    {@link HubWakeResponseSchema}): a person's own computer, to deliver a
 *    notice or to send or call for one of its owner's published pages; or a
 *    cloud agent computer the hub works with, to deliver facts it owes the
 *    hub or to keep a live run going.
 * 5. **A request for one of its published pages**, on its content host
 *    (`contentHost` in its assignment). A page is public by its link, so this
 *    is the one wake that carries no credential at all. Only a request whose
 *    `Host` is a page's name under the content host counts; it reaches the
 *    hub's page server and nothing else. Past its cap (below), the request
 *    answers `503` with `Retry-After` and the line "This page is starting. Try
 *    again in a minute.", and starts nothing new.
 * 6. **A space's wake**, for a mention of one of the hub's agents in a space
 *    it joined (`POST` to `FRONT_DOOR_WAKE_PATH` on the hub's own address).
 *    It carries the space's wake token, a credential the hosted side issued and
 *    the front door checks, never a person's. Its body and that token are
 *    defined by the team spaces contract step that adds the space's wake.
 *
 * Nothing else a computer does wakes its hub. A computer that wants the hub's
 * list of agents reads it only while the hub is already awake, and the paths
 * in `FRONT_DOOR_UNSIGNED_PATHS` never wake it. **On the hub's own address, an
 * unsigned request never wakes a hub**, nor does a request whose caller the
 * front door cannot check: the owner's wakes carry the owner's sign-in, and a
 * space's wake carries a wake token the front door checks. The content host's
 * capped wake is the only exception, and only for a page.
 *
 * **How often each may start it.** These caps count **starts**, not requests:
 * a request that finds the hub already awake, or already starting, starts
 * nothing and counts toward none of them.
 *
 * - The next-wake time and a space's wake are held to
 *   {@link HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS}: the next-wake time starts a
 *   hub at most once in that interval, and a space's wake starts it at most
 *   once in that interval for each of the space's wake tokens.
 * - The other three reasons, the owner (its request for the hub and for an
 *   agent on it, together), a page read and a computer, are each capped for
 *   each hub on their own: at most {@link HUB_WAKE_STARTS_PER_MINUTE} start a
 *   minute and {@link HUB_WAKE_STARTS_PER_HOUR} an hour for that reason. One
 *   reason reaching its cap never holds back another. Past either, the
 *   request that asked starts nothing new: the owner's is answered `503` with
 *   `Retry-After` (`hub_unavailable`), a page's as its wake above says, and a
 *   computer's as past its own cap (`429`, `rate_limited`). Apart from these, each computer has a cap
 *   of its own on `POST /v1/instances/hub-wake`
 *   ({@link HUB_WAKE_REQUEST_MIN_INTERVAL_SECONDS},
 *   {@link HUB_WAKE_REQUEST_MAX_PER_HOUR}), which counts that computer's
 *   accepted requests, not starts, and applies as well.
 *
 * **A wake grants nothing.** It starts the hub and nothing more: the hub still
 * checks a computer's dial against its own pin, and every other request as it
 * does while awake. For a computer's request, the service checks only that the
 * hub is the caller's own (its account's hub, or the hub a cloud agent
 * computer works for); it never reads the sleeping hub's pins or anything else
 * the hub holds. **The hosted side checks only what it issued itself.**
 *
 * When the front door wakes a hub for a request on the hub's own address (the
 * owner's, or a page read) and the hub does not start, it answers that
 * request `503` with `Retry-After` (the `hub_starting_failed` problem). The
 * other wakes have no waiting request to answer that way: a computer's was
 * already answered `202`, and the next-wake time has none.
 *
 * **When a hub stops.** A hub that exits with status zero is asleep: the
 * service leaves it stopped, never restarted, until one of the six wakes above
 * starts it. A hub that exits with any other status has failed, and the
 * service starts it again, up to {@link HUB_FAILED_EXIT_RESTARTS_MAX} times
 * in a row. A start that brings the hub back to `serving` in its health
 * answer (`HubHealthSchema`) resets that count, and so does a start by a
 * wake. A hub that fails that many times in a row stays stopped, and is
 * started again only by the next wake that is allowed: its owner's request,
 * a page read within its cap, a computer's wake, a space's wake, or its
 * next-wake time. Such a start counts toward that reason's cap like any
 * other, and if it fails too, the restarts begin again from zero; the
 * restarts after a failure count toward no cap.
 */

/**
 * The most times in a row the service starts a hub again after it exits with
 * a status other than zero. After that many failed restarts the hub stays
 * stopped until the next allowed wake. A clean exit (status zero) is sleep and
 * is never restarted.
 */
export const HUB_FAILED_EXIT_RESTARTS_MAX = 3 as const;

/**
 * The most starts one reason may cause for one hub in any minute: the owner's
 * request, a page read, or a computer's wake, each counted on its own. Counts
 * starts, not requests.
 */
export const HUB_WAKE_STARTS_PER_MINUTE = 1 as const;

/**
 * The most starts one reason may cause for one hub in any hour: the owner's
 * request, a page read, or a computer's wake, each counted on its own. Counts
 * starts, not requests.
 */
export const HUB_WAKE_STARTS_PER_HOUR = 30 as const;

/**
 * The shortest gap between two starts of one hub by its next-wake time, and
 * between two starts of one hub by a space's wake on the same wake token. The
 * other wakes have their own caps ({@link HUB_WAKE_STARTS_PER_MINUTE},
 * {@link HUB_WAKE_STARTS_PER_HOUR}).
 */
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
 * front door for that hub. One more answers `503` with `Retry-After`. It is
 * the page read's share of {@link HUB_WAKE_STARTS_PER_MINUTE}, and counts
 * starts, not requests.
 */
export const HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE = HUB_WAKE_STARTS_PER_MINUTE;

/**
 * The most wakes a hub's content host may cause in any hour, counted by the
 * front door for that hub. One more answers `503` with `Retry-After`. It is
 * the page read's share of {@link HUB_WAKE_STARTS_PER_HOUR}, and counts
 * starts, not requests.
 */
export const HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR = HUB_WAKE_STARTS_PER_HOUR;

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
 * - **A cap for each hub.** The hub's computers together start it at most
 *   {@link HUB_WAKE_STARTS_PER_MINUTE} a minute and
 *   {@link HUB_WAKE_STARTS_PER_HOUR} an hour. A request that would start it
 *   past either is answered the same `429` `rate_limited`, even from a
 *   computer within its own cap, with a `retryAfterMs` for whichever cap it
 *   met. A request that finds the hub awake or starting counts toward none.
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
