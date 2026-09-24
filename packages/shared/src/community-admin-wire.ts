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
  /** The import that made this community, and its state; both null when it was not imported. */
  importId: id.nullable(),
  importState: CommunityAdminImportStateSchema.nullable(),
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
});

/** Host API key scopes. Host authority only; no scope reaches community content. */
export const CommunityAdminHostApiKeyScopeSchema = z.enum([
  'communities:read',
  'communities:write',
  'communities:lifecycle',
  'communities:import',
]);

/** Host API key projection. Never carries the secret or its hash. */
export const CommunityAdminHostApiKeySchema = z.strictObject({
  id,
  label: z.string().trim().min(1).max(80),
  prefix: z.string().regex(/^dkh_[A-Za-z0-9_-]{6}$/),
  scopes: z.array(CommunityAdminHostApiKeyScopeSchema).min(1).max(4),
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
  scopes: z.array(CommunityAdminHostApiKeyScopeSchema).min(1).max(4),
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
  manifestVersion: z.literal(1),
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
