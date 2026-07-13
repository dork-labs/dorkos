import { describe, it, expect } from 'vitest';
import { classifyRegion, parseRegionCookie } from '@/lib/region';

describe('classifyRegion', () => {
  it('classifies EU-27 countries as gated', () => {
    for (const c of ['DE', 'FR', 'IT', 'ES', 'PL', 'IE', 'SE', 'GR', 'HR', 'MT']) {
      expect(classifyRegion(c)).toBe('gated');
    }
  });

  it('classifies non-EU EEA states, the UK, and Switzerland as gated', () => {
    for (const c of ['IS', 'LI', 'NO', 'GB', 'CH']) {
      expect(classifyRegion(c)).toBe('gated');
    }
  });

  it('classifies the US and other non-listed countries as open', () => {
    for (const c of ['US', 'CA', 'JP', 'AU', 'BR', 'IN', 'MX', 'SG']) {
      expect(classifyRegion(c)).toBe('open');
    }
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(classifyRegion('de')).toBe('gated');
    expect(classifyRegion(' gb ')).toBe('gated');
    expect(classifyRegion('us')).toBe('open');
  });

  it('fails closed to gated for a missing, empty, or unresolved country', () => {
    expect(classifyRegion(null)).toBe('gated');
    expect(classifyRegion(undefined)).toBe('gated');
    expect(classifyRegion('')).toBe('gated');
    expect(classifyRegion('   ')).toBe('gated');
    // Vercel's sentinel for an IP it could not resolve to a country.
    expect(classifyRegion('XX')).toBe('gated');
    expect(classifyRegion('xx')).toBe('gated');
  });

  it('classifies a known-but-non-gated country as open', () => {
    // We know where the visitor is; it just is not an opt-in-first jurisdiction.
    expect(classifyRegion('ZZ')).toBe('open');
  });
});

describe('parseRegionCookie', () => {
  it('returns open only for the exact string "open"', () => {
    expect(parseRegionCookie('open')).toBe('open');
  });

  it('fails closed to gated for anything else', () => {
    expect(parseRegionCookie('gated')).toBe('gated');
    expect(parseRegionCookie('')).toBe('gated');
    expect(parseRegionCookie(undefined)).toBe('gated');
    expect(parseRegionCookie(null)).toBe('gated');
    expect(parseRegionCookie('OPEN')).toBe('gated');
    expect(parseRegionCookie('true')).toBe('gated');
  });
});
