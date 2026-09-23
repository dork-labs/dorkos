import { z } from 'zod';

import {
  HttpsUrlSchema,
  IdSchema,
  ONE_TIME_CREDENTIAL_META,
  SecretValueSchema,
  ServerUrlSchema,
  TimestampSchema,
  pageOf,
  tolerantEnum,
} from './primitives.js';

/*
 * Hosted communities: the `/v1/communities` family.
 *
 * A hosted community is an ordinary DorkOS Community that a hosting service
 * runs on a Community server for the caller. This contract says how the DorkOS
 * app starts one, moves one in from an owner export, finds the ones the caller
 * already has, and gets past a hold. It says nothing about which host runs a
 * community, what hosting costs, or how a service decides who may start one:
 * the address a community lives at is a runtime value in every response, and a
 * refusal a larger allowance would lift is `entitlement_required` with the
 * service's own words and an `actionUrl` to open.
 *
 * The service never becomes a community's owner. Ownership moves to a person
 * through the Community server's single-use owner claim. The claim link and a
 * move's upload token are the only credentials this family returns; both carry
 * the ONE_TIME_CREDENTIAL_META marker, and a test pins where they may appear.
 *
 * Idempotency keys are scoped to the caller: two people who happen to pick the
 * same key never see each other's answer.
 */

/**
 * The grammar every community short name obeys.
 *
 * A short name is the optional address alias a Community server gives a
 * community beside its permanent identifier. The grammar is the Community
 * server's own: lower-case ASCII letters, digits and single hyphens, starting
 * with a letter and not ending with a hyphen. Published so the app can refuse a
 * bad name before a request goes out. Whether a well-formed name is free, or
 * reserved by the host, only the service can say
 * ({@link CommunityNameCheckResponseSchema}).
 *
 * Lower case by grammar, like `HandleSchema`: the app folds what a person
 * types before sending it, and the service refuses a mixed-case name rather
 * than folding it silently.
 */
export const CommunityShortNameSchema = z
  .string()
  .regex(
    /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/,
    'must be lower-case letters, digits and single hyphens, start with a letter, and not end with a hyphen'
  )
  .describe(
    'A community short name: lower case, 3 to 32 characters, letters, digits and single hyphens, starting with a letter and not ending with a hyphen.'
  );

/** A community's display name, as a person typed it. */
const CommunityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('The community`s display name. Trimmed, 1 to 80 characters.');

/** The caller-chosen key that makes a start or a move safe to retry. */
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'A key the caller chooses, scoped to the caller. Sending it again returns the same community or move instead of making a second one.'
  );

/**
 * A link that carries a single-use credential.
 *
 * A server link (`https:`, or `http:` to loopback for local use, since the
 * link points at the Community server), marked with {@link ONE_TIME_CREDENTIAL_META} so a relay can
 * refuse to pass it on and a test can pin where it appears.
 *
 * @param description - What the link is for.
 */
function oneTimeLink(description: string) {
  return ServerUrlSchema.meta({ description, [ONE_TIME_CREDENTIAL_META]: true });
}

/**
 * Where a hosted community is in its lifecycle.
 *
 * Mechanism: the Community server's own lifecycle names, plus `provisioning`
 * for the moment between the service accepting a start and the server
 * confirming it. A community a person has not yet claimed is `pending_owner`.
 * A community that no longer exists does not appear at all.
 */
export const HostedCommunityStateSchema = z
  .enum([
    'provisioning',
    'pending_owner',
    'active',
    'archived',
    'held',
    'suspended',
    'deletion_pending',
  ])
  .describe(
    'Where a hosted community is in its lifecycle. The Community server`s own lifecycle names, plus provisioning while the server confirms a start.'
  );

/** Where a hosted community is in its lifecycle. */
export type HostedCommunityState = z.infer<typeof HostedCommunityStateSchema>;

/**
 * Why a hosted community is on hold.
 *
 * A hold makes a community read-only: people can read it and its owner can
 * export it, and nothing new can be written. The reason tells the app which
 * way out to offer.
 *
 * - `over_limit`: the account holds more than its allowance covers. Choosing
 *   which communities to keep, or a larger allowance, lifts it.
 * - `inactive`: the service paused a community nobody has posted in for a long
 *   time. Restoring it lifts it, when it fits the account's allowance.
 * - `host`: the host placed the hold for its own reasons. The owner cannot lift
 *   it from the app; the community's `notice` says who to contact.
 */
