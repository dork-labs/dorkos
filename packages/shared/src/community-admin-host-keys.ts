/** Host API key wire schemas, kept apart from the rest of the admin wire, which re-exports them. */
import { z } from 'zod';

const id = z.uuid();
const timestamp = z.iso.datetime();

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
  /**
   * Close someone else's account on this host: find it by its single sign-on identity, close it
   * (the person is signed out and cannot sign in, and the account is erased after the same
   * waiting period a person's own request has), read the closure, and cancel it during the wait.
   * No other scope implies it.
   */
  'accounts:close',
  /**
   * Create a community under a reserved short name, such as the host's own official space. No
   * other scope implies it.
   */
  'communities:reserved_names',
  /**
   * List the spaces an account belongs to, found by its single sign-on identity: each space's id,
   * name, address, the person's role and whether it is open or archived. Never anything anyone
   * wrote. No other scope implies it, `accounts:close` included.
   */
  'accounts:read',
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
