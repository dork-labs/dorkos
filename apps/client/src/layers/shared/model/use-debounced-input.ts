import { useState, useCallback, useRef, useEffect } from 'react';

const DEFAULT_DELAY = 500;

/**
 * Hook for debounced text input with flush-on-blur and reset-on-key-change.
 *
 * Manages local state for a text input that debounces commits to a server
 * callback. Automatically resets local state when `resetKey` changes (e.g.,
 * when a different agent is loaded) and flushes pending changes on blur.
 *
 * @param serverValue - The current value from the server (used for reset and blur comparison)
 * @param resetKey - When this changes, local state resets to serverValue (e.g., agent.id)
 * @param onCommit - Called with the current value after the debounce delay or on blur
 * @param delay - Debounce delay in milliseconds (default 500)
 */
export function useDebouncedInput(
  serverValue: string,
  resetKey: string,
  onCommit: (value: string) => void,
  delay = DEFAULT_DELAY
): { value: string; onChange: (v: string) => void; onBlur: () => void } {
  const [value, setValue] = useState(serverValue);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset local state when a different entity is loaded
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting local input state when a different entity is loaded
    setValue(serverValue);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onChange = useCallback(
    (newValue: string) => {
      setValue(newValue);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onCommit(newValue), delay);
    },
    [onCommit, delay]
  );

  const onBlur = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (value !== serverValue) {
      onCommit(value);
    }
  }, [value, serverValue, onCommit]);

  return { value, onChange, onBlur };
}
