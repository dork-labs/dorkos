import { describe, it, expect } from 'vitest';
import { FONT_CONFIGS, DEFAULT_FONT, getFontConfig, isValidFontKey } from '../font-config';

describe('font-config', () => {
  it('all FONT_CONFIGS have unique keys', () => {
    const keys = FONT_CONFIGS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every font a person picks in Settings, but the default and system, loads from Google', () => {
    FONT_CONFIGS.filter((f) => f.key !== 'system' && f.key !== DEFAULT_FONT).forEach((f) => {
      expect(f.googleFontsUrl).toMatch(/^https:\/\/fonts\.googleapis\.com\//);
    });
  });

  // Purpose (DOR-4872): the default ships with the app, so a start asks Google
  // for nothing and never waits on it.
  it('the default font makes no Google request', () => {
    expect(getFontConfig(DEFAULT_FONT).googleFontsUrl).toBeNull();
  });

  it('system config has null googleFontsUrl', () => {
    const system = FONT_CONFIGS.find((f) => f.key === 'system');
    expect(system?.googleFontsUrl).toBeNull();
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
