/**
 * Host account wire schemas: an account's id, finding it by its sign-in identity, and listing the
 * spaces it belongs to. Kept apart from the rest of the admin wire, which re-exports them.
 */
import { z } from 'zod';

/**
 * A host account's id, as Better Auth stores it. Opaque: never an email or a sign-in identity.
 */
export const CommunityAdminAccountIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'An account id is 1 to 128 letters, digits, `_` or `-`.');

/**
 * Find the host account that signs in through this host's single sign-on with one identity. The
 * issuer must be the one this host is configured with; only an exact match answers, so the
 * lookup cannot list or guess other accounts.
 */
export const CommunityAdminAccountLookupRequestSchema = z.strictObject({
  issuer: z.string().min(1).max(2048),
  subject: z.string().min(1).max(255),
});
/** The account that signs in with the identity asked about. A miss is `404 NOT_FOUND`. */
export const CommunityAdminAccountLookupResponseSchema = z.strictObject({
  accountId: CommunityAdminAccountIdSchema,
});

/** Most spaces one account-spaces answer lists; past it the answer says `truncated`. */
export const HOST_ACCOUNT_SPACES_MAX = 500;

/**
 * List the spaces the account that signs in with one single sign-on identity belongs to. The
 * same identity as the lookup, sent in a body so it never lands in a URL. Needs `accounts:read`.
 */
export const CommunityAdminAccountSpacesRequestSchema = CommunityAdminAccountLookupRequestSchema;

/**
 * One space the account belongs to as a person, never as an agent: its id, name, public address,
 * the person's role, and whether the space is open or archived. Nothing anyone wrote in it.
 */
export const CommunityAdminAccountSpaceSchema = z.strictObject({
  communityId: z.uuid(),
  name: z.string().min(1).max(80),
  /** The space's public address on this server. */
  url: z.url(),
  role: z.enum(['owner', 'admin', 'member']),
  state: z.enum(['active', 'archived']),
});

/**
 * The spaces the account belongs to, sorted by name, at most
 * {@link HOST_ACCOUNT_SPACES_MAX}. An identity no account here signs in with answers
 * an empty list, never `404`. Spaces that are held, suspended, waiting to be deleted or still
 * waiting for an owner are left out, as are memberships that ended.
 */
export const CommunityAdminAccountSpacesResponseSchema = z.strictObject({
  spaces: z.array(CommunityAdminAccountSpaceSchema).max(HOST_ACCOUNT_SPACES_MAX),
  /** True when the account belongs to more spaces than the list holds. */
  truncated: z.boolean(),
});
