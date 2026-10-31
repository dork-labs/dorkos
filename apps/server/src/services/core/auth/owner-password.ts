/**
 * Asking for the install owner's password again before an action that opens
 * this computer wider (a step-up), such as linking it to a hub so it can be
 * reached from the web (DOR-2946).
 *
 * The bars on who is calling cannot tell the app from a program on this
 * computer while it does not ask for a password (DOR-505): an agent's shell
 * can call loopback with no headers and look like the app. An agent does not
 * have the owner's password, so asking for it closes that gap on the API and
 * MCP paths for the few actions that widen reach, in every gate posture.
 *
 * It covers those paths only. Anything that can write the data folder (an
 * agent with a shell, say) can still change what these actions guard
 * directly on disk, as it could open any other channel; that is the DOR-505
 * class, tracked separately. Nothing here makes such an action agent-proof.
 *
 * The password is checked by Better Auth's own machinery, the same way its
 * `/verify-password` endpoint does: the owner's credential account through
 * `internalAdapter.findCredentialAccount`, then `context.password.verify`.
 * That endpoint needs a session cookie, which the app at this computer does
 * not carry while no password is asked, so this reads the context directly.
 * The password is never logged, stored or audited.
 *
 * Wrong passwords are throttled globally, never per address (every caller
 * here is on loopback), by a delay that grows with each one rather than a hard
 * lock: after n wrong passwords in {@link OWNER_PASSWORD_FAILURE_WINDOW_MS},
 * every attempt is refused for 2^n seconds after the last one, capped at
 * {@link OWNER_PASSWORD_MAX_DELAY_MS}, and checked again after that. A hard
 * lock let any program on this computer keep the owner out by sending a few
 * junk passwords every window (Security, #3212 M1): with the delay, guessing
 * stays at about one try a minute and the owner's own password still gets
 * through once the wait passes. The right password clears the count.
 *
 * @module services/core/auth/owner-password
 */
import { logger } from '../../../lib/logger.js';
import { getAuth, readOwnerAccount } from './index.js';
import { needsRehash } from './passwords/password-hash.js';

/** The window wrong passwords are counted over. */
export const OWNER_PASSWORD_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** The longest wait after a wrong password, however many came before it. */
export const OWNER_PASSWORD_MAX_DELAY_MS = 60 * 1000;

/**
 * How long to wait after the latest of `count` recent wrong passwords: 2^count
 * seconds, capped at {@link OWNER_PASSWORD_MAX_DELAY_MS}; none with no failures.
 *
 * @param count - Wrong passwords in the current window.
 */
export function ownerPasswordDelayMs(count: number): number {
  if (count <= 0) return 0;
  return Math.min(2 ** count * 1000, OWNER_PASSWORD_MAX_DELAY_MS);
}

/** What checking the owner's password came to. */
export type OwnerPasswordCheck =
  /** It matched. */
  | 'ok'
  /** None was sent. */
  | 'required'
  /** It did not match. */
  | 'wrong'
  /** Too many wrong passwords lately, from anywhere. */
  | 'too-many-attempts'
  /** There is no owner account. */
  | 'no-owner'
  /** The owner has no password to check against. */
  | 'no-password';

/** The two Better Auth pieces the check uses. */
export interface PasswordVerifier {
  /** The owner's stored password hash, or `null` when there is none. */
  storedHash: (userId: string) => Promise<string | null>;
  /** Better Auth's own verify. */
  verify: (input: { hash: string; password: string }) => Promise<boolean>;
  /** The longest password Better Auth accepts. */
  maxLength: number;
  /**
   * Store the password again at today's cost, after it matched a hash written
   * at a lower one (`./passwords/password-hash.ts`). Absent where nothing is stored.
   */
  rehash?: (userId: string, password: string) => Promise<void>;
}

/** What the check reads, injectable for tests. */
export interface OwnerPasswordDeps {
  /** The owner's id, or `null`. */
  ownerId: () => string | null;
  /** Better Auth's verifier, or `null` while auth is not initialized. */
  verifier: () => Promise<PasswordVerifier | null>;
  /** The clock. */
  now: () => number;
}

