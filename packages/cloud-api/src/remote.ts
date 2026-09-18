import { z } from 'zod';

import { IdSchema, SecretValueSchema, TimestampSchema } from './primitives.js';

/**
 * How remote access is arranged for an instance.
 *
 * Mechanism, and safe under catalog blindness for the same reason the
 * entitlement capability enums are: it describes how the thing works, not what
 * anybody bought.
 */
export const RemoteModeSchema = z
  .enum(['off', 'byo', 'managed'])
  .describe('How remote access is arranged: off, the caller`s own tunnel, or a managed one.');

/** Where the tunnel is in its lifecycle. */
export const RemoteStateSchema = z
  .enum(['closed', 'opening', 'open', 'draining', 'blocked'])
  .describe('Where the tunnel is in its lifecycle.');

/**
 * `GET /v1/remote/status`.
 *
 * `alwaysAvailable` is a boolean the server computes. A client renders the
 * promise and never sees a subscription identifier to derive it from.
 */
export const RemoteStatusSchema = z
  .object({
    mode: RemoteModeSchema,
    state: RemoteStateSchema,
    address: z.string().describe('The address this instance is reachable at.'),
    url: z.string().url().optional().describe('The full URL, when the tunnel is open.'),
    openedAt: TimestampSchema.optional(),
    idleClosesAt: TimestampSchema.optional().describe('When an idle tunnel will close itself.'),
    idleWindowSeconds: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'How long the tunnel may sit idle before it closes itself. The window the instance is told to honour, in seconds.'
      ),
    drainDeadlineSeconds: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'How long the instance has to finish work already in flight once it is asked to close, in seconds.'
      ),
    lastActivityAt: TimestampSchema.optional(),
    alwaysAvailable: z
      .boolean()
      .describe(
        'Computed by the server. The client renders the promise and never derives it from a subscription.'
      ),
    reason: z
      .string()
      .optional()
      .describe('Why the tunnel is in this state, when the state needs explaining.'),
  })
  .describe('The current remote-access state of one instance.');

/** The current remote-access state of one instance. */
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

/**
 * `POST /v1/remote/open`.
 *
 * Accepted from a person`s session, a person`s bearer token, or a valid wake
 * token. Idempotent on `(instanceId, wakeId)`: repeating the call with the same
 * wake identifier repeats the answer rather than opening a second tunnel.
 */
export const RemoteOpenRequestSchema = z
  .object({
    instanceId: IdSchema,
    wakeId: IdSchema.describe(
      'A client-chosen idempotency key. The same key repeats the answer, not the effect.'
    ),
  })
  .describe(
    'Open the tunnel for an instance. Idempotent on the instance and wake identifier together.'
  );

/** The accepted open request. */
export const RemoteOpenResponseSchema = z
  .object({
    wakeId: IdSchema,
    state: RemoteStateSchema,
    pollAfterMs: z
      .number()
      .int()
      .nonnegative()
      .describe('How long to wait before reading the status again.'),
  })
  .describe('The accepted open request, and how long to wait before checking the status.');

/** `POST /v1/remote/close`. */
export const RemoteCloseResponseSchema = z
  .object({ state: RemoteStateSchema })
  .describe('The state the tunnel is in after being asked to close.');

/**
 * `POST /v1/remote/wake-tokens` — mint a token that can open a closed tunnel.
 *
 * `token` is returned once. Hold it as a credential reference, never as
 * configuration.
 */
export const RemoteWakeTokenSchema = z
  .object({
    token: SecretValueSchema,
    expiresAt: TimestampSchema,
    singleUse: z.boolean(),
  })
  .describe('A token that can open a closed tunnel. The value is returned exactly once.');

/**
 * `POST /v1/remote/enrolment` — the person`s consent to managed remote access.
 *
 * Accepted only from a person`s session. An instance cannot enrol itself.
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

/** `DELETE /v1/remote/enrolment` — withdrawn by the person or by the instance. */
export const RemoteEnrolmentWithdrawnSchema = z
  .object({ withdrawnAt: TimestampSchema })
  .describe('When consent was withdrawn. Either the person or the instance may withdraw it.');

