/** Portable tooltip. */
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@dork-labs/ui/tooltip';

/**
 * Secondary text inside a tooltip: the tooltip's own text at 70%.
 *
 * The tooltip is inverted (dark in the light theme, light in the dark one), so
 * the page's `text-muted-foreground` reads 2.28:1 and 1.87:1 on it. This reads
 * 8.83:1 in light and 6.61:1 in dark, and still sits a step below the text
 * beside it (spec `claude-account-ui`, 04 §13).
 */
export const TOOLTIP_MUTED_TEXT = 'text-dui-background/70';
