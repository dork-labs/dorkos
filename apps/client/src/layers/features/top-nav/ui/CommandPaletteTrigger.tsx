import { Search } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppStore } from '@/layers/shared/model';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Search icon button that opens the global command palette.
 *
 * Displays a tooltip with the keyboard shortcut (Cmd+K on Mac, Ctrl+K elsewhere)
 * to help users discover the shortcut. Located at the right edge of the header.
 */
export function CommandPaletteTrigger() {
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          onClick={() => setGlobalPaletteOpen(true)}
          className="text-muted-foreground hover:text-foreground flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.93 }}
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
          aria-label="Open command palette"
        >
          <Search className="size-4" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Search <Kbd>{isMac ? '⌘K' : 'Ctrl+K'}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
