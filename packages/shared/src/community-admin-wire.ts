/** Strict wire schemas for standalone Community administration. */
import { z } from 'zod';

const id = z.uuid();
const timestamp = z.iso.datetime();
const version = z.int().positive();

/** Persisted Community lifecycle visible to authorized administration surfaces. */
export const CommunityAdminLifecycleSchema = z.enum([
  'pending_owner',
  'active',
  'archived',
  'suspended',
  'held',
  'deletion_pending',
]);
/** Community admission policy. */
export const CommunityAdminAdmissionPolicySchema = z.enum(['invite_only', 'closed']);

/** The grammar of a community short name: 3-32 lowercase ASCII letters, digits, and hyphens. */
export const COMMUNITY_SHORT_NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/;
/**
 * A community short name: a mutable address alias, never identity. Input is trimmed and
 * lowercased before the grammar applies, so `Acme` and ` acme ` both mean `acme`. ASCII only,
 * so no two names can look alike.
 */
export const CommunityShortNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(COMMUNITY_SHORT_NAME_PATTERN);
/**
 * Top-level paths the Community server or its browser already owns or may soon own. No
 * community can take one as its short name; a host can add more by configuration.
 */
export const COMMUNITY_RESERVED_SHORT_NAMES: readonly string[] = [
  'api',
  'assets',
  'c',
  'claim',
  'host',
  'join',
  'pairing',
  'health',
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'settings',
  'admin',
  'static',
  'public',
  'www',
  'help',
  'docs',
  'status',
  'well-known',
  'favicon',
  'robots',
  'sitemap',
  'new',
  'import',
  'invite',
  'deletion',
  // The owner's link to keep ownership, and the new owner's claim, when a host replaces an owner.
  'keep-ownership',
  'owner-replacement',
  // First-host setup is reached through the browser app, and a host would expect the word kept.
  'setup',
  // Pages a host is likely to publish, and words that would let a community pose as the host.
  'terms',
  'privacy',
  'abuse',
  'report',
  'legal',
  'security',
  'account',
  'recovery',
  'oauth',
  'callback',
  'verify',
  'reset',
  'communities',
  'community',
  'support',
  'billing',
  'official',
  'dorkos',
];
/** Set, change, or clear (`null`) a community's short name. */
export const CommunityAdminShortNameUpdateRequestSchema = z.strictObject({
  shortName: CommunityShortNameSchema.nullable(),
});
/** A community's current short name and the retired ones that still lead to it. */
export const CommunityAdminShortNamesSchema = z.strictObject({
  communityId: id,
  current: CommunityShortNameSchema.nullable(),
  retired: z.array(z.strictObject({ shortName: CommunityShortNameSchema, retiredAt: timestamp })),
});
/**
 * Whether a short name could be given to a community now. `cooling_off` is a released name
 * still held back from reuse until `availableAt`, given as the next UTC midnight after the hold
 * ends so it never dates the release to the second; the public lookup cannot tell it from an
 * unknown name, by design, so a host needs this to explain a refusal.
 */
export const CommunityAdminShortNameAvailabilitySchema = z.strictObject({
  shortName: z.string(),
  availability: z.enum(['available', 'taken', 'cooling_off', 'reserved', 'invalid']),
  availableAt: timestamp.nullable(),
});
/**
 * Where an import of an owner export stands. It pauses at `validated` for the host to commit,
 * and ends `ready`, `failed`, or `cancelled`.
 */
export const CommunityAdminImportStateSchema = z.enum([
  'awaiting_upload',
  'validating',
  'validated',
  'restoring',
  'ready',
  'failed',
  'cancelled',
]);

/** Why a host asked to replace an owner. Shown to the owner in the product as a fixed sentence. */
export const CommunityAdminOwnerReplacementReasonSchema = z.enum([
  'owner_left_group',
  'owner_unreachable',
  'other',
]);
/**
 * Where an owner replacement stands. `notifying`, `waiting`, and `claimable` are open; the rest
 * are closed, and a closed replacement never reopens.
 */
export const CommunityAdminOwnerReplacementStateSchema = z.enum([
  'notifying',
  'waiting',
  'claimable',
  'completed',
  'objected',
  'withdrawn',
  'superseded',
  'expired',
]);
/** The open owner replacement states; a community has at most one replacement in one of them. */
export const CommunityAdminOwnerReplacementOpenStateSchema =
  CommunityAdminOwnerReplacementStateSchema.extract(['notifying', 'waiting', 'claimable']);

