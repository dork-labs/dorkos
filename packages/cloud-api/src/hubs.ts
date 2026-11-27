import { z } from 'zod';

import {
  HttpsUrlSchema,
  IdSchema,
  ONE_TIME_CREDENTIAL_META,
  TimestampSchema,
  tolerantEnum,
} from './primitives.js';
import { HttpsOriginSchema } from './hub-assignment.js';

/**
 * A person's own DorkOS in the cloud, and the agent computers it runs agents on.
 *
 * A **hub** is a person's DorkOS in the cloud. For a person with no computer
 * of their own it is the home of their private space; for a person with one,
 * that computer is the home and the hub is their way in. Either way it is the
 * home of the agents they run on cloud agent computers. It runs no agents
 * itself. Cloud keeps a warm pool of hubs that belong to nobody; one is
 * **assigned** to a person the first time they open the full app. An **agent
 * computer** is where a cloud agent runs.
 * A hub never holds a hosting supplier's credentials: it asks this service to
 * start or stop its own computers, and the service makes the call, so a hub
 * that is compromised cannot reach anybody else's machines.
 *
 * Every hub and every agent computer is an instance in the `/v1/instances`
 * sense, with its own instance API key. The routes here answer only the
 * caller's own hub and its own account's computers.
 *
 * "Hub" is a word for this wire and for code. Nothing a person reads says it:
 * the app says "your DorkOS in the cloud", or "Private" where it is the home of
 * the private space.
 *
 * What wakes a hub that is asleep, and its next-wake time, are in
 * `hub-wake.ts`.
 *
 * **How an agent computer boots.** The service starts it with three values and
 * nothing else that grants anything:
 *
 * - `DORKOS_SERVER_ROLE=agent-computer`;
 * - `DORKOS_AGENT_COMPUTER_INSTANCE_KEY_FILE`, the path of a file holding its
 *   own instance API key (sixteen characters or more). The service mounts the
 *   file readable and writable by its owner only, owned by the user the DorkOS
 *   server runs as, and passes only the path. The key itself is never in the
 *   environment: Linux keeps a process's startup environment readable by any
 *   process of the same user, so the server refuses to start if
 *   `DORKOS_AGENT_COMPUTER_INSTANCE_KEY` is set at all, or if the file can be
 *   read by anyone but its owner;
 * - `DORKOS_CLOUD_API_URL`, an https origin with no path.
 *
 * **Two users.** The DorkOS server runs as the user that owns the key file.
 * Agents, their shells and package code run as a different user, which can
 * read neither the key file nor the server's process: it cannot signal the
 * server or trace it. The model gateway grant the server hands its own agent
 * runtime gets the same treatment. Hiding other users' processes from `/proc`
 * is optional extra hardening on top, never the fix.
 *
 * Its volume is owned by root. It exits cleanly (status zero) within five
 * seconds of SIGINT, so a stop never has to be forced. Its image is public and signed, so
 * anybody can check what runs their agents.
 *
 * **Where an agent computer may reach.** The public internet, its own hub
 * through the hub's front door (never directly), and the model gateway. Never
 * the hosting supplier's private network (other machines, even the same
 * account's), a cloud metadata address, any private address range, or
 * anything on this service except the public `/v1` API. A computer reaches its
 * hub the way a person's Mac does, so it holds nothing a Mac does not. The
 * service's network policy enforces this, outside the computer; the
 * computer's own settings are not relied on.
 *
 * **How an agent computer links to its hub.** The hub mints a one-time link
 * code and hands it to the service (`POST /v1/computers/{computerId}/link-code`).
 * The computer reads it once in its assignment
 * (`GET /v1/agent-computers/self/assignment`) and redeems it at its hub, which
 * pins the public half of the computer's own signing key, as it does for a
 * Mac. The service only carries the code; it never vouches for a key.
 */

