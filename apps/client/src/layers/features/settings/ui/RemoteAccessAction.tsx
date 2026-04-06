import { Globe, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';

/** Sidebar action that opens the Remote Access dialog instead of navigating to a panel. */
export function RemoteAccessAction({ onClick }: { onClick: () => void }) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <motion.button
        onClick={onClick}
        whileTap={{ scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors',
          'hover:bg-muted/50 active:bg-muted min-h-[44px]'
        )}
      >
        <Globe className="text-muted-foreground size-(--size-icon-sm) shrink-0" />
        <span className="flex-1">Remote Access</span>
        <ChevronRight className="text-muted-foreground/40 size-(--size-icon-sm) shrink-0" />
      </motion.button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground hover:bg-muted/50 relative mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150"
    >
      <span className="relative z-10 flex items-center gap-2">
        <Globe className="size-(--size-icon-sm) shrink-0" />
        Remote Access
      </span>
    </button>
  );
}
