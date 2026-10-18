import { z } from 'zod';

import {
  HttpsUrlSchema,
  IdSchema,
  ONE_TIME_CREDENTIAL_META,
  TimestampSchema,
  tolerantEnum,
} from './primitives.js';
import { RemoteEdgeProofSchema } from './remote.js';

/**
 * A person's own DorkOS in the cloud, and the agent computers it runs agents on.
 *
 * A **hub** is one person's DorkOS: their private space, their agents' brains
 * and the account directory view. It runs no agents. Cloud keeps a warm pool of
 * hubs that belong to nobody; one is **assigned** to a person the first time
 * they open the full app. An **agent computer** is where a cloud agent runs.
 * A hub never holds a hosting supplier's credentials: it asks this service to
 * start or stop its own computers, and the service makes the call, so a hub
 * that is compromised cannot reach anybody else's machines.
 *
 * Every hub and every agent computer is an instance in the `/v1/instances`
 * sense, with its own instance API key. The routes here answer only the
 * caller's own hub and its own account's computers.
 *
 * "Hub" is a word for this wire and for code. Nothing a person reads says it:
 * the app says "Private" or "space".
 *
 * **How an agent computer boots.** The service starts it with three values and
 * nothing else that grants anything:
 *
 * - `DORKOS_SERVER_ROLE=agent-computer`;
 * - its own instance API key, as `DORKOS_AGENT_COMPUTER_INSTANCE_KEY` (sixteen
 *   characters or more), which the server reads once at boot and then drops
 *   from its environment, as a hub does with its own;
 * - `DORKOS_CLOUD_API_URL`, an https origin with no path.
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
 * Where a hub is in being given to a person.
 *
 * `pooled` is a hub nobody owns yet. It refuses every sign-in, so the first
 * visitor never becomes its owner. `assigned` carries the owner and the keys
 * the hub serves with.
 */
export const HubAssignmentStateSchema = z
  .enum(['pooled', 'assigned'])
  .describe('Where a hub is in being given to a person: nobody`s yet, or one person`s.');

/** Where a hub is in being given to a person. */
export type HubAssignmentState = z.infer<typeof HubAssignmentStateSchema>;

/**
 * An https origin and nothing more: no path, query, fragment or user part.
 * `https://hub.example.invalid` passes; `https://hub.example.invalid/x` does
 * not.
 */
export const HttpsOriginSchema = HttpsUrlSchema.refine(
  (value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  },
  { message: 'must be an https origin with no path, query or fragment' }
).describe('An https origin and nothing more: no path, query, fragment or user part.');

/**
 * The sign-in client this service registered for one hub (the "Continue with
 * DorkOS" button on it).
 *
 * A public client: it carries no client secret, so a hub proves nothing with
 * it but the exact redirect address, and runs the code flow with PKCE. One
 * client per hub, registered at assignment.
 */
export const HubSignInClientSchema = z
  .object({
    clientId: IdSchema.describe('The client id this hub presents to the issuer.'),
    redirectUri: HttpsUrlSchema.describe(
      'The one redirect address registered for this client, matched exactly. It is on the hub`s own address.'
    ),
  })
  .describe(
    'The sign-in client registered for one hub. Public: no secret, PKCE, one exact redirect address.'
  );

/** The sign-in client registered for one hub. */
export type HubSignInClient = z.infer<typeof HubSignInClientSchema>;

