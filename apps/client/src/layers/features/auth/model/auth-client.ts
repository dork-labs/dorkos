/**
 * Auth client — the single seam that speaks to the server's Better Auth REST API
 * (`/api/auth/*`). Nothing outside `features/auth/model` talks to these endpoints;
 * components consume the hooks in this slice, never this module directly.
 *
 * ## Why a thin fetch client, not `better-auth/client`
 *
 * The spec calls for wrapping `createAuthClient` from `better-auth/client`. That
 * package is a dependency of `apps/server`/`apps/site`/`packages/cli` but NOT of
 * `@dorkos/client`, and adding it would require a `pnpm install` (forbidden here —
 * the lockfile is shared with a concurrent workstream, and a package.json/lockfile
 * mismatch would break `--frozen-lockfile` for CI and every other checkout). So
 * this module implements the exact same REST contract with the existing fetch
 * stack. The public {@link AuthClient} shape mirrors Better Auth's client
 * (`signIn.email`, `signUp.email`, `signOut`, `getSession`, `apiKey.*`, all
 * returning `{ data, error }`) so swapping the internals to `createAuthClient`
 * later is a one-file change behind the hooks.
 *
 * @module features/auth/model/auth-client
 */
import { resolveApiBaseUrl } from '@/layers/shared/lib';

/** A local owner/user record as returned by Better Auth. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** 'owner' for the first (and, in P1, only) account; may be absent on older rows. */
  role?: string | null;
  emailVerified?: boolean;
}

/** The resolved session + user, or `null` when signed out. */
export interface AuthSession {
  user: AuthUser;
  session: { id: string; expiresAt: string; userId: string };
}

/** A normalized error from an auth call (never thrown — returned in {@link AuthResult}). */
export interface AuthError {
  message: string;
  status: number;
  code?: string;
  /** Seconds to wait before retrying, when the server rate-limited the request. */
  retryAfter?: number;
}

/** Better Auth-style result envelope: exactly one of `data` / `error` is set. */
export interface AuthResult<T> {
  data: T | null;
  error: AuthError | null;
}

/** A per-user API key as listed by the `apiKey` plugin (never includes the secret). */
export interface ApiKeyRecord {
  id: string;
  name: string | null;
  /** First few characters of the key, for recognition (the full key is never re-shown). */
  start: string | null;
  prefix: string | null;
  createdAt: string;
  expiresAt: string | null;
  enabled: boolean;
}

/** A freshly created API key — the only time the plaintext `key` is ever returned. */
export interface CreatedApiKey extends ApiKeyRecord {
  key: string;
}

/** The auth client surface consumed by this slice's hooks. Mirrors `better-auth/client`. */
export interface AuthClient {
  signIn: {
    email(input: {
      email: string;
      password: string;
      rememberMe?: boolean;
    }): Promise<AuthResult<{ token: string; user: AuthUser }>>;
  };
  signUp: {
    email(input: {
      email: string;
      password: string;
      name: string;
    }): Promise<AuthResult<{ token?: string; user: AuthUser }>>;
  };
  signOut(): Promise<AuthResult<{ success: boolean }>>;
  getSession(): Promise<AuthResult<AuthSession | null>>;
  apiKey: {
    create(input: { name?: string; expiresIn?: number | null }): Promise<AuthResult<CreatedApiKey>>;
    list(): Promise<AuthResult<ApiKeyRecord[]>>;
    delete(input: { keyId: string }): Promise<AuthResult<{ success: boolean }>>;
  };
}

/** Parse a Better Auth error body + headers into a normalized {@link AuthError}. */
async function toAuthError(res: Response): Promise<AuthError> {
  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
  const retryHeader = res.headers.get('X-Retry-After') ?? res.headers.get('Retry-After');
  const retryAfter = retryHeader ? Number(retryHeader) : undefined;
  return {
    message: body.message || res.statusText || `Request failed (${res.status})`,
    status: res.status,
    code: body.code,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
  };
}

/**
 * Build an {@link AuthClient} bound to a server base URL.
 *
 * @param baseUrl - The `/api` base URL (see {@link resolveApiBaseUrl}).
 */
export function createAuthRestClient(baseUrl: string): AuthClient {
  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<AuthResult<T>> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/auth${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return {
        data: null,
        error: { message: 'Network error — could not reach the server.', status: 0 },
      };
    }
    if (!res.ok) {
      return { data: null, error: await toAuthError(res) };
    }
    // Better Auth returns 200 with a `null` body for a signed-out get-session.
    const data = (await res.json().catch(() => null)) as T;
    return { data, error: null };
  }

  return {
    signIn: {
      email: (input) => request('POST', '/sign-in/email', input),
    },
    signUp: {
      email: (input) => request('POST', '/sign-up/email', input),
    },
    signOut: () => request('POST', '/sign-out'),
    getSession: () => request('GET', '/get-session'),
    apiKey: {
      create: (input) => request('POST', '/api-key/create', input),
      list: () => request('GET', '/api-key/list'),
      delete: (input) => request('POST', '/api-key/delete', input),
    },
  };
}

/** The default app-wide auth client, bound to the resolved API origin. */
export const authClient: AuthClient = createAuthRestClient(resolveApiBaseUrl());
