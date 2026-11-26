import { z } from 'zod';

/**
 * The front door of a person's DorkOS in the cloud (a hub), and what a hub
 * owes it.
 *
 * Every request for a hub arrives through the hosted front door on the hub's
 * own address (`HubAssignmentSchema`'s `address`), which adds the front-door
 * proof and passes the request on. This file is what both sides agree on
 * beyond that proof: a path prefix that belongs to the front door, how long a
 * hub stays awake after a request, the paths a caller without the owner's
 * sign-in may reach, the front door's cookies, and what a hub's health answer
 * says. The front door's refusals are the `sign_in_required`,
 * `hub_starting_failed` and `hub_unavailable` problems (`ProblemCodeSchema`).
 * What wakes a sleeping hub is in `hub-wake.ts`.
 *
 * **How a path is matched.** Every path here is matched the way
 * `REMOTE_REFUSED_PATHS` is: take the path before the first `?`, decode it
 * once, resolve `.` and `..`, collapse repeated `/`, refuse outright a path
 * that cannot be normalised safely, then compare case-insensitively. An
 * `exact` entry matches that path only; a `prefix` entry matches any path that
 * starts with it.
 *
 * @module front-door
 */

/** One path the front door treats specially: the whole path, or everything under it. */
export type FrontDoorPath = { readonly exact: string } | { readonly prefix: string };

/**
 * The path prefix on a hub's address that belongs to the front door.
 *
 * A request under it is answered by the front door and **never reaches the
 * hub**. A hub must not serve any route under it; one that receives such a
 * request anyway answers it as a path it does not serve. Lower-case, with its
 * trailing `/`.
 */
export const FRONT_DOOR_RESERVED_PATH_PREFIX = '/_dorkos/front-door/' as const;

/**
 * `POST /_dorkos/front-door/wake`, on the hub's own address: a space's wake
 * for a sleeping hub.
 *
 * The front door answers it; it never reaches the hub. Its body, its
 * credential, its answer and its cap are defined by the team spaces contract
 * step that adds the space's wake, not here. Until that step lands, the front
 * door serves nothing at this path.
 */
export const FRONT_DOOR_WAKE_PATH = `${FRONT_DOOR_RESERVED_PATH_PREFIX}wake` as const;

/**
 * How long a hub stays awake after the last request it served: **a hub owes
 * this itself.** Its idle rule never ends its wake within this many seconds of
 * the end of the last request the front door passed to it. The hosted side
 * never ends a hub's wake for being idle, and treats any clean exit as sleep,
 * this floor or not; so it is the hub's own idle rule that keeps it.
 *
 * **Only requests the front door passes on to the hub count.** The health
 * check, and any probe the hosted side or the proxy in front of the hub makes
 * for its own purposes, never count toward this floor and never keep a hub
 * awake.
 *
 * And **never while a request is in flight**: a request is in flight until its
 * response has ended, and an open stream or socket (a computer's relay dial
 * included) is in flight for as long as it is open. A hub may stay awake
 * longer; this is the least, not a schedule.
 */
export const HUB_AWAKE_AFTER_LAST_REQUEST_SECONDS = 60 as const;

/**
 * The paths a caller without the owner's sign-in may reach on an awake hub.
 * Every entry is lower-case.
 *
 * - **Only while the hub is awake.** The front door passes a request for one
 *   of these paths without asking for the owner's sign-in, but only to a hub
 *   that is awake. **It never wakes a hub for one**: while the hub sleeps it
 *   answers `503` with the `hub_unavailable` problem and `Retry-After`. A
 *   computer that must reach a sleeping hub asks for a wake first, with its
 *   own instance key (`POST /v1/instances/hub-wake`). A link code lives only
 *   while the hub that minted it is up, so a link answered `hub_unavailable`
 *   needs a fresh code once the hub is awake.
 * - **Each path checks its own caller.** Passing the front door grants
 *   nothing. The hub checks every request to these paths with that path's own
 *   credential, whoever is signed in: the relay secret of a linked computer
 *   for its dial, the one-time link code for a link. A request that fails that
 *   check is refused by the hub.
 * - **Every other path needs the owner's sign-in.** Apart from these, the
 *   front door's own paths ({@link FRONT_DOOR_RESERVED_PATH_PREFIX}) and the
 *   health check (`GET /api/health`, which the front door passes only for the
 *   hosted side's own reads and refuses from anybody else), a request reaches
 *   the hub only with the owner's sign-in. One without it never reaches the
 *   hub and never wakes it. A top-level page is sent through sign-in
 *   (`sign_in_required`, whether the hub is awake or asleep). Any other such
 *   request, such as a program's request for an agent, is answered
 *   `sign_in_required` while the hub is awake, and `503` with `Retry-After`
 *   (`hub_unavailable`) while it sleeps. A path is added to this list only by
 *   a contract change; a door for a caller who sends to an agent arrives that
 *   way, with its own contract step.
 *
 * The entries:
 *
 * 1. `/api/relay/computer`: a linked computer's relay dial, the WebSocket it
 *    opens to its hub.
 * 2. `/api/hub/link`: a computer redeeming the link code its owner copied from
 *    the hub, the step that makes it a linked computer.
 */
export const FRONT_DOOR_UNSIGNED_PATHS: readonly FrontDoorPath[] = Object.freeze([
  Object.freeze({ exact: '/api/relay/computer' }),
  Object.freeze({ exact: '/api/hub/link' }),
]);

/** The front door's own sign-in cookie on a hub's address. */
export const FRONT_DOOR_COOKIE = '__Host-dorkos-door' as const;

/** The front door's second cookie on a hub's address, which it keeps while a sign-in is under way. */
export const FRONT_DOOR_NONCE_COOKIE = '__Host-dorkos-door-n' as const;

/**
 * The front door's two cookies. They are the front door's and nobody else's:
 * **a hub never logs, forwards, relays or shows either one**, whatever path
 * the request was for. A hub that reads request headers for any reason drops
 * these two cookies first, and never sets a cookie with either name.
 */
export const FRONT_DOOR_COOKIE_NAMES: readonly string[] = Object.freeze([
  FRONT_DOOR_COOKIE,
  FRONT_DOOR_NONCE_COOKIE,
]);

/**
 * The part of a hub's health answer (`GET /api/health`) the hosted side
 * reads. The health answer carries more than this; every other field passes
 * through untouched, so this shape parses any hub's health answer, old or new.
 *
 * `serving` is `true` once the hub holds an assignment it has confirmed
 * (`POST /v1/hubs/self/assignment/confirm`) and serves its owner, and `false`
 * while it does not: pooled, not yet confirmed, or stopped after a fault.
 * **Absent** (a hub from before this field) reads as unknown, never as either
 * answer.
 */
export const HubHealthSchema = z
  .looseObject({
    serving: z
      .boolean()
      .optional()
      .describe(
        'True once the hub holds a confirmed assignment and serves its owner; false while it does not. Absent from an older hub: unknown.'
      ),
  })
  .describe(
    'The part of a hub`s health answer the hosted side reads. Other fields pass through, so an older hub`s answer still parses.'
  );

/** The part of a hub's health answer the hosted side reads. */
export type HubHealth = z.infer<typeof HubHealthSchema>;
