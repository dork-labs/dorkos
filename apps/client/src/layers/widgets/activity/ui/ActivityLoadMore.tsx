import { Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

export interface ActivityLoadMoreProps {
  /** Called when the user clicks "Load more". */
  onLoadMore: () => void;
  /** When true the button shows a spinner and is disabled. */
  isFetching: boolean;
  /** When true there are no more pages — button is hidden. */
  hasNextPage: boolean;
  className?: string;
}

/**
 * "Load more events" control for the activity feed.
 *
 * Renders nothing when there are no more pages. Shows a spinner
 * while a page is being fetched.
 */
export function ActivityLoadMore({
  onLoadMore,
  isFetching,
  hasNextPage,
  className,
}: ActivityLoadMoreProps) {
  if (!hasNextPage) return null;

  return (
    <motion.div
      data-slot="activity-load-more"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, delay: 0.1 }}
      className={cn('flex justify-center py-4', className)}
    >
      <Button
        variant="outline"
        size="sm"
        onClick={onLoadMore}
        disabled={isFetching}
        className="gap-2"
      >
        {isFetching && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        Load 50 more events
      </Button>
    </motion.div>
  );
}
