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
  /** Index of the currently keyboard-focused option (for question prompts). */
  focusedOptionIndex: number;
}

/**
 * Wire keyboard shortcuts to the active interactive tool card (approval or question prompt).
 *
 * Extracts shortcut plumbing out of ChatPanel so the component only needs to pass
 * `handleToolRef` and `focusedOptionIndex` down to MessageList.
 */
export function useToolShortcuts(
  activeInteraction: ActiveInteraction | null
): UseToolShortcutsReturn {
  const activeToolHandleRef = useRef<InteractiveToolHandle | null>(null);
  const [focusedOptionIndex, setFocusedOptionIndex] = useState(0);
  const [activeOptionCount, setActiveOptionCount] = useState(0);

  const handleToolRef = useCallback((handle: InteractiveToolHandle | null) => {
    activeToolHandleRef.current = handle;
    setActiveOptionCount(handle && 'getOptionCount' in handle ? handle.getOptionCount() : 0);
  }, []);

  useEffect(() => {
    setFocusedOptionIndex(0);
    setActiveOptionCount(0);
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

  const onDeny = useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'deny' in handle) handle.deny();
  }, []);

  const onToggleOption = useCallback((index: number) => {
    const handle = activeToolHandleRef.current;
    if (handle && 'toggleOption' in handle) {
      handle.toggleOption(index);
      setFocusedOptionIndex(index);
    }
  }, []);

  const onNavigateOption = useCallback((direction: 'up' | 'down') => {
    setFocusedOptionIndex((prev) => {
      const handle = activeToolHandleRef.current;
      const count = handle && 'getOptionCount' in handle ? handle.getOptionCount() : 0;
      if (count === 0) return prev;
      if (direction === 'up') return prev <= 0 ? count - 1 : prev - 1;
      return prev >= count - 1 ? 0 : prev + 1;
    });
  }, []);

  const onNavigateQuestion = useCallback((direction: 'prev' | 'next') => {
    const handle = activeToolHandleRef.current;
    if (handle && 'navigateQuestion' in handle) {
      handle.navigateQuestion(direction);
      setFocusedOptionIndex(0);
      setActiveOptionCount(handle.getOptionCount());
    }
  }, []);

  const onSubmit = useCallback(() => {
    const handle = activeToolHandleRef.current;
    if (handle && 'submit' in handle) handle.submit();
  }, []);

  useInteractiveShortcuts({
    activeInteraction: activeInteractionForShortcuts,
    onApprove,
    onDeny,
    onToggleOption,
    onNavigateOption,
    onNavigateQuestion,
    onSubmit,
    optionCount: activeOptionCount,
    focusedIndex: focusedOptionIndex,
  });

  return { handleToolRef, focusedOptionIndex };
}