/** Host-visible metadata without membership or content details. */
export const CommunityAdminHostProjectionSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1_000).nullable(),
  lifecycle: CommunityAdminLifecycleSchema,
  lifecycleVersion: version,
  settingsVersion: version,
  ownerPresent: z.boolean(),
  deletionState: z.enum(['waiting', 'deleting', 'retrying']).nullable(),
  /** The published date after which the host may delete a held community. */
  deletionNoticeAt: timestamp.nullable(),
  /** Who asked for a pending deletion; the host cannot cancel or speed an owner's. */
  deletionRequestedBy: z.enum(['owner', 'host']).nullable(),
  /** The current short name, if the community has one. */
  shortName: CommunityShortNameSchema.nullable(),
  /**
   * The host's legal hold, if one stands: no permanent deletion of the community runs until the
   * host releases it. Host-only; no tenant projection carries it.
   */
  legalHold: z
    .strictObject({
      since: timestamp,
      /** The host's own pointer to why (a case or ticket number). Never shown to members. */
      reference: z.string().min(1).max(200).nullable(),
    })
    .nullable(),
  /** The import that made this community, and its state; both null when it was not imported. */
  importId: id.nullable(),
  importState: CommunityAdminImportStateSchema.nullable(),
  /**
   * The community's open owner replacement, if one is open. Visible to every host actor; the
   * details stay behind `communities:ownership`.
   */
  ownerReplacement: z
    .strictObject({
      replacementId: id,
      state: CommunityAdminOwnerReplacementOpenStateSchema,
      /** When the named account may claim; null until the owner's notice resolves. */
      claimableAfter: timestamp.nullable(),
    })
    .nullable(),
  /**
   * The host's takedown of the whole community, while it waits out its reversal window. Its
   * pending deletion is reversed through the takedown, never cancelled. Added later.
   */
  takedownId: id.nullable().optional(),
  createdAt: timestamp,
});

const maxActiveMembers = z.int().min(1).max(1_000_000).nullable();
const maxStorageBytes = z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const bytes = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Host-set community limits. null means no limit. */
export const CommunityAdminLimitsSchema = z.strictObject({
  maxActiveMembers,
  maxStorageBytes,
  limitsVersion: version,
});
/** Replace a community's limits. The first write uses `limitsVersion: 1`. */
export const CommunityAdminLimitsUpdateRequestSchema = z.strictObject({
  limitsVersion: version,
  maxActiveMembers,
  maxStorageBytes,
});
/** Set or clear (`null`) one member's agents-per-person limit. */
export const CommunityAdminMemberLimitsRequestSchema = z.strictObject({
  agentsPerMember: z.int().min(1).max(1_000).nullable(),
});
/** Only the override: never a name, handle, email, or role. */
export const CommunityAdminMemberLimitsSchema = z.strictObject({
  communityId: id,
  memberId: id,
  agentsPerMember: z.int().min(1).max(1_000).nullable(),
  effectiveAgentsPerMember: z.int().min(1).max(1_000),
});
/** Aggregate usage for one community. No content-derived detail. */
export const CommunityAdminUsageSchema = z.strictObject({
  communityId: id,
  measuredAt: timestamp,
  activeMembers: z.int().nonnegative(),
  activeAgents: z.int().nonnegative(),
  storage: z.strictObject({
    attachmentBytes: bytes,
    iconBytes: bytes,
    exportBytes: bytes,
    importStagingBytes: bytes,
    pendingDeleteBytes: bytes,
    countedBytes: bytes,
  }),
  limits: CommunityAdminLimitsSchema,
  /** UTC day of the newest message, never a time. */
  lastPostDate: z.iso.date().nullable(),
});
/** One page of community usage in id order. */
export const CommunityAdminUsagePageSchema = z.strictObject({
  items: z.array(CommunityAdminUsageSchema).max(100),
  next: id.nullable(),
});

/** Idempotent host request for one unclaimed Community. */
export const CommunityAdminCreateRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1_000).nullable().optional(),
  admissionPolicy: CommunityAdminAdmissionPolicySchema.optional(),
  /** Set in the same transaction and part of the idempotency key's payload. */
  limits: CommunityAdminLimitsUpdateRequestSchema.omit({ limitsVersion: true }).optional(),
  /** Set in the same transaction and part of the idempotency key's payload. */
  shortName: CommunityShortNameSchema.optional(),
});
/** Private creation handoff. A retry returns the receipt without replaying its one-time secret. */
export const CommunityAdminCreateResponseSchema = z.strictObject({
  community: CommunityAdminHostProjectionSchema,
  ownerClaimGrantId: id,
  ownerClaimToken: z.string().min(1).nullable(),
  expiresAt: timestamp,
  replayed: z.boolean(),
});

