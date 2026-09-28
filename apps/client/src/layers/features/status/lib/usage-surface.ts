/**
 * What the usage detail is painted on, and the muted text that reads on it.
 *
 * @module features/status/lib/usage-surface
 */
import { TOOLTIP_MUTED_TEXT } from '@/layers/shared/ui';

/**
 * `panel` is a popover or panel on the page's own colors. `tooltip` is the
 * shared tooltip, which is inverted: dark in the light theme, light in the dark
 * one, so the page's muted gray reads 2.28:1 and 1.87:1 on it.
 */
export type UsageSurface = 'panel' | 'tooltip';

/**
 * The secondary text color for each surface: labels, notes and the "as of"
 * line. On the tooltip it is the tooltip's own text at 70%, which reads 8.83:1
 * in light and 6.61:1 in dark, and still sits a step below the values beside
 * it (04 §13).
 */
export const MUTED_TEXT: Record<UsageSurface, string> = {
  panel: 'text-muted-foreground',
  tooltip: TOOLTIP_MUTED_TEXT,
};