export const HostedCommunityHoldReasonSchema = z
  .enum(['over_limit', 'inactive', 'host'])
  .describe(
    'Why a hosted community is on hold: the account holds more than its allowance covers, nobody has posted in a long time, or the host placed the hold itself.'
  );

/** Why a hosted community is on hold. */
export type HostedCommunityHoldReason = z.infer<typeof HostedCommunityHoldReasonSchema>;

/**
 * What the service wants the owner to read about a community, in its own words.
 *
 * The app shows `title` and `detail` as given and, when present, a button that
 * opens `actionUrl`. It is how a host hold, a suspension or a planned deletion
 * is explained honestly without this contract enumerating every reason a host
 * might have. A malformed link or label is dropped, like the one on `Problem`,
 * so a bad link never costs the owner the notice itself.
 */
export const HostedCommunityNoticeSchema = z
  .object({
    title: z.string().min(1).max(120).describe('A short summary, safe to show a person.'),
    detail: z.string().max(2000).describe('The explanation, safe to show a person.'),
    actionUrl: HttpsUrlSchema.optional()
      .catch(undefined)
      .describe(
        'A page where the owner can act on the notice. Open it as given. A malformed value is dropped.'
      ),
    actionLabel: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .catch(undefined)
      .describe('The text for a button that opens `actionUrl`. A malformed value is dropped.'),
  })
  .describe('What the service wants the owner to read about this community, in its own words.');

/**
 * Whether the owner may keep this community open, and what that would cost.
 *
 * `wouldHold` is the preview the app shows before the owner confirms: keeping
 * this community can put others on hold. The keep request echoes it back as
 * `expectedHeldCommunityIds`, so a choice made against a stale preview is
 * refused rather than holding a community nobody was warned about.
 */
export const HostedCommunityKeepActionSchema = z
  .object({
    allowed: z.boolean().describe('The owner may choose this community as one to keep open.'),
    wouldHold: z
      .array(IdSchema)
      .describe('The caller`s other communities that keeping this one would put on hold.'),
  })
  .describe('Whether the owner may keep this community open, and which others it would hold.');

/**
 * One community the caller has hosted.
 *
 * `limits` and `usage` are numbers, never a plan: the app says "this community
 * is full" from them without knowing what the caller bought. `actions` is the
 * service's answer to "what may this person do next", so the app renders a
 * button only when the service will accept it and never re-derives the rule.
 * A new action arrives as a new optional field of `actions`.
 *
 * A `held` community always says why (`hold`), and one in `deletion_pending`
 * always says when (`deletionAt`). The rules run one way only: a later release
 * may carry a hold into another state (a held community whose deletion has
 * started, for instance), and that must still parse.
 *
 * `state` and `hold.reason` are tolerant: a value added in a later release
 * reads as `unrecognised` rather than failing the page it arrives in.
 */