/** Host claim rotation carries no caller-selected tenant or role. */
export const CommunityAdminClaimMutationRequestSchema = z.strictObject({});
/** One-time replacement claim returned with no-store caching. */
export const CommunityAdminClaimResponseSchema = z.strictObject({
  grantId: id,
  ownerClaimToken: z.string().min(1),
  expiresAt: timestamp,
});

/** Public settings projection; blob keys and storage URLs never cross this boundary. */
export const CommunityAdminSettingsSchema = z.strictObject({
  communityId: id,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1_000).nullable(),
  admissionPolicy: CommunityAdminAdmissionPolicySchema,
  hasIcon: z.boolean(),
  settingsVersion: version,
  lifecycle: CommunityAdminLifecycleSchema,
  lifecycleVersion: version,
});
/** Safe current settings returned when an administrative edit conflicts. */
export const CommunityAdminSettingsConflictSchema = z.strictObject({
  code: z.literal('STATE_CONFLICT'),
  message: z.string(),
  current: CommunityAdminSettingsSchema,
});

/** Versioned presentation and access mutation. */
export const CommunityAdminSettingsUpdateRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(1_000).nullable().optional(),
    admissionPolicy: CommunityAdminAdmissionPolicySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

/**
 * Host lifecycle transitions, each against the current lifecycle version. A hold makes a
 * community read-only while its owner can still export it; a notice date is when the host may
 * delete it at the earliest.
 */
export const CommunityAdminHostLifecycleRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('suspend'), lifecycleVersion: version }),
  z.strictObject({ action: z.literal('resume'), lifecycleVersion: version }),
  z.strictObject({
    action: z.literal('hold'),
    lifecycleVersion: version,
    deletionNoticeAt: timestamp.nullable(),
  }),
  z.strictObject({ action: z.literal('release'), lifecycleVersion: version }),
  z.strictObject({
    action: z.literal('set_notice'),
    lifecycleVersion: version,
    deletionNoticeAt: timestamp.nullable(),
  }),
]);
/** Host-started deletion of a held community whose notice date has passed. */
export const CommunityAdminHostDeletionRequestSchema = z.strictObject({
  lifecycleVersion: version,
  confirmIdSuffix: z.string().length(8),
});

/** Place a legal hold, or update the reference of the one in place. */
export const CommunityAdminHostLegalHoldRequestSchema = z.strictObject({
  reference: z.string().trim().min(1).max(200).nullable(),
});

/** Owner lifecycle mutation with recent password confirmation. */
export const CommunityAdminOwnerLifecycleRequestSchema = z.strictObject({
  action: z.enum(['archive', 'restore']),
  lifecycleVersion: version,
  password: z.string().min(1),
  confirmName: z.string().max(80).optional(),
});

/** Owner deletion request with both immutable and display confirmations. */
export const CommunityAdminDeletionRequestSchema = z.strictObject({
  lifecycleVersion: version,
  password: z.string().min(1),
  confirmName: z.string().max(80),
  confirmIdSuffix: z.string().length(8),
});
/** Deletion request or cancellation status. */
export const CommunityAdminDeletionStatusSchema = z.strictObject({
  communityId: id,
  lifecycle: CommunityAdminLifecycleSchema,
  lifecycleVersion: version,
  deleteAfter: timestamp.nullable(),
  state: z.enum(['waiting', 'deleting', 'retrying']).nullable(),
  attempts: z.int().nonnegative(),
  /** Who asked for a pending deletion. Only the owner can cancel their own; only the host its. */
  requestedBy: z.enum(['owner', 'host']).nullable(),
  /** Where a cancel of a pending deletion returns the community. */
  returnsTo: z.enum(['archived', 'suspended', 'held']).nullable(),
  /**
   * Why the host removed the whole community, when it did and chose to say so (null when the
   * host withheld it, and for every other deletion). `requestedBy` is `host` either way.
   */
  takedown: z
    .strictObject({
      category: z.enum(['child_safety', 'illegal_content', 'legal_order', 'terms_violation']),
      reference: z.string().nullable(),
      createdAt: timestamp,
    })
    .nullable(),
  /**
   * The host took the whole community down, whether or not it said why: the owner always learns
   * that the host removed it, only the reason can be withheld. Added later.
   */
  removedByHost: z.boolean().optional(),
});

