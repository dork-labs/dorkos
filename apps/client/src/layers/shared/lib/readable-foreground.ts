/**
 * Picking a legible text colour to sit directly on an arbitrary, per-identity
 * colour — the `fill` avatar variant's problem, where the disc's background
 * is not a design-system token but whatever colour that one identity hashed
 * to or was given.
 *
 * @module shared/lib/readable-foreground
 */

/** An RGB colour with 0-255 channels, the common ground every format below parses into. */
interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Near-white and near-black rather than pure `white`/`black` — a little
 * softer against a saturated fill, the way most contrast-driven UI text is
 * chosen. These are deliberately literal colours, not theme tokens: the
 * background they sit on is a per-identity colour the theme knows nothing
 * about, exactly the case {@link IdentityAvatar}'s `color-mix` tint is
 * already the one sanctioned exception for.
 */
const FOREGROUND_ON_DARK = 'oklch(0.97 0 0)';
const FOREGROUND_ON_LIGHT = 'oklch(0.2 0 0)';

/**
 * Relative-luminance threshold above which a background counts as "light"
 * and gets dark text. 0.4 sits below the naive midpoint (0.5) because a
 * white-on-colour pairing keeps working (WCAG-adjacent contrast) slightly
 * later than a black-on-colour one does as a colour darkens — so ties lean
 * toward the light foreground.
 */
const LUMINANCE_THRESHOLD = 0.4;

/** Matches `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`. */
const HEX_PATTERN = /^#([0-9a-f]{3,8})$/i;
const RGB_PATTERN = /^rgba?\(([^)]+)\)$/i;
const HSL_PATTERN = /^hsla?\(([^)]+)\)$/i;

/** Splits a `rgb(...)`/`hsl(...)` body on the comma or space+slash syntax CSS allows for either. */
function splitComponents(body: string): string[] {
  return body.split(/[\s,/]+/).filter(Boolean);
}

function parseHex(hex: string): RgbColor | null {
  const digits =
    hex.length === 3 || hex.length === 4 ? [...hex].map((ch) => ch + ch).join('') : hex;
  if (digits.length !== 6 && digits.length !== 8) return null;

  const r = parseInt(digits.slice(0, 2), 16);
  const g = parseInt(digits.slice(2, 4), 16);
  const b = parseInt(digits.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

function parseRgb(body: string): RgbColor | null {
  const [r, g, b] = splitComponents(body).map(Number.parseFloat);
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r, g, b };
}

/** Converts HSL (0-360, 0-1, 0-1) to RGB, following the standard piecewise-linear construction. */
function hslToRgb(h: number, s: number, l: number): RgbColor {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  const m = l - c / 2;
  const bySextant: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r1, g1, b1] = bySextant[Math.min(5, Math.floor(hPrime))]!;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function parseHsl(body: string): RgbColor | null {
  const [h, s, l] = splitComponents(body);
  if (h === undefined || s === undefined || l === undefined) return null;

  const hue = Number.parseFloat(h);
  const saturation = Number.parseFloat(s) / 100;
  const lightness = Number.parseFloat(l) / 100;
  if ([hue, saturation, lightness].some(Number.isNaN)) return null;
  return hslToRgb(hue, saturation, lightness);
}

/** Parses hex, `rgb()`/`rgba()`, and `hsl()`/`hsla()` — every format an identity colour in this cockpit is stored or hashed into (see `hashToHslColor`). Anything else returns `null`. */
function parseCssColor(input: string): RgbColor | null {
  const value = input.trim();
  const hex = HEX_PATTERN.exec(value);
  if (hex) return parseHex(hex[1]!);
  const rgb = RGB_PATTERN.exec(value);
  if (rgb) return parseRgb(rgb[1]!);
  const hsl = HSL_PATTERN.exec(value);
  if (hsl) return parseHsl(hsl[1]!);
  return null;
}

/** W3C relative luminance of an sRGB colour, gamma-corrected per channel. */
function relativeLuminance({ r, g, b }: RgbColor): number {
  const [rl, gl, bl] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/**
 * Choose a legible text colour to draw directly on `color` — the fallback
 * letter over a `fill`-variant {@link IdentityAvatar}, or anywhere else a
 * per-identity colour becomes a solid background rather than a tint.
 *
 * Colours this cannot parse (an unrecognised CSS colour function, a named
 * colour) are treated as a dark background, since most saturated brand and
 * hashed identity colours in this app fall on that side of the threshold
 * anyway — a light foreground is the safer default.
 *
 * @param color - CSS colour string the text will sit on. Reads hex,
 *   `rgb()`/`rgba()`, and `hsl()`/`hsla()`.
 * @returns A near-white or near-black `oklch()` string, picked by relative
 *   luminance rather than assumed.
 */
export function readableForeground(color: string): string {
  const rgb = parseCssColor(color);
  const luminance = rgb ? relativeLuminance(rgb) : 0;
  return luminance > LUMINANCE_THRESHOLD ? FOREGROUND_ON_LIGHT : FOREGROUND_ON_DARK;
}

/**
 * Whether {@link readableForeground} can compute a REAL answer for `color`,
 * as opposed to falling through to its dark-background default.
 *
 * `IdentityAvatar`'s `fill` variant reads this to decide whether filling is
 * safe at all (DOR-998): `fill` sets both the disc's background and the
 * fallback letter's colour from the same string, so a colour this cannot
 * parse — `currentColor`, a theme token like `var(--color-orange-500)` or
 * `hsl(var(--muted-foreground))` — makes `readableForeground` guess, and the
 * guess can land on the same value the background itself resolves to,
 * painting an invisible letter. `tint` has no such problem: its
 * `color-mix()` is real CSS the browser resolves a `var()` token through
 * correctly, so declining to `tint` costs nothing but the solid fill.
 *
 * @param color - The same string {@link readableForeground} would receive.
 */
export function canComputeReadableForeground(color: string): boolean {
  return parseCssColor(color) !== null;
}
