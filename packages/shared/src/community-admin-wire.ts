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
  /**
   * Why the host removed the whole community, when it did and chose to say so. Always null
   * until whole-community takedowns ship.
   */
  takedown: z
    .strictObject({
      category: z.enum(['child_safety', 'illegal_content', 'legal_order', 'terms_violation']),
      reference: z.string().nullable(),
      createdAt: timestamp,
    })
    .nullable(),
});

/** Host API key scopes. Host authority only; no scope reaches community content. */
export const CommunityAdminHostApiKeyScopeSchema = z.enum([
  'communities:read',
  'communities:write',
  'communities:lifecycle',
  'communities:import',
  'communities:takedown',
]);

/** Host API key projection. Never carries the secret or its hash. */
export const CommunityAdminHostApiKeySchema = z.strictObject({
  id,
  label: z.string().trim().min(1).max(80),
  prefix: z.string().regex(/^dkh_[A-Za-z0-9_-]{6}$/),
  scopes: z.array(CommunityAdminHostApiKeyScopeSchema).min(1).max(5),
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
  scopes: z.array(CommunityAdminHostApiKeyScopeSchema).min(1).max(5),
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
});
