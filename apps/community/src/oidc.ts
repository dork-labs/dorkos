import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { OAuthProvider } from 'better-auth/oauth2';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import type { CommunityOidcConfig } from './config.js';

/** The one provider ID the host's OpenID Connect sign-in uses, in routes and account rows. */
export const OIDC_PROVIDER_ID = 'oidc';

/** How long one discovery request may take before sign-in answers "unavailable". */
export const OIDC_DISCOVERY_TIMEOUT_MS = 10_000;

/** After a failed discovery, how long sign-in answers "unavailable" without asking again. */
export const OIDC_DISCOVERY_RETRY_MS = 30_000;

/**
 * The redirect URI a host registers with its issuer. Better Auth serves every provider, generic
 * ones included, at `/api/auth/callback/<provider id>`.
 */
export function oidcCallbackUrl(publicUrl: string): string {
  return `${publicUrl}/api/auth/callback/${OIDC_PROVIDER_ID}`;
}

type AuthContext = Parameters<NonNullable<BetterAuthPlugin['init']>>[0];
type Provider = OAuthProvider<Record<string, unknown>>;
type UserInfo = Awaited<ReturnType<Provider['getUserInfo']>>;
type Tokens = Parameters<Provider['getUserInfo']>[0];

/** Sign-in paths that act through the OIDC provider and so need its discovery document first. */
function usesOidc(ctx: { path?: string; params?: unknown; body?: unknown }): boolean {
  const params = ctx.params as { id?: string } | undefined;
  const body = ctx.body as { provider?: string } | undefined;
  if (ctx.path === `/callback/${OIDC_PROVIDER_ID}`) return true;
  if (ctx.path === '/callback/:id') return params?.id === OIDC_PROVIDER_ID;
  return (
    (ctx.path === '/sign-in/social' || ctx.path === '/link-social') &&
    body?.provider === OIDC_PROVIDER_ID
  );
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/u, '');

/**
 * Check a discovery document before trusting it: it must name exactly the configured issuer, and
 * every endpoint must be HTTPS. Plain HTTP is allowed only on loopback, and only when the issuer
 * itself is a loopback HTTP address (a local test issuer). Returns the reason it was refused.
 */
export function discoveryProblem(issuer: string, document: unknown): string | null {
  if (!document || typeof document !== 'object') return 'not a discovery document';
  const doc = document as Record<string, unknown>;
  if (typeof doc.issuer !== 'string' || withoutTrailingSlash(doc.issuer) !== issuer)
    return 'names a different issuer';
  const configured = new URL(issuer);
  const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1';
  const localIssuer = configured.protocol === 'http:' && loopback(configured.hostname);
  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'userinfo_endpoint',
    'end_session_endpoint',
  ]) {
    const value = doc[key];
    if (value === undefined && (key === 'userinfo_endpoint' || key === 'end_session_endpoint'))
      continue;
    if (typeof value !== 'string') return `has no ${key}`;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `has an invalid ${key}`;
    }
    const allowed =
      url.protocol === 'https:' ||
      (localIssuer && url.protocol === 'http:' && loopback(url.hostname));
    if (!allowed) return `has a ${key} that is not HTTPS`;
  }
  return null;
}

/**
 * Refuse any identity the issuer did not vouch for in a signed ID token: no ID token at all, an
 * unverified email, or profile data (from the userinfo endpoint) about a different subject than
 * the ID token. Returning no user makes Better Auth redirect with `unable_to_get_user_info`
 * before it looks up, links or creates anything. The ID token's signature and nonce were already
 * checked by the provider, against the discovered JWKS.
 */
function requireVouchedIdentity(tokens: Tokens, info: UserInfo): UserInfo {
  if (!tokens.idToken || !info || info.user.emailVerified !== true) return null;
  let subject: unknown;
  try {
    // Only the claims are read here; the provider has already checked the signature.
    const claims = tokens.idToken.split('.')[1] ?? '';
    subject = (JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { sub?: unknown })
      .sub;
  } catch {
    return null;
  }
  const profileSubject = (info.data as { sub?: unknown } | undefined)?.sub;
  return typeof subject === 'string' && subject && profileSubject === subject ? info : null;
}