/** Host API key scopes. Host authority only; no scope reaches community content. */
export const CommunityAdminHostApiKeyScopeSchema = z.enum([
  'communities:read',
  'communities:write',
  'communities:lifecycle',
  'communities:import',
  /** Place and release a legal hold. `communities:lifecycle` does not imply it. */
  'communities:legal_hold',
  'communities:takedown',
  /**
   * Request, list, cancel, and reissue an owner replacement. No other scope implies it, and a
   * key needs it to read a replacement's details.
   */
  'communities:ownership',
  /**
   * Read the erasure journal: which members and accounts were erased, by id only. No other
   * scope implies it.
   */
  'communities:erasure_journal',
]);
/** A key holds each scope at most once, so it can hold at most every scope there is. */
const hostApiKeyScopes = z
  .array(CommunityAdminHostApiKeyScopeSchema)
  .min(1)
  .max(CommunityAdminHostApiKeyScopeSchema.options.length);

/** Host API key projection. Never carries the secret or its hash. */
export const CommunityAdminHostApiKeySchema = z.strictObject({
  id,
  label: z.string().trim().min(1).max(80),
  prefix: z.string().regex(/^dkh_[A-Za-z0-9_-]{6}$/),
  scopes: hostApiKeyScopes,
  issuedVia: z.enum(['browser', 'command']),
  /** The issuing host operator's display name; null for a key issued by the offline command. */
  issuedByOperator: z.string().min(1).nullable(),
  createdAt: timestamp,
  expiresAt: timestamp.nullable(),
  lastUsedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
});
/** Every host API key, newest first. */
export const CommunityAdminHostApiKeyListSchema = z.strictObject({
  keys: z.array(CommunityAdminHostApiKeySchema),
});
/** Issue a host API key. Needs a host operator's session and password; a key cannot issue keys. */
export const CommunityAdminHostApiKeyIssueRequestSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  scopes: hostApiKeyScopes,
  expiresInDays: z.int().min(1).max(365).nullable(),
  password: z.string().min(1),
});
/** Rotate a host API key; the old key keeps working for the overlap. */
export const CommunityAdminHostApiKeyRotateRequestSchema = z.strictObject({
  overlapMinutes: z.int().min(0).max(1_440),
  password: z.string().min(1),
});
/** One-time secret handoff, served with Cache-Control: no-store. */
export const CommunityAdminHostApiKeySecretResponseSchema = z.strictObject({
  key: CommunityAdminHostApiKeySchema,
  secret: z.string().regex(/^dkh_[A-Za-z0-9_-]{43}$/),
  previousKeyExpiresAt: timestamp.nullable(),
});
/** Revocation takes no input; it cannot be undone. */
export const CommunityAdminHostApiKeyRevokeRequestSchema = z.strictObject({});

/** Most erasure journal lines one read returns, and how many when `limit` is left out. */
export const COMMUNITY_ERASURE_JOURNAL_PAGE_MAX = 1_000;
const COMMUNITY_ERASURE_JOURNAL_PAGE_DEFAULT = 500;

/** Read the erasure journal after `cursor`, or from the start without one. */
export const CommunityAdminErasureJournalQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(COMMUNITY_ERASURE_JOURNAL_PAGE_MAX)
    .default(COMMUNITY_ERASURE_JOURNAL_PAGE_DEFAULT),
});

/**
 * One finished erasure, by id only: the same object the server logs and writes to
 * `COMMUNITY_ERASURE_JOURNAL`. Written one per line, the lines are what `erasure:reapply` reads.
 */
export const CommunityAdminErasureJournalLineSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('community.member_erased'), communityId: id, memberId: id }),
  z.strictObject({
    event: z.literal('community.account_erased'),
    userId: z.string().min(1).max(128),
  }),
]);

/**
 * One page of the erasure journal, oldest first. Keep `nextCursor` and send it next time, even
 * when `lines` is empty; `hasMore` says whether to ask again now. A cursor this server no longer
 * recognises, as after a backup restore, answers `410 CURSOR_STALE`: read again from the start.
 */
export const CommunityAdminErasureJournalPageSchema = z.strictObject({
  lines: z.array(CommunityAdminErasureJournalLineSchema).max(COMMUNITY_ERASURE_JOURNAL_PAGE_MAX),
  nextCursor: z.string().min(1),
  hasMore: z.boolean(),
});