export const HostedCommunitySchema = z
  .object({
    communityId: IdSchema.describe(
      'The community`s permanent identifier on its Community server. Never changes, even across a rename.'
    ),
    orgId: IdSchema.describe('The organization whose account this community belongs to.'),
    name: z.string().min(1).max(80).describe('The community`s display name.'),
    shortName: CommunityShortNameSchema.nullable().describe(
      'The community`s current short name, or null when it has none.'
    ),
    communityUrl: ServerUrlSchema.describe(
      'The community`s canonical link on its Community server, built on its permanent identifier. A runtime value; pair a DorkOS installation with this.'
    ),
    state: tolerantEnum(HostedCommunityStateSchema).describe(
      'Where the community is in its lifecycle. A state this release does not know reads as unrecognised.'
    ),
    hold: z
      .object({
        reason: tolerantEnum(HostedCommunityHoldReasonSchema).describe(
          'Why the community is on hold. A reason this release does not know reads as unrecognised.'
        ),
        since: TimestampSchema,
        deletionNoticeAt: TimestampSchema.nullable().describe(
          'When the host may delete the community if the hold is not lifted, or null when no deletion is planned. The owner can export until then.'
        ),
      })
      .nullable()
      .describe('Why and since when the community is on hold. Always set when the state is held.'),
    deletionAt: TimestampSchema.nullable().describe(
      'When the Community server will delete the community for good. Always set when the state is deletion_pending.'
    ),
    notice: HostedCommunityNoticeSchema.nullable().describe(
      'What the service wants the owner to read about this community, or null when there is nothing.'
    ),
    kept: z
      .boolean()
      .describe(
        'True when the owner chose this community to stay open while the account holds more communities than its allowance covers.'
      ),
    moveId: IdSchema.nullable().describe(
      'The move filling this community from an owner export, while that move is unfinished. Null otherwise. Lets the app pick up a move after a restart.'
    ),
    limits: z
      .object({
        maxActiveMembers: z
          .number()
          .int()
          .positive()
          .nullable()
          .describe('The most people who may be active members at once. Null means no limit.'),
        maxStorageBytes: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .describe(
            'The most bytes of files the community may store. Null means no per-community limit.'
          ),
      })
      .describe('The limits the host enforces on this community. Agents and history never count.'),
    usage: z
      .object({
        activeMembers: z.number().int().nonnegative(),
        storageBytes: z
          .number()
          .int()
          .nonnegative()
          .describe('The bytes that count against the storage limit. Owner exports never count.'),
        measuredAt: TimestampSchema,
      })
      .nullable()
      .describe('The community`s last measured usage, or null before the first measurement.'),
    actions: z
      .object({
        claimLink: z
          .boolean()
          .describe('The service will issue a fresh owner-claim link for this community.'),
        keep: HostedCommunityKeepActionSchema,
        restore: z.boolean().describe('The owner may ask for this held community to reopen.'),
      })
      .describe(
        'What the caller may do next. Render an action only when it is allowed; the service applies the rule, the app never re-derives it.'
      ),
    createdAt: TimestampSchema,
  })
  .superRefine((community, ctx) => {
    if (community.state === 'held' && community.hold === null) {
      ctx.addIssue({ code: 'custom', path: ['hold'], message: 'a held community says why' });
    }
    if (community.state === 'deletion_pending' && community.deletionAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['deletionAt'],
        message: 'a community pending deletion says when',
      });
    }
  })
  .describe('One community the caller has hosted, with its state, limits and usage. Numbers only.');

/** One community the caller has hosted. */
export type HostedCommunity = z.infer<typeof HostedCommunitySchema>;

/**
 * `GET /v1/communities` — the caller's hosted communities.
 *
 * Every community the caller owns or started, across every organization they
 * belong to, in no particular order. The app reads it to show what the caller
 * already has, to finish a claim or a move after a restart, and to offer the
 * way out of a hold.
 */
export const HostedCommunityListResponseSchema = pageOf(
  HostedCommunitySchema,
  'A page of the communities the caller has hosted.'
);

/** A page of the caller's hosted communities. */
export type HostedCommunityListResponse = z.infer<typeof HostedCommunityListResponseSchema>;

/** `GET /v1/communities/name-check` query parameters. */
export const CommunityNameCheckQuerySchema = z
  .object({ name: CommunityShortNameSchema })
  .describe('The short name to check.');

/**
 * Why a well-formed short name cannot be used.
 *
 * Mechanism, and the same two answers the start and move routes refuse with as
 * `community_name_taken` and `community_name_reserved`. `taken` includes a name
 * another community used recently and that is still held back.
 */
export const CommunityNameUnavailableReasonSchema = z
  .enum(['taken', 'reserved'])
  .describe('Why a short name cannot be used: another community has it, or the host reserves it.');

/**
 * `GET /v1/communities/name-check` — is this short name free right now?
 *
 * Advisory: it lets the start form say "That web address is taken" while a
 * person types. The start and move routes check again and are the only answer
 * that binds, so a name free here can still be refused a moment later.
 * `reason` is null exactly when `available` is true.
 */
export const CommunityNameCheckResponseSchema = z
  .object({
    name: CommunityShortNameSchema,
    available: z.boolean(),
    reason: CommunityNameUnavailableReasonSchema.nullable().describe(
      'Why the name cannot be used. Null exactly when it is available.'
    ),
  })
  .superRefine((check, ctx) => {
    if (check.available !== (check.reason === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'reason is null exactly when the name is available',
      });
    }
  })
  .describe('Whether a short name is free right now. Advisory; starting a community checks again.');

/** Whether a short name is free right now. */
export type CommunityNameCheckResponse = z.infer<typeof CommunityNameCheckResponseSchema>;

/**
 * `POST /v1/communities` — start a hosted community.
 *
 * Idempotent on `idempotencyKey`, scoped to the caller: the same key with the
 * same body returns the same community (with `replayed: true`) rather than
 * starting a second one, and the same key with a different body is refused
 * with `conflict`. A refusal a larger allowance would lift is
 * `entitlement_required`; a short name that cannot be used is
 * `community_name_taken` or `community_name_reserved`.
 */
