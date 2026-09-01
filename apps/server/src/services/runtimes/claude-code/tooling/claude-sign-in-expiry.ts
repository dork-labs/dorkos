/**
 * Reads WHEN the host's Claude sign-in stops working — the one thing the
 * readiness probe next door cannot see.
 *
 * `claude auth status` reports from stored state without a live check, so a
 * present-but-expired sign-in reads `loggedIn: true` and the runtime shows
 * "Ready" right up until a real turn fails with "OAuth session expired and could
 * not be refreshed". Measured on this repo's own machine (2026-09-01): an
 * account's renewal window closed at 20:51Z and the CLI only blanked the stored
 * tokens at 12:06Z the next day — a **15-hour window** in which the credential
 * was present, unusable, and indistinguishable from a working one. This module
 * closes that window by reading the deadline the sign-in was issued with.
 *
 * ## The two deadlines, and why only one of them is worth telling anyone about
 *
 * A `claude.ai` sign-in stores two timestamps, and they mean opposite things:
 *
 * - `expiresAt` — the ACCESS token. Roughly 8 hours, and it renews itself
 *   silently on the next turn. Measured 3.5 hours out on a perfectly healthy
 *   sign-in. Warning a person about this would fire several times a day and be
 *   wrong every time.
 * - `refreshTokenExpiresAt` — the SIGN-IN. Measured ~19 days out, and it does
 *   NOT slide forward on each renewal. When it passes, nothing can renew and a
 *   person must sign in again by hand.
 *
 * So {@link ClaudeSignInDeadlines.renewableUntil} is the honest thing to warn
 * about, and the access deadline exists here only to keep the "already dead"
 * verdict from firing on a sign-in that still has hours of life in it
 * ({@link isSignInUnusable}).
 *
 * ## Reading credentials, and the line this does not cross
 *
 * Read-only, for status only: the store is parsed for two numbers and the parsed
 * value is discarded. Token material is never copied out, never logged, never
 * persisted, and never used to authenticate anything — DorkOS delegates every
 * turn to the `claude` binary, which authenticates itself. That is the boundary
 * `research/anthropic-tos-compliance.md` clears explicitly (row 1: reading the
 * host store read-only for status is permitted; extracting the token to drive
 * the SDK is the excluded pattern).
 *
 * Every failure answers "unknown" (`null`), never a guess. Unknown must stay
 * indistinguishable from healthy at every call site: an env credential, an older
 * CLI that stores no renewal deadline, a locked Keychain, or a platform whose
 * store this does not know all land here, and none of them is evidence that
 * anything is wrong.
 *
 * @module services/runtimes/claude-code/tooling/claude-sign-in-expiry
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runBinaryProbe } from '../../shared/run-probe.js';
import { logger } from '../../../../lib/logger.js';
import { claudeConfigDirEnv } from '../claude-config-dir.js';

/** Hard bound on the credential-store read, matching the sibling CLI probes. */
const EXPIRY_PROBE_TIMEOUT_MS = 5_000;

/** macOS Keychain service name Claude Code stores the DEFAULT account's sign-in under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Absolute path to the macOS Keychain CLI (absolute so `PATH` cannot redirect a credential read). */
const SECURITY_BINARY = '/usr/bin/security';

/** Filename Claude Code stores the sign-in under everywhere except macOS. */
const CREDENTIALS_FILENAME = '.credentials.json';

/** The two deadlines stored beside a `claude.ai` sign-in, as epoch milliseconds. */
export interface ClaudeSignInDeadlines {
  /**
   * When the token currently in hand stops working. Renews itself silently, so
   * this is NOT a thing to warn a person about — it is only here to tell a
   * sign-in that is merely stale from one that is actually dead.
   */
  accessExpiresAt: number;
  /**
   * When the sign-in can no longer renew itself and a person has to sign in
   * again by hand. This is the deadline worth surfacing.
   */
  renewableUntil: number;
}

/**
 * The Keychain service name holding the sign-in for `configDir`.
 *
 * Claude Code derives this as `Claude Code-credentials[-<8 hex of
 * sha256(configDir)>]` and takes the UNSUFFIXED branch exactly when
 * `CLAUDE_CONFIG_DIR` is unset — the same rule `claudeConfigDirEnv` documents,
 * and confirmed here against real Keychain entries: `~/.claude`'s entry is the
 * unsuffixed one and the suffixed spelling of that path does not exist, while a
 * `CLAUDE_CONFIG_DIR` pointing at `~/.claude2` has the suffixed entry.
 *
 * @param configDir - The ambient `CLAUDE_CONFIG_DIR`, or `undefined` when unset.
 */
