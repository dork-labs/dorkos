import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Badge } from '@/layers/shared/ui';
import { cn, fireConfetti } from '@/layers/shared/lib';
import type { ScanCandidate } from '@/layers/features/onboarding';
import { formatMarker } from '../lib/marker-labels';

/** Beat timing constants in milliseconds. */
const BEAT_1_DURATION = 2000;
const BEAT_2_DELAY = BEAT_1_DURATION;
const BEAT_2_DURATION = 500;
const BEAT_3_DELAY = BEAT_2_DELAY + BEAT_2_DURATION;
const BEAT_3_DURATION = 1500;
const TOTAL_DURATION = BEAT_3_DELAY + BEAT_3_DURATION;

/** Reduced motion delay before calling onComplete. */
const REDUCED_MOTION_DELAY = 800;

interface DiscoveryCelebrationProps {
  candidates: ScanCandidate[];
  onComplete: () => void;
}

/**
 * Three-beat celebration animation played after agent discovery completes.
 *
 * Beat 1: Agent cards stagger in with spring animations.
 * Beat 2: Confetti fires and a "Found N agents!" heading appears.
 * Beat 3: Cards fade out and onComplete is called.
 *
 * Respects prefers-reduced-motion by skipping confetti and using instant transitions.
 */
export function DiscoveryCelebration({ candidates, onComplete }: DiscoveryCelebrationProps) {
  const [beat, setBeat] = useState<1 | 2 | 3>(1);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const confettiCleanupRef = useRef<(() => void) | null>(null);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    // Reduced motion: skip animation, call onComplete after brief delay
    if (prefersReducedMotion) {
      const timeout = setTimeout(onComplete, REDUCED_MOTION_DELAY);
      return () => clearTimeout(timeout);
    }

    // Beat 2: confetti + announcement
    const beat2Timeout = setTimeout(() => {
      setBeat(2);
      void fireConfetti({
        particleCount: 60,
        origin: { x: 0.5, y: 0.5 },
      }).then((cleanup) => {
        confettiCleanupRef.current = cleanup;
      });
    }, BEAT_2_DELAY);

    // Beat 3: fade out
    const beat3Timeout = setTimeout(() => {
      setBeat(3);
    }, BEAT_3_DELAY);

    // Complete
    const completeTimeout = setTimeout(onComplete, TOTAL_DURATION);

    timeoutsRef.current = [beat2Timeout, beat3Timeout, completeTimeout];

    return () => {
      timeoutsRef.current.forEach(clearTimeout);
      confettiCleanupRef.current?.();
    };
  }, [onComplete, prefersReducedMotion]);

  // Reduced motion: simple static display
  if (prefersReducedMotion) {
    return (
      <div className="flex flex-col items-center gap-6 py-8">
        <h2 className="text-xl font-bold sm:text-2xl">
          Found {candidates.length} agent{candidates.length !== 1 ? 's' : ''}!
        </h2>
        <div className="flex w-full max-w-md flex-col gap-3">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.path} candidate={candidate} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6 py-8">
      {/* Beat 2+: Announcement heading */}
      {beat >= 2 && (
        <motion.h2
          className="text-xl font-bold sm:text-2xl"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
        >
          Found {candidates.length} agent{candidates.length !== 1 ? 's' : ''}!
        </motion.h2>
      )}

      {/* Agent cards */}
      <motion.div
        className="flex w-full max-w-md flex-col gap-3"
        initial="hidden"
        animate={beat === 3 ? 'exit' : 'visible'}
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.15 } },
          exit: { transition: { staggerChildren: 0.08 } },
        }}
      >
        {candidates.map((candidate) => (
          <motion.div
            key={candidate.path}
            variants={{
              hidden: { y: 20, opacity: 0 },
              visible: {
                y: 0,
                opacity: 1,
                transition: { type: 'spring', damping: 20, stiffness: 300 },
              },
              exit: { opacity: 0, scale: 0.95, transition: { duration: 0.3 } },
            }}
          >
            <CandidateCard candidate={candidate} />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}

/** Compact read-only card for a discovered agent during celebration. */
function CandidateCard({ candidate }: { candidate: ScanCandidate }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-4 text-left',
        'shadow-soft'
      )}
    >
      <div className="space-y-1.5">
        <span className="text-sm font-semibold">{candidate.name}</span>
        <p className="truncate text-xs text-muted-foreground">{candidate.path}</p>
        <div className="flex flex-wrap gap-1">
          {candidate.markers.map((marker) => (
            <Badge key={marker} variant="secondary" className="text-xs">
              {formatMarker(marker)}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
