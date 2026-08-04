import { describe, it, expect } from 'vitest';
import { readableForeground } from '../readable-foreground';

/** What {@link readableForeground} returns for a light background. */
const DARK_TEXT = 'oklch(0.2 0 0)';
/** What {@link readableForeground} returns for a dark background. */
const LIGHT_TEXT = 'oklch(0.97 0 0)';

describe('readableForeground', () => {
  it('picks dark text for a light identity colour', () => {
    expect(readableForeground('#fef3c7')).toBe(DARK_TEXT);
  });

  it('picks light text for a dark identity colour', () => {
    expect(readableForeground('#1e1b4b')).toBe(LIGHT_TEXT);
  });

  it('reads the shorthand 3-digit hex the same as its 6-digit expansion', () => {
    expect(readableForeground('#fff')).toBe(readableForeground('#ffffff'));
    expect(readableForeground('#000')).toBe(readableForeground('#000000'));
  });

  it('reads hsl(), the format every hashed identity colour arrives in', () => {
    // hashToHslColor always emits `hsl(H, 70%, 55%)` — mid-lightness and
    // fairly saturated, which lands below the threshold for most hues.
    expect(readableForeground('hsl(210, 70%, 55%)')).toBe(LIGHT_TEXT);
  });

  it('reads rgb()', () => {
    expect(readableForeground('rgb(250, 250, 240)')).toBe(DARK_TEXT);
    expect(readableForeground('rgb(10, 10, 20)')).toBe(LIGHT_TEXT);
  });

  it('falls back to light text for a colour it cannot parse, rather than throwing', () => {
    expect(() => readableForeground('oklch(0.5 0.1 250)')).not.toThrow();
    expect(readableForeground('not-a-colour')).toBe(LIGHT_TEXT);
  });
});
