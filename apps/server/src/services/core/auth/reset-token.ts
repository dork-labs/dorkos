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
 * A wrong guess deliberately does NOT spend the armed token — but be honest
 * about what that buys, because there are TWO ways to take an operator's armed
 * token away and this closes only one of them. The other is minting itself: a
 * blind `POST /reset/prepare` replaces the slot just as effectively, and needs
 * no guess at all. That door is bounded rather than shut — `/reset/prepare` has
 * a rate limiter of its own, and the dialog arms and spends on a single press,
 * so the window in which an operator can be disarmed is one round trip wide.
 * Not spending on a wrong guess is still worth doing: it costs nothing and it
 * keeps the cheaper door shut. Guessing the token itself is a 2^256 problem.
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

/**
 * The lifetime above, in the words a person is told it in.
 *
 * Derived rather than written twice: the refusal copy tells someone how long
 * they have, and a hand-typed "two minutes" beside a constant is a sentence that
 * goes quietly wrong the day the constant moves.
 */
export const RESET_TOKEN_TTL_DESCRIPTION = `${Math.round(RESET_TOKEN_TTL_MS / 60_000)} minutes`;

/** Token entropy, in bytes. 32 = 256 bits, the same width as the approval primitive's. */
const TOKEN_BYTES = 32;

/**
 * What `POST /api/admin/reset/prepare` hands back.
 *
 * The token and nothing else. An expiry was here too, and no caller read it: the
 * dialog arms and spends on one press, so there is no moment at which a client
 * has a token and needs to know how long it has. The TTL is stated where it is
 * acted on — in the refusal, through {@link RESET_TOKEN_TTL_DESCRIPTION}.
 */
interface MintedResetToken {
  /** The one-time value the reset request must carry. */
  token: string;
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
   * @returns The token to hand to the caller.
   */
  mint(now: number = Date.now()): MintedResetToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    this.#armed = { digest: digestOf(token), expiresAt: now + this.#ttlMs };
    return { token };
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