/**
 * The host's OpenID Connect sign-in, built on Better Auth's own `genericOAuth` provider.
 *
 * Better Auth fetches a generic provider's discovery document when the auth instance starts, and
 * skips the provider for good if the issuer is down then. This wrapper registers the provider at
 * once but runs that same `genericOAuth` setup (discovery, JWKS, PKCE, nonce binding) only when
 * someone first signs in, links or returns from the issuer. So the server starts, and makes no
 * outbound request, whatever the issuer's state. Before that setup runs, the discovery document
 * is fetched once with a timeout and checked (see {@link discoveryProblem}); a failure answers
 * "unavailable" for {@link OIDC_DISCOVERY_RETRY_MS} and is then retried.
 *
 * Sign-in is only ever through the redirect: the provider refuses a bare ID token
 * (`disableIdTokenSignIn`), because one replayed from anywhere would mint a fresh session.
 */
export function communityOidc(
  oidc: CommunityOidcConfig,
  { now = () => new Date() }: { now?: () => Date } = {}
): BetterAuthPlugin {
  const discoveryUrl = `${oidc.issuer}/.well-known/openid-configuration`;
  const inner = genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: oidc.label,
        discoveryUrl,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        scopes: oidc.scopes,
        pkce: true,
        // Refuse the provider unless discovery yields an issuer and JWKS to verify ID tokens.
        requireIdTokenVerification: true,
      },
    ],
  });
  let context: AuthContext | null = null;
  let resolved: Provider | null = null;
  let pending: Promise<Provider> | null = null;
  let failedAt: number | null = null;

  const withTimeout = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('OIDC discovery timed out')),
          OIDC_DISCOVERY_TIMEOUT_MS
        ).unref()
      ),
    ]);

  const discover = async (): Promise<Provider> => {
    if (!context || !inner.init) throw new Error('OIDC used before Better Auth started');
    const response = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(OIDC_DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OIDC discovery answered ${response.status}`);
    const problem = discoveryProblem(oidc.issuer, await response.json());
    if (problem) throw new Error(`OIDC discovery document ${problem}`);
    const setup = await withTimeout(Promise.resolve(inner.init(context)));
    const providers = (setup as { context?: { socialProviders?: Provider[] } } | undefined)?.context
      ?.socialProviders;
    // The list also holds this stand-in (same ID); a failed discovery leaves only that.
    const provider = providers?.find(
      (candidate) => candidate.id === OIDC_PROVIDER_ID && candidate !== lazy
    );
    // Better Auth fetched the document again; hold it to the same issuer as the checked one.
    if (!provider || withoutTrailingSlash(provider.issuer ?? '') !== oidc.issuer)
      throw new Error('OIDC discovery failed');
    return provider;
  };

  const resolve = (): Promise<Provider> => {
    if (resolved) return Promise.resolve(resolved);
    if (failedAt !== null && now().getTime() - failedAt < OIDC_DISCOVERY_RETRY_MS)
      return Promise.reject(new Error('OIDC discovery failed recently'));
    pending ??= discover()
      .then(
        (provider) => {
          resolved = provider;
          failedAt = null;
          return provider;
        },
        (cause: unknown) => {
          failedAt = now().getTime();
          context?.logger.error(
            `Single sign-on is unavailable: ${cause instanceof Error ? cause.message : 'unknown'}`
          );
          throw cause;
        }
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  // Stands in for the real provider until discovery has run; every call waits for it.
  const lazy: Provider = new Proxy({} as Provider, {
    get(_, key) {
      if (key === 'id') return OIDC_PROVIDER_ID;
      if (key === 'name') return oidc.label;
      if (!resolved) return undefined;
      const provider = resolved;
      if (key === 'options') return { ...provider.options, disableIdTokenSignIn: true };
      if (key === 'getUserInfo')
        return async (tokens: Tokens) =>
          requireVouchedIdentity(tokens, await provider.getUserInfo(tokens));
      const value = provider[key as keyof Provider];
      return typeof value === 'function' ? value.bind(provider) : value;
    },
  });

  return {
    id: 'community-oidc',
    init: async (ctx) => {
      context = ctx;
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
    hooks: {
      before: [
        {
          matcher: usesOidc,
          handler: createAuthMiddleware(async () => {
            try {
              await resolve();
            } catch {
              throw new APIError('SERVICE_UNAVAILABLE', {
                code: 'oidc_unavailable',
                message:
                  'Single sign-on is unavailable right now. Try again, or use your password.',
              });
            }
          }),
        },
      ],
    },
  };
}