export const CommunityStartRequestSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    name: CommunityNameSchema,
    shortName: CommunityShortNameSchema.optional().describe(
      'The short name to give the community. Omitted means none.'
    ),
    orgId: IdSchema.optional().describe(
      'The organization whose account the community belongs to. Omitted means the caller`s personal one.'
    ),
  })
  .describe('Start a hosted community. Idempotent on the caller`s key.');

/** Start a hosted community. */
export type CommunityStartRequest = z.infer<typeof CommunityStartRequestSchema>;

/**
 * A one-time link that makes a person the owner of a new community.
 *
 * The link carries a single-use credential. Open it in the person's own
 * browser, never log it, and never show it to anyone else. Issuing a fresh one
 * revokes the last.
 */
export const CommunityClaimLinkSchema = z
  .object({
    communityId: IdSchema,
    claimUrl: oneTimeLink(
      'The owner-claim link. A single-use credential: open it in the person`s own browser and never log it.'
    ),
    expiresAt: TimestampSchema.describe('When the link stops working.'),
  })
  .describe('A one-time link that makes a person the owner of a new community. Returned once.');

/** A one-time owner-claim link. */
export type CommunityClaimLink = z.infer<typeof CommunityClaimLinkSchema>;

/**
 * The started community.
 *
 * The first answer carries the claim link, and no later answer does: the link
 * is a single-use credential and the service keeps no copy it could return
 * again. `claim` is therefore null when `replayed` is true, and also while the
 * community is still `provisioning` (the Community server has not confirmed
 * it yet). In both cases the app waits for `pending_owner` in the list and
 * asks `POST /v1/communities/{communityId}/claim-link` for a link.
 */
export const CommunityStartResponseSchema = z
  .object({
    community: HostedCommunitySchema,
    claim: CommunityClaimLinkSchema.nullable().describe(
      'The owner-claim link, or null when this answer repeats an earlier request or the community is still provisioning.'
    ),
    replayed: z
      .boolean()
      .describe('True when this answer repeats an earlier request with the same key.'),
  })
  .superRefine((started, ctx) => {
    if (
      started.claim !== null &&
      (started.replayed || started.community.state !== 'pending_owner')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['claim'],
        message: 'a claim link comes only on the first answer, for a pending_owner community',
      });
    }
  })
  .describe('The started community and, the first time only, its owner-claim link.');

/** The started community. */
export type CommunityStartResponse = z.infer<typeof CommunityStartResponseSchema>;

/**
 * `POST /v1/communities/{communityId}/keep` — the request.
 *
 * `expectedHeldCommunityIds` is the `actions.keep.wouldHold` preview the owner
 * confirmed. When the service would now hold a different set, it refuses with
 * `conflict` and holds nothing, so the app refreshes the list and asks again.
 */
export const CommunityKeepRequestSchema = z
  .object({
    expectedHeldCommunityIds: z
      .array(IdSchema)
      .describe('The communities the owner was told this choice would hold, in any order.'),
  })
  .describe('Keep this community open, confirming which others the owner agreed to hold.');

/** Keep this community open. */
export type CommunityKeepRequest = z.infer<typeof CommunityKeepRequestSchema>;

/**
 * `POST /v1/communities/{communityId}/keep` — keep this community open.
 *
 * For an account that holds more communities than its allowance covers: the
 * owner chooses which stay open. The answer names every other community the
 * choice put on hold, which is exactly the confirmed preview. When no choice
 * would make room, the refusal is `entitlement_required` with the service's
 * own words and an `actionUrl`.
 */
export const CommunityKeepResponseSchema = z
  .object({
    community: HostedCommunitySchema,
    heldCommunityIds: z
      .array(IdSchema)
      .describe('Other communities of the caller`s that this choice put on hold. Often empty.'),
  })
  .describe('The kept community, and every other community the choice put on hold.');

/** The kept community, and every community the choice put on hold. */
export type CommunityKeepResponse = z.infer<typeof CommunityKeepResponseSchema>;

/**
 * Where a move is.
 *
 * Mechanism: the stages of reading an owner export into a new community.
 * `ready` means the history is in and the community waits for its owner to
 * claim it; `claimed` means they have.
 */
export const CommunityMoveStateSchema = z
  .enum(['awaiting_upload', 'importing', 'ready', 'failed', 'cancelled', 'claimed'])
  .describe('Where a move is: waiting for the export, importing it, ready to claim, or finished.');

/** Where a move is. */
export type CommunityMoveState = z.infer<typeof CommunityMoveStateSchema>;

