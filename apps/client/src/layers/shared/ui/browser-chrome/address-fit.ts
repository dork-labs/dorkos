/**
 * How the at-rest address fits its field without ever hiding which site it is on
 * (DOR-4655). The end of the host that {@link keptHostTail} names is never
 * clipped at any width; to make room, in this order: the labels before it become
 * "…" (whole labels, never part of one), the path goes, "Not secure" shrinks to
 * its icon, the padding tightens, the host's font shrinks to a floor, and last
 * the host wraps onto more lines inside the field.
 *
 * @module shared/ui/browser-chrome/address-fit
 */

/**
 * The one smaller size the at-rest host may take (the designer, DOR-4655): one
 * fixed step from its normal size, never a smooth scale. Below that it wraps.
 * The text box the person types in stays at its own size.
 */
export const ADDRESS_HOST_MIN_FONT_PX = 12;

/** Widths measured in the drawn field, all in CSS pixels, text at its normal size. */
export interface AddressMeasures {
  /** The width the address has at the normal padding. */
  available: number;
  /** What tightening the padding adds to it. */
  paddingGain: number;
  /** The gap between "Not secure" and the host. */
  gap: number;
  /** "Not secure" in words; 0 when there is no such mark. */
  badgeFull: number;
  /** "Not secure" as its icon only; 0 when there is no such mark. */
  badgeIcon: number;
  /** The whole host. */
  host: number;
  /** The part of the host that is never clipped. */
  kept: number;
  /** The "…" that stands for the labels before it; 0 when there are none. */
  ellipsis: number;
  /** The host's normal font size. */
  baseFontPx: number;
}

/** How to draw the at-rest address. */
export interface AddressFit {
  /** The whole host, or "…" for the labels before the kept part. */
  host: 'full' | 'elided';
  /** Whether the path shows; it may still shorten itself. */
  path: boolean;
  /** Whether "Not secure" shows as its icon only. */
  badgeIcon: boolean;
  /** Whether the padding is tightened. */
  tightPadding: boolean;
  /** The host's font size in pixels, or null for its normal size. */
  fontPx: number | null;
  /** Whether the host wraps onto more lines. */
  wrap: boolean;
}

/** The address as it is drawn when there is room: nothing given up. */
export const ROOMY_ADDRESS_FIT: AddressFit = {
  host: 'full',
  path: true,
  badgeIcon: false,
  tightPadding: false,
  fontPx: null,
  wrap: false,
};

/**
 * The address before anything is measured (first paint, a hidden panel, no resize
 * yet): the whole host, free to wrap, so no guess can ever clip or elide it.
 */
export const UNMEASURED_ADDRESS_FIT: AddressFit = { ...ROOMY_ADDRESS_FIT, wrap: true };

/**
 * Choose how the at-rest address fits, giving up the least it can and never
 * clipping the kept part.
 *
 * @param m - The field's measured widths.
 */
export function chooseAddressFit(m: AddressMeasures): AddressFit {
  const lead = (icon: boolean) => {
    const badge = icon ? m.badgeIcon : m.badgeFull;
    return badge > 0 ? badge + m.gap : 0;
  };
  // The path shortens itself, so the whole host fitting is enough to keep it.
  if (lead(false) + m.host <= m.available) return ROOMY_ADDRESS_FIT;
  const elided = m.ellipsis + m.kept;
  const given = { ...ROOMY_ADDRESS_FIT, host: 'elided' as const, path: false };
  if (lead(false) + elided <= m.available) return given;
  if (lead(true) + elided <= m.available) return { ...given, badgeIcon: true };
  const room = m.available + m.paddingGain - lead(true);
  const tight = { ...given, badgeIcon: true, tightPadding: true };
  if (elided <= room) return tight;
  const small = { ...tight, fontPx: ADDRESS_HOST_MIN_FONT_PX };
  if ((elided * ADDRESS_HOST_MIN_FONT_PX) / m.baseFontPx <= room) return small;
  // Wrapped, width is no longer what is short, so the lines get their padding back.
  return { ...small, tightPadding: false, wrap: true };
}
