/**
 * The page stamp: when this server last sent the app's page into a tab
 * (DOR-5026).
 *
 * After a risky mini app clears, "Confirm it's you" is refused for any page
 * that may still hold its code (Security's M1 on #3401). Judging that by the
 * sign-in's start was not enough: a sign-in is a cookie every tab shares, and
 * signing in again happens inside the same page. So each page the server
 * sends gets a stamp written into its HTML: when it went out, signed with a
 * key only this server holds, and bound to the sign-in it went out under. A
 * confirm carries the stamp back, and the risk check reads the page's own
 * load time from it.
 *
 * Only a real top-level navigation gets a stamp: a script's `fetch` of the
 * page, an iframe or a prefetch never does. Mini app code runs in a frame
 * sandboxed to `allow-scripts` alone, so it can neither open the app's page
 * nor read one. The page is sent `no-store`, so no cached copy replays an old
 * stamp.
 *
 * Stamps are enforced only by the server that sends the page itself: under
 * the Vite dev server the page comes from Vite and carries none, and the
 * sign-in check stays as it was.
 *
 * @module services/extensions/step-up/page-stamp
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseCookies } from 'better-auth/cookies';
import { PAGE_STAMP_META, type StepUpStaleConfirm } from '@dorkos/shared/step-up';

import { logger } from '../../../lib/logger.js';

const VERSION = 'v1';

/** What a valid stamp says. */
export interface PageStamp {
  /** When the page went out, in ms. */
  loadedAt: number;
  /** The sign-in the page went out under, as a fingerprint; null when signed out. */
  session: string | null;
}

/** The request facts a stamp decision reads. */
export interface StampRequest {
  /** The HTTP method. */
  method?: string | undefined;
  /** The request's headers, lower-case names. */
  headers: Record<string, string | string[] | undefined>;
}

let key: Buffer = randomBytes(32);
let enforced = false;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function b64(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(body: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

/**
 * Keep the signing key in `file`, made once with owner-only access. A key
 * that is missing or can't be read is made again, so every older stamp stops
 * counting. Called once at startup.
 *
 * @param file - Where the key lives, under the data folder's `step-up/`.
 */
export function usePageStampKeyFile(file: string): void {
  try {
    const read = fs.readFileSync(file);
    if (read.length === 32) {
      key = read;
      // Owner-only, even for a copy restored with wider access. A key that
      // can't be narrowed still signs: only this server's user can run here.
      try {
        fs.chmodSync(file, 0o600);
      } catch (error) {
        logger.warn('[StepUp] Could not narrow the page stamp key', {
          error: (error as Error).name,
        });
      }
      return;
    }
  } catch {
    // Missing or unreadable: make a new one below.
  }
  key = randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, key, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    // The key in memory still works until a restart; stamps then stop counting.
    logger.warn('[StepUp] Could not save the page stamp key', { error: (error as Error).name });
  }
}

/**
 * Make confirms carry a page stamp. Called when this server starts sending
 * the app's page itself, the only place a stamp can come from.
 */
export function enforcePageStamps(): void {
  enforced = true;
}

/** Whether confirms must carry a page stamp: this server sends the app's page. */
export function pageStampsEnforced(): boolean {
  return enforced;
}

/**
 * The sign-in a `Cookie` header carries, as a fingerprint: every Better Auth
 * session token in it, sorted, hashed. Null when it carries none.
 *
 * @param cookieHeader - The raw `Cookie` header.
 */
export function sessionFingerprint(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const tokens = [...parseCookies(cookieHeader)]
    .filter(([name]) => name.endsWith('.session_token'))
    .map(([, value]) => value)
    .sort();
  if (tokens.length === 0) return null;
  return b64(createHash('sha256').update(tokens.join('\n')).digest());
}

/**
 * Whether this request for the app's page gets a stamp: a `GET` that is a
 * top-level navigation. A browser that sends no `Sec-Fetch-*` headers is
 * stamped too; one that says it is anything but a page navigation is not.
 *
 * @param req - The request for the page.
 */
export function wantsPageStamp(req: StampRequest): boolean {
  if (req.method !== 'GET') return false;
  const mode = first(req.headers['sec-fetch-mode']);
  const dest = first(req.headers['sec-fetch-dest']);
  if (mode !== undefined && mode !== 'navigate') return false;
  if (dest !== undefined && dest !== 'document') return false;
  return true;
}

/**
 * A new stamp for a page going out now.
 *
 * @param cookieHeader - The page request's `Cookie` header.
 * @param now - When it goes out, in ms.
 */
export function mintPageStamp(cookieHeader: string | undefined, now: number = Date.now()): string {
  const body = b64(
    JSON.stringify({
      t: now,
      s: sessionFingerprint(cookieHeader),
      n: b64(randomBytes(12)),
    })
  );
  return `${VERSION}.${body}.${b64(sign(`${VERSION}.${body}`))}`;
}

/**
 * What a stamp says, or null when it is absent, malformed, or signed with any
 * key but this server's own.
 *
 * @param stamp - The stamp a confirm carried.
 */
export function readPageStamp(stamp: string | string[] | undefined): PageStamp | null {
  const value = first(stamp);
  if (!value) return null;
  const [version, body, mac, ...rest] = value.split('.');
  if (version !== VERSION || !body || !mac || rest.length > 0) return null;
  const expected = sign(`${version}.${body}`);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { t, s } = parsed as { t?: unknown; s?: unknown };
    if (typeof t !== 'number' || !Number.isFinite(t)) return null;
    if (s !== null && typeof s !== 'string') return null;
    return { loadedAt: t, session: s };
  } catch {
    return null;
  }
}

