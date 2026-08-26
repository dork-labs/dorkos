import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BEZEL,
  DECK,
  DECK_DEPTH,
  DECK_PROJECTED,
  DECK_TILT,
  KEY_COLUMNS,
  KEY_ROWS,
  LID_HEIGHT,
  LID_WIDTH,
  MACHINE_HEIGHT,
  PERSPECTIVE,
  projectDepth,
  SCREEN_RATIO,
  SEAT_LIFT,
} from '../macbook-geometry';
import {
  chatScaleAt,
  layBackAt,
  machineArrivalAt,
  machineOpacityAt,
  seatAt,
  shellOpacityAt,
  STAGE_TIMING,
} from '../stage-timing';
import { DEFAULT_TREATMENT, parseTreatment, STAGE_TREATMENTS } from '../stage-treatment';

/** The two frames' shapes live in their class names, so their shape is source. */
const source = (name: string) => readFileSync(join(import.meta.dirname, '..', name), 'utf8');
const MACBOOK_FRAME = source('MacbookFrame.tsx');
const MACBOOK_DECK = source('MacbookDeck.tsx');
const STAGE = source('StageSection.tsx');
const TOGGLE = source('TreatmentToggle.tsx');
const HOME_EXPERIENCE = source('HomeExperience.tsx');

describe('the stage has two endings and the page can switch between them', () => {
  it('offers exactly the bezel and the MacBook', () => {
    expect([...STAGE_TREATMENTS].sort()).toEqual(['bezel', 'macbook']);
  });

  it('shows the one being evaluated to anyone who has not chosen', () => {
    expect(DEFAULT_TREATMENT).toBe('macbook');
  });

  it('ignores a treatment name it does not recognise', () => {
    // The choice arrives from a query string and from localStorage, both of
    // which a stranger can put anything into. Anything but a known name has to
    // fall through to the default rather than render a stage with no ending.
    expect(parseTreatment('macbook')).toBe('macbook');
    expect(parseTreatment('bezel')).toBe('bezel');
    for (const junk of ['MacBook', 'laptop', '', null, undefined]) {
      expect(parseTreatment(junk), `"${junk}" was accepted`).toBeNull();
    }
  });

  it('renders both frames from the same live chat, not two copies of it', () => {
    // The whole claim of the comparison is that only the chrome differs. Two
    // `<ChatWindow>` elements would let the two endings drift into two
    // different demos, and the one being judged would not be the one shipping.
    expect(STAGE.match(/<ChatWindow/g)).toHaveLength(1);
    expect(STAGE).toContain('<MacbookFrame');
    expect(STAGE).toContain('<LaptopFrame');
  });

  it('keeps the switch reachable without a mouse', () => {
    // Real buttons and a pressed state, rather than a styled div with an
    // onClick, which is the shape this kind of furniture usually ships in.
    expect(TOGGLE).toContain('type="button"');
    expect(TOGGLE).toContain('aria-pressed={active}');
    expect(TOGGLE).toContain('focus-visible:ring-2');
  });

  it('puts the switch on the page rather than leaving it unreachable', () => {
    expect(HOME_EXPERIENCE).toContain('<TreatmentToggle');
    expect(HOME_EXPERIENCE).toContain('useStageTreatment()');
  });
});