/**
 * Where a cloud agent computer is in its life.
 *
 * Tolerant on the wire (see {@link CloudComputerSchema}), so a state added in a
 * later release reads as `unrecognised` rather than failing a whole list.
 */
export const CloudComputerStateSchema = z
  .enum(['starting', 'running', 'stopping', 'stopped', 'failed'])
  .describe('Where a cloud agent computer is in its life.');

/** Where a cloud agent computer is in its life. */
export type CloudComputerState = z.infer<typeof CloudComputerStateSchema>;

/**
 * Why a cloud agent computer is stopped, so the app can say so.
 *
 * `requested` (its hub or its owner stopped it), `idle` (nothing was due),
 * `out_of_credits` (shown read-only, data kept), `held` (the account is on
 * hold), `suspended` (this one computer was switched off by the service; its
 * `reasonText` says why). Names no allowance and no price.
 */
export const CloudComputerStopReasonSchema = z
  .enum(['requested', 'idle', 'out_of_credits', 'held', 'suspended'])
  .describe('Why a cloud agent computer is stopped, in terms the app can show.');

/** Why a cloud agent computer is stopped. */
export type CloudComputerStopReason = z.infer<typeof CloudComputerStopReasonSchema>;

/** One cloud agent computer the caller's account owns. */
export const CloudComputerSchema = z
  .object({
    id: IdSchema.describe('This computer. Stable across starts and stops.'),
    instanceId: IdSchema.nullable().describe(
      'The instance id the computer reports under once it has first booted, or null before then.'
    ),
    displayName: z.string().describe('The name to show for this computer.'),
    state: tolerantEnum(CloudComputerStateSchema).describe(
      'Where the computer is now. A state this release does not know reads as unrecognised.'
    ),
    stopReason: tolerantEnum(CloudComputerStopReasonSchema)
      .nullable()
      .describe('Why it is stopped, or null when it is not.'),
    reasonText: z
      .string()
      .optional()
      .describe(
        'The service`s own words about why it is stopped, to show as given. Absent when there is nothing to add.'
      ),
    createdAt: TimestampSchema,
    stateChangedAt: TimestampSchema.describe('When `state` last changed.'),
  })
  .describe('One cloud agent computer the caller`s account owns.');

/** One cloud agent computer the caller's account owns. */
export type CloudComputer = z.infer<typeof CloudComputerSchema>;

/**
 * `GET /v1/computers` — the caller's account's cloud agent computers.
 *
 * Who may call each computer route: the person, or the account's own hub (its
 * instance key). Never an agent computer's key, and never a person's own
 * computer's key: making or starting a computer spends money. Any other caller
 * is `not_found`. Deleting is the person's alone, and handing over a link code
 * (`link-code`) is the hub's alone.
 */
export const CloudComputerListResponseSchema = z
  .object({
    items: z.array(CloudComputerSchema),
  })
  .describe('Every cloud agent computer the caller`s account owns. An account with none gets []');

/** Every cloud agent computer the caller's account owns. */
export type CloudComputerListResponse = z.infer<typeof CloudComputerListResponseSchema>;

/**
 * `POST /v1/computers` — make a cloud agent computer for the caller's account.
 *
 * Retry-safe by `idempotencyKey`, scoped to the caller: a repeat answers the
 * same computer with `replayed: true`. A refusal a larger allowance or a card
 * would lift is `entitlement_required`, with the service's own words.
 */
export const CloudComputerCreateRequestSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe('A key you choose, one per computer you mean to make.'),
    displayName: z.string().min(1).max(100).optional(),
  })
  .describe('Make a cloud agent computer for the caller`s account.');

/** Make a cloud agent computer. */
export type CloudComputerCreateRequest = z.infer<typeof CloudComputerCreateRequestSchema>;

/** The computer a create made, or the one an earlier create with the same key made. */
export const CloudComputerCreateResponseSchema = z
  .object({
    computer: CloudComputerSchema,
    replayed: z.boolean().describe('True when an earlier request with this key made it.'),
  })
  .describe('The computer a create made, or the one an earlier create with the same key made.');

