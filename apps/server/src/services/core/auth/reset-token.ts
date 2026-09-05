/**
 * The one-time credential that arms `POST /api/admin/reset` (DOR-1707).
 *
 * Deleting the data directory used to be one blind POST away: any caller that
 * could reach the API and send `{ confirm: 'reset' }` got it, and with local
 * login off there was no credential in front of it at all. `confirm` is a fixed
 * string in the client's source, so it proves nothing about who sent the
 * request. This store supplies the thing that does: a value the caller cannot
 * know unless it asked for one and READ the answer.
 *
 * ## Shape
 *
 * 256 bits from the OS CSPRNG, handed out once by `POST /api/admin/reset/prepare`
 * and held here only as its SHA-256 digest, compared in constant time. It
 * expires after {@link RESET_TOKEN_TTL_MS} and is spent by the first successful
 * use, so a token cannot be replayed, cannot be pulled out of a log an hour
 * later, and cannot survive the process that minted it.
 *
 * ## One at a time
 *
 * Minting replaces whatever was armed before. Reset is a single-operator,
 * once-in-a-lifetime action, and one slot means an abandoned dialog leaves
 * nothing usable behind. The cost is that two tabs racing to arm a reset leave
 * only the newer one working — the older tab's attempt is refused and has to be
 * started again, which is the correct outcome for a destructive action nobody
 * is watching.
 *
 * A wrong guess deliberately does NOT spend the armed token: spending it would
 * let anything able to POST disarm an operator's real reset over and over.
 * Guessing the right one is a 2^256 problem instead.
 *
 * @module services/core/auth/reset-token
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * How long a minted reset token stays usable.
 *
 * Long enough to read a confirmation dialog and type a word into it, short
 * enough that a token left behind by an abandoned dialog is dead before anyone
 * could find it.
 */
export const RESET_TOKEN_TTL_MS = 2 * 60 * 1000;

/** Token entropy, in bytes. 32 = 256 bits, the same width as the approval primitive's. */
const TOKEN_BYTES = 32;

/** What `POST /api/admin/reset/prepare` hands back. */
interface MintedResetToken {
  /** The one-time value the reset request must carry. */
  token: string;
  /** How long it stays usable, in milliseconds, so a client can say so. */
  expiresInMs: number;
}

/** SHA-256 of a token, as a raw buffer for constant-time comparison. */
function digestOf(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Holds the single outstanding reset token for this process.
 *
 * In-memory on purpose: a token that survives a restart would outlive the
 * consent it stands for.
 */
export class ResetTokenStore {
  #armed: { digest: Buffer; expiresAt: number } | null = null;
  readonly #ttlMs: number;

  /**
   * Build a store.
   *
   * @param options - `ttlMs` overrides {@link RESET_TOKEN_TTL_MS} (tests pass a
   *   short one; nothing in production does).
   */
  constructor(options?: { ttlMs?: number }) {
    this.#ttlMs = options?.ttlMs ?? RESET_TOKEN_TTL_MS;
  }

  /**
   * Mint a token, replacing any token already armed.
   *
   * @param now - Current epoch ms (injectable for tests).
   * @returns The token to hand to the caller, and how long it lasts.
   */
  mint(now: number = Date.now()): MintedResetToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.#armed = { digest: digestOf(token), expiresAt: now + this.#ttlMs };
    return { token, expiresInMs: this.#ttlMs };
  }

  /**
   * Spend a token, if it is the armed one and it is still alive.
   *
   * Takes `unknown` because it is fed straight from a request body: a number, an
   * object, or nothing at all is a refusal, not a crash.
   *
   * @param presented - Whatever the caller sent as its token.
   * @param now - Current epoch ms (injectable for tests).
   * @returns `true` only when the reset may proceed. The token is spent then,
   *   and only then.
   */
  consume(presented: unknown, now: number = Date.now()): boolean {
    const armed = this.#armed;
    if (!armed) return false;
    if (now >= armed.expiresAt) {
      this.#armed = null;
      return false;
    }
    if (typeof presented !== 'string' || presented.length === 0) return false;
    if (!timingSafeEqual(digestOf(presented), armed.digest)) return false;
    this.#armed = null;
    return true;
  }
}
