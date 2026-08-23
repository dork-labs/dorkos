import type { ReactNode } from 'react';

/**
 * Numeric priority ladder for one-time moments. Higher wins. The host shows the
 * single highest-priority eligible moment and never stacks, so these values
 * decide which question a user is asked on the one launch that asks anything.
 *
 * Two rungs, deliberately far apart: a door the user must answer before the app
 * is honest about what it will do, and an invitation they may ignore. Anything
 * new slots between them without renumbering.
 */
export const MOMENT_PRIORITY = {
  /** Consent doors — the app is asking permission for something it will do. */
  high: 30,
  /** Invitations — nothing changes if the user never answers. */
  low: 10,
} as const;

/**
 * Describes one candidate one-time modal contributed to the moments rail. A
 * descriptor hook returns this when its moment is eligible, or `null` when it is
 * not — eligibility lives in the hook, never on the object, so an ineligible
 * moment is absent from the collector's array rather than sitting in it where it
 * could occupy the winning slot.
 */
export interface MomentDescriptor {
  /** Stable identity — drives the host's render key. */
  id: string;
  /** Higher wins. Use {@link MOMENT_PRIORITY}. */
  priority: number;
  /**
   * Renders the modal body; the host owns the dialog and its open/close state.
   *
   * A pure factory: the component it returns owns its own state. The host keeps
   * the last descriptor alive briefly so the modal can animate closed, so a
   * `render` that read live values out of its closure would show stale ones on
   * the way out.
   *
   * @param props - Handed the host's `onClose` for a moment with its own
   *   "not now" affordance. The dialog's own dismiss controls call it too.
   */
  render: (props: { onClose: () => void }) => ReactNode;
}
