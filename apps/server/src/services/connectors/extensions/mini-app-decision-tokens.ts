/**
 * One-time tokens for the page where a person lets a mini app read an app
 * (DOR-3547, Security's out-of-app page conditions).
 *
 * The page gets a token when it renders, and the decision must carry it back.
 * A token is:
 *
 * - **bound** to the read it was drawn for, the person's session, the files
 *   the page showed, and a cookie only that page's response set;
 * - **single use**: redeeming it removes it, whether the decision then
 *   succeeds or not;
 * - **short**: it lasts five minutes;
 * - **stored hashed**, in memory only: a restart drops every token, and the
 *   person opens the page again.
 *
 * @module services/connectors/extensions/mini-app-decision-tokens
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a decide page's token lasts. */
export const DECISION_TOKEN_TTL_MS = 5 * 60_000;

/** What a token was drawn for. */
export interface DecisionTicket {
  readonly extensionId: string;
  readonly service: string;
  /** The mini app's files when the page rendered. */
  readonly filesDigest: string;
  /** The person's session: their account id with login on, `local` with it off. */
  readonly sessionKey: string;
}

/** A stored token: its ticket, its cookie's hash, and when it runs out. */
interface Stored {
  readonly ticket: DecisionTicket;
  readonly cookieHash: Buffer;
  readonly expiresAt: number;
}

/** A SHA-256 of a secret, for storage and comparison. */
function hash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** A fresh secret. */
function secret(): string {
  return randomBytes(32).toString('base64url');
}

/** In-memory, single-use decision tokens. */
export class MiniAppDecisionTokens {
  private readonly stored = new Map<string, Stored>();

  /**
   * Construct the store.
   *
   * @param now - Clock in milliseconds, for tests.
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Draw a token and its cookie for one rendered page.
   *
   * @param ticket - What the page shows and who it was shown to.
   * @returns The token for the page's body and the value for its cookie.
   */
  issue(ticket: DecisionTicket): { token: string; cookie: string } {
    this.prune();
    const token = secret();
    const cookie = secret();
    this.stored.set(hash(token).toString('hex'), {
      ticket,
      cookieHash: hash(cookie),
      expiresAt: this.now() + DECISION_TOKEN_TTL_MS,
    });
    return { token, cookie };
  }

  /**
   * Use a token up. It is removed whatever the answer, so it never works twice.
   *
   * @param token - The token the page sent back.
   * @param cookie - The page's cookie, as the browser sent it.
   * @param sessionKey - The session deciding now.
   * @returns The ticket when the token, cookie and session all match and it is
   *   still fresh, else `undefined`.
   */
  redeem(
    token: string,
    cookie: string | undefined,
    sessionKey: string
  ): DecisionTicket | undefined {
    const key = hash(token).toString('hex');
    const found = this.stored.get(key);
    this.stored.delete(key);
    if (!found || cookie === undefined) return undefined;
    if (found.expiresAt <= this.now()) return undefined;
    if (!timingSafeEqual(found.cookieHash, hash(cookie))) return undefined;
    if (found.ticket.sessionKey !== sessionKey) return undefined;
    return found.ticket;
  }

  /** Drop tokens that ran out. */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.stored) {
      if (entry.expiresAt <= now) this.stored.delete(key);
    }
  }
}
