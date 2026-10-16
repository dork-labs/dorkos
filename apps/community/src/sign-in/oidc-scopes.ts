/** One OAuth scope token (RFC 6749 §3.3): printable ASCII except space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

/**
 * What a sign-in with a DorkOS account may ask for: who you are, and nothing that acts in your
 * account. A space signs you in to its rooms only (DOR-2957, room-only power for a space sign-in);
 * a scope that reached your DorkOS account, your computers or your agents would give the space
 * power outside them.
 */
export const DORKOS_SIGN_IN_SCOPES: readonly string[] = ['openid', 'email', 'profile'];

/**
 * Read `COMMUNITY_OIDC_SCOPES`: space-separated scope tokens that include `openid`, at most 16,
 * `openid email profile` when unset. With the DorkOS mark, only {@link DORKOS_SIGN_IN_SCOPES}.
 *
 * @param raw - The setting's value, if set.
 * @param dorkos - Whether the issuer is a DorkOS account (`COMMUNITY_OIDC_MARK=dorkos`).
 * @returns The scopes to ask for, each once.
 */
export function parseOidcScopes(raw: string | undefined, dorkos: boolean): string[] {
  const scopes = (raw ?? 'openid email profile').split(/\s+/u).filter(Boolean);
  if (
    !scopes.includes('openid') ||
    scopes.length > 16 ||
    scopes.some((scope) => !SCOPE_TOKEN.test(scope))
  )
    throw new Error('COMMUNITY_OIDC_SCOPES must be space-separated scopes that include openid');
  if (dorkos && scopes.some((scope) => !DORKOS_SIGN_IN_SCOPES.includes(scope)))
    throw new Error(
      'COMMUNITY_OIDC_SCOPES may ask a DorkOS account only for openid, email and profile: a space signs people in to its rooms, never to their account'
    );
  return [...new Set(scopes)];
}