/** The computer a create made. */
export type CloudComputerCreateResponse = z.infer<typeof CloudComputerCreateResponseSchema>;

/**
 * The answer to `POST /v1/computers/{computerId}/start` and `/stop`.
 *
 * Both answer at once with the state the computer is moving to; the computer
 * gets there on its own. Starting a running computer, or stopping a stopped
 * one, is not an error: it answers the computer as it is. Only the account's
 * own hub (its instance key) or the account's own person may call either.
 */
export const CloudComputerTransitionResponseSchema = z
  .object({
    computer: CloudComputerSchema,
  })
  .describe('The computer as it is after a start or stop was accepted.');

/** One computer after a start or stop was accepted. */
export type CloudComputerTransitionResponse = z.infer<typeof CloudComputerTransitionResponseSchema>;

/**
 * Why a hub starts a computer, for metering only.
 *
 * `turn` (an agent has work to do), `viewer` (somebody opened one of its
 * chats), `beat` (a scheduled beat is due). Tolerant on the wire, so a reason
 * added later reads as `unrecognised` rather than refusing the start.
 */
export const CloudComputerStartReasonSchema = z
  .enum(['turn', 'viewer', 'beat'])
  .describe('Why a hub starts a computer: a turn, a viewer, or a beat. For metering only.');

/** Why a hub starts a computer. */
export type CloudComputerStartReason = z.infer<typeof CloudComputerStartReasonSchema>;

/**
 * The optional body of `POST /v1/computers/{computerId}/start`.
 *
 * The body is optional, and so is `reason`: a start with no body, as every
 * caller before this field sent, starts the computer the same way. The reason
 * is recorded for metering and changes nothing about the start.
 */
export const CloudComputerStartRequestSchema = z
  .object({
    reason: tolerantEnum(CloudComputerStartReasonSchema)
      .optional()
      .describe(
        'Why the computer is started, for metering. A reason this release does not know reads as unrecognised. Absent says nothing.'
      ),
  })
  .describe('Start a cloud agent computer, optionally saying why. The body may be left out.');

/** The optional body of a start. */
export type CloudComputerStartRequest = z.infer<typeof CloudComputerStartRequestSchema>;

/**
 * `POST /v1/instances/{instanceId}/viewer-open` — ask one of the caller's own
 * computers to dial its hub, because somebody opened one of its chats.
 *
 * Called by the account's hub (its instance key). The service sends a
 * `viewer_open` command on that computer's command stream. The command carries
 * no address: the computer dials only the hub address and key it pinned when
 * its owner turned this on. A computer that is not the caller's account's is
 * `not_found`, so the answer never says whether it exists.
 *
 * At most one `viewer_open` waits per computer: asking again while one waits
 * answers that one, with its `commandId`, rather than queueing another. One
 * not acknowledged by its `expiresAt` is dropped, never retried.
 */
export const ViewerOpenResponseSchema = z
  .object({
    commandId: IdSchema.describe(
      'The command waiting for the computer: the `id` it will see on its stream.'
    ),
    queuedAt: TimestampSchema,
  })
  .describe('The service queued a viewer-open command for the computer.');

/** The service queued a viewer-open command. */
export type ViewerOpenResponse = z.infer<typeof ViewerOpenResponseSchema>;

/**
 * The answer to `DELETE /v1/computers/{computerId}`: the computer, its disk
 * and its snapshots are gone.
 *
 * The person only (never a hub key), with a recent sign-in; an older sign-in
 * is `forbidden`, and the app asks the person to sign in again. Cannot be
 * undone. Deleting a computer that is already gone answers the same.
 */
export const CloudComputerDeletedResponseSchema = z
  .object({
    deletedAt: TimestampSchema,
  })
  .describe('When the computer, its disk and its snapshots were deleted. Cannot be undone.');

