import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { fireConfetti } from '@/layers/shared/lib';
import { useWidgetMotion, WIDGET_SPRING } from '../../lib/widget-motion';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;
type MoodEmotion = NodeOf<'mood'>['emotion'];

// Face coordinate space — a 64x64 viewBox scaled to fill the size-14 circle.
const EYE_R = 3;
const MOUTH_Y = 42;

/** Eye positions per emotion; only emotions that shift the gaze override the default. */
const EYE_POSITIONS: Partial<Record<MoodEmotion, { lx: number; rx: number; y: number }>> = {
  thinking: { lx: 27, rx: 43, y: 22 }, // shifted up-right
  sheepish: { lx: 21, rx: 37, y: 30 }, // averted down-left
};
const DEFAULT_EYES = { lx: 24, rx: 40, y: 26 };

/** Blink cycle: a quick 150ms close, then idle — the full cycle lands ~every 5s. */
const BLINK_DURATION = 0.15;
const BLINK_REPEAT_DELAY = 4.85;
const BLINK_TRANSITION = {
  duration: BLINK_DURATION,
  times: [0, 0.85, 0.92, 1],
  repeat: Infinity,
  repeatDelay: BLINK_REPEAT_DELAY,
  ease: 'easeInOut' as const,
};

/** Emotions rendered with plain round "blinking" eyes (as opposed to a bespoke eye shape). */
const BLINKING_EMOTIONS = new Set<MoodEmotion>([
  'happy',
  'thinking',
  'sheepish',
  'determined',
  'surprised',
  'sad',
]);

/**
 * `mood` node — the delight-pack showpiece. A compact SVG face (two eyes, one
 * mouth) plus an optional speech-bubble message. Faces blink on a slow, calm
 * cadence and each emotion carries one small idle tell (thinking dots,
 * pulsing hearts, a gentle celebratory bounce); `celebrating` also fires a
 * single confetti burst on mount.
 */
