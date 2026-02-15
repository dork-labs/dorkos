import { useEffect, useRef } from 'react';

interface UseInteractiveShortcutsOptions {
  /** The currently active interactive tool, or null */
  activeInteraction: {
    type: 'approval' | 'question';
    toolCallId: string;
  } | null;
  /** Callbacks for approval shortcuts */
  onApprove?: () => void;
  onDeny?: () => void;
  /** Callbacks for question shortcuts */
  onToggleOption?: (index: number) => void;
  onNavigateOption?: (direction: 'up' | 'down') => void;
  onNavigateQuestion?: (direction: 'prev' | 'next') => void;
  onSubmit?: () => void;
  /** Total options count for bounds checking */
  optionCount?: number;
  /** Current focused option index */
  focusedIndex?: number;
}

export function useInteractiveShortcuts({
  activeInteraction,
  onApprove,
  onDeny,
  onToggleOption,
  onNavigateOption,
  onNavigateQuestion,
  onSubmit,
  optionCount = 0,
  focusedIndex = 0,
}: UseInteractiveShortcutsOptions) {
  const respondingRef = useRef(false);

  // Reset responding flag when active interaction changes
  useEffect(() => {
    respondingRef.current = false;
  }, [activeInteraction?.toolCallId]);

  useEffect(() => {
    if (!activeInteraction) return;

    function handler(e: KeyboardEvent) {
      // If target is an enabled textarea or input, only handle Enter/Esc
      const target = e.target as HTMLElement;
      const isTextInput =
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') &&
        !(target as HTMLInputElement).disabled;

      if (respondingRef.current) return;

      if (activeInteraction!.type === 'approval') {
        if (e.key === 'Enter') {
          e.preventDefault();
          respondingRef.current = true;
          onApprove?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          respondingRef.current = true;
          onDeny?.();
        }
        return;
      }

      if (activeInteraction!.type === 'question') {
        // In text input, only Enter/Esc work
        if (isTextInput) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.();
          }
          return;
        }

        // Digit keys 1-9 toggle option
        const digit = parseInt(e.key, 10);
        if (digit >= 1 && digit <= 9) {
          e.preventDefault();
          if (digit - 1 < optionCount) {
            onToggleOption?.(digit - 1);
          }
          return;
        }

        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault();
            onNavigateOption?.('up');
            break;
          case 'ArrowDown':
            e.preventDefault();
            onNavigateOption?.('down');
            break;
          case ' ':
            e.preventDefault();
            onToggleOption?.(focusedIndex);
            break;
          case 'ArrowLeft':
          case '[':
            e.preventDefault();
            onNavigateQuestion?.('prev');
            break;
          case 'ArrowRight':
          case ']':
            e.preventDefault();
            onNavigateQuestion?.('next');
            break;
          case 'Enter':
            e.preventDefault();
            onSubmit?.();
            break;
        }
      }
    }

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    activeInteraction,
    onApprove,
    onDeny,
    onToggleOption,
    onNavigateOption,
    onNavigateQuestion,
    onSubmit,
    optionCount,
    focusedIndex,
  ]);
}