/** When a computer was deleted. */
export type CloudComputerDeletedResponse = z.infer<typeof CloudComputerDeletedResponseSchema>;

/** How long an agent computer's link code works, at most, after its hub mints it. */
export const AGENT_COMPUTER_LINK_CODE_TTL_SECONDS = 600 as const;

/**
 * How far the service lets a link code's `expiresAt` run past
 * {@link AGENT_COMPUTER_LINK_CODE_TTL_SECONDS} from when the service received
 * it, for a hub whose clock runs a little ahead. The service sees when it
 * received the code, never when the hub minted it, so it refuses only an
 * `expiresAt` later than receipt plus both. A hub mints at the TTL, never more.
 */
export const AGENT_COMPUTER_LINK_CODE_CLOCK_SKEW_SECONDS = 60 as const;

/**
 * A one-time code an agent computer links to its hub with.
 *
 * The hub mints it, in the same format as the code a person's own computer
 * links with: sixteen characters of uppercase Crockford base-32 (the digits and
 * the capital letters, without `I`, `L`, `O` or `U`), eighty bits. This wire
 * carries it canonical, with no spaces, dashes or host.
 *
 * - **Single use**, and it works for at most
 *   {@link AGENT_COMPUTER_LINK_CODE_TTL_SECONDS} after the hub minted it. An
 *   `expiresAt` further out than that is refused with `malformed_request` by
 *   the service. The schema does not check it, because a schema has no clock:
 *   a check against "now" would make the same payload pass or fail depending
 *   on when it was parsed.
 * - **Bound to one computer.** The hub mints it for one `computerId` and, when
 *   it is redeemed, checks both the code and that the computer redeeming it is
 *   that one.
 * - **One live code per computer.** Handing the service a new one replaces the
 *   old one.
 * - **Handed out once.** The service deletes it as soon as the computer has
 *   read it, and never logs it.
 */
export const AgentComputerLinkCodeSchema = z
  .object({
    code: z
      .string()
      .regex(
        /^[0-9A-HJKMNP-TV-Z]{16}$/,
        'must be 16 characters of uppercase Crockford base32, with no spaces or dashes'
      )
      .meta({
        description:
          'The code itself: 16 characters of uppercase Crockford base32, 80 bits. Single use. Never log it or return it to a browser.',
        [ONE_TIME_CREDENTIAL_META]: true,
      }),
    expiresAt: TimestampSchema.describe(
      'When the code stops working: at most ten minutes after the hub minted it.'
    ),
  })
  .describe(
    'A one-time code an agent computer links to its hub with. Single use, ten minutes at most, bound to one computer.'
  );

/** A one-time code an agent computer links to its hub with. */
export type AgentComputerLinkCode = z.infer<typeof AgentComputerLinkCodeSchema>;

/**
 * `POST /v1/computers/{computerId}/link-code` — the hub hands the service the
 * link code it minted for one of its account's agent computers. Answered `204`
 * with no body.
 *
 * The account's hub (its instance key) only. The service also checks that the
 * computer belongs to the hub's account; a computer that is not the account's
 * is `not_found`, so the answer never says whether it exists. A new code
 * replaces the computer's old one, and the computer reads it at its next
 * assignment read (`agent_computer_assignment_changed` asks it to read now).
 */
export const AgentComputerLinkCodeRequestSchema = AgentComputerLinkCodeSchema.describe(
  'The link code a hub minted for an agent computer on its account. Hub instance key only; answered 204.'
);

/** The link code a hub hands the service for one computer. */
export type AgentComputerLinkCodeRequest = z.infer<typeof AgentComputerLinkCodeRequestSchema>;

