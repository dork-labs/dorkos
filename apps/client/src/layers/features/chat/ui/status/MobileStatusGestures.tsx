import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PanInfo } from 'motion/react';
import { STORAGE_KEYS, TIMING } from '@/layers/shared/lib';
import { DragHandle } from './DragHandle';

const SWIPE_THRESHOLD = 80;
const VELOCITY_THRESHOLD = 500;

/** Bump the "swipe to collapse" hint counter; it stops showing after three sightings. */
function recordHintSeen(): void {
  const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
  localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, String(count + 1));
}

/** Whether the hint still has sightings left. */
function hintUnseen(): boolean {
  const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
  return count < 3;
}

/**
 * Touch wrapper for the status area: a drag handle, a swipe-to-collapse gesture,
 * and a first-run hint.
 *
 * @param props - The status content to wrap.
 */
export function MobileStatusGestures({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showHint, setShowHint] = useState(hintUnseen);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    recordHintSeen();
  }, []);

  useEffect(() => {
    if (!showHint) return;
    const timer = setTimeout(dismissHint, TIMING.GESTURE_HINT_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showHint, dismissHint]);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const { offset, velocity } = info;
    if (offset.y > SWIPE_THRESHOLD || velocity.y > VELOCITY_THRESHOLD) {
      setCollapsed(true);
    } else if (offset.y < -SWIPE_THRESHOLD || velocity.y < -VELOCITY_THRESHOLD) {
      setCollapsed(false);
    }
  };

  return (
    <>
      <motion.div
        animate={showHint ? { y: [0, 8, 0] } : undefined}
        transition={showHint ? { duration: 1.2, repeat: 2 } : undefined}
      >
        <DragHandle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </motion.div>
      <AnimatePresence>
        {showHint && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={dismissHint}
            className="text-muted-foreground cursor-pointer text-center text-xs"
          >
            Swipe to collapse
          </motion.p>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="overflow-hidden"
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={0.2}
            onDragEnd={handleDragEnd}
            style={{ touchAction: 'pan-y' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