/**
 * The host's own pointer for an owner replacement (a ticket or case number): 1 to 80 letters,
 * digits, spaces, and `._#-`. No `:` or `/`, so it can never read as a link. Shown to the owner
 * in the product as quoted plain text; never to admins or members, never in mail or audit.
 */
export const COMMUNITY_OWNER_REPLACEMENT_REFERENCE_PATTERN = /^[A-Za-z0-9 ._#-]{1,80}$/;
/**
 * Ask to make the account named in the request a community's owner. A host person must send
 * their `password`; a key must not. With single sign-on configured the request must name the
 * account's subject; without it, it must not.
 */
export const CommunityAdminOwnerReplacementRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  lifecycleVersion: version,
  reason: CommunityAdminOwnerReplacementReasonSchema,
  reference: z.string().regex(COMMUNITY_OWNER_REPLACEMENT_REFERENCE_PATTERN).nullable(),
  claimant: z.strictObject({
    /** The subject this host's OIDC issuer gives the new owner; stored with the issuer. */
    oidcSubject: z.string().min(1).max(255).nullable(),
  }),
  password: z.string().min(1).optional(),
});
/**
 * Host view of one owner replacement. Never a member id, name, email, or the OIDC subject:
 * `claimantNamed` only says whether the request names an account.
 */
export const CommunityAdminOwnerReplacementSchema = z.strictObject({
  replacementId: id,
  communityId: id,
  state: CommunityAdminOwnerReplacementStateSchema,
  reason: CommunityAdminOwnerReplacementReasonSchema,
  reference: z.string().regex(COMMUNITY_OWNER_REPLACEMENT_REFERENCE_PATTERN).nullable(),
  claimantNamed: z.boolean(),
  requestedAt: timestamp,
  /** A host person's display name, or a key's prefix. */
  requestedBy: z.strictObject({ kind: z.enum(['person', 'api_key']), label: z.string().min(1) }),
  /** Whether the owner's mail server took the notice. Accepted never means read. */
  notice: z.strictObject({
    state: z.enum(['pending', 'accepted', 'failed']),
    resolvedAt: timestamp.nullable(),
    /** Whether the owner's address was marked verified when the notice was sent. */
    verifiedAddress: z.boolean().nullable(),
  }),
  /** Which waiting period applies; null until the notice resolves. */
  wait: z.enum(['standard', 'long']).nullable(),
  claimableAfter: timestamp.nullable(),
  claimExpiresAt: timestamp.nullable(),
  claimReissuedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
  /**
   * On a `withdrawn` replacement: the host cancelled it, suspended the community, or started
   * deleting it. Null in every other state.
   */
  withdrawnBecause: z.enum(['cancelled', 'suspended', 'deletion']).nullable(),
  /** On an `objected` replacement: when the host may ask again. */
  cooldownUntil: timestamp.nullable(),
});
/**
 * A new owner replacement and its claim token, returned once with Cache-Control: no-store. On
 * a replay the token and link are null: they were only ever shown the first time.
 */
export const CommunityAdminOwnerReplacementCreateResponseSchema = z.strictObject({
  replacement: CommunityAdminOwnerReplacementSchema,
  claimToken: z.string().min(1).nullable(),
  /** The claim page with the token in the fragment, so it never reaches a server log. */
  claimUrl: z.url().nullable(),
  replayed: z.boolean(),
});
/** One community's owner replacements, newest first, at most 50. */
export const CommunityAdminOwnerReplacementListSchema = z.strictObject({
  replacements: z.array(CommunityAdminOwnerReplacementSchema).max(50),
});
/** Cancelling an open owner replacement takes no input. */
export const CommunityAdminOwnerReplacementCancelRequestSchema = z.strictObject({});
/** Reissuing an open replacement's claim token takes no input. */
export const CommunityAdminOwnerReplacementClaimTokenRequestSchema = z.strictObject({});
/**
 * A reissued claim token, returned once with Cache-Control: no-store. The old token stops
 * working, no date moves, and the owner is told.
 */
export const CommunityAdminOwnerReplacementClaimTokenSchema = z.strictObject({
  replacementId: id,
  claimToken: z.string().min(1),
  claimUrl: z.url(),
});

