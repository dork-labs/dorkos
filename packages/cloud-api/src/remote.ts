import { z } from 'zod';

import {
  IdSchema,
  ONE_TIME_CREDENTIAL_META,
  SecretValueSchema,
  TimestampSchema,
  tolerantEnum,
} from './primitives.js';
import { HandleSchema } from './seats.js';

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
    instanceId: IdSchema.optional().describe(
      'The instance this status is about, echoed from the request so an answer can be matched to its instance. Absent from an older service.'
    ),
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
 * `GET /v1/orgs/{orgId}/remote/designation` — which instance the organization
 * keeps always available, if any.
 *
 * The same fields the `POST` answers, each nullable, so "nobody holds it" is a
 * state rather than a 404. An organization whose designated instance was
 * unlinked has none until somebody names another; that is a normal state.
 * `cooldownUntil` says when the designation may next change, so a page can say
 * so before anybody tries. There is no route that withdraws a designation.
 */
export const RemoteDesignationStatusSchema = z
  .object({
    instanceId: IdSchema.nullable().describe(
      'The designated instance, or null when the organization has none.'
    ),
    effectiveAt: TimestampSchema.nullable().describe(
      'When the current designation took effect, or null when there is none.'
    ),
    cooldownUntil: TimestampSchema.nullable().describe(
      'Until when the designation cannot be changed, or null when it can be changed now.'
    ),
  })
  .describe(
    'Which instance an organization keeps always available, if any, and when that may next change.'
  );

/** Which instance an organization keeps always available, if any. */
export type RemoteDesignationStatus = z.infer<typeof RemoteDesignationStatusSchema>;

/** What a remote-usage figure is counted in: hours, gigabytes, or a count. */
export const RemoteCeilingUnitSchema = z
  .enum(['hours', 'GB', 'count'])
  .describe('What a remote-usage figure is counted in: hours, gigabytes, or a plain count.');

/** Where an account stands against one fair-use limit. */
export const RemoteCeilingStateSchema = z
  .enum(['clear', 'alert', 'reached'])
  .describe(
    'Where an account stands against one limit: well within it, past the warning point, or at it.'
  );

/**
 * Where one account stands against one published remote-access limit, this
 * period.
 *
 * The server converts and the server divides. `limit` and `used` are already in
 * `unit`, and `fraction` is on the wire, so no two clients can round a
 * percentage differently from the service that enforces it. It is a fair-use
 * report, not a bill: nothing here is money.
 *
 * `unit` and `state` are tolerant: a value added in a later release reads as
 * `unrecognised`, so one new unit on one entry cannot fail the whole report.
 * Generate the JSON Schema with `{ io: 'input' }`.
 */
export const RemoteCeilingSchema = z
  .object({
    ceiling: z
      .string()
      .describe(
        'Which limit, as a server-supplied mechanism name. Render the rest of the entry; a name this client does not know is still a valid entry.'
      ),
    limit: z.number().nonnegative().describe('The published limit, in `unit`.'),
    used: z.number().nonnegative().describe('What the account has used this period, in `unit`.'),
    unit: tolerantEnum(RemoteCeilingUnitSchema).describe(
      'What `limit` and `used` are counted in. A unit this release does not know reads as unrecognised.'
    ),
    fraction: z
      .number()
      .nonnegative()
      .describe('`used / limit`, as the server computed it. May exceed 1. Never recompute it.'),
    alertFraction: z
      .number()
      .nonnegative()
      .describe('The fraction at which the published copy says a warning fires.'),
    state: tolerantEnum(RemoteCeilingStateSchema).describe(
      'Where the account stands against this limit. A state this release does not know reads as unrecognised.'
    ),
    enforceable: z
      .boolean()
      .describe(
        'False when `used` is the period`s high-water mark rather than a figure for now. Such a limit frees as soon as the usage ends, so do not present the peak as a present count.'
      ),
    provenance: z
      .object({
        source: z
          .string()
          .describe('How the limit was arrived at, as a server-supplied string. Render it.'),
        measuredAt: TimestampSchema.nullable().describe(
          'When it was measured, or null when nothing measured it.'
        ),
      })
      .describe('Where this limit came from.'),
  })
  .describe('Where one account stands against one published remote-access limit, this period.');

