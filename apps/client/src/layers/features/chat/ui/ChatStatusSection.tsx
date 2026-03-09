import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { PanInfo } from 'motion/react';
import type { SessionStatusEvent } from '@dorkos/shared/types';
import { useIsMobile, useAppStore } from '@/layers/shared/model';
import { STORAGE_KEYS, TIMING } from '@/layers/shared/lib';
import { ShortcutChips } from './ShortcutChips';
import { DragHandle } from './DragHandle';
import { StatusLine } from '@/layers/features/status';

interface ChatStatusSectionProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
  onChipClick: (trigger: string) => void;
}

const SWIPE_THRESHOLD = 80;
const VELOCITY_THRESHOLD = 500;

/**
 * Mobile gesture UI (drag handle, swipe hint, collapsible status) and
 * desktop status bar (shortcut chips + status line).
 */
export function ChatStatusSection({
  sessionId,
  sessionStatus,
  isStreaming,
  onChipClick,
}: ChatStatusSectionProps) {
  const isMobile = useIsMobile();
  const showShortcutChips = useAppStore((s) => s.showShortcutChips);

  // Mobile-only gesture state
  const [collapsed, setCollapsed] = useState(false);
  const [showHint, setShowHint] = useState(() => {
    if (!isMobile) return false;
    const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
    return count < 3;
  });

  useEffect(() => {
    if (!showHint) return;
    const timer = setTimeout(() => {
      setShowHint(false);
      const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
      localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, String(count + 1));
    }, TIMING.GESTURE_HINT_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showHint]);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
    localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, String(count + 1));
  }, []);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const { offset, velocity } = info;
    if (offset.y > SWIPE_THRESHOLD || velocity.y > VELOCITY_THRESHOLD) {
      setCollapsed(true);
    } else if (offset.y < -SWIPE_THRESHOLD || velocity.y < -VELOCITY_THRESHOLD) {
      setCollapsed(false);
    }
  };

  if (isMobile) {
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
              {showShortcutChips && <ShortcutChips onChipClick={onChipClick} />}
              <StatusLine
                sessionId={sessionId}
                sessionStatus={sessionStatus}
                isStreaming={isStreaming}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  return (
    <>
      <AnimatePresence>
        {showShortcutChips && <ShortcutChips onChipClick={onChipClick} />}
      </AnimatePresence>
      <StatusLine
        sessionId={sessionId}
        sessionStatus={sessionStatus}
        isStreaming={isStreaming}
      />
    </>
  );
}
