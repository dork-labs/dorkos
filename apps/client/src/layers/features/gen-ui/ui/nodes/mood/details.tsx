/**
 * Signature micro-details — each emotion's one small tell. A sweat drop slides
 * for sheepish, a tear wells for sad, steam wisps rise for determined. All are
 * tasteful and small; under reduced motion the wet ones freeze at a readable
 * mid-pose (they still carry the emotion) and the steam hides (a static puff
 * reads as a smudge, not resolve).
 *
 * @module features/gen-ui/ui/nodes/mood/details
 */
import { motion } from 'motion/react';

/** A small teardrop path centered on (0,0), pointing down. */
const DROPLET_D = 'M 0 -3.2 C 2.2 -0.6, 2.6 1.4, 0 3.2 C -2.6 1.4, -2.2 -0.6, 0 -3.2 Z';

interface DropProps {
  /** Where the drop begins its slide. */
  x: number;
  y: number;
  motionOn: boolean;
  /** Seconds for one slide. */
  duration: number;
  /** Idle seconds between slides. */
  repeatDelay: number;
}

/**
 * A liquid drop that wells up, slides down, and fades — shared by the sheepish
 * sweat bead and the sad tear (they differ only in placement and tempo).
 * Reduced motion: frozen mid-slide at half opacity, still legible as a drop.
 */
function Drop({ x, y, motionOn, duration, repeatDelay }: DropProps) {
  if (!motionOn) {
    return (
      <g transform={`translate(${x} ${y + 4})`} opacity={0.5}>
        <path d={DROPLET_D} className="text-status-info" fill="currentColor" />
      </g>
    );
  }
  return (
    <motion.g
      style={{ x, y }}
      animate={{
        y: [y, y + 2, y + 9, y + 11],
        opacity: [0, 0.85, 0.85, 0],
        scale: [0.5, 1, 1, 0.85],
      }}
      transition={{
        duration,
        times: [0, 0.3, 0.85, 1],
        repeat: Infinity,
        repeatDelay,
        ease: 'easeIn',
      }}
    >
      <path d={DROPLET_D} className="text-status-info" fill="currentColor" />
    </motion.g>
  );
}

/** Sheepish's sweat bead — wells at the temple and slides down every few seconds. */
export function SweatDrop({ motionOn }: { motionOn: boolean }) {
  return <Drop x={47} y={13} motionOn={motionOn} duration={3.4} repeatDelay={2.6} />;
}

/** Sad's welling tear — forms at the inner corner of the left eye and falls slowly. */
export function Tear({ motionOn }: { motionOn: boolean }) {
  return <Drop x={24} y={30} motionOn={motionOn} duration={3.6} repeatDelay={3.2} />;
}

/**
 * Determined's steam wisps — two tiny puffs that rise and dissolve near the
 * temple on offset tempos. Motion-only (a frozen puff reads as a smudge).
 */
export function SteamWisp({ motionOn }: { motionOn: boolean }) {
  if (!motionOn) return null;
  return (
    <>
      {[
        { x: 49, y: 15, delay: 0 },
        { x: 53.5, y: 19, delay: 0.9 },
      ].map((puff, i) => (
        <motion.circle
          key={i}
          cx={puff.x}
          cy={puff.y}
          r={2}
          fill="currentColor"
          style={{ transformOrigin: `${puff.x}px ${puff.y}px` }}
          animate={{ opacity: [0, 0.45, 0], y: [0, -3, -6], scale: [0.6, 1, 1.4] }}
          transition={{
            duration: 2,
            repeat: Infinity,
            repeatDelay: 1.4,
            delay: puff.delay,
            ease: 'easeOut',
          }}
        />
      ))}
    </>
  );
}
