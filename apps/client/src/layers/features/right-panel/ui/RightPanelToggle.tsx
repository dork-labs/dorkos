import { PanelRight, PanelRightClose } from 'lucide-react';
import { motion } from 'motion/react';
import { useRouterState } from '@tanstack/react-router';
import { useAppStore, useSlotContributions } from '@/layers/shared/model';
import { isMac } from '@/layers/shared/lib';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';

/**
 * Toggle button for the shell-level right panel.
 *
 * Hides itself when no contributions are visible on the current route.
 * Uses the same spring animation and tooltip pattern as CanvasToggle.
 */
export function RightPanelToggle() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const allContributions = useSlotContributions('right-panel');
  const visibleContributions = allContributions.filter(
    (c) => !c.visibleWhen || c.visibleWhen({ pathname })
  );

  // Hide when there is nothing to show on this route
  if (visibleContributions.length === 0) return null;

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
        <span>Toggle right panel</span>
        <Kbd>{shortcutLabel}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