/**
 * The `<meta>` tag that carries a stamp, for the page's `<head>`. The stamp is
 * base64url and dots only, so it needs no escaping.
 *
 * @param stamp - From {@link mintPageStamp}.
 */
export function pageStampMeta(stamp: string): string {
  return `<meta name="${PAGE_STAMP_META}" content="${stamp}">`;
}

/** What {@link staleConfirm} reads. */
export interface PageRiskInputs {
  /** The risk ledger: whether code from before a time may still be risky. */
  ledger: { mayHoldRiskyCode: (startedAt: number | null) => boolean };
  /** Whether confirms must carry a page stamp ({@link pageStampsEnforced}). */
  enforced: boolean;
  /** The confirm's page stamp header (`PAGE_STAMP_HEADER`). */
  stamp: string | string[] | undefined;
  /** The confirm's `Cookie` header. */
  cookie: string | undefined;
  /** When the confirm's sign-in started, in ms; null when unknown. */
  sessionStartedAt: number | null;
}

/**
 * Why the page asking to confirm may still hold a risky mini app's code, or
 * `undefined` when it cannot (Security's M1 on #3401, DOR-5026). Both have to
 * be newer than the last clear: the sign-in, as before, and the page itself,
 * by its stamp. Each answer names which one is too old (DOR-5086), so a
 * refusal never reads as a mini app that is not there.
 *
 * Nothing changes until a risk has been seen. After that, a confirm with no
 * valid stamp, a stamp for another sign-in, or a signed-out stamp from before
 * this sign-in began is treated as a page from before the clear.
 *
 * @param inputs - See {@link PageRiskInputs}.
 * @returns `stale-sign-in` when the sign-in began before the clear,
 *   `stale-page` when the page can't show it loaded after it.
 */
export function staleConfirm(inputs: PageRiskInputs): StepUpStaleConfirm | undefined {
  const { ledger, sessionStartedAt } = inputs;
  if (ledger.mayHoldRiskyCode(sessionStartedAt)) return 'stale-sign-in';
  // Without a server-sent page there is no stamp to ask for (the dev server).
  if (!inputs.enforced) return undefined;
  // No risk was ever seen, so no page can hold one.
  if (!ledger.mayHoldRiskyCode(Number.NEGATIVE_INFINITY)) return undefined;
  const stamp = readPageStamp(inputs.stamp);
  if (!stamp) return 'stale-page';
  if (stamp.session === null) {
    // Sent signed out: it counts only for a sign-in made on that page, later.
    // (A null start was already refused above once any risk was seen.)
    if (sessionStartedAt === null || sessionStartedAt <= stamp.loadedAt) return 'stale-page';
  } else if (stamp.session !== sessionFingerprint(inputs.cookie)) {
    return 'stale-page';
  }
  return ledger.mayHoldRiskyCode(stamp.loadedAt) ? 'stale-page' : undefined;
}
