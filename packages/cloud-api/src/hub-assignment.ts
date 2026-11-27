import { z } from 'zod';

import { HttpsUrlSchema, IdSchema, TimestampSchema } from './primitives.js';
import { RemoteEdgeProofSchema } from './remote.js';

/*
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
 * sense, with its own instance API key. The routes in this file answer only
 * the caller's own hub.
 *
 * "Hub" is a word for this wire and for code. Nothing a person reads says it:
 * the app says "your DorkOS in the cloud", or "Private" where it is the home of
 * the private space.
 *
 * What wakes a hub that is asleep, and its next-wake time, are in
 * `hub-wake.ts`. Agent computers, how they boot, link and report being busy,
 * are in `agent-computers.ts`.
 *
 * This file holds a hub's assignment: who it belongs to, and the keys it
 * serves with (`GET /v1/hubs/self/assignment` and its confirmation).
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
 * A host name a hub serves published pages under: lower-case letters, digits
 * and hyphens in two or more dot-separated labels, with no scheme, port, path
 * or trailing dot. `pages.example.invalid` passes; `https://pages.example.invalid`
 * and `Pages.Example.Invalid` do not.
 *
 * The grammar is all a schema can check. The hub checks the rest before it
 * serves a page (see `contentHost` on {@link HubAssignmentSchema}).
 */
export const ContentHostSchema = z
  .string()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'must be a lower-case host name of two or more labels, with no scheme, port or path'
  )
  .describe(
    'A lower-case host name a hub serves published pages under. No scheme, port, path or trailing dot.'
  );

/** A host name a hub serves published pages under. */
export type ContentHost = z.infer<typeof ContentHostSchema>;

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
 *
 * **Home or way in, decided once.** `privateSpaceHome` says whether this hub
 * is the home of its owner's private space (`true`) or their way in (`false`).
 * It is `true` when no computer of the person's own (an instance with the role
 * `computer`) was registered to the account when the hub was first assigned,
 * and `false` when one was. The service decides it once, at that first
 * assignment, and never changes it, except by a later move of the whole
 * space. For a hub assigned before this field existed, the service decides it
 * the same way, from the account's instances with the role `computer`
 * registered before that assignment. Linking or unlinking a computer never
 * changes it. **A computer linked to an organization never counts**, whoever
 * sits at it: it cannot read the account's directory and cannot wake or dial
 * the hub, so it could never be the home the hub would be a way in to. A
 * person whose only computer is an organization's has a hub that is their
 * home and works alone. The hub keeps the first value it reads and never reads it
 * again. **Absent** (a service from before this field) means the hub has not
 * recorded anything yet: it keeps behaving as it did before the field existed
 * until a read carries a value.
 *
 * **Published pages, on a host of their own.** `contentHost` is the host name
 * this hub serves its owner's published pages under: each page answers over
 * https on its own origin, `<link key>.<contentHost>`, a site of its own,
 * apart from the app.
 * The hub uses it only when all four of these hold, and otherwise serves no
 * pages:
 *
 * 1. its registrable domain, by the Public Suffix List's public section, is
 *    not one of the product's own domains;
 * 2. that registrable domain is not the hub's `address`'s, nor `issuer`'s;
 * 3. it is neither under nor above the hub's `address` host;
 * 4. it has its own explicit rule in the Public Suffix List, found as a
 *    listed rule and never by the list's default rule for an unknown name, so
 *    each `<link key>.<contentHost>` is a site of its own.
 *
 * The front door serves every name under `contentHost`, over https only, and
 * passes each request to
 * this hub only, with the same front-door proof and the `Host` unchanged. The
 * hub admits a request whose `Host` is under `contentHost` to its page server
 * and nothing else. The front door adds nothing to a page's answer: no
 * cookie, no shared caching of an answer the hub marked `private`, and no
 * header that loosens the hub's own.
 *
 * The service keeps no copy of a page's files and serves none while the hub
 * sleeps: every request for a page reaches the hub, and a sleeping hub is
 * woken for it, within the cap in `hub-wake.ts`. So taking a page down,
 * private pages and passwords stay the hub's alone, and the first view after
 * a sleep waits for the wake. **Absent** (a service from before this field,
 * or one with no content host for this hub) means the hub serves no pages. A
 * value that is not a well-formed host name reads as absent, so it costs the
 * hub its pages and nothing else.
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
        privateSpaceHome: z
          .boolean()
          .optional()
          .describe(
            'True when this hub is the home of its owner`s private space (no computer of their own was registered to the account when it was first assigned; a computer linked to an organization never counts); false when it is their way in. Decided once, never changed by linking or unlinking a computer. The hub keeps the first value it reads. Absent from an older service: the hub records nothing and behaves as before until a read carries a value.'
          ),
        contentHost: ContentHostSchema.optional()
          .catch(undefined)
          .describe(
            'The host name this hub serves its owner`s published pages under, each at `<link key>.<contentHost>`. The hub checks it before use (its own Public Suffix List rule, apart from the product`s and the hub`s own domains). Absent, or not a well-formed host name: the hub serves no pages.'
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