/**
 * `GET /v1/hubs/self/assignment` — who this hub belongs to, and the keys it
 * serves with. Hub instance API key only; any other caller is `not_found`.
 *
 * A pooled hub reads `{ state: 'pooled' }` and keeps refusing every sign-in.
 * It reads again when a `hub_assignment_changed` command arrives (the service
 * sends one at assignment), and otherwise every `pollAfterSeconds`. A hub that
 * cannot read its assignment, or reads a state this release does not know,
 * acts as pooled: it refuses every sign-in. An assigned hub reads its owner and
 * its keys:
 *
 * - `ownerAccountId` and `issuer` are the only way the hub knows its owner. A
 *   sign-in is the owner when the issuer is exactly `issuer` and the subject is
 *   exactly `ownerAccountId`. **Never match the owner by email.**
 * - `address` is the hub's one origin. The hub answers to that exact host and
 *   nothing else.
 * - `frontDoorProof` is the header the front door adds to every request it
 *   passes on. It works exactly like a managed remote edge proof
 *   (`RemoteEdgeProofSchema`): refuse any request without exactly one copy
 *   carrying the secret, before any other handling, then strip it.
 *
 * The hub makes its own auth secret when it takes the assignment. The service
 * never sends one and never holds one.
 *
 * The keys are new for each assignment, so a hub that was pooled holds nothing
 * a person's traffic could use. The hub confirms what it applied with
 * `POST /v1/hubs/self/assignment/confirm`, and the front door sends a person's
 * traffic only once it has.
 *
 * **The owner never changes.** An assigned hub is never reassigned. Once a hub
 * has confirmed, `ownerAccountId` and `issuer` stay as they are; a later read
 * may change only the address, the proof and the sign-in client, under a new
 * `assignmentId`. A read naming a different owner or issuer is a fault: the
 * hub refuses it and stops serving, and never serves the new owner from the
 * old owner's data.
 *
 * **Replacing the proof overlaps.** When the service replaces the front-door
 * proof it sends `hub_assignment_changed`, so an awake hub reads again at
 * once; a hub that was asleep reads on waking. The front door keeps sending
 * the old proof until the hub confirms the new `assignmentId`. The hub accepts
 * the new proof once it has read it, and the old one until
 * `REMOTE_EDGE_PROOF_OVERLAP_SECONDS` after it confirms. An ended assignment
 * reads `not_found`: the hub stops serving.
 *
 * **The secret can be read again, by this hub alone.** Unlike a remote
 * credential, this read repeats, because a hub that restarts must serve again.
 * It still carries the one-time marker: never log it, never relay it, never
 * return it to a browser.
 */
export const HubAssignmentSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('pooled'),
        pollAfterSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'How long to wait before reading again when no command arrives. Absent leaves the wait to the hub.'
          ),
      })
      .describe('Nobody owns this hub yet. Refuse every sign-in.'),
    z
      .object({
        state: z.literal('assigned'),
        assignmentId: IdSchema.describe(
          'This assignment. Echo it to confirm; a different one means the address, proof or sign-in client changed, never the owner.'
        ),
        assignedAt: TimestampSchema,
        ownerAccountId: IdSchema.describe(
          'The owner`s account id at `issuer`: the subject a sign-in must carry. Never an email.'
        ),
        issuer: HttpsUrlSchema.describe(
          'The one issuer whose sign-ins this hub accepts, compared exactly.'
        ),
        address: HttpsOriginSchema.describe(
          'The hub`s one origin, with no path. Answer to this exact host and nothing else.'
        ),
        frontDoorProof: RemoteEdgeProofSchema.describe(
          'The header the front door adds to every request it passes on, and the secret it carries. Same rules as a remote edge proof.'
        ),
        signIn: HubSignInClientSchema.optional().describe(
          'The sign-in client registered for this hub. Absent until the service registers one.'
        ),
      })
      .describe(
        'This hub is one person`s, and never anybody else`s: an assigned hub is never reassigned. Serve only them, at this address, behind this proof.'
      ),
  ])
  .describe(
    'Who a hub belongs to, and the keys it serves with. Hub instance API key only; never cached by a proxy.'
  );

/** Who a hub belongs to, and the keys it serves with. */
export type HubAssignment = z.infer<typeof HubAssignmentSchema>;

/**
 * `POST /v1/hubs/self/assignment/confirm` — the hub applied this assignment.
 *
 * A stale `assignmentId` is `conflict`: the hub reads its assignment again. A
 * `signingPublicKey` different from the one the service already holds for
 * this hub is `precondition_failed`: the service keeps the key it holds,
 * refuses the confirmation and raises an alert, and the hub stops serving for
 * good, since it no longer holds the key its owner's Macs trust.
 */
export const HubAssignmentConfirmRequestSchema = z
  .object({
    assignmentId: IdSchema.describe('The assignment the hub now serves with.'),
    signingPublicKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'must be base64url of exactly 32 bytes, unpadded')
      .optional()
      .describe(
        'The public half of the hub`s own Ed25519 signing key: base64url of the raw 32 bytes, 43 characters, no padding. The hub makes the pair before its first confirmation and never replaces it, so it sends the same key every time; a Mac pins it at pairing and checks the hub`s relay handshakes with it. Optional so an older hub still confirms.'
      ),
  })
  .describe(
    'Tell the service the hub now serves with this assignment`s owner, address and proof. A stale id is `conflict`.'
  );

/** Tell the service the hub now serves with this assignment. */
export type HubAssignmentConfirmRequest = z.infer<typeof HubAssignmentConfirmRequestSchema>;

/** When the service recorded the confirmation. */
export const HubAssignmentConfirmResponseSchema = z
  .object({
    confirmedAt: TimestampSchema,
  })
  .describe('When the service recorded that the hub serves with this assignment.');

/** When the service recorded the confirmation. */
export type HubAssignmentConfirmResponse = z.infer<typeof HubAssignmentConfirmResponseSchema>;

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