/** Start importing an owner export into a new, unclaimed community. The export arrives separately. */
export const CommunityAdminImportCreateRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1_000).nullable().optional(),
  admissionPolicy: CommunityAdminAdmissionPolicySchema.optional(),
  /** The new community's web address, set in the same transaction. Part of the key's payload. */
  shortName: CommunityShortNameSchema.optional(),
  /** Set in the same transaction and part of the idempotency key's payload. */
  limits: CommunityAdminLimitsUpdateRequestSchema.omit({ limitsVersion: true }).optional(),
  /** Restore as soon as the export checks out, instead of pausing at `validated`. */
  autoCommit: z.boolean().optional(),
});
/** What an owner export holds, measured before anything is restored. Counts and sizes only. */
export const CommunityAdminImportReportSchema = z.strictObject({
  /** The export's format: version 1 (one manifest), or version 2 (any size, in data files). */
  manifestVersion: z.union([z.literal(1), z.literal(2)]),
  sourceLifecycle: z.enum(['active', 'archived']),
  channels: z.int().nonnegative(),
  entries: z.int().nonnegative(),
  attachments: z.int().nonnegative(),
  historicalMembers: z.int().nonnegative(),
  historicalAgents: z.int().nonnegative(),
  auditEvents: z.int().nonnegative(),
  attachmentBytes: bytes,
  /** The bytes that will count against the community's storage limit. */
  countedBytes: bytes,
  fitsStorageLimit: z.boolean(),
  /** Channel names and descriptions longer than this host allows, shortened with an ellipsis. */
  shortened: z.int().nonnegative(),
});
/**
 * Why an import failed, redacted: a code, never a value from the export.
 *
 * - `IMPORT_ARCHIVE_INVALID`: the file is damaged or is not an owner export.
 * - `IMPORT_NOT_OWNER_EXPORT`: the file is a personal export.
 * - `IMPORT_VERSION_UNSUPPORTED`: the export's format version is one this host cannot read.
 * - `IMPORT_TOO_LARGE`: the export holds more than an import may.
 * - `STORAGE_LIMIT_REACHED`: its files do not fit the community's storage limit.
 * - `IMPORT_CHECKSUM_MISMATCH`: a file does not match the export's own record of it.
 * - `IMPORT_STORAGE_UNAVAILABLE`: the host could not store the files, after retrying.
 *
 * An upload window that closes before a matching file arrives, and a checked import left
 * uncommitted for seven days, end `cancelled` rather than `failed`.
 */
export const CommunityAdminImportFailureCodeSchema = z.enum([
  'IMPORT_ARCHIVE_INVALID',
  'IMPORT_NOT_OWNER_EXPORT',
  'IMPORT_VERSION_UNSUPPORTED',
  'IMPORT_TOO_LARGE',
  'STORAGE_LIMIT_REACHED',
  'IMPORT_CHECKSUM_MISMATCH',
  'IMPORT_STORAGE_UNAVAILABLE',
]);
/** One import, as the host reads it. Never names, text, or the upload token. */
export const CommunityAdminImportSchema = z.strictObject({
  importId: id,
  /** The new community; null once a cancelled or failed import's community has been removed. */
  communityId: id.nullable(),
  state: CommunityAdminImportStateSchema,
  /** Set from `validated` on. */
  report: CommunityAdminImportReportSchema.nullable(),
  /** Set exactly when `state` is `failed`. */
  failureCode: CommunityAdminImportFailureCodeSchema.nullable(),
  autoCommit: z.boolean(),
  archiveBytes: bytes.nullable(),
  uploadExpiresAt: timestamp,
  /** The largest export this host accepts in one upload. */
  maxArchiveBytes: bytes,
  createdAt: timestamp,
  updatedAt: timestamp,
});
/** The started import. The upload token is returned once, only on the first answer. */
export const CommunityAdminImportCreateResponseSchema = z.strictObject({
  import: CommunityAdminImportSchema,
  uploadToken: z.string().min(1).nullable(),
  replayed: z.boolean(),
});
/** Commit and cancel take no input. */
export const CommunityAdminImportMutationRequestSchema = z.strictObject({});

/** A SHA-256 digest as lowercase hex. */
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
/** The most parts one export may be uploaded in. */
export const COMMUNITY_IMPORT_MAX_PARTS = 10_000;

/** One received part of an export uploaded in parts. */
export const CommunityAdminImportPartSchema = z.strictObject({
  partNumber: z.int().min(1).max(COMMUNITY_IMPORT_MAX_PARTS),
  byteSize: bytes.positive(),
  sha256: sha256Hex,
});
/**
 * The parts received so far, in part-number order, so an uploader resumes after a crash, and
 * the limits the rest must keep to.
 */