/** `GET` / `POST /v1/remote/address` — the canonical address for an instance. */
export const RemoteAddressSchema = z
  .object({
    address: z.string(),
    host: z.string(),
    kind: z.literal('canonical'),
  })
  .describe('The canonical address an instance is reachable at.');

/** Where a custom hostname is in its setup. */
export const CustomAddressStatusSchema = z
  .enum(['pending_verification', 'verifying', 'active', 'failed'])
  .describe('Where a custom hostname is in its setup.');

/** Where a custom hostname`s certificate is. */
export const CertificateStateSchema = z
  .enum(['none', 'pending', 'issued', 'renewing', 'failed'])
  .describe('Where a custom hostname`s certificate is.');

/** `GET` / `POST` / `DELETE /v1/remote/address/custom`. */
export const RemoteCustomAddressSchema = z
  .object({
    hostname: z.string(),
    status: CustomAddressStatusSchema,
    verification: z
      .object({
        recordName: z.string().describe('The DNS record name to create.'),
        recordValue: z.string().describe('The DNS record value to set.'),
      })
      .describe('The DNS record that proves the caller controls the hostname.'),
    certificate: z
      .object({ state: CertificateStateSchema, renewsAt: TimestampSchema.nullable() })
      .describe('The certificate this hostname is served with.'),
  })
  .describe('A custom hostname for an instance, its verification record and its certificate.');

/** A custom hostname for an instance. */
export type RemoteCustomAddress = z.infer<typeof RemoteCustomAddressSchema>;

/** `POST /v1/orgs/{orgId}/remote/designation` — pick the always-available instance. */
export const RemoteDesignationRequestSchema = z
  .object({ instanceId: IdSchema })
  .describe('Designate which instance an organization keeps always available.');

/** The accepted designation. */
export const RemoteDesignationSchema = z
  .object({
    instanceId: IdSchema,
    effectiveAt: TimestampSchema,
    cooldownUntil: TimestampSchema.describe('Until when the designation cannot be changed again.'),
  })
  .describe('The accepted designation, and when it may next be changed.');

/**
 * `POST /v1/remote/credentials/issue` — an instance asks for a tunnel
 * credential.
 *
 * Instance API key only. `value` is returned once.
 */
export const RemoteCredentialIssueRequestSchema = z
  .object({
    instanceId: IdSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .describe(
        'A client-chosen key. Repeating an issue with the same key repeats the answer, not the effect.'
      ),
  })
  .describe('An instance asking for a tunnel credential. Instance API key only.');

/** A freshly issued tunnel credential. */
export const RemoteCredentialSchema = z
  .object({
    issuanceId: IdSchema,
    credentialId: IdSchema,
    value: SecretValueSchema,
    fingerprint: z.string().describe('A stable digest of the credential, safe to log and compare.'),
    acl: z
      .array(z.string())
      .describe('What this credential may do, as opaque server-supplied strings.'),
  })
  .describe('A freshly issued tunnel credential. The `value` is returned exactly once.');

/** A freshly issued tunnel credential. */
export type RemoteCredential = z.infer<typeof RemoteCredentialSchema>;

/** `POST /v1/remote/credentials/confirm` — the instance reports it stored the credential. */
export const RemoteCredentialConfirmRequestSchema = z
  .object({ credentialId: IdSchema })
  .describe('An instance confirming it has stored an issued credential.');

/** The confirmation. */
export const RemoteCredentialConfirmResponseSchema = z
  .object({ credentialId: IdSchema, confirmedAt: TimestampSchema })
  .describe('When the server recorded the instance`s confirmation.');

/**
 * One event on the instance command stream.
 *
 * A published discriminated union rather than an untyped string, so adding a
 * command kind later is a package release the two sides can agree on rather
 * than a field they disagree about.
 */
