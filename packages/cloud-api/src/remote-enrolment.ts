/**
 * Consent to managed remote access: the enrolment record, how it is
 * withdrawn, and the request a machine makes so a person can approve it.
 *
 * Its own module so `remote.ts` stays about the tunnel itself. Every row here
 * is re-exported from the package root, beside the rest of `/v1/remote`.
 *
 * @module remote-enrolment
 */
import { z } from 'zod';

import { HttpsUrlSchema, IdSchema, TimestampSchema } from './primitives.js';

/**
 * `POST /v1/remote/enrolment?instanceId=…` — the person`s consent to managed
 * remote access, given on the service`s own pages.
 *
 * Accepted only from a person`s browser session: a person bearer token and an
 * instance API key are both refused, because the record says a person chose
 * this. The request has no body; the `instanceId` query parameter names the
 * machine. The person needs a seat in the organization the machine is linked
 * to (`forbidden` otherwise) and must have agreed to the service`s current
 * terms (`precondition_failed`, with an `actionUrl` to agree). A machine that
 * is already enrolled is refused with `conflict`: withdraw first to agree
 * again.
 *
 * The same record is the answer to an approved enrolment request: see
 * {@link RemoteEnrolmentRequestSchema} for how a person at the machine starts
 * one, and {@link RemoteEnrolmentRequestStatusSchema} for how the machine
 * learns it was approved.
 */
export const RemoteEnrolmentSchema = z
  .object({
    enrolmentId: IdSchema,
    consentVersion: z.string().describe('Which version of the consent text the person agreed to.'),
    enrolledAt: TimestampSchema,
  })
  .describe('A person`s consent to managed remote access. Only a person`s session can create one.');

/** A person`s consent to managed remote access. */
export type RemoteEnrolment = z.infer<typeof RemoteEnrolmentSchema>;

/**
 * `DELETE /v1/remote/enrolment` — withdraw consent, by the instance or by a
 * person.
 *
 * Two callers are accepted, and either one is enough:
 *
 * - **The instance, with its own API key.** It withdraws that instance`s own
 *   enrolment and no other: the instance is the one the key belongs to, and an
 *   `instanceId` in the query is ignored. Accepted because a consent that can
 *   only be withdrawn through the service that benefits from it is not consent.
 *   An instance withdraws locally first and does not wait for this call.
 * - **A person`s browser session**, with `?instanceId=…` naming the machine
 *   (`malformed_request` without it). The person needs a seat in the
 *   organization the machine is linked to (`forbidden` otherwise). A person
 *   bearer token is not accepted.
 *
 * Either way the service also revokes the instance`s tunnel credential before
 * it answers, so a withdrawn machine cannot be reached under a managed address.
 * A machine that is not enrolled is answered `not_found`. Withdrawing is never
 * refused for want of agreement to the terms.
 */
export const RemoteEnrolmentWithdrawnSchema = z
  .object({ withdrawnAt: TimestampSchema })
  .describe(
    'When consent was withdrawn. The instance (its own enrolment, by its API key) or a person`s session may withdraw it, and the tunnel credential is revoked with it.'
  );

/**
 * The letters a {@link RemoteEnrolmentUserCodeSchema} is made of: twenty
 * consonants, with no vowels so a code never spells a word, and nothing that
 * reads as a digit. The base-20 alphabet RFC 8628 suggests for codes a person
 * types.
 */
export const REMOTE_ENROLMENT_USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ' as const;

/**
 * The short code that ties a person approving on the service`s page to the
 * machine that asked.
 *
 * Eight letters from {@link REMOTE_ENROLMENT_USER_CODE_ALPHABET}, shown and
 * sent as two groups of four joined by a hyphen (`BCDF-GHJK`). The approval
 * page may let a person type it in lower case or without the hyphen, but on
 * the wire it is always this canonical form.
 */
export const RemoteEnrolmentUserCodeSchema = z
  .string()
  .regex(
    new RegExp(
      `^[${REMOTE_ENROLMENT_USER_CODE_ALPHABET}]{4}-[${REMOTE_ENROLMENT_USER_CODE_ALPHABET}]{4}$`
    ),
    'must be eight letters from the published alphabet, as XXXX-XXXX'
  )
  .describe(
    'The short code a person compares and types to approve a machine: eight consonants as XXXX-XXXX, upper case, from BCDFGHJKLMNPQRSTVWXZ.'
  );

/**
 * `POST /v1/remote/enrolment/requests` — a machine asks a person to approve
 * managed remote access for it.
 *
 * The device-authorization shape (RFC 8628), for consent rather than for a
 * token. The instance calls it with its own API key, and only after a person
 * signed in to DorkOS on that machine chose managed access there: the request
 * is how that local choice reaches a person the service knows. The instance
 * shows `userCode` and opens `approveUrl`; a signed-in person sees the same
 * code on the service`s page and approves or denies it. The instance polls
 * {@link RemoteEnrolmentRequestStatusSchema} until the request settles. Nothing
 * here enrols the machine by itself: only a person`s approval does.
 *
 * The request takes no body; the machine is the one the API key belongs to.
 * At most one request per instance is pending: a new `POST` replaces the
 * earlier pending one, which then reads `expired`. That is also how an
 * instance recovers from a lost response: ask again.
 *
 * Refusals, in the ordinary error envelope:
 *
 * - `unauthenticated` without a valid instance API key; `forbidden` for a
 *   person`s session or bearer token (a person enrols on the service`s page
 *   with `POST /v1/remote/enrolment` instead).
 * - `conflict` when the machine is already enrolled. To agree again, withdraw
 *   first with `DELETE /v1/remote/enrolment`.
 * - `precondition_failed` when the machine is not linked to an organization.
 * - `entitlement_required` when the organization cannot use managed remote
 *   access, with an `actionUrl` where a person can change that.
 * - `rate_limited` when the machine asks too often.
 */