/**
 * Why a move failed, in terms a person can act on.
 *
 * Mechanism, one member per thing the app says differently:
 *
 * - `not_owner_export`: the file is a personal export, not the owner's.
 * - `archive_invalid`: the file is damaged or not a community export at all.
 * - `checksum_mismatch`: a file inside the export does not match the export's
 *   own record of it, so the export itself is damaged. Export again.
 * - `version_unsupported`: the export is from a version this host cannot read.
 * - `too_large`: the export is larger than any single move may be.
 * - `storage_limit_reached`: the files do not fit the community's storage limit.
 * - `upload_expired`: the export did not arrive before the upload window closed.
 * - `storage_unavailable`: the host could not store the files. Trying again later may work.
 *
 * An upload whose bytes do not match the declared size or digest is not a
 * failure of the move: the upload is refused and the move stays
 * `awaiting_upload` (see {@link CommunityMoveUploadSchema}). An upload window
 * that closes before a matching file arrives is `upload_expired`.
 */
export const CommunityMoveFailureCodeSchema = z
  .enum([
    'not_owner_export',
    'archive_invalid',
    'checksum_mismatch',
    'version_unsupported',
    'too_large',
    'storage_limit_reached',
    'upload_expired',
    'storage_unavailable',
  ])
  .describe('Why a move failed, in terms a person can act on.');

/** Why a move failed. */
export type CommunityMoveFailureCode = z.infer<typeof CommunityMoveFailureCodeSchema>;

/**
 * What an owner export holds, measured before anything is restored.
 *
 * Counts and sizes only. No channel name, file name, person or text ever
 * appears here.
 */
export const CommunityMoveReportSchema = z
  .object({
    channels: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative().describe('Messages and replies.'),
    attachments: z.number().int().nonnegative(),
    historicalMembers: z
      .number()
      .int()
      .nonnegative()
      .describe('People whose messages move. They join again by invitation.'),
    historicalAgents: z
      .number()
      .int()
      .nonnegative()
      .describe('Agents whose messages move. Their owners pair them again.'),
    attachmentBytes: z.number().int().nonnegative(),
    countedBytes: z
      .number()
      .int()
      .nonnegative()
      .describe('The bytes that will count against the community`s storage limit.'),
  })
  .describe('What an owner export holds, in counts and sizes only.');

/**
 * One move of a community into hosting, from an owner export.
 *
 * A move fills a brand-new community. The old community is never touched and
 * keeps running until its owner deletes it. Nothing of the new community is
 * visible until the whole export is in. A failed or cancelled move removes the
 * new community and everything uploaded for it, and frees its short name at
 * once, so starting again with the same name works.
 *
 * A `failed` move always says why (`failureCode`); the rule runs one way only.
 * `state` and `failureCode` are tolerant: a value added in a later release
 * reads as `unrecognised` rather than failing the page it arrives in.
 */
export const CommunityMoveSchema = z
  .object({
    moveId: IdSchema,
    communityId: IdSchema.describe(
      'The new community the export fills. It no longer exists once a move has failed or been cancelled.'
    ),
    communityUrl: ServerUrlSchema.describe('The new community`s canonical link. A runtime value.'),
    name: z.string().min(1).max(80).describe('The name the new community was given.'),
    state: tolerantEnum(CommunityMoveStateSchema).describe(
      'Where the move is. A state this release does not know reads as unrecognised.'
    ),
    failureCode: tolerantEnum(CommunityMoveFailureCodeSchema)
      .nullable()
      .describe(
        'Why the move failed. Always set when the state is failed. A code this release does not know reads as unrecognised.'
      ),
    report: CommunityMoveReportSchema.nullable().describe(
      'What the export holds, once it has been read. Null before then.'
    ),
    pollAfterMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe('How long to wait before reading the move again. Null once it has finished.'),
    updatedAt: TimestampSchema,
  })
  .superRefine((move, ctx) => {
    if (move.state === 'failed' && move.failureCode === null) {
      ctx.addIssue({ code: 'custom', path: ['failureCode'], message: 'a failed move says why' });
    }
  })
  .describe('One move of a community into hosting, from an owner export.');

/** One move of a community into hosting. */
export type CommunityMove = z.infer<typeof CommunityMoveSchema>;

/**
 * `GET /v1/communities/moves` — the caller's moves.
 *
 * Every unfinished move, and every move that finished (failed, cancelled or
 * claimed) within the last seven days, newest first. It is how the app shows
 * a failed move to a person who closed the app while it was importing: the
 * new community is gone by then, so the hosted-community list cannot.
 */
