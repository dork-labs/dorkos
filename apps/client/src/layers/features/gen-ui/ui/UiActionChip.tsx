/**
 * A compact, calm chip that stands in for the raw `<ui_action>` block a widget
 * interaction injects as a user turn. Reads like a receipt of the move — a small
 * pointer glyph, the widget's title, and a human phrasing of the action — never
 * the wire XML or the payload JSON.
 *
 * @module features/gen-ui/ui/UiActionChip
 */
import { motion } from 'motion/react';
import { MousePointerClick } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useWidgetMotion, WIDGET_SPRING } from '../lib/widget-motion';
import type { ParsedUiAction } from '../lib/ui-action-parse';

/** Turn an action id (`move-1-1`, `confirm_packing`) into readable words. */
function humanizeAction(actionId: string): string {
  return actionId.replace(/[-_]+/g, ' ').trim();
}

/**
 * Render a parsed widget interaction as a chip.
 *
 * @param action - The parsed `<ui_action>` block (from `parseUiActionMessage`).
 */
export function UiActionChip({ action }: { action: ParsedUiAction }) {
  const motionOn = useWidgetMotion();
  const humanAction = humanizeAction(action.actionId);
  const srLabel = `Widget interaction${action.title ? `, ${action.title}` : ''}: ${humanAction}`;

  return (
    <motion.span
      data-testid="ui-action-chip"
      // The payload never shows by default — tuck it behind the native tooltip.
      title={action.payload ? JSON.stringify(action.payload) : undefined}
      className={cn(
        'ml-auto inline-flex w-fit items-center gap-2 rounded-full border py-1 pr-3 pl-1.5',
        'bg-muted/40 shadow-soft text-xs'
      )}
      initial={motionOn ? { opacity: 0, y: 4, scale: 0.9 } : false}
      animate={motionOn ? { opacity: 1, y: 0, scale: 1 } : false}
      transition={motionOn ? WIDGET_SPRING : undefined}
    >
      <span className="sr-only">{srLabel}</span>
      <span
        aria-hidden
        className="bg-primary/10 text-primary flex size-5 shrink-0 items-center justify-center rounded-full"
      >
        <MousePointerClick className="size-3" />
      </span>
      <span aria-hidden className="text-muted-foreground truncate">
        {action.title && <span className="text-foreground font-medium">{action.title}</span>}
        {action.title && <span className="px-1 opacity-50">·</span>}
        <span className="text-foreground font-medium">{humanAction}</span>
      </span>
    </motion.span>
  );
}
