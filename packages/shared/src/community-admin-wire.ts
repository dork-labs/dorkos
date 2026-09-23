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
  'deletion_pending',
]);
/** Community admission policy. */
export const CommunityAdminAdmissionPolicySchema = z.enum(['invite_only', 'closed']);

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
  createdAt: timestamp,
});

/** Idempotent host request for one unclaimed Community. */
export const CommunityAdminCreateRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1_000).nullable().optional(),
  admissionPolicy: CommunityAdminAdmissionPolicySchema.optional(),
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

/** Host suspension transition uses the current lifecycle version. */
export const CommunityAdminHostLifecycleRequestSchema = z.strictObject({
  action: z.enum(['suspend', 'resume']),
  lifecycleVersion: version,
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
