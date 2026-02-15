// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { loadGoogleFont, removeGoogleFont, applyFontCSS, removeFontCSS } from '../font-loader';

describe('font-loader', () => {
  beforeEach(() => {
    document.getElementById('google-fonts-link')?.remove();
    document.documentElement.style.removeProperty('--font-sans');
    document.documentElement.style.removeProperty('--font-mono');
  });

  describe('loadGoogleFont', () => {
    it('creates a link element with correct attributes', () => {
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Inter');
      const link = document.getElementById('google-fonts-link') as HTMLLinkElement;
      expect(link).toBeTruthy();
      expect(link.rel).toBe('stylesheet');
      expect(link.href).toContain('fonts.googleapis.com');
    });

    it('updates existing link instead of creating duplicate', () => {
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Inter');
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Roboto');
      const links = document.querySelectorAll('#google-fonts-link');
      expect(links.length).toBe(1);
      expect((links[0] as HTMLLinkElement).href).toContain('Roboto');
    });
  });

  describe('removeGoogleFont', () => {
    it('removes the link element', () => {
      loadGoogleFont('https://fonts.googleapis.com/css2?family=Inter');
      expect(document.getElementById('google-fonts-link')).toBeTruthy();
      removeGoogleFont();
      expect(document.getElementById('google-fonts-link')).toBeNull();
    });

    it('does nothing if no link exists', () => {
      expect(() => removeGoogleFont()).not.toThrow();
    });
  });

  describe('applyFontCSS', () => {
    it('sets CSS custom properties on documentElement', () => {
      applyFontCSS("'Inter', sans-serif", "'JetBrains Mono', monospace");
      expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe(
        "'Inter', sans-serif",
      );
      expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe(
        "'JetBrains Mono', monospace",
      );
    });
  });

  describe('removeFontCSS', () => {
    it('removes CSS custom properties', () => {
      applyFontCSS("'Inter', sans-serif", "'JetBrains Mono', monospace");
      removeFontCSS();
      expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('');
      expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('');
    });
  });
});
