/**
 * Map a widget {@link WidgetTone} to badge classes built from the design
 * system's status tokens, so tones read consistently in light and dark.
 *
 * @module features/gen-ui/lib/widget-tone
 */
import type { WidgetTone } from '@dorkos/shared/ui-widget';

const TONE_BADGE_CLASSES: Record<WidgetTone, string> = {
  default: 'bg-secondary text-secondary-foreground border-transparent',
  success: 'bg-status-success-bg text-status-success-fg border-status-success-border',
  warning: 'bg-status-warning-bg text-status-warning-fg border-status-warning-border',
  error: 'bg-status-error-bg text-status-error-fg border-status-error-border',
  info: 'bg-status-info-bg text-status-info-fg border-status-info-border',
};

/**
 * Return the border/background/foreground classes for a badge of the given tone.
 *
 * @param tone - The widget tone (defaults to `default`)
 */
export function toneBadgeClass(tone?: WidgetTone): string {
  return TONE_BADGE_CLASSES[tone ?? 'default'];
}
