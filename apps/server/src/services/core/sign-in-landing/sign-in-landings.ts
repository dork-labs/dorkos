/**
 * What a finished sign-in leaves for the page the browser lands on.
 *
 * An OAuth callback (`routes/mcp-oauth.ts`, `routes/runtimes.ts`) finishes the
 * exchange, records the outcome here, and redirects the browser to the app's
 * `/signed-in?landing=<id>` page, which reads the record back through
 * `routes/sign-in-landings.ts`. Two things follow from keeping it on the
 * server rather than in the redirect's query string:
 *
 * - **Nothing the page prints comes from the URL.** A forged
 *   `/signed-in?landing=…` can only name a record this server wrote, so no
 *   one can mint a convincing "Signed in to …" page with their own words.
 * - **Try again restarts the same sign-in.** The record keeps a closure that
 *   starts the flow with everything the first one had, the conversation to
 *   resume included, which a link built from the URL could not carry.
 *
 * Records live in memory for {@link LANDING_TTL_MS} and at most
 * {@link MAX_LANDINGS} at a time: a landing is read within seconds of being
 * written, and a restart losing one costs a page that says the link expired.
 *
 * @module services/core/sign-in-landing/sign-in-landings
 */
import { randomBytes } from 'node:crypto';
import type {
  SignInFailureReason,
  SignInLanding,
  SignInLandingService,
  SignInRetryResult,
} from '@dorkos/shared/sign-in-landing';
import { env } from '../../../env.js';

/** How long a landing record can be read after its sign-in finished. */
export const LANDING_TTL_MS = 15 * 60 * 1000;

/** The most landing records kept at once; the oldest goes first. */
export const MAX_LANDINGS = 64;

/** The app path every landing page is served at. */
export const SIGNED_IN_PATH = '/signed-in';

/** What a callback hands over when its sign-in finishes. */
export interface SignInLandingInput {
  /** Which kind of sign-in this was. */
  service: SignInLandingService;
  /** The service's name as the person knows it. */
  serviceName: string;
  /** Whether it finished. */
  connected: boolean;
  /** Why not, when it did not. */
  reason?: SignInFailureReason;
  /** The agent it was for, when it was for one. */
  agentId?: string;
  /** The conversation that asked for it, when one did. */
  originSessionId?: string;
  /** Starts the same sign-in again, when it can be. */
  retry?: () => Promise<SignInRetryResult>;
}

interface StoredLanding {
  view: SignInLanding;
  retry?: () => Promise<SignInRetryResult>;
  expiresAt: number;
}

/**
 * Whether a session id is safe to put in an app path as it is. Session ids are
 * UUIDs or ULIDs; anything else is left out rather than escaped, so the path
 * can never carry more than the one parameter it names.
 */
function isPlainId(value: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}

/**
 * Which DorkOS the person reached this sign-in from. The desktop app runs its
 * own server and says so in `DORKOS_MANAGED_BY`, so a sign-in that lands on
 * that server began in the desktop app: its sign-in links open in the system
 * browser, which is why the person is reading a browser page at all.
 */
export function signInReturnSurface(): SignInLanding['returnSurface'] {
  return env.DORKOS_MANAGED_BY === 'desktop' ? 'desktop' : 'browser';
}

/** The landing records a running server holds. */
export class SignInLandingStore {
  private readonly landings = new Map<string, StoredLanding>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Keep what a finished sign-in left, and return the record's id.
   *
   * @param input - The outcome, as the callback saw it.
   */
  record(input: SignInLandingInput): string {
    this.prune();
    while (this.landings.size >= MAX_LANDINGS) {
      const oldest = this.landings.keys().next().value;
      if (oldest === undefined) break;
      this.landings.delete(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    const sessionId =
      input.originSessionId && isPlainId(input.originSessionId) ? input.originSessionId : undefined;
    const view: SignInLanding = {
      id,
      service: input.service,
      serviceName: input.serviceName,
      status: input.connected ? 'connected' : 'failed',
      ...(input.connected ? {} : { reason: input.reason ?? 'failed' }),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      resumesConversation: input.connected && sessionId !== undefined,
      ...(sessionId ? { returnPath: `/session?session=${sessionId}` } : {}),
      returnSurface: signInReturnSurface(),
      canRetry: !input.connected && input.retry !== undefined,
    };
    this.landings.set(id, {
      view,
      ...(input.retry ? { retry: input.retry } : {}),
      expiresAt: this.now() + LANDING_TTL_MS,
    });
    return id;
  }

  /**
   * What the page shows for a record, or `undefined` once it is gone.
   *
   * @param id - The record's id.
   */
  get(id: string): SignInLanding | undefined {
    this.prune();
    return this.landings.get(id)?.view;
  }

  /**
   * Start the record's sign-in again, or `undefined` when there is nothing to
   * restart (the record is gone, or the sign-in finished).
   *
   * @param id - The record's id.
   */
  retry(id: string): Promise<SignInRetryResult> | undefined {
    this.prune();
    const landing = this.landings.get(id);
    if (!landing?.view.canRetry || !landing.retry) return undefined;
    return landing.retry();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, landing] of this.landings) {
      if (landing.expiresAt <= now) this.landings.delete(id);
    }
  }
}

/** The server's one landing store, shared by every callback and the page's routes. */
export const signInLandings = new SignInLandingStore();

/**
 * Where to send a browser whose sign-in just finished: the app's landing page
 * for this record.
 *
 * Always built from this server's own idea of where the app is, never from the
 * request, so the redirect cannot be pointed anywhere else. When this server
 * serves the app itself the address is relative, which keeps the browser on the
 * exact host it called back on (and the sign-in cookie that goes with it). In
 * development the app is on the Vite server instead, at `cockpitOrigin`.
 *
 * @param id - The landing record's id.
 * @param where - Where the app is: served by this server, or at `cockpitOrigin`.
 */
export function landingLocation(
  id: string,
  where: { servesApp: boolean; cockpitOrigin: string }
): string {
  const path = `${SIGNED_IN_PATH}?landing=${encodeURIComponent(id)}`;
  return where.servesApp ? path : `${where.cockpitOrigin}${path}`;
}
