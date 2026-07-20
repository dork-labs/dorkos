import type { ReactNode } from 'react';
import type { BannerVariant } from '@/layers/shared/ui';

/**
 * Numeric priority for the app banner severity ladder. Higher wins. The slot
 * shows the single highest-priority eligible banner and never stacks, so these
 * values decide which standing condition a user sees when several are active.
 */
export const BANNER_PRIORITY: Record<BannerVariant, number> = {
  critical: 40,
  warning: 30,
  info: 20,
  neutral: 10,
};

/**
 * Describes one candidate banner contributed to the global slot. A feature's
 * descriptor hook returns this when its banner is eligible, or `null` when it is
 * not. The slot ranks descriptors by {@link BannerDescriptor.priority} and
 * renders only the winner.
 */
export interface BannerDescriptor {
  /** Stable identity — drives the slot's exit-before-enter swap key. */
  id: string;
  /** Higher wins. Use {@link BANNER_PRIORITY} for the standard severity ladder. */
  priority: number;
  /** Severity, mirroring the rendered banner's variant. */
  variant: BannerVariant;
  /** Renders the `<Banner>` element for this descriptor. */
  render: () => ReactNode;
}