export function claudeCredentialKeychainService(configDir: string | undefined): string {
  if (configDir === undefined) return KEYCHAIN_SERVICE;
  const digest = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${digest}`;
}

/** Read one epoch-ms deadline off a credential record, or `undefined` when it is absent or not a number. */
function readDeadline(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Pull the two sign-in deadlines out of a raw credential store.
 *
 * Reads `claudeAiOauth` only. A real store also carries an `mcpOAuth` map whose
 * entries have their own unrelated `expiresAt` values, and mistaking one of those
 * for the sign-in's deadline would warn about the wrong thing entirely.
 *
 * @param raw - The credential store's contents, as JSON text.
 * @returns Both deadlines, or `null` when the store holds no `claude.ai` sign-in,
 *   omits the renewal deadline (older CLI versions), or does not parse.
 */
export function parseClaudeSignInDeadlines(raw: string): ClaudeSignInDeadlines | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const signIn = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof signIn !== 'object' || signIn === null) return null;

  const record = signIn as Record<string, unknown>;
  const accessExpiresAt = readDeadline(record, 'expiresAt');
  const renewableUntil = readDeadline(record, 'refreshTokenExpiresAt');
  if (accessExpiresAt === undefined || renewableUntil === undefined) return null;

  return { accessExpiresAt, renewableUntil };
}

/**
 * Whether the sign-in can no longer serve a turn: the token in hand is dead AND
 * the sign-in can no longer renew itself.
 *
 * Both conditions are required, because either alone is a false alarm. A dead
 * access token with renewal still open is the ordinary overnight case — the next
 * turn renews it silently. A closed renewal window with a live access token
 * still runs, for as long as that token lasts; an active user who worked shortly
 * before the deadline can hold one for hours after it.
 *
 * @param deadlines - The sign-in's two deadlines.
 * @param now - Current epoch ms.
 */
export function isSignInUnusable(deadlines: ClaudeSignInDeadlines, now: number): boolean {
  return deadlines.accessExpiresAt <= now && deadlines.renewableUntil <= now;
}

/**
 * Format an epoch-ms deadline as an ISO-8601 instant.
 *
 * Answers `undefined` for a value no calendar date can represent — a corrupt or
 * absurd number in the store must degrade to "no deadline known", never throw on
 * the readiness path.
 *
 * @param epochMs - The deadline, in epoch milliseconds.
 */
export function toIsoDeadline(epochMs: number): string | undefined {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Read the raw credential store for `root` (macOS Keychain, or the file beside it). */
async function readCredentialStore(root: string): Promise<string> {
  if (process.platform === 'darwin') {
    // Which Keychain BRANCH Claude Code takes is decided by whether it would see
    // `CLAUDE_CONFIG_DIR` set for this root, not by the root itself — so ask the
    // same function that builds the spawn env, rather than restating its rule.
    const service = claudeCredentialKeychainService(claudeConfigDirEnv(root).CLAUDE_CONFIG_DIR);
    return runBinaryProbe(
      SECURITY_BINARY,
      ['find-generic-password', '-w', '-s', service],
      EXPIRY_PROBE_TIMEOUT_MS
    );
  }
  return readFile(path.join(root, CREDENTIALS_FILENAME), 'utf-8');
}

/**
 * Read the deadlines on the sign-in belonging to `root`.
 *
 * The account is passed in rather than resolved here, because it must be the
 * SAME one the caller pinned its `claude auth status` probe to and the same one
 * sessions actually launch on. Resolving the ambient environment here instead
 * would let the card assert a dead sign-in for an account no session uses, on a
 * machine where a chosen default account is signed in perfectly well.
 *
 * @param root - Absolute Claude config directory whose sign-in to read.
 * @returns The deadlines, or `null` whenever they cannot be established — which
 *   callers must treat as "no information", never as a problem.
 */
export async function readClaudeSignInDeadlines(
  root: string
): Promise<ClaudeSignInDeadlines | null> {
  try {
    return parseClaudeSignInDeadlines(await readCredentialStore(root));
  } catch (err) {
    // Expected and uninteresting on any machine that signs in another way (an
    // API key, a locked Keychain, a store this platform does not have), so this
    // is `debug`: it explains an absent warning, it does not report a fault.
    logger.debug('[Runtimes] could not read the Claude sign-in expiry', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
