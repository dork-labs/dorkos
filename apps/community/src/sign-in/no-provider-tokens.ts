/**
 * Room-only power for a space sign-in (DOR-2957, specs/everything-is-a-space C8). Signing in to
 * a space with Google, GitHub or a DorkOS account proves who you are, and that is all the space
 * keeps: never the provider's access, refresh or ID token, which could act in that account
 * outside the space. A space that held them could read your mail, your repositories or your
 * DorkOS account long after you signed in. Migration 0045 clears the ones stored before this.
 */

/** Every token column Better Auth's `account` row has. */
export const PROVIDER_TOKEN_FIELDS = [
  'accessToken',
  'refreshToken',
  'idToken',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt',
] as const;

/**
 * An account row as it may be written: the same fields, with every provider token cleared.
 * Better Auth hands each create and update through this before it writes the row.
 */
export function withoutProviderTokens<T extends object>(account: T): T {
  const cleared = { ...account } as Record<string, unknown>;
  for (const field of PROVIDER_TOKEN_FIELDS) cleared[field] = null;
  return cleared as T;
}
