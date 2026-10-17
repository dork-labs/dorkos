/**
 * The one-time codes a hub's owner links a computer with (step B3, DOR-2946).
 *
 * - **Minted only by the owner**, from their signed-in browser
 *   (`POST /api/hub/computers/link-code`): 16 characters of Crockford base32,
 *   80 bits.
 * - **Single use, for ten minutes**, and kept only as a SHA-256 in memory: a
 *   restart voids every outstanding code, which costs the owner one click.
 * - **At most {@link HUB_LINK_MAX_OUTSTANDING} at once**: minting another
 *   drops the oldest, so the owner is never locked out of minting.
 * - **Slowed on failures, as a backstop**: past {@link HUB_LINK_MAX_FAILURES}
 *   wrong codes in ten minutes, every redemption is refused until the window
 *   passes. The cap is global, never per address, because every computer
 *   reaches a hub through the same front door. Guessing an 80-bit, single-use,
 *   ten-minute code is not feasible anyway, so the cap is high, and **minting a
 *   code clears it**: someone sending wrong codes can delay the owner by one
 *   click, never block linking.
 *
 * A code also remembers who minted it, so the link it is redeemed for is
 * recorded as theirs.
 *
 * @module services/core/hub-relay/link-codes
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import {
  RELAY_LINK_CODE_ALPHABET,
  RELAY_LINK_CODE_LENGTH,
  RELAY_LINK_CODE_TTL_MS,
  normalizeRelayLinkCode,
} from '@dorkos/shared/session-relay-link';

/** Most codes outstanding at once. */
export const HUB_LINK_MAX_OUTSTANDING = 3;

/** Wrong codes allowed in one {@link HUB_LINK_FAILURE_WINDOW_MS}, from anywhere. */
export const HUB_LINK_MAX_FAILURES = 100;

/** The window wrong codes are counted over. */
export const HUB_LINK_FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** A freshly minted code: the only time the code itself exists outside a hash. */
export interface MintedLinkCode {
  /** The canonical 16 characters. */
  code: string;
  /** When it stops working (epoch ms). */
  expiresAt: number;
}

/** What redeeming a code came to. */
export type LinkCodeRedemption =
  | { ok: true; mintedBy: AuditActor | undefined }
  /** Wrong, expired or already used: one answer for all three. */
  | { ok: false; reason: 'invalid' }
  /** Too many wrong codes lately, from anywhere. */
  | { ok: false; reason: 'throttled' };

interface Outstanding {
  hash: Buffer;
  expiresAt: number;
  mintedBy: AuditActor | undefined;
}

function hashOf(code: string): Buffer {
  return createHash('sha256').update(code, 'utf8').digest();
}

/** A hub's outstanding link codes and its recent failures, in memory. */
export class LinkCodeBook {
  private outstanding: Outstanding[] = [];
  private failures: number[] = [];

  /**
   * Start with no codes and no failures.
   *
   * @param now - The clock; injectable for tests.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Mint a code, dropping the oldest outstanding one past the cap, and clear
   * the failure count: the owner asking for a code is never held back by
   * someone else's wrong ones.
   *
   * @param mintedBy - Who asked for it, to record the link as theirs.
   */
  mint(mintedBy?: AuditActor): MintedLinkCode {
    const now = this.now();
    let code = '';
    for (let i = 0; i < RELAY_LINK_CODE_LENGTH; i++) {
      code += RELAY_LINK_CODE_ALPHABET[randomInt(RELAY_LINK_CODE_ALPHABET.length)];
    }
    const expiresAt = now + RELAY_LINK_CODE_TTL_MS;
    this.failures = [];
    this.outstanding = [
      ...this.live(now).slice(-(HUB_LINK_MAX_OUTSTANDING - 1)),
      { hash: hashOf(code), expiresAt, mintedBy },
    ];
    return { code, expiresAt };
  }

  /**
   * Redeem a code: on success it is spent. Compares hashes in constant time
   * and walks every outstanding code, so how long it takes says nothing about
   * which one, or how much of one, matched.
   *
   * @param input - The code as the request carried it.
   */
  consume(input: string): LinkCodeRedemption {
    const now = this.now();
    if (this.recentFailures(now) >= HUB_LINK_MAX_FAILURES)
      return { ok: false, reason: 'throttled' };
    const code = normalizeRelayLinkCode(input);
    const offered = hashOf(code ?? '');
    let found: Outstanding | null = null;
    for (const entry of this.live(now)) {
      if (timingSafeEqual(entry.hash, offered) && code !== null && !found) found = entry;
    }
    if (!found) {
      this.failures.push(now);
      return { ok: false, reason: 'invalid' };
    }
    this.outstanding = this.outstanding.filter((entry) => entry !== found);
    return { ok: true, mintedBy: found.mintedBy };
  }

  /** The codes that have not expired, dropping the rest. */
  private live(now: number): Outstanding[] {
    this.outstanding = this.outstanding.filter((entry) => entry.expiresAt > now);
    return this.outstanding;
  }

  /** Wrong codes inside the window, dropping the ones that aged out. */
  private recentFailures(now: number): number {
    this.failures = this.failures.filter((at) => now - at < HUB_LINK_FAILURE_WINDOW_MS);
    return this.failures.length;
  }
}

/** The live hub's codes. */
export const hubLinkCodes = new LinkCodeBook();
