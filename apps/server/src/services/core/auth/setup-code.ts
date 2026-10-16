/**
 * The setup code: what creating the owner account from another device needs
 * (ADR 261015-125850 rule 4, F5 DOR-2968).
 *
 * A computer with no owner yet is open to whoever reaches it first. From this
 * computer that is fine, since the person there already controls it. From
 * anywhere else, the first sign-up could be a stranger's. So an owner-less
 * sign-up from another device must present a code that only someone at this
 * computer can read:
 *
 * - at least 40 bits: 10 characters of Crockford base32 (50 bits), shown as
 *   `XXXXX-XXXXX`;
 * - single use, and good for one hour;
 * - written to a `0600` file in the DorkOS data folder, and printed to this
 *   server's terminal only when it is one (a TTY). Under a service manager,
 *   `docker logs` or the desktop app, stdout is a log file, so there only the
 *   file's location is printed. It never goes through the logger;
 * - slowed on failures: past a few wrong codes in ten minutes, every attempt
 *   from another device waits out the window. The cap is global, not per
 *   address, because a tunnel or a proxy makes every visitor one address; and
 *   it never replaces the code, so guessing cannot keep the owner's copy stale.
 *   Creating the owner on this computer never needs a code, so the cap can
 *   never lock the owner out.
 *
 * A code is minted only when a sign-up needs one, so an install nobody tries
 * to claim from another device never prints one.
 *
 * @module services/core/auth/setup-code
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';

/** Request header a sign-up carries its setup code in. */
export const SETUP_CODE_HEADER = 'x-dorkos-setup-code';

/** File the current code is written to, inside the DorkOS data folder. */
export const SETUP_CODE_FILE_NAME = 'setup-code';

/** How long a code is good for. */
export const SETUP_CODE_TTL_MS = 60 * 60 * 1000;

/** Wrong codes allowed in one {@link SETUP_CODE_FAILURE_WINDOW_MS}, from anywhere. */
export const SETUP_CODE_MAX_FAILURES = 10;

/** The window wrong codes are counted over. */
export const SETUP_CODE_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** Crockford base32: no I, L, O or U, so a code read aloud is not misheard. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

interface CurrentCode {
  value: string;
  expiresAt: number;
}

let current: CurrentCode | null = null;
/** When each recent wrong code arrived, oldest first. */
let failures: number[] = [];

/** One sign-up's setup-code attempt: what it sent, and from where. */
export interface SetupCodeAttempt {
  /** The code the request carried, or `undefined` when it carried none. */
  code: string | undefined;
  /** The TCP peer, kept for the record; the failure cap is global. */
  address: string | undefined;
}

const scope = new AsyncLocalStorage<SetupCodeAttempt>();

/**
 * Run `fn` with this request's setup-code attempt in scope, so the sign-up
 * hook can read it (`http/better-auth.ts` wraps Better Auth's handler).
 *
 * @param attempt - The code the request carried and its peer address.
 * @param fn - The work.
 */
export function withSetupCodeAttempt<T>(attempt: SetupCodeAttempt, fn: () => T): T {
  return scope.run(attempt, fn);
}

/** The attempt in scope, or an empty one outside any request. */
export function currentSetupCodeAttempt(): SetupCodeAttempt {
  return scope.getStore() ?? { code: undefined, address: undefined };
}

/** Why a setup code was not accepted. */
export type SetupCodeRefusal =
  /** The request carried no code. A code has been printed for the person at this computer. */
  | 'required'
  /** The code was wrong or expired. */
  | 'invalid'
  /** Too many wrong codes in the last ten minutes, from anywhere. */
  | 'too-many-attempts';

/**
 * Check a sign-up's setup code. On success the code is spent: it cannot be
 * used again, and its file is removed.
 *
 * @param attempt - What the request carried, and from where.
 * @param now - The current time; injectable for tests.
 * @returns `null` when the code is good, otherwise why not.
 */
export function checkSetupCode(
  attempt: SetupCodeAttempt,
  now: number = Date.now()
): SetupCodeRefusal | null {
  // Checked before anything is minted, so a throttled caller prints nothing.
  if (recentFailures(now) >= SETUP_CODE_MAX_FAILURES) return 'too-many-attempts';
  const code = ensureCurrentCode(now);
  if (attempt.code === undefined || attempt.code.trim() === '') return 'required';
  if (!sameCode(normalize(attempt.code), code.value)) {
    failures.push(now);
    return 'invalid';
  }
  spend();
  return null;
}

/** The current code, minted (and printed) when there is none or it expired. */
function ensureCurrentCode(now: number): CurrentCode {
  if (current && current.expiresAt > now) return current;
  current = { value: mintValue(), expiresAt: now + SETUP_CODE_TTL_MS };
  publish(current);
  return current;
}

function mintValue(): string {
  let value = '';
  for (let i = 0; i < CODE_LENGTH; i++) value += ALPHABET[randomInt(ALPHABET.length)];
  return value;
}

/** Uppercase, drop spaces and dashes, and read the letters people confuse. */
function normalize(input: string): string {
  return (
    input
      .toUpperCase()
      // Spaces and every dash a paste might bring (hyphen, en and em dashes).
      .replace(/[\s\u002D\u2010-\u2015\u2212]/g, '')
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1')
  );
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `XXXXX-XXXXX`, as printed and typed. */
function formatted(value: string): string {
  return `${value.slice(0, 5)}-${value.slice(5)}`;
}

function codeFilePath(): string {
  return path.join(resolveDorkHome(), SETUP_CODE_FILE_NAME);
}

/**
 * Print the code to the terminal and write it to the `0600` file. Straight to
 * stdout, never through the logger: log files and excerpts must not hold it.
 */
function publish(code: CurrentCode): void {
  const file = codeFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${formatted(code.value)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (err) {
    logger.warn('[Auth] Could not write the setup code file', {
      path: file,
      error: (err as Error).message,
    });
  }
  const expires = new Date(code.expiresAt).toLocaleTimeString();
  // Only a real terminal is shown the code itself. Anywhere else stdout is
  // kept in a log, so it gets the file's location instead.
  const where = process.stdout.isTTY
    ? `  If it is you, enter this setup code there: ${formatted(code.value)}\n` +
      `  It works once, until ${expires}. It is also in ${file}.`
    : `  If it is you, the setup code to enter there is in ${file}.\n` +
      `  It works once, until ${expires}.`;
  process.stdout.write(
    ['', '  Someone is creating the owner account from another device.', where, ''].join('\n') +
      '\n'
  );
  logger.info('[Auth] A setup code was printed to the terminal for an owner sign-up', {
    path: file,
  });
}

/** Use the code up: no second sign-up can present it. */
function spend(): void {
  current = null;
  try {
    fs.rmSync(codeFilePath(), { force: true });
  } catch {
    // The file is only a copy; the code itself is already gone.
  }
}

/** Wrong codes inside the window, dropping the ones that aged out. */
function recentFailures(now: number): number {
  failures = failures.filter((at) => now - at < SETUP_CODE_FAILURE_WINDOW_MS);
  return failures.length;
}

/**
 * Forget the current code, if one was minted and not used. Called when the
 * owner account is created any other way, so no stale code file is left.
 */
export function discardSetupCode(): void {
  spend();
}

/**
 * Forget every code and failure.
 *
 * @internal Exported for testing only.
 */
export function resetSetupCodeForTests(): void {
  current = null;
  failures = [];
}