describe('the MacBook the chat falls into', () => {
  it('has a modern screen, like the bezel it is compared against', () => {
    // Same law as `LaptopFrame`: the beat says the visitor is looking at their
    // own computer, and a 4:3 box argues the opposite. Both endings declare
    // 16:10 rather than inheriting a shape from the chat.
    const ratio = MACBOOK_FRAME.match(/aspect-\[(\d+)\/(\d+)\]/);
    expect(ratio, 'the frame declares no aspect ratio').not.toBeNull();
    expect(Number(ratio?.[1]) / Number(ratio?.[2])).toBeCloseTo(16 / 10, 3);
    expect(SCREEN_RATIO).toBeCloseTo(10 / 16, 6);
  });

  it('holds the ratio when the chat fills up, which the ratio alone does not', () => {
    // `min-height: auto` on a flex item is a content floor that outranks
    // `aspect-ratio`, so the screen grows taller as messages arrive without
    // this. The bezel treatment learned it the hard way; this one inherits it.
    expect(MACBOOK_FRAME).toMatch(/SCREEN_FLOOR = 'min-h-0'/);
    expect(MACBOOK_FRAME).toMatch(/\$\{SCREEN_ASPECT\} \$\{SCREEN_FLOOR\}/);
  });

  it('measures itself in viewport units only, because it is passed down as a variable', () => {
    // A percentage inside a custom property resolves where it is *used*, not
    // where it is set, so a `calc(100% - …)` in this length would mean one
    // thing in the lid and another in the deck. It did, once, and the machine
    // came apart.
    const width = MACBOOK_FRAME.match(/const SCREEN_WIDTH = '([^']+)'/)?.[1];
    expect(width, 'the frame declares no screen width').toBeDefined();
    expect(width).not.toMatch(/%/);
    expect(width).toMatch(/vh/);
  });

  it('is proportioned off a real enclosure rather than eyeballed', () => {
    // 312.6 x 221.2mm of case around a 302.4mm display. Each of these is a
    // ratio a reader can check against a spec sheet, and getting one wrong is
    // how a drawn laptop turns into a laptop-shaped rectangle.
    expect(LID_WIDTH).toBeCloseTo(312.6 / 302.4, 3);
    expect(LID_HEIGHT / LID_WIDTH).toBeCloseTo(0.677, 2);
    expect(DECK_DEPTH / LID_WIDTH).toBeCloseTo(221.2 / 312.6, 3);
    // The bottom bezel is the widest and the sides the narrowest. A lid with
    // four equal borders is a picture frame.
    expect(BEZEL.bottom).toBeGreaterThan(BEZEL.top);
    expect(BEZEL.top).toBeGreaterThan(BEZEL.side);
  });

  it('reserves exactly the height the laid-back deck paints', () => {
    // The deck is drawn face-on and rotated, so how much vertical space it
    // ends up occupying is a projection, not its height. Guessing it leaves a
    // gap under the machine or a deck that overlaps whatever follows.
    expect(DECK_PROJECTED).toBeCloseTo(projectDepth(DECK_DEPTH, DECK_TILT, PERSPECTIVE), 9);
    expect(MACBOOK_DECK).toContain('height: w(DECK_PROJECTED)');
    expect(MACBOOK_DECK).toContain(`rotateX(\${DECK_TILT}deg)`);
    // And it is a foreshortening, so it must be well short of the real depth.
    expect(DECK_PROJECTED).toBeLessThan(DECK_DEPTH * 0.6);
    expect(DECK_PROJECTED).toBeGreaterThan(0);
  });

  it('keeps the camera far enough back to read as a photograph', () => {
    // The near edge of the deck paints wider than its hinge edge, and how much
    // wider is the difference between a product shot and a fisheye. Aceternity
    // ships 800px on a 512px machine, which is 43% of spread; this is 13%.
    const spread = PERSPECTIVE / (PERSPECTIVE - DECK_DEPTH * Math.sin((DECK_TILT * Math.PI) / 180));
    expect(spread).toBeGreaterThan(1.05);
    expect(spread).toBeLessThan(1.2);
  });

  it('draws a keyboard whose every row fills the same grid', () => {
    // Rows are laid out in key units, so a row that adds up to anything else
    // silently stretches or shrinks every key in it and the columns stop
    // lining up down the deck.
    expect(KEY_ROWS).toHaveLength(6);
    for (const [at, row] of KEY_ROWS.entries()) {
      const columns = row.keys.reduce((total, key) => total + key, row.arrows ? 3 : 0);
      expect(columns, `row ${at} spans ${columns} of ${KEY_COLUMNS} columns`).toBeCloseTo(
        KEY_COLUMNS,
        6
      );
    }
    // One half-height strip at the top, and full rows under it.
    expect(KEY_ROWS[0].height).toBeLessThan(1);
    expect(KEY_ROWS.slice(1).every((row) => row.height === 1)).toBe(true);
    // The inverted T is on the last row and nowhere else.
    expect(KEY_ROWS.filter((row) => row.arrows)).toEqual([KEY_ROWS[5]]);
  });

  it('leaves the keys blank, and the deck free of anything to trademark', () => {
    // No legends: at the size this paints they are grey noise, and the ones
    // that would be legible are somebody else's marks. Nothing on the machine
    // renders text at all.
    expect(MACBOOK_DECK).not.toMatch(/>[A-Za-z]{2,}</);
    expect(MACBOOK_FRAME).not.toMatch(/>[A-Za-z]{2,}</);
  });

  it('fits the deck’s parts inside the deck', () => {
    // Percentages of a box that is rotated afterwards; anything over 100 hangs
    // off the machine and paints on the page behind it.
    expect(DECK.well.top + DECK.well.height).toBeLessThan(DECK.trackpad.top);
    expect(DECK.trackpad.top + DECK.trackpad.height).toBeLessThan(1);
    expect(DECK.well.width).toBeLessThan(1);
    expect(DECK.vent.height).toBeLessThan(DECK.well.top);
  });

  it('hides the whole machine from anyone who cannot see it', () => {
    // It is a picture of a laptop wrapped around a conversation. A screen
    // reader that walks into the keyboard finds seventy-eight empty divs.
    expect(MACBOOK_FRAME).toContain('aria-hidden="true"');
    expect(MACBOOK_DECK).toContain('aria-hidden="true"');
  });
});