export const CommunityAdminImportPartListSchema = z.strictObject({
  parts: z.array(CommunityAdminImportPartSchema).max(COMMUNITY_IMPORT_MAX_PARTS),
  /** The largest one part may be. */
  maxPartBytes: bytes.positive(),
  /** The largest whole export this host accepts in parts. */
  maxArchiveBytes: bytes.positive(),
});
/**
 * Put the uploaded parts together: exactly parts 1 to `parts`, whose bytes in order are
 * `archiveBytes` long with SHA-256 `archiveSha256`.
 */
export const CommunityAdminImportCompleteRequestSchema = z.strictObject({
  parts: z.int().min(1).max(COMMUNITY_IMPORT_MAX_PARTS),
  archiveBytes: bytes.positive(),
  archiveSha256: sha256Hex,
});

/** Why the host removed something. Shown to the owner and author as one plain sentence. */
export const CommunityAdminTakedownCategorySchema = z.enum([
  'child_safety',
  'illegal_content',
  'legal_order',
  'terms_violation',
]);
/** The host's own case number for a takedown. Never free text. */
const takedownReference = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
/**
 * Take down one message, one file, the community's icon, or the whole community, by id.
 *
 * A person (host operator session) must send `password`; a key must not. When `notify` is
 * omitted it is false for `child_safety` (telling the uploader can tip off someone under
 * investigation) and true for every other category; the response carries the value used.
 */
export const CommunityAdminTakedownRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entry'), entryId: id }),
    z.strictObject({ kind: z.literal('attachment'), attachmentId: id }),
    z.strictObject({ kind: z.literal('icon') }),
    z.strictObject({
      kind: z.literal('community'),
      lifecycleVersion: version,
      confirmIdSuffix: z.string().length(8),
    }),
  ]),
  category: CommunityAdminTakedownCategorySchema,
  reference: takedownReference.nullable(),
  notify: z.boolean().optional(),
  password: z.string().min(1).optional(),
});
/** Where a takedown's evidence copy stands. */
export const CommunityAdminTakedownEvidenceStateSchema = z.enum([
  'pending',
  'retrying',
  'stored',
  'failed',
  'not_configured',
  'nothing_to_preserve',
  /** `child_safety` or `legal_order` with no evidence store: bytes kept until released. */
  'held_on_primary',
]);
/** A takedown as host authority sees it: ids and states only, never content. */
export const CommunityAdminTakedownSchema = z.strictObject({
  id,
  communityId: id,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entry'), entryId: id }),
    z.strictObject({ kind: z.literal('attachment'), attachmentId: id, entryId: id.nullable() }),
    z.strictObject({ kind: z.literal('icon') }),
    z.strictObject({ kind: z.literal('community') }),
  ]),
  category: CommunityAdminTakedownCategorySchema,
  reference: z.string().nullable(),
  notify: z.boolean(),
  actor: z.strictObject({ kind: z.enum(['person', 'api_key']), id: z.string() }),
  state: z.enum(['active', 'reversed']),
  evidence: z.strictObject({
    state: CommunityAdminTakedownEvidenceStateSchema,
    /** SHA-256 of `record.json`, once stored. */
    recordSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    /** `takedowns/<id>/attempt-<n>/` once stored. */
    location: z.string().nullable(),
    attempts: z.int().nonnegative(),
    /** Unsettled for longer than the host's alert hours. */
    overdue: z.boolean(),
  }),
  deleteAfter: timestamp.nullable(),
  createdAt: timestamp,
  reversedAt: timestamp.nullable(),
});
/** One takedown, as create, replay, read, reverse, retry, and release answer. */
export const CommunityAdminTakedownResponseSchema = z.strictObject({
  takedown: CommunityAdminTakedownSchema,
});
/** One page of takedowns, newest first. Pass `nextAfter` as `after` for the next page. */
export const CommunityAdminTakedownListSchema = z.strictObject({
  takedowns: z.array(CommunityAdminTakedownSchema),
  nextAfter: id.nullable(),
  /** Whether this host has an evidence store, so the host page can warn when it has none. */
  evidenceStore: z.boolean(),
});
/** Reverse a community takedown within its window. A person sends `password`. */
export const CommunityAdminTakedownReverseRequestSchema = z.strictObject({
  lifecycleVersion: version,
  password: z.string().min(1).optional(),
});
/** Try a failed or held evidence copy again. Takes no input. */
export const CommunityAdminTakedownEvidenceRetryRequestSchema = z.strictObject({});
/** Release bytes held on this server to deletion. A person only, with their password. */
export const CommunityAdminTakedownReleaseHeldRequestSchema = z.strictObject({
  password: z.string().min(1).optional(),
});