/** The live verifier: the initialized Better Auth context. */
async function liveVerifier(): Promise<PasswordVerifier | null> {
  const auth = getAuth();
  if (!auth) return null;
  const context = await auth.$context;
  return {
    storedHash: async (userId) =>
      (await context.internalAdapter.findCredentialAccount(userId))?.password ?? null,
    verify: (input) => context.password.verify(input),
    maxLength: context.password.config.maxPasswordLength,
    rehash: async (userId, password) => {
      await context.internalAdapter.updatePassword(userId, await context.password.hash(password));
    },
  };
}

/** Better Auth's own default, for before auth is initialized. */
const DEFAULT_MIN_PASSWORD_LENGTH = 8;

/**
 * The shortest owner password Better Auth accepts (8). A step-up for one
 * action refuses a password shorter than this even when it matches, and
 * offers to change it in place (DOR-3234).
 */
export async function ownerPasswordMinLength(): Promise<number> {
  const auth = getAuth();
  if (!auth) return DEFAULT_MIN_PASSWORD_LENGTH;
  return (await auth.$context).password.config.minPasswordLength;
}

const liveDeps: OwnerPasswordDeps = {
  ownerId: () => readOwnerAccount()?.id ?? null,
  verifier: liveVerifier,
  now: () => Date.now(),
};

/** When each recent wrong password arrived, oldest first. */
let failures: number[] = [];

function recentFailures(now: number): number {
  failures = failures.filter((at) => now - at < OWNER_PASSWORD_FAILURE_WINDOW_MS);
  return failures.length;
}

/** Milliseconds until a password is checked again, or `0` when it is checked now. */
function waitMs(now: number): number {
  const count = recentFailures(now);
  if (count === 0) return 0;
  return Math.max(0, failures[count - 1]! + ownerPasswordDelayMs(count) - now);
}

/**
 * Check a password against the install owner's. Never throws; a verifier that
 * fails reads as a wrong password, so nothing opens on an error.
 *
 * @param password - What the person typed, or `undefined`.
 * @param deps - Seams for tests; the live owner and Better Auth by default.
 */
export async function checkOwnerPassword(
  password: string | undefined,
  deps: OwnerPasswordDeps = liveDeps
): Promise<OwnerPasswordCheck> {
  const now = deps.now();
  // Checked first, so a throttled caller learns nothing about the password.
  if (waitMs(now) > 0) return 'too-many-attempts';
  if (password === undefined || password === '') return 'required';
  const ownerId = deps.ownerId();
  if (!ownerId) return 'no-owner';
  // Claim the slot before the first `await` (Security, #3212): the hash check
  // takes tens of milliseconds, and a failure counted only after it let every
  // request that arrived meanwhile pass the wait above, so parallel guesses
  // skipped the delay. Counted as a wrong password until it proves right.
  failures.push(now);
  const release = () => {
    const at = failures.lastIndexOf(now);
    if (at !== -1) failures.splice(at, 1);
  };
  let matched = false;
  try {
    const verifier = await deps.verifier();
    if (!verifier) {
      release();
      return 'no-password';
    }
    const hash = await verifier.storedHash(ownerId);
    if (!hash) {
      release();
      return 'no-password';
    }
    matched = password.length <= verifier.maxLength && (await verifier.verify({ hash, password }));
    // Only now is the password known, so only now can a weaker hash be
    // rewritten. A failed rewrite keeps the old hash, which still verifies.
    if (matched && verifier.rehash && needsRehash(hash)) {
      await verifier.rehash(ownerId, password).catch((error: unknown) => {
        logger.warn('[Auth] The owner password could not be stored at the new cost', {
          error: (error as Error).name,
        });
      });
    }
  } catch (error) {
    logger.warn('[Auth] The owner password could not be checked', {
      error: (error as Error).name,
    });
  }
  if (matched) {
    failures = [];
    return 'ok';
  }
  logger.warn('[Auth] A wrong owner password was given for a step-up');
  return 'wrong';
}

/**
 * How long until a step-up is checked again after wrong passwords, in
 * milliseconds, or `0` when it is checked now.
 *
 * @param now - The current time, for tests.
 */
export function ownerPasswordRetryAfterMs(now = Date.now()): number {
  return waitMs(now);
}

/**
 * Forget every recorded wrong password.
 *
 * @internal Tests only.
 */
export function resetOwnerPasswordFailuresForTests(): void {
  failures = [];
}