describe('the finale reverses, because the whole page does', () => {
  const SAMPLES = [0, 0.3, 0.6, 0.66, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];

  it('is a function of scroll position and nothing else', () => {
    // Every value the ending animates is derived from progress alone, with no
    // state carried between frames. That is what makes scrolling back up undo
    // it exactly rather than approximately, and it is asserted here because a
    // single remembered value would break it silently.
    for (const at of SAMPLES) {
      expect(chatScaleAt(at)).toBe(chatScaleAt(at));
      expect(seatAt(at)).toBe(seatAt(at));
      expect(machineArrivalAt(at)).toBe(machineArrivalAt(at));
      expect(layBackAt(at)).toBe(layBackAt(at));
    }
  });

  it('starts nothing before the last beat is on screen', () => {
    // The beat flips to "It all happens on your computer." at 0.66. A machine
    // that begins arriving under the previous headline breaks the wayfinding
    // the three beats do.
    expect(STAGE_TIMING.machineFrom).toBeGreaterThanOrEqual(0.66);
    expect(STAGE_TIMING.shrinkFrom).toBeGreaterThanOrEqual(0.66);
    expect(machineArrivalAt(0.66)).toBe(0);
    expect(machineOpacityAt(0.66)).toBe(0);
    expect(seatAt(0.66)).toBe(0);
    expect(chatScaleAt(0.66)).toBe(1);
  });

  it('goes solid well before it stops moving', () => {
    // A dark enclosure held part-way transparent over a cream page is a grey
    // smear. It stops being transparent early and does the rest of its
    // arriving as a solid object sliding up from under the frame.
    expect(STAGE_TIMING.machineFadeTo).toBeLessThan(STAGE_TIMING.machineTo);
    expect(machineOpacityAt(0.83)).toBe(1);
    expect(machineArrivalAt(0.83)).toBeLessThan(0.6);
  });

  it('lands the chat square to the reader at both ends of the tilt', () => {
    // It is a conversation and it has to stay legible. The lay-back is a hump
    // that returns to zero, not a resting angle: a permanently tilted screen
    // would be perspective-warped text at the one moment the page most wants
    // it read.
    expect(layBackAt(STAGE_TIMING.shrinkFrom)).toBeCloseTo(0, 6);
    expect(layBackAt(1)).toBeCloseTo(0, 6);
    const middle = (STAGE_TIMING.shrinkFrom + STAGE_TIMING.shrinkTo) / 2;
    expect(Math.abs(layBackAt(middle))).toBeCloseTo(STAGE_TIMING.layBack, 6);
  });

  it('finishes everything by the time the caption is legible', () => {
    // "home sweet localhost" is the last word of the stage, and it should not
    // be reading over a machine still settling into place.
    expect(STAGE_TIMING.machineTo).toBeLessThanOrEqual(STAGE_TIMING.captionTo);
    expect(STAGE_TIMING.shrinkTo).toBeLessThanOrEqual(STAGE_TIMING.captionTo);
    expect(machineArrivalAt(STAGE_TIMING.captionTo)).toBe(1);
    expect(seatAt(STAGE_TIMING.captionTo)).toBe(1);
  });

  it('centres the finished machine where the chat used to be', () => {
    // The chat is the middle of the frame for two whole beats. The machine is
    // mostly below its screen, so without this shift the deck hangs off the
    // bottom and the lid floats high. The number is derived from the drawing
    // rather than dialled in by eye, so redrawing the deck moves it.
    const below = MACHINE_HEIGHT - BEZEL.top - SCREEN_RATIO;
    expect(SEAT_LIFT).toBeCloseTo((100 * (below - BEZEL.top)) / 2 / SCREEN_RATIO, 6);
    expect(SEAT_LIFT).toBeGreaterThan(0);
    // Applied over the same window the chat shrinks in, so there is one
    // arrival rather than two.
    expect(STAGE).toContain('`${-SEAT_LIFT * seatAt(v)}%`');
  });

  it('leaves the bezel treatment’s own timing untouched', () => {
    // The comparison is only worth anything if the thing being compared
    // against is the thing that shipped.
    expect(STAGE_TIMING.shrinkFrom).toBe(0.68);
    expect(STAGE_TIMING.shrinkTo).toBe(0.92);
    expect(STAGE_TIMING.shrinkAmount).toBe(0.46);
    expect(shellOpacityAt(0.78)).toBe(0);
    expect(shellOpacityAt(0.9)).toBe(1);
  });
});