const evidenceSession = z.strictObject({
  createdAt: timestamp,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});
/** An account as the evidence record names it: what the sign-in stored, nothing more. */
const evidenceAccount = z.strictObject({
  id: z.string(),
  email: z.string(),
  createdAt: timestamp,
  sessions: z.array(evidenceSession),
});
const evidenceFile = z.strictObject({
  id,
  name: z.string(),
  contentType: z.string(),
  byteSize: z.int().positive(),
  uploadedAt: timestamp,
  uploaderMemberId: id.nullable(),
  uploaderAgentId: id.nullable(),
  /** Relative to the attempt folder. */
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * True for a file its author or an admin had already taken out of the message before the
   * takedown, kept only because its bytes had not been swept yet. Absent in records written
   * before this field existed.
   */
  removedBeforeTakedown: z.boolean().optional(),
});

/**
 * `record.json`, the last file of a complete evidence attempt in the host's evidence store.
 * The server writes it and never reads it back; it is here so a host's own tooling can parse it.
 */
export const CommunityEvidenceRecordV1Schema = z.strictObject({
  version: z.literal(1),
  takedown: z.strictObject({
    id,
    createdAt: timestamp,
    actor: z.strictObject({
      kind: z.enum(['person', 'api_key']),
      id: z.string(),
      /** The operator's display name, for a person. */
      name: z.string().nullable(),
    }),
    category: CommunityAdminTakedownCategorySchema,
    reference: z.string().nullable(),
    notify: z.boolean(),
  }),
  server: z.strictObject({ publicUrl: z.string(), version: z.string() }),
  community: z.strictObject({ id, name: z.string(), lifecycle: CommunityAdminLifecycleSchema }),
  channel: z.strictObject({ id, name: z.string() }).nullable(),
  entry: z
    .strictObject({
      id,
      seq: z.int().positive(),
      createdAt: timestamp,
      text: z.string(),
      parentEntryId: id.nullable(),
      threadRootEntryId: id.nullable(),
      mentionIds: z.array(id),
      contentAlreadyRemoved: z.boolean(),
    })
    .nullable(),
  author: z
    .strictObject({
      memberId: id,
      displayName: z.string(),
      handle: z.string(),
      role: z.enum(['owner', 'admin', 'member']),
      kind: z.enum(['human', 'agent']),
      /** For an agent: the agent itself. Its owner is `memberId`. */
      agent: z.strictObject({ id, displayName: z.string(), handle: z.string() }).nullable(),
    })
    .nullable(),
  /** The author's account, or for an agent its owner's; null when it was already erased. */
  account: evidenceAccount.nullable(),
  files: z.array(evidenceFile),
  icon: z
    .strictObject({
      contentType: z.string(),
      byteSize: z.int().positive(),
      path: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  notes: z.array(z.string()),
  /**
   * A whole-community takedown's copy: the evidence export's segments, in order, beside this
   * file. Absent for a message, file, or icon.
   */
  archive: z
    .strictObject({
      format: z.literal('zip64'),
      manifestVersion: z.literal(2),
      segments: z.array(
        z.strictObject({
          /** Relative to the attempt folder: `archive.zip.000001` and on. */
          path: z.string(),
          byteSize: z.int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
      ),
      byteSize: z.int().positive(),
      /** How to read it: concatenate the segments in order to get one .zip. */
      note: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * A whole-community takedown: every member's account as it was at the takedown, so a later
   * erasure or sign-out cannot take it out of the copy. Absent for a message, file, or icon.
   */
  accounts: z
    .array(z.strictObject({ memberId: id, account: evidenceAccount }))
    .nullable()
    .optional(),
});

/**
 * What this host can do beyond the basics, for the host page and host programs. `mail` is true
 * only when the host has configured its own SMTP server; features that must reach a person who
 * may no longer open the community refuse to run without it. `oidc` is true when the host's own
 * single sign-on is configured.
 */
export const CommunityAdminHostCapabilitiesSchema = z.strictObject({
  mail: z.boolean(),
  oidc: z.boolean(),
});
