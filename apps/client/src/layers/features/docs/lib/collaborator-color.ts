/**
 * A collaborator's colour in the one spelling live cursors accept (DOR-2984).
 *
 * The app's identity colours are often `hsl(…)`; y-prosemirror only accepts
 * `#rrggbb` for cursor colours (it appends an alpha for the selection), and
 * falls back to its own default for anything else.
 *
 * @module features/docs/lib/collaborator-color
 */

/** The colour used when an identity colour cannot be read. */
export const FALLBACK_COLLABORATOR_COLOR = '#6b7280';

function hex(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
}

/**
 * `#rrggbb` for a CSS colour written as hex or `hsl(h, s%, l%)`.
 *
 * @param color - The identity colour.
 * @returns The same colour as `#rrggbb`, or {@link FALLBACK_COLLABORATOR_COLOR}.
 */
export function toHexColor(color: string): string {
  const value = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(value);
  if (!hsl) return FALLBACK_COLLABORATOR_COLOR;
  const h = (((Number(hsl[1]) % 360) + 360) % 360) / 360;
  const s = Number(hsl[2]) / 100;
  const l = Number(hsl[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const k = (t + 1) % 1;
    if (k < 1 / 6) return p + (q - p) * 6 * k;
    if (k < 1 / 2) return q;
    if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
    return p;
  };
  return `#${hex(channel(h + 1 / 3) * 255)}${hex(channel(h) * 255)}${hex(channel(h - 1 / 3) * 255)}`;
}
