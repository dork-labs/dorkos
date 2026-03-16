import { AnimatePresence, motion } from 'motion/react';
import { Info } from 'lucide-react';

interface SystemStatusZoneProps {
  message: string | null;
}

/**
 * Ephemeral system status zone — displays transient SDK status messages
 * (e.g., "Compacting context...", permission mode changes) with auto-fade.
 */
export function SystemStatusZone({ message }: SystemStatusZoneProps) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center justify-center gap-1.5 px-4 py-1"
        >
          <Info className="text-muted-foreground/60 size-3 shrink-0" />
          <span className="text-muted-foreground/60 text-xs">{message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
