import { describe, expect, it } from 'vitest';
import {
  ADDRESS_HOST_MIN_FONT_PX,
  ROOMY_ADDRESS_FIT,
  chooseAddressFit,
  type AddressFit,
  type AddressMeasures,
} from '../browser-chrome/address-fit';

/** A field about 258px wide on a phone, measured at 16px: about 8.8px a character. */
const CHAR = 8.8;
const narrow = (host: string, kept: string, badge = false): AddressMeasures => ({
  available: 40,
  paddingGain: 6,
  gap: 6,
  badgeFull: badge ? 75 : 0,
  badgeIcon: badge ? 15 : 0,
  host: host.length * CHAR,
  kept: kept.length * CHAR,
  ellipsis: host === kept ? 0 : CHAR,
  baseFontPx: 16,
});

/** Whether a fit, if it does not wrap, leaves the kept part whole in the room it has. */
function keptFits(m: AddressMeasures, fit: AddressFit): boolean {
  if (fit.wrap) return true;
  const scale = (fit.fontPx ?? m.baseFontPx) / m.baseFontPx;
  const badge = fit.badgeIcon ? m.badgeIcon : m.badgeFull;
  const lead = badge > 0 ? badge + m.gap : 0;
  const text = fit.host === 'full' ? m.host : m.ellipsis + m.kept;
  return lead + text * scale <= m.available + (fit.tightPadding ? m.paddingGain : 0) + 0.001;
}

describe('chooseAddressFit (DOR-4655)', () => {
  it('gives nothing up when the whole host fits', () => {
    const m = { ...narrow('shop.example', 'shop.example'), available: 300 };
    expect(chooseAddressFit(m)).toEqual(ROOMY_ADDRESS_FIT);
  });

  it('elides only the labels before the kept part first, as "…", never part of one', () => {
    const m = {
      ...narrow('accounts.google.com.attacker.example', 'com.attacker.example'),
      available: 200,
    };
    expect(chooseAddressFit(m)).toMatchObject({ host: 'elided', path: false, fontPx: null });
  });

  it('then shrinks Not secure to its icon, then tightens the padding, before any font change', () => {
    const base = narrow('accounts.google.com.attacker.example', 'com.attacker.example', true);
    const kept = 9 * CHAR + 20 * CHAR; // "…" plus the kept part
    expect(chooseAddressFit({ ...base, available: kept + 75 + 6 })).toMatchObject({
      badgeIcon: false,
      host: 'elided',
    });
    expect(chooseAddressFit({ ...base, available: CHAR + 20 * CHAR + 15 + 6 })).toMatchObject({
      badgeIcon: true,
      tightPadding: false,
      fontPx: null,
    });
    expect(chooseAddressFit({ ...base, available: CHAR + 20 * CHAR + 15 + 6 - 4 })).toMatchObject({
      badgeIcon: true,
      tightPadding: true,
      fontPx: null,
    });
  });

  it('shrinks the font one fixed step to 12px, and wraps rather than clip below it', () => {
    expect(ADDRESS_HOST_MIN_FONT_PX).toBe(12);
    const shrinks = { ...narrow('evil.example', 'evil.example'), available: 90 };
    const fit = chooseAddressFit(shrinks);
    expect(fit.fontPx).toBe(ADDRESS_HOST_MIN_FONT_PX);
    expect(fit.wrap).toBe(false);
    const wraps = chooseAddressFit(
      narrow('accounts.google.com.attacker.example', 'com.attacker.example')
    );
    expect(wraps).toMatchObject({ wrap: true, fontPx: ADDRESS_HOST_MIN_FONT_PX });
  });

  it.each([
    ['notgoogle.com', 'notgoogle.com'],
    ['evil-google.com', 'evil-google.com'],
    ['accounts.google.com.attacker.example', 'com.attacker.example'],
    ['login-google.vercel.app', 'login-google.vercel.app'],
    [
      'a-very-long-attacker-registrable-name.example',
      'a-very-long-attacker-registrable-name.example',
    ],
  ])('never clips the kept part of %s at any width', (host, kept) => {
    for (let available = 20; available <= 400; available += 7) {
      for (const badge of [false, true]) {
        const m = { ...narrow(host, kept, badge), available };
        expect(keptFits(m, chooseAddressFit(m))).toBe(true);
      }
    }
  });
});
