/**
 * "Continue with DorkOS" on a hub (A4, DOR-2936): the owner signs in with
 * their DorkOS account, and nobody else signs in at all.
 *
 * The sign-in client comes from the hub's assignment (`signIn` in
 * `@dork-labs/cloud-api` `HubAssignmentSchema`): a public client, so no
 * secret, the code flow with PKCE, `state` and `nonce`, one exact redirect
 * address, and the scopes `openid email profile`. It is built on Better Auth's
 * own `genericOAuth` provider, registered at once and set up only when someone
 * signs in, the way the Community does it (`apps/community/src/oidc.ts`), and
 * set up again whenever the assignment names a different client.
 *
 * Sign-in is open only while the hub serves, and only when:
 *
 * - the redirect address is exactly {@link HUB_SIGN_IN_CALLBACK_PATH} on the
 *   assignment's own address;
 * - the issuer's discovery document names exactly the assignment's issuer,
 *   over https;
 * - the ID token is signed by that issuer, carries the nonce, and its
 *   subject is exactly the pinned owner's account id. **Never matched by
 *   email.**
 *
 * The owner account is linked to that subject when the hub takes its
 * assignment ({@link linkHubOwner}), so a sign-in finds it and never creates
 * an account. Anyone else is turned away before anything is looked up.
 *
 * @module services/core/hub/hub-sign-in
 */
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { OAuthProvider } from 'better-auth/oauth2';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';

import { currentServerRole } from '../../../lib/server-role.js';
import { logger } from '../../../lib/logger.js';
import { hubServingState } from './hub-serving.js';

/** The provider id: in the callback path and in the owner's account row. */
export const HUB_SIGN_IN_PROVIDER_ID = 'dorkos';

/** Where the issuer sends the owner back, on the hub's own address. Agreed with DorkOS Cloud. */
export const HUB_SIGN_IN_CALLBACK_PATH = `/api/auth/callback/${HUB_SIGN_IN_PROVIDER_ID}`;

/** The only scopes a hub asks for. */
export const HUB_SIGN_IN_SCOPES = ['openid', 'email', 'profile'];

/** How long one discovery request may take before sign-in answers "unavailable". */
const DISCOVERY_TIMEOUT_MS = 10_000;

/** After a failed discovery, how long sign-in answers "unavailable" without asking again. */
const DISCOVERY_RETRY_MS = 30_000;

/** The sign-in client a serving hub uses, from its assignment. */
export interface HubSignInClient {
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** The only account this hub signs in. */
  ownerAccountId: string;
}

/**
 * The sign-in client this hub uses now, or `null` when sign-in is closed: not
 * a hub, not serving, no client in the assignment, or a redirect address that
 * is not exactly the callback on the hub's own address.
 */
export function currentHubSignInClient(): HubSignInClient | null {
  if (currentServerRole() !== 'hub') return null;
  const state = hubServingState();
  if (state.state !== 'serving') return null;
  const { signIn, issuer, ownerAccountId, address } = state.assignment;
  if (!signIn) return null;
  const expected = `${new URL(address).origin}${HUB_SIGN_IN_CALLBACK_PATH}`;
  if (signIn.redirectUri !== expected) {
    logger.error(
      '[Hub] The assignment`s sign-in redirect is not this hub`s callback; sign-in is off'
    );
    return null;
  }
  return {
    issuer: issuer.replace(/\/+$/u, ''),
    clientId: signIn.clientId,
    redirectUri: signIn.redirectUri,
    ownerAccountId,
  };
}

/**
 * Check a discovery document before trusting it: it names exactly the
 * assignment's issuer, and every endpoint is https. Plain http is allowed
 * only on loopback, when the issuer itself is a loopback http address (a local
 * test issuer). Returns why it was refused, or `null`.
 *
 * @param issuer - The assignment's issuer, no trailing slash.
 * @param document - The parsed discovery document.
 */
