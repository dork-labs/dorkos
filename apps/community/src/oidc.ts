import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { OAuthProvider } from 'better-auth/oauth2';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import type { CommunityOidcConfig } from './config.js';

/** The one provider ID the host's OpenID Connect sign-in uses, in routes and account rows. */
export const OIDC_PROVIDER_ID = 'oidc';

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

/**
 * Refuse an identity whose issuer did not vouch for its email. Returning no user makes Better
 * Auth redirect with `unable_to_get_user_info` before it looks up, links or creates anything.
 */
function requireVerifiedEmail(info: UserInfo): UserInfo {
  return info?.user.emailVerified === true ? info : null;
}

/**
 * The host's OpenID Connect sign-in, built on Better Auth's own `genericOAuth` provider.
 *
 * Better Auth fetches a generic provider's discovery document when the auth instance starts,
 * and skips the provider for good if the issuer is down then. This wrapper registers the provider
 * at once but runs that same `genericOAuth` setup (discovery, JWKS, PKCE, nonce binding) only when
 * someone first signs in, links or returns from the issuer. So the server starts, and makes no
 * outbound request, whatever the issuer's state; and a failed discovery is retried on the next
 * attempt instead of disabling sign-in until a restart.
 */
export function communityOidc(oidc: CommunityOidcConfig): BetterAuthPlugin {
  const inner = genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: oidc.label,
        discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        scopes: oidc.scopes,
        pkce: true,
        // Only a signed ID token from the discovered issuer and JWKS names a person.
        requireIdTokenVerification: true,
      },
    ],
  });
  let context: AuthContext | null = null;
  let resolved: Provider | null = null;
  let pending: Promise<Provider> | null = null;

  const resolve = (): Promise<Provider> => {
    if (resolved) return Promise.resolve(resolved);
    pending ??= (async () => {
      if (!context || !inner.init) throw new Error('OIDC used before Better Auth started');
      const setup = await inner.init(context);
      const providers = (setup as { context?: { socialProviders?: Provider[] } } | undefined)
        ?.context?.socialProviders;
      // The list also holds this stand-in (same ID); a failed discovery leaves only that.
      const provider = providers?.find(
        (candidate) => candidate.id === OIDC_PROVIDER_ID && candidate !== lazy
      );
      if (!provider) throw new Error('OIDC discovery failed');
      resolved = provider;
      return provider;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };

  // Stands in for the real provider until discovery has run; every call waits for it.
  const lazy = new Proxy({} as Provider, {
    get(_, key) {
      if (key === 'id') return OIDC_PROVIDER_ID;
      if (key === 'name') return oidc.label;
      if (resolved) {
        if (key === 'getUserInfo')
          return async (...args: Parameters<Provider['getUserInfo']>) =>
            requireVerifiedEmail(await resolved!.getUserInfo(...args));
        const value = resolved[key as keyof Provider];
        return typeof value === 'function' ? value.bind(resolved) : value;
      }
      return undefined;
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
