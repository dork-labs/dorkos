/**
 * The page stamp (DOR-5026): only a real navigation gets one, only this
 * server's key signs one, it names the sign-in it went out under, and a
 * confirm counts only from a page loaded after the last risk cleared.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mintPageStamp,
  pageMayHoldRiskyCode,
  pageStampMeta,
  readPageStamp,
  sessionFingerprint,
  usePageStampKeyFile,
  wantsPageStamp,
} from '../page-stamp.js';
import { StepUpRiskLedger } from '../step-up-risk-ledger.js';

let dir: string;
let keyFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-stamp-'));
  keyFile = path.join(dir, 'step-up', 'page-stamp.key');
  usePageStampKeyFile(keyFile);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const SIGNED_IN_A = 'better-auth.session_token=made-up-a; theme=dark';
const SIGNED_IN_B = 'better-auth.session_token=made-up-b';

describe('wantsPageStamp', () => {
  const req = (headers: Record<string, string>, method = 'GET') => ({ method, headers });

  it('stamps a top-level navigation, and a browser that sends no Sec-Fetch headers', () => {
    expect(
      wantsPageStamp(req({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))
    ).toBe(true);
    expect(wantsPageStamp(req({}))).toBe(true);
  });

  it('never stamps a script’s fetch, an iframe, a prefetch or a HEAD', () => {
    expect(wantsPageStamp(req({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).toBe(
      false
    );
    expect(wantsPageStamp(req({ 'sec-fetch-mode': 'same-origin' }))).toBe(false);
    expect(wantsPageStamp(req({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }))).toBe(
      false
    );
    expect(wantsPageStamp(req({ 'sec-fetch-dest': 'empty' }))).toBe(false);
    expect(wantsPageStamp(req({}, 'HEAD'))).toBe(false);
  });
});

describe('a stamp', () => {
  it('reads back what it was minted with, and names the sign-in', () => {
    const stamp = readPageStamp(mintPageStamp(SIGNED_IN_A, 1_000));
    expect(stamp).toEqual({ loadedAt: 1_000, session: sessionFingerprint(SIGNED_IN_A) });
    expect(readPageStamp(mintPageStamp(undefined, 2_000))).toEqual({
      loadedAt: 2_000,
      session: null,
    });
  });

  it('is refused when absent, malformed, altered or signed with another key', () => {
    const stamp = mintPageStamp(SIGNED_IN_A, 1_000);
    const [version, body, mac] = stamp.split('.');
    const later = Buffer.from(
      JSON.stringify({ t: 9_999_999, s: sessionFingerprint(SIGNED_IN_A), n: 'x' })
    ).toString('base64url');
    expect(readPageStamp(undefined)).toBeNull();
    expect(readPageStamp('')).toBeNull();
    expect(readPageStamp('not a stamp')).toBeNull();
    expect(readPageStamp(`${version}.${later}.${mac}`)).toBeNull();
    expect(readPageStamp(`v2.${body}.${mac}`)).toBeNull();
    expect(readPageStamp(`${stamp}.extra`)).toBeNull();
    // A new key: every stamp the old one signed stops counting.
    fs.rmSync(keyFile);
    usePageStampKeyFile(keyFile);
    expect(readPageStamp(stamp)).toBeNull();
  });

  it('keeps its key across a restart, owner-only, and makes a new one when it can’t be read', () => {
    const stamp = mintPageStamp(SIGNED_IN_A, 1_000);
    usePageStampKeyFile(keyFile);
    expect(readPageStamp(stamp)).not.toBeNull();
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    // A copy restored with wider access is made owner-only again.
    fs.chmodSync(keyFile, 0o644);
    usePageStampKeyFile(keyFile);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readPageStamp(stamp)).not.toBeNull();
    fs.writeFileSync(keyFile, 'short');
    usePageStampKeyFile(keyFile);
    expect(readPageStamp(stamp)).toBeNull();
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
  });

  it('goes in the page as a meta tag', () => {
    const stamp = mintPageStamp(undefined, 1_000);
    expect(pageStampMeta(stamp)).toBe(`<meta name="dorkos-page-stamp" content="${stamp}">`);
  });
});

describe('sessionFingerprint', () => {
  it('reads only the sign-in, under any cookie prefix', () => {
    expect(sessionFingerprint(undefined)).toBeNull();
    expect(sessionFingerprint('theme=dark')).toBeNull();
    expect(sessionFingerprint(SIGNED_IN_A)).toBe(
      sessionFingerprint('better-auth.session_token=made-up-a')
    );
    expect(sessionFingerprint('__Secure-better-auth-0a.session_token=made-up-a')).toBe(
      sessionFingerprint(SIGNED_IN_A)
    );
    expect(sessionFingerprint(SIGNED_IN_A)).not.toBe(sessionFingerprint(SIGNED_IN_B));
  });
});

describe('pageMayHoldRiskyCode', () => {
  /** A ledger whose risk cleared at 5_000: a mini app was held or turned off. */
  function cleared(): StepUpRiskLedger {
    const ledger = new StepUpRiskLedger();
    ledger.note(1, 4_000);
    ledger.note(0, 5_000);
    return ledger;
  }
  const ask = (
    ledger: StepUpRiskLedger,
    stamp: string | undefined,
    cookie: string | undefined,
    sessionStartedAt: number | null,
    enforced = true
  ) => pageMayHoldRiskyCode({ ledger, enforced, stamp, cookie, sessionStartedAt });

  it('asks for nothing before a risk was ever seen', () => {
    expect(ask(new StepUpRiskLedger(), undefined, SIGNED_IN_A, 1_000)).toBe(false);
  });

  it('after a clear, refuses a page with no stamp or a forged one', () => {
    expect(ask(cleared(), undefined, SIGNED_IN_B, 6_000)).toBe(true);
    expect(ask(cleared(), 'v1.made-up.stamp', SIGNED_IN_B, 6_000)).toBe(true);
  });

  it('refuses a page loaded before the clear, even after signing in again in place', () => {
    // Loaded at 1_000 signed in as A; the risk cleared at 5_000; signed in again as B at 6_000.
    const old = mintPageStamp(SIGNED_IN_A, 1_000);
    expect(ask(cleared(), old, SIGNED_IN_B, 6_000)).toBe(true);
    // Same sign-in, still the old page.
    expect(ask(cleared(), old, SIGNED_IN_A, 6_000)).toBe(true);
  });

  it('allows a page loaded after the clear, under the same sign-in', () => {
    expect(ask(cleared(), mintPageStamp(SIGNED_IN_B, 7_000), SIGNED_IN_B, 6_000)).toBe(false);
  });

  it('refuses a fresh stamp carried into another sign-in', () => {
    expect(ask(cleared(), mintPageStamp(SIGNED_IN_A, 7_000), SIGNED_IN_B, 6_000)).toBe(true);
  });

  it('takes a signed-out stamp only for a sign-in made after the page loaded', () => {
    const signedOut = mintPageStamp(undefined, 7_000);
    expect(ask(cleared(), signedOut, SIGNED_IN_B, 8_000)).toBe(false);
    expect(ask(cleared(), signedOut, SIGNED_IN_B, 6_000)).toBe(true);
    expect(ask(cleared(), signedOut, SIGNED_IN_B, null)).toBe(true);
  });

  it('still refuses a sign-in from before the clear, whatever the page', () => {
    expect(ask(cleared(), mintPageStamp(SIGNED_IN_A, 7_000), SIGNED_IN_A, 1_000)).toBe(true);
  });

  it('keeps the sign-in check alone when this server sends no page (the dev server)', () => {
    expect(ask(cleared(), undefined, SIGNED_IN_B, 6_000, false)).toBe(false);
    expect(ask(cleared(), undefined, SIGNED_IN_B, 1_000, false)).toBe(true);
  });
});
