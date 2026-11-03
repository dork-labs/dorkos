/** Portable tooltip. */
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@dork-labs/ui/tooltip';
export type { TooltipProps } from '@dork-labs/ui/tooltip';

/**
 * Secondary text inside a tooltip: the tooltip's own text at 70%.
 *
 * The tooltip has its own dark chip in both themes, so the page's
 * `text-muted-foreground` is the wrong ink on it. This still sits a step below the
 * text beside it (spec `claude-account-ui`, 04 §13).
 */
export const TOOLTIP_MUTED_TEXT = 'text-dui-tooltip-foreground/70';
