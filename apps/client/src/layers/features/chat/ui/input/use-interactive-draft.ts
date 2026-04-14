import { useRef, useEffect } from 'react';
import type { ToolCallState } from '../../model/chat-types';

/**
 * Preserve the user's draft text when switching to/from interactive mode.
 *
 * Saves input to a ref on entering interactive mode and restores it on exit,
 * so the user doesn't lose their in-progress message.
 */
export function useInteractiveDraft(
  activeInteraction: ToolCallState | null,
  input: string,
  setInput: (value: string) => void
) {
  const draftRef = useRef('');

  useEffect(() => {
    if (activeInteraction) {
      draftRef.current = input;
    }
    // Only trigger when the active tool call changes, not on every input keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInteraction?.toolCallId]);

  useEffect(() => {
    if (!activeInteraction && draftRef.current) {
      setInput(draftRef.current);
      draftRef.current = '';
    }
  }, [activeInteraction, setInput]);
}