export function hubDiscoveryProblem(issuer: string, document: unknown): string | null {
  if (!document || typeof document !== 'object') return 'not a discovery document';
  const doc = document as Record<string, unknown>;
  if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/u, '') !== issuer) {
    return 'names a different issuer';
  }
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
    if (value === undefined && (key === 'userinfo_endpoint' || key === 'end_session_endpoint')) {
      continue;
    }
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
    if (!allowed) return `has a ${key} that is not https`;
  }
  return null;
}

type AuthContext = Parameters<NonNullable<BetterAuthPlugin['init']>>[0];
type Provider = OAuthProvider<Record<string, unknown>>;
type UserInfo = Awaited<ReturnType<Provider['getUserInfo']>>;
type Tokens = Parameters<Provider['getUserInfo']>[0];

/** The subject an ID token names; the provider already checked its signature and nonce. */
function idTokenSubject(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const claims = idToken.split('.')[1] ?? '';
    const { sub } = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Whether a sign-in is the hub's owner: a signed ID token (the provider
 * checked its signature and nonce) whose subject is exactly the pinned
 * owner's account id, and a profile, if any, about that same subject. The
 * email never counts.
 *
 * @param idToken - The ID token from the token response.
 * @param info - The profile the provider read.
 * @param ownerAccountId - The pinned owner's account id at the issuer.
 */
export function isTheOwner(
  idToken: string | undefined,
  info: { data?: unknown } | null,
  ownerAccountId: string
): boolean {
  const subject = idTokenSubject(idToken);
  if (!info || !subject || subject !== ownerAccountId) return false;
  const profileSubject = (info.data as { sub?: unknown } | undefined)?.sub;
  return profileSubject === undefined || profileSubject === subject;
}

/**
 * Whether a request is the return from the issuer, or a sign-in that starts
 * with this provider.
 */
function usesHubSignIn(ctx: { path?: string; params?: unknown; body?: unknown }): boolean {
  const params = ctx.params as { id?: string } | undefined;
  if (ctx.path === `/callback/${HUB_SIGN_IN_PROVIDER_ID}`) return true;
  if (ctx.path === '/callback/:id' && params?.id === HUB_SIGN_IN_PROVIDER_ID) return true;
  const body = ctx.body as { provider?: string; providerId?: string } | undefined;
  const named = body?.provider ?? body?.providerId;
  return (
    named === HUB_SIGN_IN_PROVIDER_ID &&
    ['/sign-in/social', '/link-social', '/get-access-token', '/refresh-token'].includes(
      ctx.path ?? ''
    )
  );
}

/**
 * The hub's sign-in, as a Better Auth plugin. Inert on a person's own
 * computer: there the provider is never set up and every use of it is
 * refused.
 *
 * @param options - `now` and `readClient` replace the clock and the client, for tests.
 */
