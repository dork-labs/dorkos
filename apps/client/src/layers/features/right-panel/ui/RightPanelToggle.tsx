import { PanelRight, PanelRightClose } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { isMac } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';
import { useAttentionItems } from '@/layers/features/dashboard-attention';
import { AttentionCountBadge } from './AttentionCountBadge';

/**
 * Compose the toggle's accessible name. Closed with pending items folds the count
 * into the label so a screen reader hears "Open right panel — 3 items need
 * attention" on focus; open (or nothing pending) stays plain — the count is
 * already visible inside the panel, so repeating it there is noise.
 */
function toggleAriaLabel(open: boolean, count: number): string {
  if (open) return 'Close right panel';
  if (count <= 0) return 'Open right panel';
  const noun = count === 1 ? 'item needs' : 'items need';
  return `Open right panel — ${count} ${noun} attention`;
}

/**
 * Toggle button for the shell-level right panel.
 *
 * Always mounted, on every route — the panel shell is load-bearing
 * infrastructure that is never route-hidden (research:
 * 20260720_context-aware-right-inspector-panels). It stays put even where no
 * contribution is currently visible; opening it then reveals an honest empty
 * state (owned by {@link RightPanelContainer}) rather than nothing. Uses the
 * same spring animation and tooltip pattern as CanvasToggle.
 *
 * It also carries the ambient {@link AttentionCountBadge}: riding the same
 * `useAttentionItems` query Pulse reads (shared cache key — no double fetch), the
 * badge ticks up while the panel is CLOSED, so the operator sees "3 things need
 * you" without opening anything. Zero items → no badge, no decoration.
 */
export function RightPanelToggle() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  // Same query key as Pulse's attention section → TanStack dedupes to one fetch.
  const { items } = useAttentionItems();
  const attentionCount = items.length;

  const Icon = rightPanelOpen ? PanelRightClose : PanelRight;
  const ariaLabel = toggleAriaLabel(rightPanelOpen, attentionCount);
  const shortcutLabel = isMac ? '⌘.' : 'Ctrl+.';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          aria-label={ariaLabel}
          className="text-muted-foreground hover:text-foreground relative flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          onClick={toggleRightPanel}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.93 }}
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
        >
          <Icon className="size-4" />
          {/* Hidden while the panel is open — the count is already on screen inside it. */}
          {!rightPanelOpen && <AttentionCountBadge count={attentionCount} />}
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="pr-2">Toggle right panel</span>
        <Kbd className="relative z-10">{shortcutLabel}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
