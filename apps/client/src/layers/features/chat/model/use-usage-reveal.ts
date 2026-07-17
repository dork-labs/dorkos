/**
 * Client-only reveal state for the usage & cost surface (the `/context` intent).
 *
 * Typing `/context` (or an alias like `/usage`, `/status`) is a DorkOS-native
 * action that pins open the runtime-neutral usage & cost detail (DOR-100) so a
 * keyboard user sees utilization + cost without hovering the status-bar item —
 * identical on every runtime, no message sent (DOR-109). This tiny store is the
 * signal between the native-command executor and the status bar that renders it.
 *
 * @module features/chat/model/use-usage-reveal
 */
import { create } from 'zustand';

interface UsageRevealState {
  /** Whether the usage & cost detail is pinned open. */
  open: boolean;
  /** Set the pinned-open state (the status bar's popover onOpenChange). */
  setOpen: (open: boolean) => void;
  /** Reveal (pin open) the usage & cost surface — the `/context` native action. */
  reveal: () => void;
}

/** Store backing the `/context` usage & cost reveal. */
export const useUsageReveal = create<UsageRevealState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  reveal: () => set({ open: true }),
}));