export function hubSignInPlugin(
  options: { now?: () => number; readClient?: () => HubSignInClient | null } = {}
): BetterAuthPlugin {
  const now = options.now ?? Date.now;
  const readClient = options.readClient ?? currentHubSignInClient;
  let context: AuthContext | null = null;
  let resolved: { key: string; provider: Provider; client: HubSignInClient } | null = null;
  let pending: { key: string; work: Promise<void> } | null = null;
  let failed: { key: string; at: number } | null = null;

  const discover = async (client: HubSignInClient): Promise<Provider> => {
    if (!context) throw new Error('Sign-in used before Better Auth started');
    const discoveryUrl = `${client.issuer}/.well-known/openid-configuration`;
    const response = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`discovery answered ${response.status}`);
    const document = (await response.json()) as unknown;
    const problem = hubDiscoveryProblem(client.issuer, document);
    if (problem) throw new Error(`the discovery document ${problem}`);
    const checked = document as Record<string, string | undefined>;
    // The endpoints people, codes and tokens go to are the ones checked above,
    // passed explicitly. Better Auth reads the document once more itself, for
    // the issuer and the keys ID tokens are checked against; that read is held
    // to the same issuer below, and to a deadline. An issuer that answers it
    // with different keys could sign tokens anyway: it is the issuer.
    const inner = genericOAuth({
      config: [
        {
          providerId: HUB_SIGN_IN_PROVIDER_ID,
          name: 'DorkOS',
          discoveryUrl,
          authorizationUrl: checked.authorization_endpoint,
          tokenUrl: checked.token_endpoint,
          userInfoUrl: checked.userinfo_endpoint,
          clientId: client.clientId,
          // Signing out of this hub never signs the owner out of DorkOS.
          disableProviderLogout: true,
          redirectURI: client.redirectUri,
          scopes: HUB_SIGN_IN_SCOPES,
          pkce: true,
          requireIdTokenVerification: true,
        },
      ],
    });
    if (!inner.init) throw new Error('Better Auth genericOAuth has no setup step');
    const setup = await Promise.race([
      Promise.resolve(inner.init(context)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('discovery timed out')), DISCOVERY_TIMEOUT_MS).unref()
      ),
    ]);
    const providers = (setup as { context?: { socialProviders?: Provider[] } } | undefined)?.context
      ?.socialProviders;
    const provider = providers?.find(
      (candidate) => candidate.id === HUB_SIGN_IN_PROVIDER_ID && candidate !== lazy
    );
    if (!provider || (provider.issuer ?? '').replace(/\/+$/u, '') !== client.issuer) {
      throw new Error('discovery failed');
    }
    return provider;
  };

  const resolve = async (): Promise<void> => {
    const client = readClient();
    if (!client) throw new Error('sign-in is closed');
    const key = JSON.stringify(client);
    if (resolved?.key === key) return;
    if (failed?.key === key && now() - failed.at < DISCOVERY_RETRY_MS) {
      throw new Error('discovery failed recently');
    }
    // Sign-ins that start together share one setup.
    if (pending?.key !== key) {
      const work = discover(client).then(
        (provider) => {
          resolved = { key, provider, client };
          failed = null;
        },
        (err: unknown) => {
          failed = { key, at: now() };
          logger.error('[Hub] Sign-in with DorkOS is unavailable', {
            error: err instanceof Error ? err.message : 'unknown',
          });
          throw err;
        }
      );
      pending = { key, work };
      void work
        .finally(() => {
          if (pending?.work === work) pending = null;
        })
        .catch(() => undefined);
    }
    await pending.work;
  };

  /** The identity a sign-in may use: the pinned owner, vouched for by a signed ID token. */
  const onlyTheOwner = (tokens: Tokens, info: UserInfo): UserInfo => {
    const client = readClient();
    return client && isTheOwner(tokens.idToken, info, client.ownerAccountId) ? info : null;
  };

  // Stands in for the real provider until it is set up; every call waits for it.
  const lazy: Provider = new Proxy({} as Provider, {
    get(_, key) {
      if (key === 'id') return HUB_SIGN_IN_PROVIDER_ID;
      if (key === 'name') return 'DorkOS';
      if (!resolved) return undefined;
      const provider = resolved.provider;
      // A bare ID token would sign in from anywhere; only the redirect does.
      if (key === 'options') return { ...provider.options, disableIdTokenSignIn: true };
      if (key === 'getUserInfo') {
        return async (tokens: Tokens) => onlyTheOwner(tokens, await provider.getUserInfo(tokens));
      }
      const value = provider[key as keyof Provider];
      return typeof value === 'function' ? value.bind(provider) : value;
    },
  });

  return {
    id: 'dorkos-hub-sign-in',
    init: async (ctx) => {
      context = ctx;
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
    hooks: {
      before: [
        {
          matcher: usesHubSignIn,
          handler: createAuthMiddleware(async () => {
            try {
              await resolve();
            } catch {
              throw new APIError('SERVICE_UNAVAILABLE', {
                code: 'hub_sign_in_unavailable',
                message: 'Sign-in with DorkOS is unavailable right now. Try again soon.',
              });
            }
          }),
        },
      ],
    },
  };
}
