import { PanelRight, PanelRightClose } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { isMac } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';

/**
 * Toggle button for the shell-level right panel.
 *
 * Always mounted, on every route — the panel shell is load-bearing
 * infrastructure that is never route-hidden (research:
 * 20260720_context-aware-right-inspector-panels). It stays put even where no
 * contribution is currently visible; opening it then reveals an honest empty
 * state (owned by {@link RightPanelContainer}) rather than nothing. Uses the
 * same spring animation and tooltip pattern as CanvasToggle.
 */
export function RightPanelToggle() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);

  const Icon = rightPanelOpen ? PanelRightClose : PanelRight;
  const ariaLabel = rightPanelOpen ? 'Close right panel' : 'Open right panel';
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
        </motion.button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="pr-2">Toggle right panel</span>
        <Kbd className="relative z-10">{shortcutLabel}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