/** Where one account stands against one published remote-access limit. */
export type RemoteCeiling = z.infer<typeof RemoteCeilingSchema>;

/**
 * `GET /v1/remote/usage` — where the caller's account stands against every
 * published remote-access limit this period.
 *
 * A bearer token or the person's own browser session, and always the caller's
 * own account: nothing in the request names another. An account that has used
 * nothing gets 200 and zeroes, never a 404.
 *
 * Beside `/v1/remote/**` rather than under `/v1/usage` on purpose: these figures
 * are reachability counted per period and are not money, where `/v1/usage` is
 * inference for a window, denominated in money and credits.
 */
export const RemoteUsageResponseSchema = z
  .object({
    orgId: IdSchema.describe(
      'The account the figures were counted against, in the same space as `/v1/orgs`.'
    ),
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
      .describe('The service`s own period, a calendar month in UTC, as YYYY-MM.'),
    ceilings: z.array(RemoteCeilingSchema),
  })
  .describe(
    'Where the caller`s account stands against every published remote-access limit this period. An account that used nothing gets zeroes, never a 404.'
  );

/** Where the caller's account stands against every published remote-access limit. */
export type RemoteUsageResponse = z.infer<typeof RemoteUsageResponseSchema>;

/**
 * `POST /v1/remote/credentials/issue` — an instance asks for a tunnel
 * credential.
 *
 * Instance API key only, and the credential is for the instance the key
 * belongs to: the body`s `instanceId` does not choose another one. `value` and
 * `edgeProof.secret` are returned once, in this answer and never again,
 * because the service does not keep them.
 *
 * ## A repeated key is refused, never answered twice
 *
 * The `idempotencyKey` stops a retry from creating a second credential. It
 * does not replay the answer: a second call with a key the service already
 * issued under is refused with `conflict`, whatever happened to the first
 * answer. The refusal`s `detail` names the issuance, the credential id, its
 * fingerprint and whether it was confirmed, for a person reading a log; do not
 * parse it.
 *
 * ## Recovering after a lost answer
 *
 * When an issue answer is lost (a timeout, a crash before the value was
 * stored), issue again with a **fresh** `idempotencyKey`. The new answer is a
 * new credential; store it and confirm it. The credential behind the lost
 * answer was never confirmed, so it is never used: the service withdraws an
 * issued but unconfirmed credential when a newer one is issued to the same
 * instance, and in any case once the window for confirming it passes.
 *
 * A `rotate` command`s key is the one exception to choosing the key: present
 * the command`s `credentialId` as the key. A key whose replacement was already
 * collected, or is no longer on offer, is refused with `conflict` and nothing
 * is created; keep using the current credential.
 *
 * A lost rotation answer recovers on its own. A replacement that was collected
 * but not confirmed within the window for confirming it is withdrawn, and the
 * service sends a new `rotate` command, with a new `credentialId`, before the
 * current credential`s own deadline. Until then the instance keeps serving
 * with its current credential, which stays valid.
 *
 * Other refusals: `precondition_failed` when the machine is not linked to an
 * organization, has no address yet, or its owner has not agreed to the
 * current terms (then with an `actionUrl`); `unauthenticated` when the key is
 * no longer valid, including a machine unlinked while the call was on its way;
 * `forbidden` for a person`s session.
 */
export const RemoteCredentialIssueRequestSchema = z
  .object({
    instanceId: IdSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .describe(
        'A client-chosen key that stops a retry from creating a second credential. A key already used is refused with `conflict`, never answered with the value again. After a lost answer, issue again with a fresh key; a rotate command supplies its own key.'
      ),
  })
  .describe(
    'An instance asking for a tunnel credential. Instance API key only. A repeated key is refused, not replayed; recover a lost answer with a fresh key.'
  );

