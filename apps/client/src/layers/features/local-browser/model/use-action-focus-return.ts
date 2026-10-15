import { useEffect, useRef } from 'react';

/** Return focus after a removed action, unless the person has moved on to another control or page. */
export function useActionFocusReturn(waiting: boolean) {
  const openButton = useRef<HTMLButtonElement>(null);
  const intent = useRef<{ action: HTMLElement; interrupted: boolean } | null>(null);
  const rememberFocus = (action: HTMLElement) => {
    intent.current = document.activeElement === action ? { action, interrupted: false } : null;
  };
  useEffect(() => {
    const moved = (event: Event) => {
      const pending = intent.current;
      if (
        pending &&
        event.target !== pending.action &&
        !(event.type === 'focusin' && event.target === document.body)
      ) {
        pending.interrupted = true;
      }
    };
    const blurred = () => {
      if (intent.current) intent.current.interrupted = true;
    };
    document.addEventListener('pointerdown', moved, true);
    document.addEventListener('keydown', moved, true);
    document.addEventListener('focusin', moved, true);
    window.addEventListener('blur', blurred);
    return () => {
      intent.current = null;
      document.removeEventListener('pointerdown', moved, true);
      document.removeEventListener('keydown', moved, true);
      document.removeEventListener('focusin', moved, true);
      window.removeEventListener('blur', blurred);
    };
  }, []);
  useEffect(() => {
    if (waiting || !intent.current) return;
    const pending = intent.current;
    intent.current = null;
    if (!pending.interrupted && document.activeElement === document.body && document.hasFocus()) {
      const target = openButton.current;
      if (target && !target.disabled) target.focus();
    }
  }, [waiting]);
  return { openButton, rememberFocus };
}