/**
 * `GET /v1/agent-computers/self/assignment` — which hub this agent computer
 * works for, and the code it links with. That computer's own instance key
 * only; any other caller is `not_found`.
 *
 * - `hubOrigin` is where the computer reaches its hub, through the hub's front
 *   door. It may change; the hub's key, pinned when the computer linked, does
 *   not.
 * - `ownerAccountId` and `issuer` name the person the hub belongs to, the same
 *   way `HubAssignmentSchema` does. They never change for a computer. A read
 *   naming a different owner or issuer is a fault: the computer refuses it and
 *   stops working.
 * - `linkCode` is the one-time code to redeem at the hub, or null when there is
 *   none waiting. The service hands each code out once, then deletes it, so a
 *   later read is null.
 *
 * **The service never vouches for the computer's key.** The computer makes its
 * own signing key pair and sends the public half when it redeems the code; the
 * hub pins it then, as it does for a Mac. So a code that was already used is
 * worthless to anybody who reads it later.
 *
 * **An accepted risk.** The service holds the live code until the computer
 * reads it, so someone inside the service could redeem it first, with a key
 * of their own. That is accepted: the service already runs this computer. The
 * hub treats a second redeem for a computer that is already linked as a
 * security event: it unlinks the computer, tells the person, and mints a new
 * code.
 *
 * The computer reads again when an `agent_computer_assignment_changed` command
 * arrives, and otherwise every `pollAfterSeconds`.
 */
export const AgentComputerAssignmentSchema = z
  .object({
    computerId: IdSchema.describe('This computer, as the hub and `GET /v1/computers` name it.'),
    hubOrigin: HttpsOriginSchema.describe(
      'Where this computer reaches its hub: an https origin with no path, through the hub`s front door.'
    ),
    ownerAccountId: IdSchema.describe(
      'The account id, at `issuer`, of the person the hub belongs to. Never an email, and never changes.'
    ),
    issuer: HttpsUrlSchema.describe('The issuer `ownerAccountId` belongs to, compared exactly.'),
    linkCode: AgentComputerLinkCodeSchema.nullable().describe(
      'The one-time code to redeem at the hub, or null when none is waiting. Handed out once.'
    ),
    pollAfterSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'How long to wait before reading again when no command arrives. Absent leaves the wait to the computer.'
      ),
  })
  .describe(
    'Which hub an agent computer works for, and the code it links with. That computer`s instance key only; never cached by a proxy.'
  );

/** Which hub an agent computer works for, and the code it links with. */
export type AgentComputerAssignment = z.infer<typeof AgentComputerAssignmentSchema>;

/** How long an agent computer's `busy: true` holds without being sent again. */
export const AGENT_COMPUTER_BUSY_TTL_SECONDS = 600 as const;

/**
 * The longest an agent computer runs without a break, however often it says
 * it is busy: six hours. Past it the service stops the computer and tells the
 * owner, whatever `busy` says.
 */
export const AGENT_COMPUTER_BUSY_MAX_SECONDS = 21600 as const;

/**
 * `PUT /v1/agent-computers/self/activity` — whether this agent computer is in
 * the middle of work. That computer's own instance key only; answered `204`
 * with no body.
 *
 * - **Busy expires.** `busy: true` holds for
 *   {@link AGENT_COMPUTER_BUSY_TTL_SECONDS} unless it is sent again, so a turn
 *   that crashed cannot keep a computer running forever. A computer that is
 *   still working sends it again before then.
 * - **A hard cap still applies.** After {@link AGENT_COMPUTER_BUSY_MAX_SECONDS}
 *   of running without a break the service stops the computer and tells the
 *   owner, whatever `busy` says.
 * - **Idle stop.** The service stops a computer for being idle only once its
 *   idle window has passed with `busy` false or expired.
 */
export const AgentComputerActivityRequestSchema = z
  .object({
    busy: z
      .boolean()
      .describe(
        'True while the computer is in the middle of work. Holds for ten minutes unless sent again.'
      ),
  })
  .describe(
    'Whether an agent computer is in the middle of work. That computer`s instance key only; answered 204.'
  );

/** Whether an agent computer is in the middle of work. */
export type AgentComputerActivityRequest = z.infer<typeof AgentComputerActivityRequestSchema>;