/**
 * Header names an edge proof may never use, because HTTP, a proxy or a session
 * already gives them a meaning. Any `x-forwarded-*` name is refused as well,
 * and a `:` pseudo-header cannot pass the name pattern at all.
 */
export const REMOTE_EDGE_PROOF_RESERVED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'upgrade',
  'content-length',
  'transfer-encoding',
  'te',
  'forwarded',
];

/**
 * The header a request must carry to prove it arrived through the managed
 * edge, and the value it must carry.
 *
 * ## Which requests must carry it
 *
 * **Every** request that arrives over managed access: on the instance`s
 * managed listener, or whose `Host` is one of the credential`s `hosts`. The
 * proof is required, never optional: a request without the header is refused,
 * not let through as if it came some other way.
 *
 * ## What the edge does, and what the instance checks
 *
 * The managed edge removes every copy of `header` a client sent and adds
 * exactly one, carrying `secret`. So before any other handling (before login,
 * sessions, routing, logging or counting) an instance refuses such a request
 * unless it carries **exactly one** `header` whose value equals `secret`. Zero
 * copies, more than one copy, or a different value are all refused, and never
 * resolved by reading the first or last copy. Count copies from the raw or
 * distinct header lists (in Node, `req.rawHeaders` or `req.headersDistinct`),
 * never from a field that folds repeats into one comma-joined value. Compare
 * the value in constant time. Then remove the header, so no later handler,
 * logger or proxy ever sees it. A refused request is not activity and is not
 * counted.
 *
 * The proof says only that a request came through the edge. It is not a
 * person, a login or an approval, and it never stands in for one.
 *
 * ## When a secret changes
 *
 * The secret belongs to one credential, and every issued credential carries a
 * new one. A **replacement** (a `rotate` command, or any newer credential the
 * instance confirms) overlaps: the instance accepts the new secret from when it
 * starts serving the new credential, and keeps accepting the old one until
 * {@link REMOTE_EDGE_PROOF_OVERLAP_SECONDS} after it confirmed the new
 * credential, never more than these two. The service, in turn, moves the edge
 * to the new secret no earlier than the confirmation, and does not revoke the
 * replaced credential or retire its secret until that overlap has passed. A
 * **revoke** (a `revoke` command, `POST /v1/remote/credentials/revoke`, a
 * withdrawn enrolment, an unlinked machine) is a security action, not a
 * replacement: it is immediate on both sides, and the instance stops accepting
 * that credential`s secret at once.
 *
 * Header names that already mean something to HTTP, a proxy or a session are
 * refused ({@link REMOTE_EDGE_PROOF_RESERVED_HEADERS}, any `x-forwarded-*`, and
 * any `:` pseudo-header), so honouring the proof can never mean stripping one.
 *
 * Never log `secret`, never put it in configuration in the clear, and never
 * return it to a browser.
 */
export const RemoteEdgeProofSchema = z
  .object({
    header: z
      .string()
      .max(64)
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        'must be a lower-case header name: letters, digits and single hyphens'
      )
      .refine(
        (name) =>
          !REMOTE_EDGE_PROOF_RESERVED_HEADERS.includes(name) && !name.startsWith('x-forwarded-'),
        'must not be a header HTTP, a proxy or a session already uses'
      )
      .describe(
        'The request header that carries the proof, in lower case. Never a header HTTP, a proxy or a session already uses. Compare header names without regard to case.'
      ),
    secret: z
      .string()
      .min(32)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII with no spaces')
      .meta({
        description:
          'The value the header carries: opaque, high-entropy, at least 32 characters. Returned once, with its credential. Never log it or return it to a browser.',
        [ONE_TIME_CREDENTIAL_META]: true,
      }),
  })
  .describe(
    'The header the managed edge adds to every request it forwards, and the secret it carries. Every request over managed access must carry exactly one matching copy; refuse it otherwise.'
  );

/** The header and secret that prove a request came through the managed edge. */
export type RemoteEdgeProof = z.infer<typeof RemoteEdgeProofSchema>;

