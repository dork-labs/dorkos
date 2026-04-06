import { useState } from 'react';

interface UseDialogTabStateOptions<T extends string> {
  /** Whether the dialog is currently open. Used to detect open transitions. */
  open: boolean;
  /** Optional pre-targeted tab. Honored each time the dialog opens. */
  initialTab: T | null;
  /** Fallback tab when no `initialTab` is set. */
  defaultTab: T;
}

/**
 * Tab state for tabbed dialogs with deep-link support.
 *
 * Uses the React-recommended "adjust state during render" pattern (not `useEffect`)
 * to sync `initialTab` into local state when the dialog opens. This avoids the
 * unnecessary re-render of the `useEffect` approach and matches the pattern
 * recommended in the React 19 docs for "deriving state from props."
 *
 * @param options.open - Whether the dialog is open
 * @param options.initialTab - Pre-targeted tab from deep link or store
 * @param options.defaultTab - Fallback tab
 * @returns `[activeTab, setActiveTab]` tuple, like `useState`
 */
export function useDialogTabState<T extends string>({
  open,
  initialTab,
  defaultTab,
}: UseDialogTabStateOptions<T>): [T, (tab: T) => void] {
  const [activeTab, setActiveTab] = useState<T>(initialTab ?? defaultTab);
  const [prevOpen, setPrevOpen] = useState(open);

  // Adjust state during render (React 19 recommended pattern)
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }

  return [activeTab, setActiveTab];
}
