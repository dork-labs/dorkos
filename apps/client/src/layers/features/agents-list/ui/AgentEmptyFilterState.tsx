import { SearchX } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui/button';

interface AgentEmptyFilterStateProps {
  onClearFilters: () => void;
}

/**
 * Empty state shown when active filters match zero agents but the fleet has agents.
 * Prompts the user to clear their filters rather than suggesting the fleet is empty.
 */
export function AgentEmptyFilterState({ onClearFilters }: AgentEmptyFilterStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <SearchX className="text-muted-foreground/50 size-10" />
      <p className="text-muted-foreground text-sm">No agents match your filters</p>
      <Button variant="outline" size="sm" onClick={onClearFilters}>
        Clear filters
      </Button>
    </motion.div>
  );
}
