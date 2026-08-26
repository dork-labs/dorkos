/**
 * A modern MacBook Pro, in numbers.
 *
 * Every value here is a real measurement divided by the width of the display,
 * so one CSS length — the screen's width — drives the whole drawing and the
 * machine keeps a laptop's proportions at any size. The enclosure is
 * 312.6 x 221.2mm; the display is 302.4mm wide, and the stage pins it to 16:10,
 * so 302.4 x 189mm is the box every other number is measured against.
 *
 * Nothing here is eyeballed. A laptop drawn from invented ratios reads as a
 * laptop-shaped rectangle, and the whole point of the last beat is that the
 * visitor recognises the machine on their own desk.
 */

/** 16:10 — the shape the stage declares and every MacBook has shipped in. */
export const SCREEN_RATIO = 10 / 16;

/**
 * One CSS length drives the whole machine: `--mb-w`, the width of the screen,
 * set once on the assembly. Every part asks for its own measurement as a
 * multiple of it, so the drawing scales without a single media query and
 * without any part knowing how wide the stage decided to be.
 */
export function machineLength(ratio: number): string {
  return `calc(var(--mb-w) * ${ratio})`;
}

/**
 * The black borders around the display, as fractions of its width.
 *
 * They are not equal, and the difference is what makes the lid read as a
 * laptop rather than a picture frame: 5.1mm at the sides, 8.4mm above (the
 * camera lives there), 14.4mm below.
 */
export const BEZEL = {
  side: 5.1 / 302.4,
  top: 8.4 / 302.4,
  bottom: 14.4 / 302.4,
} as const;

/** The lid's own width: the display plus both side bezels. */
export const LID_WIDTH = 1 + 2 * BEZEL.side;

/** The lid's own height: the display plus the bezels above and below it. */
export const LID_HEIGHT = SCREEN_RATIO + BEZEL.top + BEZEL.bottom;

/** Corner radius of the enclosure, 10mm on a 312.6mm case, as a fraction of the lid. */
export const LID_RADIUS = 10 / 312.6;

/**
 * Corner radius of the deck's hinge edge, as a fraction of the lid.
 *
 * The real machine's deck is not square where it meets the hinge — the top
 * corners carry a small ease, visibly tighter than the 10mm front corners.
 * Operator-directed (2026-08-26): rounded, with a smaller radius.
 */
export const DECK_TOP_RADIUS = 4 / 312.6;

/** The dark band where lid meets deck. */
export const HINGE = 3 / 302.4;

/** How deep the deck is before it is laid back, as a fraction of the lid's width. */
export const DECK_DEPTH = (221.2 / 312.6) * LID_WIDTH;

/** Degrees the deck is laid back from the picture plane. */
export const DECK_TILT = 68;

/**
 * Camera distance, as a multiple of the screen's width.
 *
 * Short perspectives are what make a CSS laptop look like a wide-angle photo:
 * at 2x the near edge of the deck paints 43% wider than the hinge. Six is a
 * product shot — about 13% of spread, which reads as depth rather than as a
 * lens.
 */
export const PERSPECTIVE = 6;

/**
 * How tall a laid-back plane of `depth` actually paints, given the tilt and
 * the camera distance. Derived rather than measured, so changing the tilt
 * cannot silently leave the reserved space wrong.
 */
export function projectDepth(depth: number, tiltDegrees: number, perspective: number): number {
  const tilt = (tiltDegrees * Math.PI) / 180;
  const towardViewer = depth * Math.sin(tilt);
  return (depth * Math.cos(tilt) * perspective) / (perspective - towardViewer);
}

/** The painted height of the deck once it is laid back. */
export const DECK_PROJECTED = projectDepth(DECK_DEPTH, DECK_TILT, PERSPECTIVE);

/** Everything the machine paints below the screen: chin, hinge, deck. */
export const MACHINE_BELOW = BEZEL.bottom + HINGE + DECK_PROJECTED;

/** The machine's whole painted height, as a multiple of the screen's width. */
export const MACHINE_HEIGHT = BEZEL.top + SCREEN_RATIO + MACHINE_BELOW;

/**
 * How far the assembly rides up as the chat seats, as a percentage of the
 * screen's own height.
 *
 * The chat is centred in the stage for the first two beats and has to stay
 * there. The finished machine is mostly below the screen, so leaving it where
 * the chat was would hang the deck off the bottom of the frame. This is the
 * shift that puts the machine's centre where the chat's centre used to be.
 */
export const SEAT_LIFT = (100 * (MACHINE_BELOW - BEZEL.top)) / 2 / SCREEN_RATIO;

/** One row of the keyboard: how tall it is, and how wide each of its keys is. */
export interface KeyRow {
  /** Height in key units. The function row is a half-height strip. */
  height: number;
  /** Each key's width in key units. */
  keys: readonly number[];
  /** Whether the row ends in the inverted-T arrow cluster. */
  arrows?: boolean;
}

/** Key units across the keyboard. Every row adds up to this or the grid is wrong. */
export const KEY_COLUMNS = 14.5;

/** The arrow cluster's width in key units: left, the stacked pair, right. */
export const ARROW_COLUMNS = 3;

/**
 * The keyboard, row by row, in key units.
 *
 * No glyphs. At the size this paints — a key is about 20px across at 1440, and
 * 12 on a phone — legends are grey noise, and the ones that would be legible
 * are a trademark we have no business drawing. The shape of the rows is what
 * makes a keyboard recognisable anyway: a half-height function strip, a
 * stepped left edge from tab to caps to shift, and an inverted T at the end.
 */
export const KEY_ROWS: readonly KeyRow[] = [
  // esc, twelve function keys, the power key
  { height: 0.55, keys: [1.4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.1] },
  // the number row, ending in delete
  { height: 1, keys: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5] },
  // tab, then QWERTY
  { height: 1, keys: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  // caps lock, the home row, return
  { height: 1, keys: [1.8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.7] },
  // both shifts
  { height: 1, keys: [2.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.2] },
  // the modifier row, the space bar, and the arrows
  { height: 1, keys: [1, 1, 1, 1.25, 5, 1.25, 1], arrows: true },
];

/** Total key-unit height of the keyboard, gaps excluded. */
export const KEY_ROW_UNITS = KEY_ROWS.reduce((total, row) => total + row.height, 0);

/**
 * Where the deck's parts sit, as fractions of the deck's own box before it is
 * laid back. Measured off the same enclosure: a 250mm keyboard well and a
 * 130 x 81mm trackpad on a 312.6 x 221.2mm deck.
 */
export const DECK = {
  /** The black keyboard well: 250mm of keys on a 312.6mm case. */
  well: { width: 250 / 312.6, top: 0.075, height: 0.477 },
  /** The trackpad, centred under the keyboard. */
  trackpad: { width: 130 / 312.6, top: 0.57, height: 81 / 221.2 },
  /** The speaker grilles either side of the well. */
  speaker: { inset: 0.022 },
  /** The recessed strip along the back edge, where the deck meets the hinge. */
  vent: { height: 0.055, inset: 0.09 },
  /** The finger notch cut into the front edge. */
  notch: { width: 0.06, height: 0.016 },
} as const;

/** The gap between key tops: a real 3mm pitch on a 302.4mm display width. */
export const KEY_GAP = 3 / 302.4;

/** A perforation and its pitch in the speaker grilles, in the same units. */
export const SPEAKER_PITCH = 1.6 / 302.4;
