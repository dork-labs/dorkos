/**
 * Shared face primitives for the mood widget — eyes, brows, and the blink
 * vocabulary. Every stroke inherits `currentColor` so the whole face themes
 * with the surface; accent parts (hearts, blush, tears) opt into status tokens.
 *
 * Blink design: one long loop carries a single blink early and a double-blink
 * past the midpoint, so the face reads alive without metronome regularity.
 * Both eyes blink together (humans do) — asymmetry lives in brows, gaze, and
 * mouth timing instead.
 *
 * @module features/gen-ui/ui/nodes/mood/parts
 */
import { motion } from 'motion/react';

/** Seconds for one full blink cycle (single blink + later double-blink). */
const BLINK_LOOP_DURATION = 7.4;

/** Blink track: quick close/open at 2%, a double-blink around 52–61%. */
const BLINK_KEYFRAMES = [1, 0.1, 1, 1, 0.1, 1, 0.1, 1, 1];
const BLINK_TIMES = [0, 0.02, 0.045, 0.52, 0.54, 0.565, 0.585, 0.61, 1];

interface BlinkEyeProps {
  cx: number;
  cy: number;
  r?: number;
  /** Vertical squash for narrowed eyes (determined). 1 = fully open. */
  openness?: number;
  /** Blink loop only runs for `active` eyes — a closed/heart eye never blinks. */
  active?: boolean;
  /** `surprised` eyes pop in with a spring on mount, on top of the blink loop. */
  popIn?: boolean;
  motionOn: boolean;
}

/**
 * A round eye that blinks on a long, humanlike loop (single blink, then an
 * occasional double-blink), gated on `active`/`motionOn`.
 */
export function BlinkEye({
  cx,
  cy,
  r = 3,
  openness = 1,
  active = true,
  popIn = false,
  motionOn,
}: BlinkEyeProps) {
  const blink = motionOn && active;
  const open = openness;
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      r={r}
      fill="currentColor"
      style={{ transformOrigin: `${cx}px ${cy}px`, scaleY: motionOn ? undefined : open }}
      initial={motionOn && popIn ? { scale: 0.2 } : undefined}
      animate={
        motionOn
          ? {
              scale: 1,
              ...(blink ? { scaleY: BLINK_KEYFRAMES.map((k) => k * open) } : { scaleY: open }),
            }
          : undefined
      }
      transition={
        motionOn
          ? {
              scale: { type: 'spring', stiffness: 500, damping: 15 },
              ...(blink
                ? {
                    scaleY: {
                      duration: BLINK_LOOP_DURATION,
                      times: BLINK_TIMES,
                      repeat: Infinity,
                      ease: 'easeInOut',
                    },
                  }
                : {}),
            }
          : undefined
      }
    />
  );
}

/** A closed, upward-arcing "^" eye — the happy squint (celebrating). */
export function CaretEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <path
      d={`M ${cx - 4.5} ${cy + 1.5} Q ${cx} ${cy - 4.5} ${cx + 4.5} ${cy + 1.5}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
    />
  );
}

interface HeartEyeProps {
  cx: number;
  cy: number;
  motionOn: boolean;
  /** Seconds for one pulse — give each eye its own so they never sync (variance). */
  pulseDuration: number;
  /** Start offset so the two hearts beat out of phase. */
  delay?: number;
  /** Degrees of idle wobble; sign sets direction so the pair counter-rotates. */
  wobble?: number;
}

/**
 * A heart-shaped eye that pulses and wobbles — each instance gets its own
 * tempo and rotation direction so the pair reads organic, never mechanical.
 */
export function HeartEye({
  cx,
  cy,
  motionOn,
  pulseDuration,
  delay = 0,
  wobble = 3,
}: HeartEyeProps) {
  const d = `M ${cx} ${cy + 4} C ${cx - 8} ${cy - 2}, ${cx - 4} ${cy - 8}, ${cx} ${cy - 4} C ${cx + 4} ${cy - 8}, ${cx + 8} ${cy - 2}, ${cx} ${cy + 4} Z`;
  return (
    <motion.path
      d={d}
      fill="currentColor"
      className="text-status-error"
      style={{ transformOrigin: `${cx}px ${cy}px` }}
      animate={motionOn ? { scale: [1, 1.16, 1], rotate: [-wobble, wobble, -wobble] } : undefined}
      transition={
        motionOn
          ? {
              scale: { duration: pulseDuration, repeat: Infinity, ease: 'easeInOut', delay },
              rotate: {
                duration: pulseDuration * 2.1,
                repeat: Infinity,
                ease: 'easeInOut',
                delay,
              },
            }
          : undefined
      }
    />
  );
}

/**
 * One eyebrow — a short stroke whose path carries most of the emotional read
 * (raised arc = bright, inner-raised slant = worried, inner-dropped = resolve).
 */
export function Brow({ d }: { d: string }) {
  return <path d={d} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />;
}

/** A soft blush ellipse under an eye; tints with the status-error token. */
export function Blush({ cx, cy, opacity = 0.3 }: { cx: number; cy: number; opacity?: number }) {
  return (
    <ellipse
      cx={cx}
      cy={cy}
      rx={3.6}
      ry={2.1}
      className="text-status-error"
      fill="currentColor"
      fillOpacity={opacity}
    />
  );
}
