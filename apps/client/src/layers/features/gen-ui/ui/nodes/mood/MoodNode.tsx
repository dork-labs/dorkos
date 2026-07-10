/**
 * `mood` node — the delight-pack showpiece. A compact SVG face on a size-14
 * circle, plus an optional speech-bubble message.
 *
 * The body language is layered classic character animation: each emotion gets
 * an ENTRANCE (an overshooting settle for most; a recoil for surprised; a slow
 * heavy sink for sad) on an outer wrapper, and an IDLE loop (buoyant bob,
 * heavy droop, celebratory bounce-squash, thoughtful tilt…) on an inner
 * wrapper — two elements so the one-shot and the loop never fight over the
 * same transform. Faces themselves live in `./faces` with per-element timing.
 * `celebrating` also fires a single confetti burst on mount, erupting from the
 * face circle itself (origin-aware, via {@link rectToCelebrationOrigin}).
 *
 * Every animation gates on {@link useWidgetMotion}; under reduced motion the
 * static brow/mouth shapes still carry each emotion.
 *
 * @module features/gen-ui/ui/nodes/mood/MoodNode
 */
import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import type { TargetAndTransition, Transition } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { fireCelebration, rectToCelebrationOrigin } from '@/layers/shared/lib';
import { useWidgetMotion } from '../../../lib/widget-motion';
import { Face } from './faces';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;
type MoodEmotion = NodeOf<'mood'>['emotion'];

/** One entrance spec: where the face starts and how it settles in. */
interface EntranceSpec {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  transition: Transition;
}

/** Default entrance: small, then an overshooting spring settle (anticipation → pop). */
const POP_ENTRANCE: EntranceSpec = {
  initial: { opacity: 0, scale: 0.5 },
  animate: { opacity: 1, scale: 1 },
  transition: { type: 'spring', stiffness: 380, damping: 16, mass: 0.9 },
};

/** Per-emotion entrances that differ from the default pop. */
const ENTRANCES: Partial<Record<MoodEmotion, EntranceSpec>> = {
  // Surprised recoils: blows past full size, squashes back, settles.
  surprised: {
    initial: { opacity: 0, scale: 0.4 },
    animate: { opacity: 1, scale: [0.4, 1.14, 0.94, 1.03, 1] },
    transition: { duration: 0.65, times: [0, 0.4, 0.62, 0.82, 1], ease: 'easeOut' },
  },
  // Sad arrives without bounce — it sinks into place, a beat slower than joy.
  sad: {
    initial: { opacity: 0, scale: 0.92, y: -3 },
    animate: { opacity: 1, scale: 1, y: 0 },
    transition: { duration: 0.7, ease: 'easeOut' },
  },
};

/** One idle-loop spec for the face circle. */
interface IdleSpec {
  animate: TargetAndTransition;
  transition: Transition;
}

/**
 * Emotion-appropriate idle motion. Amplitudes are small on purpose — this is a
 * calm control panel, not a cartoon; the loop should be felt more than seen.
 * `surprised` gets none: stillness after the recoil is what sells shock.
 */
const IDLES: Partial<Record<MoodEmotion, IdleSpec>> = {
  happy: {
    animate: { y: [0, -1.5, 0] },
    transition: { duration: 2.8, repeat: Infinity, ease: 'easeInOut' },
  },
  thinking: {
    animate: { rotate: [0, -1.2, 0, 1.2, 0] },
    transition: { duration: 6, repeat: Infinity, ease: 'easeInOut' },
  },
  // The celebratory bounce with squash-and-stretch on the landing.
  celebrating: {
    animate: { y: [0, -4, 0, 0], scaleY: [1, 1.06, 0.9, 1], scaleX: [1, 0.96, 1.08, 1] },
    transition: { duration: 1.3, times: [0, 0.35, 0.7, 1], repeat: Infinity, ease: 'easeInOut' },
  },
  // A shy tilt that holds, then rights itself.
  sheepish: {
    animate: { rotate: [0, -2.5, -2.5, 0] },
    transition: { duration: 5, times: [0, 0.2, 0.7, 1], repeat: Infinity, ease: 'easeInOut' },
  },
  // A slow breathing press — resolve gathering.
  determined: {
    animate: { scale: [1, 1.02, 1] },
    transition: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
  },
  // Sits heavy: a long, low droop with the faintest lean.
  sad: {
    animate: { y: [0, 2, 0], rotate: [0, -1.5, 0] },
    transition: { duration: 5, repeat: Infinity, ease: 'easeInOut' },
  },
  // A gentle besotted sway.
  love: {
    animate: { rotate: [0, 2.5, 0, -2.5, 0] },
    transition: { duration: 4, repeat: Infinity, ease: 'easeInOut' },
  },
};

/** The `mood` widget node: animated face circle + optional message bubble. */
export function MoodNode({ node }: { node: NodeOf<'mood'> }) {
  const motionOn = useWidgetMotion();
  const confettiFired = useRef(false);
  const faceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (node.emotion !== 'celebrating' || !motionOn || confettiFired.current) return;
    confettiFired.current = true;
    // Erupt from the face itself, not screen-center (origin-aware confetti).
    const rect = faceRef.current?.getBoundingClientRect();
    void fireCelebration({ origin: rect ? rectToCelebrationOrigin(rect) : undefined });
  }, [node.emotion, motionOn]);

  const entrance = ENTRANCES[node.emotion] ?? POP_ENTRANCE;
  const idle = IDLES[node.emotion];

  return (
    <div className="flex items-center gap-3" role="img" aria-label={`Mood: ${node.emotion}`}>
      <div className="flex items-center gap-2">
        {/* Outer wrapper: the one-shot entrance. Inner wrapper: the idle loop.
            Separate elements so the settle and the loop never fight over one
            transform. */}
        <motion.div
          initial={motionOn ? entrance.initial : false}
          animate={motionOn ? entrance.animate : false}
          transition={motionOn ? entrance.transition : undefined}
        >
          <motion.div
            ref={faceRef}
            className="bg-muted text-foreground relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full"
            animate={motionOn && idle ? idle.animate : undefined}
            transition={motionOn && idle ? idle.transition : undefined}
          >
            <svg viewBox="0 0 64 64" className="size-full" aria-hidden>
              <Face emotion={node.emotion} motionOn={motionOn} />
            </svg>
          </motion.div>
        </motion.div>
        {node.emotion === 'thinking' && <ThinkingDots motionOn={motionOn} />}
      </div>
      {node.message && (
        <motion.div
          className="bg-muted/40 rounded-lg border px-3 py-2 text-sm"
          initial={motionOn ? { opacity: 0, x: -4 } : false}
          animate={motionOn ? { opacity: 1, x: 0 } : false}
          transition={motionOn ? { duration: 0.3, delay: 0.15, ease: 'easeOut' } : undefined}
        >
          {node.message}
        </motion.div>
      )}
    </div>
  );
}

/**
 * Three dots that cascade beside the thinking face — each rises, brightens,
 * and settles slightly after its neighbor.
 */
function ThinkingDots({ motionOn }: { motionOn: boolean }) {
  return (
    <div className="flex items-end gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="bg-muted-foreground/60 size-1.5 rounded-full"
          animate={motionOn ? { y: [0, -3.5, 0], opacity: [0.3, 1, 0.3] } : undefined}
          transition={
            motionOn
              ? {
                  duration: 1.3,
                  repeat: Infinity,
                  repeatDelay: 0.4,
                  delay: i * 0.16,
                  ease: 'easeInOut',
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}
