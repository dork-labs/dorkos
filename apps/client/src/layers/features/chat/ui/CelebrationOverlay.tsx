import { useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { fireConfetti, RADIAL_GLOW_STYLE, type CelebrationEvent } from '@/layers/shared/lib';

interface CelebrationOverlayProps {
  celebration: CelebrationEvent | null;
  onComplete: () => void;
}

export function CelebrationOverlay({ celebration, onComplete }: CelebrationOverlayProps) {
  const confettiCleanupRef = useRef<(() => void) | null>(null);
  const isMajor = celebration?.level === 'major';

  const stableOnComplete = useCallback(() => {
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    if (!isMajor) return;

    let cancelled = false;

    fireConfetti({
      particleCount: 40,
      origin: { x: 0.5, y: 0.6 },
      colors: ['#FFD700', '#FFC107', '#F7B500'],
    }).then((cleanup) => {
      if (cancelled) {
        cleanup();
        return;
      }
      confettiCleanupRef.current = cleanup;
    });

    const timer = setTimeout(() => {
      stableOnComplete();
    }, 2000);

    return () => {
      cancelled = true;
      confettiCleanupRef.current?.();
      confettiCleanupRef.current = null;
      clearTimeout(timer);
    };
  }, [isMajor, stableOnComplete]);

  return (
    <AnimatePresence>
      {isMajor && (
        <motion.div
          aria-hidden="true"
          className="fixed inset-0 pointer-events-none z-50"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.1 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          style={RADIAL_GLOW_STYLE}
        />
      )}
    </AnimatePresence>
  );
}