/**
 * How long, in seconds, a replacement credential and the one it replaces
 * overlap after the replacement is confirmed: the instance keeps accepting the
 * old edge secret, and the service keeps the old credential valid, for this
 * long. A revoke has no overlap. See {@link RemoteEdgeProofSchema}.
 */
export const REMOTE_EDGE_PROOF_OVERLAP_SECONDS = 60 as const;

/**
 * A freshly issued tunnel credential.
 *
 * `edgeProof` is optional only so an answer from an older service still
 * parses. An instance does not open managed access with a credential that
 * lacks it, because it would have no way to tell a request that came through
 * the managed edge from one that did not.
 */
export const RemoteCredentialSchema = z
  .object({
    issuanceId: IdSchema,
    credentialId: IdSchema,
    value: SecretValueSchema,
    fingerprint: z.string().describe('A stable digest of the credential, safe to log and compare.'),
    acl: z
      .array(z.string())
      .describe('What this credential may do, as opaque server-supplied strings.'),
    hosts: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Every hostname this credential lets the instance serve: its own address first, then any custom hostname its organization added. The instance serves each one, and stops serving any hostname it served before that is not in the list. Compare hostnames without regard to case. Read this rather than `acl`, which stays opaque. When the field is absent, keep serving as before: absent is not an empty list, and a present list is never empty.'
      ),
    edgeProof: RemoteEdgeProofSchema.optional().describe(
      'The header and secret every request forwarded by the managed edge carries for this credential. Refuse a managed request without exactly one matching copy. Absent only from an older service; do not open managed access without it.'
    ),
  })
  .describe(
    'A freshly issued tunnel credential. The `value` and the edge proof secret are returned exactly once.'
  );

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
 * `POST /v1/remote/credentials/revoke` — an instance cuts off its own
 * reachability.
 *
 * Instance API key only (`forbidden` for a person`s session), and it takes no
 * body: the instance is the one the key belongs to, and there is no way to
 * name another. Every tunnel credential the instance holds is revoked, and
 * their edge secrets with them. An instance with nothing to revoke still gets
 * `200`: it asked not to be reachable, and it is not. Never refused for want
 * of agreement to the terms.
 *
 * It does not withdraw the enrolment, so the service can still offer the
 * machine a credential later. To end consent as well, use
 * `DELETE /v1/remote/enrolment`, which revokes the credential too.
 */
export const RemoteCredentialRevokeResponseSchema = z
  .object({
    revokedAt: TimestampSchema.describe('When the instance`s credentials were marked revoked.'),
  })
  .describe(
    'When an instance`s own tunnel credentials were revoked. Answered even when there was nothing to revoke.'
  );

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
        credentialId: IdSchema.describe(
          'An issue key, not a credential id. Present it as the `idempotencyKey` of `POST /v1/remote/credentials/issue` to receive the replacement, then confirm the replacement with the `credentialId` that call returns. If that call is refused, keep using the current credential; the service may offer another replacement later.'
        ),
      })
      .describe(
        'Replace the tunnel credential. Nothing is created until the instance asks for it, with the id this command carries.'
      ),
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
 * instance declined and can say why. The slug is bounded by {@link HandleSchema},
 * so a refusal reason is a single lower-case routing token a log and a dashboard
 * can group by without parsing prose.
 *
 * The family is open on purpose, and it is mechanism rather than catalog: a new
 * reason to refuse a command is something the server learns to say without a
 * package release, and no refusal names a subscription, a supplier or an
 * amount. A client that does not recognise a slug shows the whole string.
 *
 * Built from the handle grammar itself rather than from a copy of its pattern,
 * for two reasons. The two cannot drift apart while the doc above claims they
 * match. And a template literal keeps the three settled outcomes narrowable: a
 * plain `z.string()` branch would infer as `string`, which swallows the union
 * and silently turns an exhaustive switch over this field into one TypeScript
 * can no longer check.
 */
