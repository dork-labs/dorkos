/**
 * Caller tokens: how the server knows which app a call between apps came
 * from (DOR-3293, Security 2026-11-10).
 *
 * The person's window asks for one token per frame it loads, naming the app
 * that frame runs. The server mints it only for a person's window (never an
 * agent or an API key), only for an app whose screens run, and binds it to
 * that app and to the person's session. A call to another app's routes then
 * carries the token, and the server reads the calling app from its own record
 * of the token: a header naming an app counts for nothing on its own.
 *
 * Tokens live in this process only, expire after a few idle minutes, and die
 * with the session they were minted for.
 *
 * @module routes/extension-caller-token
 */
import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { calledApps, type ExtensionManifest } from '@dorkos/extension-api';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';

/** The header a call between apps carries its token in. */
export const CALLER_TOKEN_HEADER = 'x-dorkos-caller-token';

/** The code a refused or unknown token answers with, so the window can ask for a new one. */
export const CALLER_TOKEN_INVALID = 'caller_token_invalid';

/** How long a token lasts without being used. */
export const CALLER_TOKEN_IDLE_MS = 10 * 60 * 1000;

/** The most tokens kept at once; the oldest goes first. */
const MAX_TOKENS = 1000;

interface TokenRecord {
  appId: string;
  /** The session it was minted in: the cookie's session id, or `local` with sign-in off. */
  session: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenRecord>();

/** The session a request belongs to, as a token records it. */
function sessionOf(facts: Pick<RequestFacts, 'user'>): string {
  return facts.user?.sessionId ?? 'local';
}

/**
 * Whether a request comes from something other than a person's window: an
 * agent, or a program holding an API key. Such a caller never mints, and
 * never sends, a caller token or a caller header.
 *
 * @param facts - The request's facts.
 */
export function isNotAWindow(facts: RequestFacts): boolean {
  return presentsAgentIdentity(facts) || facts.user?.credential === 'api-key';
}

/**
 * The app a token names, for this request, or `null` when the token is
 * unknown, expired, or was minted in another session. A good token's idle
 * time starts again.
 *
 * @param token - The token the request carried.
 * @param facts - The request's facts, for its session.
 * @param now - The current time, for tests.
 */
export function resolveCallerToken(
  token: string,
  facts: Pick<RequestFacts, 'user'>,
  now = Date.now()
): string | null {
  const record = tokens.get(token);
  if (!record) return null;
  if (record.expiresAt <= now || record.session !== sessionOf(facts)) {
    tokens.delete(token);
    return null;
  }
  record.expiresAt = now + CALLER_TOKEN_IDLE_MS;
  return record.appId;
}

/** Forget every token. For tests. */
export function resetCallerTokens(): void {
  tokens.clear();
}

/** What the mint route reads about each app. */
export interface CallerTokenDeps {
  /** Whether the app's screens run right now. */
  appScreenRuns(id: string): boolean;
  /** The app's manifest, or `undefined` when it is not installed. */
  manifest(id: string): ExtensionManifest | undefined;
}

/** Answer a refused mint. */
function refuseMint(c: Context<ApiEnv>, status: 400 | 403, error: string): Response {
  return c.json({ error, code: CALLER_TOKEN_INVALID }, status);
}

/**
 * Add `POST /caller-token` to the frame routes: mint a token for one frame
 * load of one app.
 *
 * @param router - The `/api/extension-frame` router.
 * @param deps - DorkOS's records of each app.
 */
export function registerCallerTokenRoute(router: Hono<ApiEnv>, deps: CallerTokenDeps): void {
  router.post('/caller-token', (c) => {
    const facts = honoRequestFacts(c);
    if (isNotAWindow(facts) || !clearsTheAgentBar(facts)) {
      return refuseMint(c, 403, 'Only a person’s DorkOS window can ask for this.');
    }
    const body = readJsonBody(c) as { appId?: unknown } | undefined;
    const appId = typeof body?.appId === 'string' ? body.appId : '';
    const manifest = deps.appScreenRuns(appId) ? deps.manifest(appId) : undefined;
    if (!manifest || calledApps(manifest).length === 0) {
      return refuseMint(c, 400, 'That app is not running, or calls no other app.');
    }
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    tokens.set(token, {
      appId,
      session: sessionOf(facts),
      expiresAt: Date.now() + CALLER_TOKEN_IDLE_MS,
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ token }, 201);
  });
}
