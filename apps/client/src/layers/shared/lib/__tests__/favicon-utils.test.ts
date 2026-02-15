/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fnv1aHash, hashToHslColor, hashToEmoji, setFavicon } from '../favicon-utils';

describe('fnv1aHash', () => {
  it('returns consistent hash for same input', () => {
    expect(fnv1aHash('/Users/test/project')).toBe(fnv1aHash('/Users/test/project'));
  });

  it('returns different hashes for different inputs', () => {
    expect(fnv1aHash('/project-a')).not.toBe(fnv1aHash('/project-b'));
  });

  it('returns a uint32', () => {
    const hash = fnv1aHash('/any/path');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('handles empty string', () => {
    const hash = fnv1aHash('');
    expect(hash).toBe(0x811c9dc5);
  });
});

describe('hashToHslColor', () => {
  it('returns valid HSL color string', () => {
    expect(hashToHslColor('/test')).toMatch(/^hsl\(\d+, 70%, 55%\)$/);
  });

  it('returns same color for same cwd', () => {
    expect(hashToHslColor('/a')).toBe(hashToHslColor('/a'));
  });

  it('produces different hues for different paths', () => {
    expect(hashToHslColor('/project-1')).not.toBe(hashToHslColor('/project-2'));
  });
});

describe('hashToEmoji', () => {
  it('returns a single emoji character from EMOJI_SET', () => {
    const emoji = hashToEmoji('/test');
    expect(emoji.length).toBeGreaterThanOrEqual(1);
    expect(emoji.length).toBeLessThanOrEqual(2);
  });

  it('returns same emoji for same cwd', () => {
    expect(hashToEmoji('/a')).toBe(hashToEmoji('/a'));
  });

  it('returns different emojis for different cwds', () => {
    const emojis = new Set(
      ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h'].map(hashToEmoji),
    );
    expect(emojis.size).toBeGreaterThan(1);
  });
});

describe('setFavicon', () => {
  beforeEach(() => {
    document.querySelectorAll("link[rel*='icon']").forEach((el) => el.remove());
  });

  it('creates a link element if none exists', () => {
    setFavicon('data:image/png;base64,test');
    const link = document.querySelector<HTMLLinkElement>("link[rel*='icon']");
    expect(link).not.toBeNull();
    expect(link!.href).toBe('data:image/png;base64,test');
  });

  it('reuses existing link element', () => {
    const existing = document.createElement('link');
    existing.rel = 'icon';
    document.head.appendChild(existing);

    setFavicon('data:image/png;base64,updated');
    const links = document.querySelectorAll("link[rel*='icon']");
    expect(links.length).toBe(1);
    expect((links[0] as HTMLLinkElement).href).toBe('data:image/png;base64,updated');
  });
});
