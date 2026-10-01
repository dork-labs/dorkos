import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { useInteractiveShortcuts } from '@/layers/shared/model';
import type { InteractiveToolHandle } from '../ui/message';

interface ActiveInteraction {
  interactiveType?: string;
  toolCallId: string;
}

interface UseToolShortcutsReturn {
  /** Ref callback to attach to the currently active interactive tool card. */
  handleToolRef: (handle: InteractiveToolHandle | null) => void;
  /**
   * Index of the keyboard-focused option (for question prompts), or -1 until the
   * person has used a shortcut on this interaction.
   */
  focusedOptionIndex: number;
}

/**
 * Wire keyboard shortcuts to the active interactive tool card (approval or question prompt).
 *
 * Extracts shortcut plumbing out of ChatPanel so the component only needs to pass
 * `handleToolRef` and `focusedOptionIndex` down to the transcript.
 */
export function useToolShortcuts(
  activeInteraction: ActiveInteraction | null
): UseToolShortcutsReturn {
  const activeToolHandleRef = useRef<InteractiveToolHandle | null>(null);
  const [focusedOptionIndex, setFocusedOptionIndex] = useState(0);
  // The option cursor is shown only once a shortcut has been used here — the
  // same promise `:focus-visible` makes. It always starts at the first option,
  // and a solid focus ring (DOR-2615) drawn there before anyone touched the
  // keyboard read as an answer already picked, to a mouse user most of all.
  const [keyboardEngaged, setKeyboardEngaged] = useState(false);
  const [activeOptionCount, setActiveOptionCount] = useState(0);

  const handleToolRef = useCallback((handle: InteractiveToolHandle | null) => {
    activeToolHandleRef.current = handle;
    setActiveOptionCount(handle && 'getOptionCount' in handle ? handle.getOptionCount() : 0);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting keyboard navigation state when active tool changes
    setFocusedOptionIndex(0);
    setActiveOptionCount(0);
    setKeyboardEngaged(false);
  }, [activeInteraction?.toolCallId]);

  const activeInteractionForShortcuts = useMemo(() => {
    if (!activeInteraction?.interactiveType) return null;
    return {
      type: activeInteraction.interactiveType as 'approval' | 'question',
      toolCallId: activeInteraction.toolCallId,
    };
  }, [activeInteraction]);

  const onApprove = useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'approve' in handle) handle.approve();
  }, []);

  const onAlwaysAllow = useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'alwaysAllow' in handle) handle.alwaysAllow();
  }, []);

  const onDeny = useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'deny' in handle) handle.deny();
  }, []);

  const onToggleOption = useCallback((index: number) => {
    const handle = activeToolHandleRef.current;
    if (handle && 'toggleOption' in handle) {
      handle.toggleOption(index);
      setFocusedOptionIndex(index);
      setKeyboardEngaged(true);
    }
  }, []);

  const onNavigateOption = useCallback(
    (direction: 'up' | 'down') => {
      // While the cursor is hidden, the first arrow key only reveals it at its
      // current (unmoved) index — otherwise the reveal and a move happened in
      // the same keypress, so ArrowDown looked like it skipped option 1 and
      // ArrowUp looked like it jumped to the last option (DOR-2617).
      if (!keyboardEngaged) {
        setKeyboardEngaged(true);
        return;
      }
      setFocusedOptionIndex((prev) => {
        const handle = activeToolHandleRef.current;
        const count = handle && 'getOptionCount' in handle ? handle.getOptionCount() : 0;
        if (count === 0) return prev;
        if (direction === 'up') return prev <= 0 ? count - 1 : prev - 1;
        return prev >= count - 1 ? 0 : prev + 1;
      });
    },
    [keyboardEngaged]
  );

  const onNavigateQuestion = useCallback((direction: 'prev' | 'next') => {
    const handle = activeToolHandleRef.current;
    if (handle && 'navigateQuestion' in handle) {
      handle.navigateQuestion(direction);
      setFocusedOptionIndex(0);
      setKeyboardEngaged(true);
      setActiveOptionCount(handle.getOptionCount());
    }
  }, []);

  const onSubmit = useCallback(() => {
    // Unlike the arrows, Enter never reads the hidden cursor: the card's own
    // submit() advances tabs and submits selections, which are tracked
    // separately from focusedOptionIndex (QuestionPrompt.tsx). Gating this on
    // keyboardEngaged would swallow Enter on a single-question or last-tab
    // ask, and in the free-text "Other" field.
    const handle = activeToolHandleRef.current;
    if (handle && 'submit' in handle) handle.submit();
  }, []);

  useInteractiveShortcuts({
    activeInteraction: activeInteractionForShortcuts,
    onApprove,
    onAlwaysAllow,
    onDeny,
    onToggleOption,
    onNavigateOption,
    onNavigateQuestion,
    onSubmit,
    optionCount: activeOptionCount,
    focusedIndex: focusedOptionIndex,
  });

  return { handleToolRef, focusedOptionIndex: keyboardEngaged ? focusedOptionIndex : -1 };
}
