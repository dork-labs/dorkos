import { describe, it, expect } from 'vitest';
import { FONT_CONFIGS, DEFAULT_FONT, getFontConfig, isValidFontKey } from '../font-config';
import { STORAGE_KEYS } from '../constants';

describe('font-config', () => {
  it('all FONT_CONFIGS have unique keys', () => {
    const keys = FONT_CONFIGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('all non-system configs have a googleFontsUrl', () => {
    FONT_CONFIGS.filter((f) => f.key !== 'system').forEach((f) => {
      expect(f.googleFontsUrl).toBeTruthy();
    });
  });

  it('system config has null googleFontsUrl', () => {
    const system = FONT_CONFIGS.find((f) => f.key === 'system');
    expect(system?.googleFontsUrl).toBeNull();
  });

  it('keeps the key and value the browser suite seeds to stay off Google Fonts', () => {
    // apps/e2e/google-fonts-stub.ts spells both by hand (apps/e2e depends on no
    // client code) and seeds them into every browser test's localStorage so no
    // page load waits on fonts.googleapis.com (DOR-4871). A rename here would
    // put the suite back on the network without failing anything else.
    expect(STORAGE_KEYS.FONT_FAMILY).toBe('dorkos-font-family');
    expect(getFontConfig('system').googleFontsUrl).toBeNull();
  });

  it('DEFAULT_FONT is inter', () => {
    expect(DEFAULT_FONT).toBe('inter');
  });

  describe('getFontConfig', () => {
    it('returns correct config for each valid key', () => {
      FONT_CONFIGS.forEach((config) => {
        expect(getFontConfig(config.key)).toEqual(config);
      });
    });

    it('returns default (inter) config for unknown key', () => {
      const result = getFontConfig('nonexistent');
      expect(result.key).toBe(DEFAULT_FONT);
    });

    it('returns default config for empty string', () => {
      const result = getFontConfig('');
      expect(result.key).toBe(DEFAULT_FONT);
    });
  });

  describe('isValidFontKey', () => {
    it('returns true for all valid keys', () => {
      FONT_CONFIGS.forEach((config) => {
        expect(isValidFontKey(config.key)).toBe(true);
      });
    });

    it('returns false for invalid key', () => {
      expect(isValidFontKey('comic-sans')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidFontKey('')).toBe(false);
    });
  });
});