export const CommunityMoveListResponseSchema = pageOf(
  CommunityMoveSchema,
  'A page of the caller`s moves: every unfinished one, and those that finished within the last 7 days, newest first.'
);

/** A page of the caller's moves. */
export type CommunityMoveListResponse = z.infer<typeof CommunityMoveListResponseSchema>;

/**
 * `POST /v1/communities/moves` — start a move.
 *
 * The caller names the export by size and digest before sending a byte, so a
 * file too large for a move is refused with `import_too_large`, and one that
 * would not fit the account with `entitlement_required`, before an upload
 * starts. Idempotent on the caller's key, like a start.
 */
export const CommunityMoveStartRequestSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    name: CommunityNameSchema,
    shortName: CommunityShortNameSchema.optional().describe(
      'The short name to give the new community. Omitted means none.'
    ),
    orgId: IdSchema.optional().describe(
      'The organization whose account the community belongs to. Omitted means the caller`s personal one.'
    ),
    archiveBytes: z.number().int().positive().describe('The size of the export file, in bytes.'),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'must be a lower-case hex SHA-256 digest')
      .describe('The SHA-256 of the export file, as lower-case hex.'),
  })
  .describe('Start moving a community in from an owner export. Idempotent on the caller`s key.');

/** Start moving a community in from an owner export. */
export type CommunityMoveStartRequest = z.infer<typeof CommunityMoveStartRequestSchema>;

/**
 * The header that carries an export's digest on its upload, as lower-case hex.
 *
 * The Community server compares it with the bytes it received and refuses the
 * upload when they differ.
 */
export const COMMUNITY_ARCHIVE_DIGEST_HEADER = 'X-Archive-SHA256' as const;

/**
 * Where to send the export file.
 *
 * Send the file's exact bytes with `PUT` to `url`, with `token` as a bearer
 * credential, `Content-Length` set to the declared size, and the declared
 * digest in the {@link COMMUNITY_ARCHIVE_DIGEST_HEADER} header. The URL is the
 * Community server's own upload route, so the file goes straight to the host
 * and never through the hosting service.
 *
 * What the Community server answers, in its own error envelope (a JSON body
 * with a `code`, not this contract's `Problem`):
 *
 * - success: the token is spent and the move goes on to `importing`;
 * - `400 IMPORT_ARCHIVE_INVALID`: the bytes did not match the declared size or
 *   digest. Nothing is kept, the move stays `awaiting_upload`, and the same
 *   token may be used again until `expiresAt`;
 * - a dropped connection part-way: the same, the token still works;
 * - `401`: the upload window has closed. The move is then `failed` with
 *   `upload_expired`, and the app starts a new move. A failed move frees its
 *   short name at once, so the new move can use the same one.
 */
export const CommunityMoveUploadSchema = z
  .object({
    url: ServerUrlSchema.describe('Where to send the export. A runtime value.'),
    token: SecretValueSchema.meta({
      description: 'The upload bearer credential. Returned once; never log it.',
      [ONE_TIME_CREDENTIAL_META]: true,
    }),
    expiresAt: TimestampSchema.describe('When the upload window closes.'),
    maxBytes: z.number().int().positive().describe('The largest file the upload accepts.'),
  })
  .describe('Where and how to send the export file. The token is returned once.');

/** Where and how to send the export file. */
export type CommunityMoveUpload = z.infer<typeof CommunityMoveUploadSchema>;

/**
 * The started move.
 *
 * The first answer carries the upload target, and no later answer does: the
 * token is a credential the service keeps no copy of. `upload` is therefore
 * null exactly when `replayed` is true. A caller that lost it cancels the move
 * and starts a new one; cancelling frees the short name at once.
 */
export const CommunityMoveStartResponseSchema = z
  .object({
    move: CommunityMoveSchema,
    upload: CommunityMoveUploadSchema.nullable().describe(
      'Where to send the export, or null when this answer repeats an earlier request.'
    ),
    replayed: z
      .boolean()
      .describe('True when this answer repeats an earlier request with the same key.'),
  })
  .superRefine((started, ctx) => {
    if (started.replayed !== (started.upload === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['upload'],
        message: 'upload is null exactly when the answer is replayed',
      });
    }
  })
  .describe('The started move and, the first time only, where to send the export.');

/** The started move. */
export type CommunityMoveStartResponse = z.infer<typeof CommunityMoveStartResponseSchema>;
