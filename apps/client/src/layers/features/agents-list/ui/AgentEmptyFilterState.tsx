import { SearchX, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui/button';

interface AgentEmptyFilterStateProps {
  onClearFilters: () => void;
  /** Human-readable description of active filters (e.g. "status Active and search 'bot'"). */
  filterDescription?: string;
}

/**
 * Empty state shown when active filters match zero agents but the fleet has agents.
 * Prompts the user to clear their filters rather than suggesting the fleet is empty.
 */
export function AgentEmptyFilterState({
  onClearFilters,
  filterDescription,
}: AgentEmptyFilterStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <SearchX className="text-muted-foreground/50 size-10" />
      <p className="text-muted-foreground text-sm">
        {filterDescription
          ? `No agents match ${filterDescription}`
          : 'No agents match your filters'}
      </p>
      <Button variant="outline" size="sm" onClick={onClearFilters}>
        Clear filters
      </Button>
    </motion.div>
  );
}

/**
 * Empty state for when the **Team roster's** filters, not this table's own, are
 * what left it with no rows.
 *
 * Separate from {@link AgentEmptyFilterState} because it cannot offer the same
 * way out: "Clear filters" clears the FilterBar, and `?kind=`, `?owner=` and
 * `?q=` are not the FilterBar's. Offering a button that would not fix what the
 * person is looking at is the kind of small lie this page is meant not to tell,
 * so it names the control that does work instead.
 */
export function AgentRosterFilterEmpty({ peopleOnly }: { peopleOnly: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center gap-2 py-12 text-center"
      data-slot="agent-roster-filter-empty"
    >
      <Users className="text-muted-foreground/50 size-10" />
      <p className="text-muted-foreground max-w-xs text-sm">
        {peopleOnly
          ? 'This table lists agents. Switch to Cards to see the people on your team.'
          : 'No agents match what the roster is filtered to. Switch to Cards to change it.'}
      </p>
    </motion.div>
  );
}