export function MoodNode({ node }: { node: NodeOf<'mood'> }) {
  const motionOn = useWidgetMotion();
  const confettiFired = useRef(false);

  useEffect(() => {
    if (node.emotion !== 'celebrating' || !motionOn || confettiFired.current) return;
    confettiFired.current = true;
    void fireConfetti();
  }, [node.emotion, motionOn]);

  return (
    <motion.div
      className="flex items-center gap-3"
      role="img"
      aria-label={`Mood: ${node.emotion}`}
      initial={motionOn ? { opacity: 0, scale: 0.9 } : false}
      animate={motionOn ? { opacity: 1, scale: 1 } : false}
      transition={WIDGET_SPRING}
    >
      <div className="flex items-center gap-2">
        <motion.div
          className="bg-muted text-foreground relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full"
          animate={node.emotion === 'celebrating' && motionOn ? { y: [0, -3, 0] } : undefined}
          transition={
            node.emotion === 'celebrating' && motionOn
              ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
        >
          <svg viewBox="0 0 64 64" className="size-full" aria-hidden>
            <Face emotion={node.emotion} motionOn={motionOn} />
          </svg>
        </motion.div>
        {node.emotion === 'thinking' && <ThinkingDots motionOn={motionOn} />}
      </div>
      {node.message && (
        <div className="bg-muted/40 rounded-lg border px-3 py-2 text-sm">{node.message}</div>
      )}
    </motion.div>
  );
}

/** The SVG eyes + mouth (+ per-emotion extras) for one emotion. */
function Face({ emotion, motionOn }: { emotion: MoodEmotion; motionOn: boolean }) {
  const eyes = EYE_POSITIONS[emotion] ?? DEFAULT_EYES;

  return (
    <>
      {emotion === 'love' ? (
        <>
          <HeartEye cx={eyes.lx} cy={eyes.y} motionOn={motionOn} />
          <HeartEye cx={eyes.rx} cy={eyes.y} motionOn={motionOn} />
        </>
      ) : emotion === 'celebrating' ? (
        <>
          <CaretEye cx={eyes.lx} cy={eyes.y} />
          <CaretEye cx={eyes.rx} cy={eyes.y} />
        </>
      ) : (
        <>
          <BlinkEye
            cx={eyes.lx}
            cy={eyes.y}
            r={emotion === 'surprised' ? 4.5 : EYE_R}
            popIn={emotion === 'surprised'}
            active={BLINKING_EMOTIONS.has(emotion)}
            motionOn={motionOn}
          />
          <BlinkEye
            cx={eyes.rx}
            cy={eyes.y}
            r={emotion === 'surprised' ? 4.5 : EYE_R}
            popIn={emotion === 'surprised'}
            active={BLINKING_EMOTIONS.has(emotion)}
            motionOn={motionOn}
          />
        </>
      )}

      {emotion === 'determined' && (
        <>
          <line
            x1={eyes.lx - 5}
            y1={eyes.y - 7}
            x2={eyes.lx + 3}
            y2={eyes.y - 4}
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <line
            x1={eyes.rx + 5}
            y1={eyes.y - 7}
            x2={eyes.rx - 3}
            y2={eyes.y - 4}
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        </>
      )}

      {emotion === 'sheepish' && (
        <>
          <circle
            cx={14}
            cy={34}
            r={3}
            className="text-status-error"
            fill="currentColor"
            fillOpacity={0.3}
          />
          <circle
            cx={50}
            cy={34}
            r={3}
            className="text-status-error"
            fill="currentColor"
            fillOpacity={0.3}
          />
        </>
      )}

      <Mouth emotion={emotion} />
    </>
  );
}

function Mouth({ emotion }: { emotion: MoodEmotion }) {
  switch (emotion) {
    case 'happy':
      return (
        <path
          d="M20 40 Q32 50 44 40"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
        />
      );
    case 'thinking':
      return (
        <line
          x1={27}
          y1={MOUTH_Y}
          x2={37}
          y2={MOUTH_Y}
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      );
    case 'celebrating':
      return (
        <path
          d="M20 38 Q32 52 44 38 Q32 45 20 38 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinejoin="round"
        />
      );
    case 'sheepish':
      return (
        <path
          d="M24 42 Q28 39.5 32 42 T40 42"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
      );
    case 'determined':
      return (
        <line
          x1={23}
          y1={MOUTH_Y}
          x2={41}
          y2={MOUTH_Y}
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
        />
      );
    case 'surprised':
      return <circle cx={32} cy={44} r={3} fill="none" stroke="currentColor" strokeWidth={2} />;
    case 'sad':
      return (
        <path
          d="M20 46 Q32 37 44 46"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
        />
      );
    case 'love':
      return (
        <path
          d="M22 40 Q32 46 42 40"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      );
  }
}

interface BlinkEyeProps {
  cx: number;
  cy: number;
  r: number;
  /** Blink loop only runs for `active` eyes — a closed/heart eye never blinks. */
  active: boolean;
  /** `surprised` eyes pop in with a spring on mount, on top of the blink loop. */
  popIn: boolean;
  motionOn: boolean;
}

/** A round eye that blinks on a slow loop (gated on `active`/`motionOn`). */
function BlinkEye({ cx, cy, r, active, popIn, motionOn }: BlinkEyeProps) {
  const blink = motionOn && active;
  return (
    <motion.circle
      cx={cx}
      cy={cy}
      r={r}
      fill="currentColor"
      style={{ transformOrigin: `${cx}px ${cy}px` }}
      initial={motionOn && popIn ? { scale: 0.3 } : undefined}
      animate={motionOn ? { scale: 1, ...(blink ? { scaleY: [1, 1, 0.1, 1] } : {}) } : undefined}
      transition={
        motionOn
          ? { scale: WIDGET_SPRING, ...(blink ? { scaleY: BLINK_TRANSITION } : {}) }
          : undefined
      }
    />
  );
}

/** A closed, upward-arcing "^" eye — the `celebrating` emotion's happy squint. */
function CaretEye({ cx, cy }: { cx: number; cy: number }) {
  return (
    <path
      d={`M ${cx - 4} ${cy + 1} Q ${cx} ${cy - 4} ${cx + 4} ${cy + 1}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
    />
  );
}

/** A small heart-shaped eye that pulses gently — the `love` emotion's eyes. */
function HeartEye({ cx, cy, motionOn }: { cx: number; cy: number; motionOn: boolean }) {
  const d = `M ${cx} ${cy + 4} C ${cx - 8} ${cy - 2}, ${cx - 4} ${cy - 8}, ${cx} ${cy - 4} C ${cx + 4} ${cy - 8}, ${cx + 8} ${cy - 2}, ${cx} ${cy + 4} Z`;
  return (
    <motion.path
      d={d}
      fill="currentColor"
      className="text-status-error"
      style={{ transformOrigin: `${cx}px ${cy}px` }}
      animate={motionOn ? { scale: [1, 1.1, 1] } : undefined}
      transition={motionOn ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' } : undefined}
    />
  );
}

/** Three dots that fade in sequence beside the face — the `thinking` emotion's idle tell. */
function ThinkingDots({ motionOn }: { motionOn: boolean }) {
  return (
    <div className="flex items-end gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted-foreground/60 size-1.5 rounded-full"
          animate={motionOn ? { opacity: [0.25, 1, 0.25] } : undefined}
          transition={
            motionOn
              ? { duration: 1.2, repeat: Infinity, delay: i * 0.25, ease: 'easeInOut' }
              : undefined
          }
        />
      ))}
    </div>
  );
}
