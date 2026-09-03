import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface InlineKillButtonProps {
  taskType: 'agent' | 'bash';
  onConfirm: () => void;
}

/** Auto-dismiss duration for the "Stop?" confirmation label (ms). */
const CONFIRM_DISMISS_MS = 3000;

/**
 * Inline kill button — instant for bash tasks, "Stop?" confirmation for agents.
 *
 * For bash: clicking the x immediately calls onConfirm (low-stakes, like Ctrl+C).
 * For agents: first click morphs x to "Stop?" label; second click confirms.
 * The confirmation auto-dismisses after 3 seconds.
 */
export function InlineKillButton({ taskType, onConfirm }: InlineKillButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Auto-dismiss confirmation
  useEffect(() => {
    if (confirming) {
      timerRef.current = setTimeout(() => {
        setConfirming(false);
      }, CONFIRM_DISMISS_MS);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
  }, [confirming]);

  const handleClick = useCallback(() => {
    if (taskType === 'bash') {
      // Instant kill for bash — low stakes, like Ctrl+C
      onConfirm();
      return;
    }

    // Agent: two-step confirmation
    if (confirming) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setConfirming(false);
      onConfirm();
    } else {
      setConfirming(true);
    }
  }, [taskType, confirming, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  return (
    <button
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex shrink-0 items-center justify-center rounded transition-all duration-150',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1',
        confirming
          ? 'bg-destructive/20 text-destructive hover:bg-destructive/30 text-3xs px-1.5 py-0.5 font-medium'
          : 'text-muted-foreground/40 hover:text-destructive size-4'
      )}
      aria-label={confirming ? 'Confirm stop task' : 'Stop task'}
      tabIndex={0}
    >
      {confirming ? 'Stop?' : <X className="size-3" />}
    </button>
  );
}
