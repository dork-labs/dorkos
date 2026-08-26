'use client';

import type { CSSProperties, ReactNode } from 'react';
import { motion, type MotionValue } from 'motion/react';
import { MacbookDeck } from './MacbookDeck';
import {
  BEZEL,
  HINGE,
  LID_HEIGHT,
  LID_RADIUS,
  LID_WIDTH,
  machineLength as w,
  PERSPECTIVE,
} from './macbook-geometry';
import { MACBOOK } from './theme';

/**
 * The screen's shape, and it is not negotiable: 16:10, the proportion every
 * MacBook has shipped in for a decade. Same law as `LaptopFrame`, for the same
 * reason — the beat says the visitor is looking at their own computer, and a
 * 4:3 box argues the opposite before a single pixel of chrome is drawn.
 */
const SCREEN_ASPECT = 'aspect-[16/10]';

/**
 * `min-h-0`, and it is the whole reason the ratio above holds: a flex item's
 * default `min-height: auto` is a content floor that outranks `aspect-ratio`,
 * so without this the screen grows taller as messages arrive.
 */
const SCREEN_FLOOR = 'min-h-0';

/**
 * How wide the screen is allowed to get — the same three limits the bezel
 * treatment uses, deliberately, so the two endings are compared at the same
 * size rather than at whichever size each one happened to pick.
 *
 * The machine does not need a limit of its own. It paints
 * {@link MACHINE_HEIGHT} times its screen's width from the top of the lid to
 * the front of the deck, which is more than the screen alone — but it is only
 * ever drawn while the assembly is shrinking, and by the time the machine is
 * solid it stands 0.55 of a screen-width above and below the point the chat
 * used to occupy, which is less than the screen box already reserves. The
 * height that has to fit the pinned stage is still the screen's.
 *
 * Every term is a viewport unit, and that is load-bearing rather than a style
 * choice. This length is handed down the tree as a custom property and every
 * part of the machine measures itself as a multiple of it, but a percentage
 * inside a custom property is resolved where it is *used*, not where it is
 * set. A `calc(100% - 1.5rem)` in here would mean something different in the
 * deck than it does in the lid, and the machine came apart at the seams the
 * first time this was written that way.
 */
const SCREEN_WIDTH = 'min(42rem, calc(100vw - 4rem), calc(52vh * 1.6))';

/** A value the stage animates, or a fixed one when the visitor asked for stillness. */
type Animatable<T> = MotionValue<T> | T;

interface MacbookFrameProps {
  /** Scale of the whole assembly as the chat shrinks into the machine. */
  scale: Animatable<number>;
  /** How far the assembly has ridden up to centre the finished machine, as a CSS length. */
  lift: Animatable<string>;
  /** How far the machine still is below its seat, as a CSS length. */
  rise: Animatable<string>;
  /** How solid the machine is: 0 before it arrives, 1 once it has. */
  presence: Animatable<number>;
  /** How far the chat still has to fall into the screen opening, as a CSS length. */
  drop: Animatable<string>;
  /** Degrees the chat is laid back onto the plane of the lid. */
  layBack: Animatable<number>;
  /** The screen content — the live chat, unchanged from every other beat. */
  children: ReactNode;
}

/** The lid: dark enclosure, thin bezels, an empty display waiting behind the chat. */
function Lid() {
  return (
    <div
      className="absolute inset-0"
      style={{
        background: MACBOOK.lid,
        borderRadius: w(LID_RADIUS * LID_WIDTH),
        boxShadow: `inset 0 ${w(0.0015)} 0 ${MACBOOK.lidEdge}`,
      }}
    >
      <div
        className="absolute"
        style={{
          left: `${(100 * BEZEL.side) / LID_WIDTH}%`,
          right: `${(100 * BEZEL.side) / LID_WIDTH}%`,
          top: `${(100 * BEZEL.top) / LID_HEIGHT}%`,
          bottom: `${(100 * BEZEL.bottom) / LID_HEIGHT}%`,
          background: MACBOOK.glass,
          borderRadius: w(LID_RADIUS * LID_WIDTH - BEZEL.side),
        }}
      />
      {/* The camera, which is the only thing in the top bezel and the one
          detail that dates the machine to this decade rather than 2012. */}
      <div
        className="absolute left-1/2 -translate-x-1/2 rounded-full"
        style={{
          top: `${(100 * BEZEL.top * 0.34) / LID_HEIGHT}%`,
          width: w(0.008),
          height: w(0.008),
          background: 'rgba(255,255,255,0.09)',
        }}
      />
    </div>
  );
}

/**
 * The laptop that rises from below the stage and takes the chat into its
 * screen.
 *
 * This is the Aceternity MacBook effect run backwards. Theirs starts with a
 * closed machine and scrolls the display up and out of it until it fills the
 * window; this one starts with the window full of a live conversation and
 * scrolls it down into the machine. Four things move, all of them transforms:
 * the assembly shrinks, the machine rises to meet it, the chat falls the last
 * of the way into the opening, and it tips onto the plane of the lid on the
 * way in and comes upright again as it lands.
 *
 * Nothing is swapped at the seam. The chat is the same live component in the
 * same box at every beat, so the machine forms around a conversation that is
 * still going rather than replacing it with a picture of one — and it lands
 * square to the reader, because it is still a conversation and it still has to
 * be read.
 */
export function MacbookFrame({
  scale,
  lift,
  rise,
  presence,
  drop,
  layBack,
  children,
}: MacbookFrameProps) {
  return (
    <motion.div
      style={{ scale, '--mb-w': SCREEN_WIDTH } as CSSProperties}
      className="flex w-full origin-center justify-center"
    >
      <motion.div
        style={{ y: lift, width: 'var(--mb-w)', perspective: w(PERSPECTIVE) }}
        className={`relative ${SCREEN_ASPECT} ${SCREEN_FLOOR}`}
      >
        <motion.div
          aria-hidden="true"
          style={{
            opacity: presence,
            y: rise,
            left: w(-BEZEL.side),
            top: w(-BEZEL.top),
            width: w(LID_WIDTH),
          }}
          className="absolute flex flex-col items-center"
        >
          <div className="relative w-full" style={{ height: w(LID_HEIGHT) }}>
            <Lid />
          </div>
          <div
            style={{ width: '96%', height: w(HINGE), background: MACBOOK.hinge }}
            className="rounded-b-[2px]"
          />
          <MacbookDeck />
          {/* What the machine sits on. Painted rather than a `drop-shadow`
              filter, which would have put the whole rotated deck through a
              filter pass on every frame of the arrival for a soft ellipse. */}
          <div
            className="absolute -bottom-[2%] left-1/2 -z-10 -translate-x-1/2"
            style={{
              width: w(LID_WIDTH * 1.1),
              height: w(0.05),
              background: `radial-gradient(closest-side, ${MACBOOK.shadow}, transparent)`,
            }}
          />
        </motion.div>

        <motion.div
          style={{ y: drop, rotateX: layBack, transformOrigin: 'bottom center' }}
          className="relative h-full"
        >
          {children}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
