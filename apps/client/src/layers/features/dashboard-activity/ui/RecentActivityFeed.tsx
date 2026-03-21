import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui';
import { motion } from 'motion/react';
import { useActivityFeed } from '../model/use-activity-feed';
import { useLastVisited } from '../model/use-last-visited';
import { ActivityFeedGroup } from './ActivityFeedGroup';

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.03 } },
} as const;

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2 } },
} as const;

/**
 * Recent activity feed section — time-grouped list of session and Pulse run events.
 * Capped at 20 items. Tracks last visit via localStorage to highlight new events.
 * Shows a "View all →" link when more than 20 events exist.
 */
export function RecentActivityFeed() {
  const navigate = useNavigate();
  const { groups, totalCount } = useActivityFeed();
  const lastVisitedAt = useLastVisited();

  if (groups.length === 0) {
    return (
      <section>
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-widest uppercase">
          Recent Activity
        </h2>
        <div className="bg-card/50 flex items-center justify-center rounded-xl border border-dashed py-12">
          <p className="text-muted-foreground text-sm">
            No activity yet. Your agent history will appear here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          Recent Activity
        </h2>
        {totalCount > 20 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => navigate({ to: '/session' })}
          >
            View all →
          </Button>
        )}
      </div>
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {groups.map((group, idx) => (
          <motion.div key={group.label} variants={staggerItem}>
            <ActivityFeedGroup
              group={group}
              lastVisitedAt={lastVisitedAt}
              showSeparator={idx === 0}
            />
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
