/**
 * The eight mood faces, one component each, composed from shared parts. Every
 * face has brows (the strokes that unlock most of the emotional range), a
 * bespoke mouth, and one signature micro-tell — with per-element timing kept
 * deliberately out of lockstep so the faces read alive, not mechanical.
 *
 * All geometry lives in the 64×64 viewBox and every stroke inherits
 * `currentColor`; accent parts (hearts, blush, drops) use status tokens. Under
 * reduced motion the shapes alone carry each emotion.
 *
 * @module features/gen-ui/ui/nodes/mood/faces
 */
import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { BlinkEye, Blush, Brow, CaretEye, HeartEye } from './parts';
import { SteamWisp, SweatDrop, Tear } from './details';

type MoodEmotion = Extract<WidgetNode, { type: 'mood' }>['emotion'];

/** Stroke props shared by every mouth. */
const MOUTH_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
} as const;

/**
 * Happy — buoyant and warm. Signature: every ~8s the eyes squint shut and the
 * cheek apples lift (a closed-eye smile beat), then it settles back to a calm
 * blink. The smile sits wide and generous.
 */
function HappyFace({ motionOn }: { motionOn: boolean }) {
  // One 8s track per eye: a quick blink early, then the squint-smile hold near
  // the end. Cheeks fade in exactly during the squint (same clock, same times).
  const eyeTrack = {
    scaleY: [1, 0.1, 1, 1, 0.15, 0.15, 1],
    times: [0, 0.03, 0.06, 0.84, 0.87, 0.96, 1],
  };
  const cheekTrack = { opacity: [0, 0, 0.4, 0.4, 0], times: [0, 0.84, 0.88, 0.96, 1] };
  const loop = { duration: 8, repeat: Infinity, ease: 'easeInOut' as const };
  return (
    <>
      <Brow d="M18 18 Q24 14.5 30 18" />
      <Brow d="M34 18 Q40 14.5 46 18" />
      {[24, 40].map((cx) => (
        <motion.circle
          key={cx}
          cx={cx}
          cy={26}
          r={3}
          fill="currentColor"
          style={{ transformOrigin: `${cx}px 26px` }}
          animate={motionOn ? { scaleY: eyeTrack.scaleY } : undefined}
          transition={motionOn ? { ...loop, times: eyeTrack.times } : undefined}
        />
      ))}
      {motionOn && (
        <motion.g
          animate={{ opacity: cheekTrack.opacity }}
          transition={{ ...loop, times: cheekTrack.times }}
        >
          <Blush cx={16.5} cy={33} opacity={1} />
          <Blush cx={47.5} cy={33} opacity={1} />
        </motion.g>
      )}
      <path d="M19 38 Q32 51 45 38" {...MOUTH_STROKE} strokeWidth={3} />
    </>
  );
}

/**
 * Thinking — one brow raised, gaze drifting. Signature: the eyes dart aside
 * and back on a long loop while the raised brow bobs on its own clock.
 */
function ThinkingFace({ motionOn }: { motionOn: boolean }) {
  return (
    <>
      <Brow d="M20 20 L29 20" />
      <motion.g
        animate={motionOn ? { y: [0, -1.2, 0] } : undefined}
        transition={motionOn ? { duration: 3.4, repeat: Infinity, ease: 'easeInOut' } : undefined}
      >
        <Brow d="M36 16 Q41 13 46 16" />
      </motion.g>
      <motion.g
        animate={motionOn ? { x: [0, 0, -3.5, -3.5, 0, 0, 2, 0] } : undefined}
        transition={
          motionOn
            ? {
                duration: 7,
                times: [0, 0.3, 0.36, 0.52, 0.58, 0.78, 0.84, 1],
                repeat: Infinity,
                ease: 'easeInOut',
              }
            : undefined
        }
      >
        <BlinkEye cx={27} cy={23} motionOn={motionOn} />
        <BlinkEye cx={43} cy={23} motionOn={motionOn} />
      </motion.g>
      <path d="M27 43 L37 41.5" {...MOUTH_STROKE} strokeWidth={2.5} />
    </>
  );
}

/**
 * Celebrating — pure joy. Caret-squint eyes, brows high, a big open smile.
 * Signature: the bounce-squash lives on the container (see MoodNode); confetti
 * fires once on mount.
 */
function CelebratingFace() {
  return (
    <>
      <Brow d="M18 16 Q24 12.5 30 16" />
      <Brow d="M34 16 Q40 12.5 46 16" />
      <CaretEye cx={24} cy={26} />
      <CaretEye cx={40} cy={26} />
      <path
        d="M19 37 Q32 54 45 37 Q32 44 19 37 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </>
  );
}

/**
 * Sheepish — averted eyes, worried brows, blush. Signature: a sweat bead
 * wells at the temple and slides down every few seconds.
 */
function SheepishFace({ motionOn }: { motionOn: boolean }) {
  return (
    <>
      <Brow d="M17 20 L27 17" />
      <Brow d="M33 17 L43 20" />
      <BlinkEye cx={21} cy={30} motionOn={motionOn} />
      <BlinkEye cx={37} cy={30} motionOn={motionOn} />
      <Blush cx={14.5} cy={36} />
      <Blush cx={44.5} cy={36} />
      <SweatDrop motionOn={motionOn} />
      <path d="M23 42 Q27.5 39.5 32 42 T41 42" {...MOUTH_STROKE} strokeWidth={2.5} />
    </>
  );
}

