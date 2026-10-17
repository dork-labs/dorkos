/**
 * @vitest-environment node
 *
 * A hub's one-time link codes: 80 bits, single use, ten minutes, three at
 * most, and a global stop after 100 wrong codes in ten minutes that minting
 * a code clears.
 */
import { describe, expect, it } from 'vitest';
import {
  RELAY_LINK_CODE_ALPHABET,
  RELAY_LINK_CODE_TTL_MS,
} from '@dorkos/shared/session-relay-link';
import {
  HUB_LINK_FAILURE_WINDOW_MS,
  HUB_LINK_MAX_FAILURES,
  HUB_LINK_MAX_OUTSTANDING,
  LinkCodeBook,
} from '../link-codes.js';

const OWNER = { accountId: 'acct_owner', kind: 'person', name: 'Dorian' } as const;

/** A code book on a clock the test moves. */
function book() {
  const clock = { now: 1_000_000 };
  return { clock, codes: new LinkCodeBook(() => clock.now) };
}

describe('LinkCodeBook', () => {
  it('mints 16 Crockford characters that expire in ten minutes', () => {
    const { clock, codes } = book();
    const minted = codes.mint();
    expect(minted.code).toHaveLength(16);
    for (const char of minted.code) expect(RELAY_LINK_CODE_ALPHABET).toContain(char);
    expect(minted.expiresAt).toBe(clock.now + RELAY_LINK_CODE_TTL_MS);
  });

  it('redeems a code once, and remembers who minted it', () => {
    const { codes } = book();
    const { code } = codes.mint(OWNER);
    expect(codes.consume(code)).toEqual({ ok: true, mintedBy: OWNER });
    expect(codes.consume(code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reads a code as a person types it', () => {
    const { codes } = book();
    const { code } = codes.mint();
    const typed = `${code.slice(0, 4)}-${code.slice(4, 8)} ${code.slice(8)}`.toLowerCase();
    expect(codes.consume(typed).ok).toBe(true);
  });

  it('refuses a code once it has expired', () => {
    const { clock, codes } = book();
    const { code } = codes.mint();
    clock.now += RELAY_LINK_CODE_TTL_MS;
    expect(codes.consume(code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps at most three, dropping the oldest', () => {
    const { codes } = book();
    const minted = Array.from({ length: HUB_LINK_MAX_OUTSTANDING + 1 }, () => codes.mint());
    expect(codes.consume(minted[0]!.code).ok).toBe(false);
    for (const later of minted.slice(1)) expect(codes.consume(later.code).ok).toBe(true);
  });

  it('refuses everything, a right code included, past the cap, until the window passes', () => {
    const { clock, codes } = book();
    const { code } = codes.mint();
    for (let i = 0; i < HUB_LINK_MAX_FAILURES; i++) {
      expect(codes.consume('0000-0000-0000-0000')).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(codes.consume(code)).toEqual({ ok: false, reason: 'throttled' });
    clock.now += HUB_LINK_FAILURE_WINDOW_MS - RELAY_LINK_CODE_TTL_MS / 2;
    expect(codes.consume(code)).toEqual({ ok: false, reason: 'throttled' });
    clock.now += RELAY_LINK_CODE_TTL_MS / 2;
    // The window has passed: a wrong code is wrong again, no longer throttled.
    expect(codes.consume('0000-0000-0000-0000')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('counts anything that is not a code as a wrong code', () => {
    const { codes } = book();
    const { code } = codes.mint();
    for (let i = 0; i < HUB_LINK_MAX_FAILURES; i++) codes.consume('not a code');
    expect(codes.consume(code)).toEqual({ ok: false, reason: 'throttled' });
  });

  it('clears the failures when the owner mints a code, so wrong codes never block linking', () => {
    const { codes } = book();
    for (let i = 0; i < HUB_LINK_MAX_FAILURES; i++) codes.consume('0000-0000-0000-0000');
    expect(codes.consume('0000-0000-0000-0000')).toEqual({ ok: false, reason: 'throttled' });
    const { code } = codes.mint();
    expect(codes.consume(code).ok).toBe(true);
  });

  it('keeps the cap a backstop: 100 wrong codes in ten minutes', () => {
    expect(HUB_LINK_MAX_FAILURES).toBe(100);
  });
});
