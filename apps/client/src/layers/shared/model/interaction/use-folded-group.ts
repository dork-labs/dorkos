import { useState } from 'react';
import { readBool, writeBool } from '../app-store/app-store-helpers';

/** Options for {@link useFoldedGroup}. */
interface UseFoldedGroupOptions {
  /** localStorage key that remembers, per viewer, whether the group is open. */
  storageKey: string;
  /** Whether the dialog holding the group is open. */
  dialogOpen: boolean;
  /** True when the dialog's active tab is one of the group's own tabs. */
  activeInGroup: boolean;
  /** The dialog's active tab id. */
  activeTab: string;
}

/**
 * Open/closed state for a sidebar group that starts folded ("Advanced").
 *
 * Three rules, in this order:
 *
 * 1. Each time the dialog opens, the group starts the way this viewer last
 *    left it — folded by default, and remembered in localStorage only when the
 *    viewer presses the toggle themselves.
 * 2. Landing on one of the group's tabs unfolds it — a `?settings=` link to a
 *    folded tab, or a reopen while one is still the active tab. A selected tab
 *    hidden behind a closed fold reads as a dialog with nothing selected. That reveal is NOT
 *    remembered: following a link once is not a decision to keep the group
 *    open.
 * 3. The reveal fires once per arrival, so a viewer can still fold the group
 *    away while one of its tabs is showing; the panel stays put.
 *
 * Uses the "adjust state during render" pattern (as `useDialogTabState` does)
 * so a deep-linked tab never paints one frame behind a closed fold.
 *
 * @param options - See {@link UseFoldedGroupOptions}.
 * @returns `[expanded, setExpanded]`; `setExpanded` remembers the choice.
 */
export function useFoldedGroup({
  storageKey,
  dialogOpen,
  activeInGroup,
  activeTab,
}: UseFoldedGroupOptions): [boolean, (expanded: boolean) => void] {
  const [expanded, setExpandedState] = useState(() => readBool(storageKey, false));
  const [prevDialogOpen, setPrevDialogOpen] = useState(dialogOpen);
  // The arrival this fold has already answered: the active tab while it is one
  // of the group's, null otherwise. A new value is a new arrival.
  const arrival = dialogOpen && activeInGroup ? activeTab : null;
  const [prevArrival, setPrevArrival] = useState<string | null>(null);

  let next = expanded;
  if (dialogOpen !== prevDialogOpen) {
    setPrevDialogOpen(dialogOpen);
    if (dialogOpen) next = readBool(storageKey, false);
  }
  if (arrival !== prevArrival) {
    setPrevArrival(arrival);
    if (arrival !== null) next = true;
  }
  if (next !== expanded) setExpandedState(next);

  const setExpanded = (value: boolean) => {
    writeBool(storageKey, value);
    setExpandedState(value);
  };

  return [next, setExpanded];
}