/**
 * Determined — narrowed eyes under inner-dropped brows, a firm mouth.
 * Signature: the brows press into a periodic furrow while tiny steam wisps
 * rise and dissolve at the temple.
 */
function DeterminedFace({ motionOn }: { motionOn: boolean }) {
  return (
    <>
      <motion.g
        animate={motionOn ? { y: [0, 1.4, 1.4, 0] } : undefined}
        transition={
          motionOn
            ? { duration: 5, times: [0, 0.12, 0.5, 0.62], repeat: Infinity, ease: 'easeInOut' }
            : undefined
        }
      >
        <Brow d="M18 15 L29 19.5" />
        <Brow d="M35 19.5 L46 15" />
      </motion.g>
      <BlinkEye cx={24} cy={27} openness={0.8} motionOn={motionOn} />
      <BlinkEye cx={40} cy={27} openness={0.8} motionOn={motionOn} />
      <SteamWisp motionOn={motionOn} />
      <path d="M23 42 L41 42" {...MOUTH_STROKE} strokeWidth={3} />
    </>
  );
}

/**
 * Surprised — the whole face startles. Signature: brows shoot up from the
 * eyeline on mount while the 'O' mouth pops in with a spring; the container
 * recoils then holds still (stillness sells shock).
 */
function SurprisedFace({ motionOn }: { motionOn: boolean }) {
  return (
    <>
      <motion.g
        initial={motionOn ? { y: 7 } : undefined}
        animate={motionOn ? { y: 0 } : undefined}
        transition={
          motionOn ? { type: 'spring', stiffness: 420, damping: 11, delay: 0.08 } : undefined
        }
      >
        <Brow d="M18 14 Q24 10.5 30 14" />
        <Brow d="M34 14 Q40 10.5 46 14" />
      </motion.g>
      <BlinkEye cx={24} cy={26} r={4.5} popIn motionOn={motionOn} />
      <BlinkEye cx={40} cy={26} r={4.5} popIn motionOn={motionOn} />
      <motion.circle
        cx={32}
        cy={44}
        r={4}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        style={{ transformOrigin: '32px 44px' }}
        initial={motionOn ? { scale: 0.2 } : undefined}
        animate={motionOn ? { scale: 1 } : undefined}
        transition={
          motionOn ? { type: 'spring', stiffness: 500, damping: 12, delay: 0.14 } : undefined
        }
      />
    </>
  );
}

/**
 * Sad — sits heavy. Inner-raised brows, a deep frown, and the signature: a
 * tear that wells at the eye and falls, slowly, on a long quiet loop.
 */
function SadFace({ motionOn }: { motionOn: boolean }) {
  return (
    <>
      <Brow d="M19 20.5 L29 16.5" />
      <Brow d="M35 16.5 L45 20.5" />
      <BlinkEye cx={24} cy={26} motionOn={motionOn} />
      <BlinkEye cx={40} cy={26} motionOn={motionOn} />
      <Tear motionOn={motionOn} />
      <path d="M20 47 Q32 37.5 44 47" {...MOUTH_STROKE} strokeWidth={3} />
    </>
  );
}

/**
 * Love — heart eyes with variance: each heart pulses on its own tempo and
 * counter-wobbles, so the pair never beats in mechanical sync. Soft blush,
 * relaxed brows, gentle smile.
 */
function LoveFace({ motionOn }: { motionOn: boolean }) {
  return (
    <>
      <Brow d="M18 17.5 Q24 15 30 17.5" />
      <Brow d="M34 17.5 Q40 15 46 17.5" />
      <HeartEye cx={24} cy={27} motionOn={motionOn} pulseDuration={1.5} wobble={3} />
      <HeartEye cx={40} cy={27} motionOn={motionOn} pulseDuration={1.9} delay={0.35} wobble={-3} />
      <Blush cx={15} cy={35} opacity={0.25} />
      <Blush cx={49} cy={35} opacity={0.25} />
      <path d="M21 40 Q32 48 43 40" {...MOUTH_STROKE} strokeWidth={2.5} />
    </>
  );
}

/** Dispatch to the emotion's face component. */
export function Face({ emotion, motionOn }: { emotion: MoodEmotion; motionOn: boolean }) {
  switch (emotion) {
    case 'happy':
      return <HappyFace motionOn={motionOn} />;
    case 'thinking':
      return <ThinkingFace motionOn={motionOn} />;
    case 'celebrating':
      return <CelebratingFace />;
    case 'sheepish':
      return <SheepishFace motionOn={motionOn} />;
    case 'determined':
      return <DeterminedFace motionOn={motionOn} />;
    case 'surprised':
      return <SurprisedFace motionOn={motionOn} />;
    case 'sad':
      return <SadFace motionOn={motionOn} />;
    case 'love':
      return <LoveFace motionOn={motionOn} />;
  }
}