export const RemoteCommandOutcomeSchema = z
  .union([z.enum(['applied', 'ignored', 'failed']), z.templateLiteral(['refused:', HandleSchema])])
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

/**
 * A count of bytes, as a base-10 integer string.
 *
 * A string for the reason amounts are: a long window moves more bytes than a
 * JavaScript number holds exactly, and a string cannot silently lose digits.
 * Parse it with `BigInt`, never `Number`. Its length is bounded far beyond
 * anything a window can move, so a runaway value is refused.
 */
export const ByteCountSchema = z
  .string()
  .max(30)
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a non-negative base-10 integer with no leading zeros')
  .describe('A count of bytes, as a base-10 integer string. Parse it with BigInt, never Number.');

/**
 * The request header that names one `POST /v1/remote/events` batch.
 *
 * Every batch carries it, and the service refuses a batch without it with
 * `malformed_request`. A batch retried after a lost acknowledgement reuses its
 * key; a batch with new contents gets a new one. A key whose batch the service
 * already accepted from the same instance (the one the request's API key
 * belongs to) is answered `200` with an `accepted` count of zero: the batch was
 * already applied, and nothing in it is counted again. A batch that was refused
 * or failed was not accepted, so a retry with its key is applied as new.
 *
 * A header rather than a body field so the body stays exactly what instances
 * already send: a new required body field would refuse every one of them.
 */
export const REMOTE_EVENTS_IDEMPOTENCY_HEADER = 'Idempotency-Key' as const;

/** The value of {@link REMOTE_EVENTS_IDEMPOTENCY_HEADER}. */
export const RemoteEventBatchKeySchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'The Idempotency-Key header of a POST /v1/remote/events batch: an opaque string the instance chooses, one per batch, at most 200 characters. Reuse it to retry the same batch. A key whose batch was already accepted from the same instance is answered { accepted: 0 } and counts nothing again; a batch that was refused or failed was not accepted, so its retry is applied as new.'
  );

/**
 * `POST /v1/remote/events` — batched activity from an instance.
 *
 * The request carries the batch's key in the
 * {@link REMOTE_EVENTS_IDEMPOTENCY_HEADER} header ({@link RemoteEventBatchKeySchema}),
 * not in this body.
 *
 * Each close report names the span it covers: `openedAt` beside the existing
 * `at` (when the tunnel closed), the requests that crossed it in that span, and
 * the bytes in each direction. All four are optional, so a batch from an
 * instance that predates them is accepted as it always was, at lower
 * precision. `activity[].requests` is unchanged and still a running counter.
 */
export const RemoteEventBatchSchema = z
  .object({
    instanceId: IdSchema,
    activity: z
      .array(z.object({ at: TimestampSchema, requests: z.number().int().nonnegative() }))
      .describe('Windowed request counters.'),
    closeReports: z
      .array(
        z.object({
          at: TimestampSchema.describe('When the tunnel closed.'),
          reason: z.string(),
          wakeId: IdSchema.nullable(),
          openedAt: TimestampSchema.optional().describe(
            'When the tunnel this report closes was opened, so the report names a span. Absent from an older instance.'
          ),
          requests: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              'How many requests crossed the tunnel between `openedAt` and `at`. Scoped to this span, unlike the running `activity[].requests`.'
            ),
          bytesIn: ByteCountSchema.optional().describe(
            'Bytes received through the tunnel in this span.'
          ),
          bytesOut: ByteCountSchema.optional().describe(
            'Bytes sent through the tunnel in this span.'
          ),
        })
      )
      .describe('Why and when the tunnel closed itself, and what crossed it while it was open.'),
  })
  .describe(
    'Batched activity, close reports and window counters from one instance. The request names the batch in its Idempotency-Key header.'
  );

/** How many events were accepted. */
export const RemoteEventBatchResponseSchema = z
  .object({ accepted: z.number().int().nonnegative() })
  .describe(
    'How many of the reported events the server accepted. Zero for a batch whose Idempotency-Key was already accepted from the same instance, and for an empty batch, so zero alone does not say which.'
  );