export const RemoteEnrolmentRequestSchema = z
  .object({
    requestId: IdSchema.describe(
      'Names this request. Read its status with it. Not a credential: only this instance`s key can read it.'
    ),
    userCode: RemoteEnrolmentUserCodeSchema,
    approveUrl: HttpsUrlSchema.describe(
      'The service page where a signed-in person sees the code and approves or denies the request. It may already carry the code; the page still shows it so the person can compare it with the one on the machine. Open it as given.'
    ),
    expiresAt: TimestampSchema.describe(
      'When the request lapses unapproved and reads `expired`. Ask again after that.'
    ),
    pollAfterMs: z
      .number()
      .int()
      .nonnegative()
      .describe('How long to wait before the first read of the request`s status.'),
    consentVersion: z
      .string()
      .min(1)
      .describe(
        'The version of the consent text the person will be shown and agree to. The enrolment an approval creates carries the same value.'
      ),
  })
  .describe(
    'A machine`s request for a person to approve managed remote access: the code to show, the page to open, and when to check back. Instance API key only.'
  );

/** A machine`s request for a person to approve managed remote access. */
export type RemoteEnrolmentRequest = z.infer<typeof RemoteEnrolmentRequestSchema>;

/**
 * `GET /v1/remote/enrolment/requests/{requestId}` — where one enrolment request
 * stands.
 *
 * Instance API key only, and only for that instance`s own requests: a request
 * that belongs to another instance, or that the service no longer holds, is
 * answered `not_found`. Discriminated on `status`:
 *
 * - `pending`: nobody has answered yet. Read again after `pollAfterMs`.
 * - `approved`: a person approved it, and `enrolment` is the record that
 *   approval created. Managed access may now be set up.
 * - `denied`: a person declined it. Nothing was enrolled.
 * - `expired`: it lapsed, or a newer request replaced it. Nothing was enrolled.
 *
 * The last three are final. The approve and deny routes answer with this
 * shape too. A later release may add a status; a client that cannot parse an
 * answer treats the request as ended without enrolment, and asks again.
 */
export const RemoteEnrolmentRequestStatusSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        status: z.literal('pending'),
        requestId: IdSchema,
        expiresAt: TimestampSchema.describe('When the request lapses if nobody answers it.'),
        pollAfterMs: z
          .number()
          .int()
          .nonnegative()
          .describe('How long to wait before reading the status again.'),
      })
      .describe('Nobody has answered yet.'),
    z
      .object({
        status: z.literal('approved'),
        requestId: IdSchema,
        enrolment: RemoteEnrolmentSchema.describe('The enrolment the approval created.'),
      })
      .describe('A person approved the request.'),
    z
      .object({ status: z.literal('denied'), requestId: IdSchema })
      .describe('A person declined the request. Nothing was enrolled.'),
    z
      .object({ status: z.literal('expired'), requestId: IdSchema })
      .describe('The request lapsed or was replaced by a newer one. Nothing was enrolled.'),
  ])
  .describe(
    'Where one enrolment request stands: pending, approved with the enrolment it created, denied, or expired.'
  );

/** Where one enrolment request stands. */
export type RemoteEnrolmentRequestStatus = z.infer<typeof RemoteEnrolmentRequestStatusSchema>;

/**
 * `POST /v1/remote/enrolment/requests/{requestId}/approve` — a person approves
 * a machine`s request.
 *
 * A person`s browser session only; the service`s own approval page is the
 * caller. `userCode` must match the request`s code, which is what ties the
 * person at the page to the machine that asked: a mismatch is refused with
 * `precondition_failed` and changes nothing, and the service may end a request
 * after repeated wrong codes. Approval checks what `POST /v1/remote/enrolment`
 * checks: a seat in the organization the machine is linked to (`forbidden`)
 * and agreement to the current terms (`precondition_failed`, with an
 * `actionUrl`). A request that is no longer pending is refused with
 * `conflict`; one the person cannot see is `not_found`. The answer is
 * {@link RemoteEnrolmentRequestStatusSchema} with status `approved`.
 *
 * `POST /v1/remote/enrolment/requests/{requestId}/deny` takes no body, has the
 * same caller and seat rules, and answers with status `denied`.
 */
export const RemoteEnrolmentApproveRequestSchema = z
  .object({
    userCode: RemoteEnrolmentUserCodeSchema.describe(
      'The code the person read on their machine. Must match the request`s code.'
    ),
  })
  .describe(
    'A person approving a machine`s enrolment request, with the code shown on the machine. Person session only.'
  );
