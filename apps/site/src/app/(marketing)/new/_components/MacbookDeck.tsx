import {
  ARROW_COLUMNS,
  DECK,
  DECK_DEPTH,
  DECK_PROJECTED,
  DECK_TILT,
  KEY_GAP,
  KEY_ROWS,
  LID_RADIUS,
  LID_WIDTH,
  machineLength as w,
  PERSPECTIVE,
  SPEAKER_PITCH,
  type KeyRow,
} from './macbook-geometry';
import { MACBOOK } from './theme';

/** The gap between key tops, as a CSS length. */
const GAP = w(KEY_GAP);

/** The perforations, as a dot grid whose spacing tracks the machine's size. */
const SPEAKER_DOTS = {
  backgroundImage: `radial-gradient(circle, ${MACBOOK.speaker} 34%, transparent 36%)`,
  backgroundSize: `${w(SPEAKER_PITCH)} ${w(SPEAKER_PITCH)}`,
} as const;

/** One key: a rounded slab with the light catching its front edge. */
function Key({ units, height }: { units: number; height?: string }) {
  return (
    <div
      style={{
        flex: `${units} 1 0`,
        height,
        background: MACBOOK.key,
        borderRadius: w(0.004),
        boxShadow: `inset 0 ${w(-0.0015)} 0 ${MACBOOK.keyEdge}`,
      }}
    />
  );
}

/**
 * The inverted T. Left and right are full height; up and down share one column
 * and take half each, which is the detail that makes an arrow cluster read as
 * an arrow cluster rather than as three more keys.
 */
function ArrowCluster() {
  return (
    <div className="flex" style={{ flex: `${ARROW_COLUMNS} 1 0`, gap: GAP }}>
      <Key units={1} />
      <div className="flex flex-col justify-end" style={{ flex: '1 1 0', gap: GAP }}>
        <Key units={1} height="50%" />
        <Key units={1} height="50%" />
      </div>
      <Key units={1} />
    </div>
  );
}

/** One row of keys, sized in key units so the grid stays square at any width. */
function Row({ row }: { row: KeyRow }) {
  return (
    <div className="flex" style={{ flex: `${row.height} 1 0`, gap: GAP }}>
      {row.keys.map((units, at) => (
        <Key key={at} units={units} />
      ))}
      {row.arrows ? <ArrowCluster /> : null}
    </div>
  );
}

/** The black recess and the six rows inside it. */
function Keyboard() {
  return (
    <div
      className="absolute flex flex-col"
      style={{
        left: `${(100 * (1 - DECK.well.width)) / 2}%`,
        width: `${100 * DECK.well.width}%`,
        top: `${100 * DECK.well.top}%`,
        height: `${100 * DECK.well.height}%`,
        gap: GAP,
        padding: GAP,
        background: MACBOOK.well,
        borderRadius: w(0.006),
      }}
    >
      {KEY_ROWS.map((row, at) => (
        <Row key={at} row={row} />
      ))}
    </div>
  );
}

/** One grille, filling whatever space is left between the well and the edge. */
function Speaker({ side }: { side: 'left' | 'right' }) {
  const outer = DECK.speaker.inset;
  const inner = (1 - DECK.well.width) / 2 + DECK.speaker.inset;
  return (
    <div
      className="absolute"
      style={{
        [side]: `${100 * outer}%`,
        width: `${100 * (inner - outer)}%`,
        top: `${100 * DECK.well.top}%`,
        height: `${100 * DECK.well.height}%`,
        ...SPEAKER_DOTS,
      }}
    />
  );
}

/**
 * The base of the machine, laid back away from the reader.
 *
 * It is drawn face-on and then rotated, rather than drawn pre-squashed, which
 * is what gives the deck a near edge wider than its hinge edge and a keyboard
 * whose rows crowd together as they recede. The outer box reserves the height
 * the rotation actually paints, computed from the tilt rather than guessed, so
 * nothing below it has to know what a rotated plane does to a layout.
 */
export function MacbookDeck() {
  return (
    <div
      aria-hidden="true"
      style={{ width: w(LID_WIDTH), height: w(DECK_PROJECTED), perspective: w(PERSPECTIVE) }}
      className="relative"
    >
      <div
        className="absolute inset-x-0 top-0"
        style={{
          height: w(DECK_DEPTH),
          transform: `rotateX(${DECK_TILT}deg)`,
          transformOrigin: 'top center',
          background: `linear-gradient(${MACBOOK.deckBack}, ${MACBOOK.deckFront})`,
          borderRadius: `0 0 ${w(LID_RADIUS * LID_WIDTH)} ${w(LID_RADIUS * LID_WIDTH)}`,
        }}
      >
        {/* The recess along the back edge. Without it the keyboard well runs
            straight into the hinge and the deck reads as one flat panel. */}
        <div
          className="absolute top-0"
          style={{
            left: `${100 * DECK.vent.inset}%`,
            right: `${100 * DECK.vent.inset}%`,
            height: `${100 * DECK.vent.height}%`,
            background: MACBOOK.well,
            borderRadius: `0 0 ${w(0.004)} ${w(0.004)}`,
          }}
        />
        <Speaker side="left" />
        <Keyboard />
        <Speaker side="right" />
        <div
          className="absolute"
          style={{
            left: `${(100 * (1 - DECK.trackpad.width)) / 2}%`,
            width: `${100 * DECK.trackpad.width}%`,
            top: `${100 * DECK.trackpad.top}%`,
            height: `${100 * DECK.trackpad.height}%`,
            borderRadius: w(0.01),
            background: MACBOOK.trackpad,
            boxShadow: `0 0 0 ${w(0.001)} ${MACBOOK.trackpadEdge}`,
          }}
        />
        <div
          className="absolute bottom-0"
          style={{
            left: `${(100 * (1 - DECK.notch.width)) / 2}%`,
            width: `${100 * DECK.notch.width}%`,
            height: `${100 * DECK.notch.height}%`,
            background: MACBOOK.hinge,
            borderRadius: `${w(0.01)} ${w(0.01)} 0 0`,
          }}
        />
      </div>
    </div>
  );
}