export const RemoteCommandSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('open'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        wakeId: IdSchema,
        leaseId: IdSchema.optional().describe(
          'The lease the instance echoes when it reconnects. Opaque: the instance stores it and sends it back, and reads nothing from it.'
        ),
        address: z
          .string()
          .optional()
          .describe('The address this instance is reachable at once the tunnel is open.'),
        host: z.string().optional().describe('The host part of that address.'),
        idleWindowSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'How long the tunnel may sit idle before it closes itself, in seconds. The same window `RemoteStatusSchema` reports.'
          ),
        drainDeadlineSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'How long the instance has to finish work already in flight once it is asked to close, in seconds.'
          ),
      })
      .describe('Open the tunnel.'),
    z
      .object({
        kind: z.literal('close'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        reason: z.string(),
      })
      .describe('Close the tunnel.'),
    z
      .object({
        kind: z.literal('rotate'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        credentialId: IdSchema,
      })
      .describe('Replace the tunnel credential.'),
    z
      .object({
        kind: z.literal('revoke'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        credentialId: IdSchema,
      })
      .describe('Stop using the tunnel credential and forget it.'),
    z
      .object({
        kind: z.literal('inbox_pending'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        seatId: IdSchema,
      })
      .describe('There is mail waiting for a seat.'),
    z
      .object({
        kind: z.literal('keepalive'),
        id: IdSchema,
        reconnectAfterMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'How long to wait before reconnecting if the stream drops. A convenience rather than a gap: the server-sent-events `retry:` field already carries the same number, and an instance that honours it needs nothing here.'
          ),
      })
      .describe('Nothing to do. Sent so a silent stream can be told from a dead one.'),
  ])
  .describe(
    'One event on the `GET /v1/remote/commands` stream. Server-sent events; instance API key only.'
  );

/** One event on the instance command stream. */
export type RemoteCommand = z.infer<typeof RemoteCommandSchema>;

/**
 * What an instance did with one command it leased.
 *
 * Three settled outcomes, plus an open `refused:<slug>` family for a command an
 * instance declined and can say why. The slug is bounded by the handle grammar
 * (`HandleSchema` in the seats module), so a refusal reason is a single lower-case routing
 * token a log and a dashboard can group by without parsing prose.
 *
 * The family is open on purpose, and it is mechanism rather than catalog: a new
 * reason to refuse a command is something the server learns to say without a
 * package release, and no refusal names a subscription, a supplier or an
 * amount. A client that does not recognise a slug shows the whole string.
 */
export const RemoteCommandOutcomeSchema = z
  .union([
    z.enum(['applied', 'ignored', 'failed']),
    z
      .string()
      .regex(
        /^refused:[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/,
        'must be `refused:` followed by a slug in the handle grammar'
      ),
  ])
  .describe(
    'What the instance did with a command: applied, ignored, failed, or refused with a slug bounded by the handle grammar.'
  );

/** What an instance did with one command it leased. */
export type RemoteCommandOutcome = z.infer<typeof RemoteCommandOutcomeSchema>;

/** `POST /v1/remote/commands/ack`. */
export const RemoteCommandAckRequestSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: IdSchema,
          leaseToken: z.string().min(1),
          outcome: RemoteCommandOutcomeSchema.describe('What the instance did with the command.'),
        })
      )
      .min(1)
      .max(100),
  })
  .describe('Report what an instance did with the commands it leased.');

/** How many command leases were settled. */
export const RemoteCommandAckResponseSchema = z
  .object({ acknowledged: z.number().int().nonnegative() })
  .describe('How many command leases the server settled.');

/** `POST /v1/remote/events` — batched activity from an instance. */
export const RemoteEventBatchSchema = z
  .object({
    instanceId: IdSchema,
    activity: z
      .array(z.object({ at: TimestampSchema, requests: z.number().int().nonnegative() }))
      .describe('Windowed request counters.'),
    closeReports: z
      .array(z.object({ at: TimestampSchema, reason: z.string(), wakeId: IdSchema.nullable() }))
      .describe('Why and when the tunnel closed itself.'),
  })
  .describe('Batched activity, close reports and window counters from one instance.');

/** How many events were accepted. */
export const RemoteEventBatchResponseSchema = z
  .object({ accepted: z.number().int().nonnegative() })
  .describe('How many of the reported events the server accepted.');
