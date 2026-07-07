/**
 * Opaque tokens for newsletter double opt-in and unsubscribe (ADR 260707-025214).
 *
 * A token is 32 random bytes hex-encoded. Only its sha256 **hash** is persisted
 * (`newsletter_subscriber.confirm_token_hash` / `unsubscribe_token_hash`); the
 * raw token travels only in the emailed URL. Verification hashes the incoming
 * token and matches by hash, so a database read never exposes a usable token.
 * The token's own entropy is the secret, so no separate signing key is needed.
 *
 * @module lib/newsletter/tokens
 */
import { createHash, randomBytes } from 'node:crypto';

/** Raw token byte length before hex encoding. */
const TOKEN_BYTES = 32;

/** A freshly minted token: the raw value for the URL, plus its stored hash. */
export interface NewsletterToken {
  /** The raw token to place in the confirm/unsubscribe URL. Never stored. */
  raw: string;
  /** sha256(raw) — the only form written to the database. */
  hash: string;
}

/**
 * Hash a raw token for storage or lookup.
 *
 * @param raw - The raw hex token from a URL.
 * @returns Lowercase hex sha256 digest.
 */
export function hashNewsletterToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a new random token and its storage hash.
 *
 * @returns The raw token (for the URL) and its sha256 hash (for the row).
 */
export function generateNewsletterToken(): NewsletterToken {
  const raw = randomBytes(TOKEN_BYTES).toString('hex');
  return { raw, hash: hashNewsletterToken(raw) };
}
