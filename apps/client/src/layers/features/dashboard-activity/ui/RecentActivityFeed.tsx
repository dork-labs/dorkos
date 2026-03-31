import { useNavigate } from '@tanstack/react-router';
import { Button, Table, TableBody } from '@/layers/shared/ui';
import { motion } from 'motion/react';
import { ActivityRow } from '@/layers/features/activity-feed-page';
import { useDashboardActivity } from '../model/use-activity-feed';

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.05 } },
} as const;

const groupFade = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2 } },
} as const;

/**
 * Recent activity feed section for the dashboard.
 * Fetches data from the server activity API (same source as the /activity page)
 * and renders a compact preview with time-grouped items.
 */
export function RecentActivityFeed() {
  const navigate = useNavigate();
  const { groups, isLoading } = useDashboardActivity();

  if (!isLoading && groups.length === 0) {
    return (
      <section>
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-widest uppercase">
          Recent Activity
        </h2>
        <div className="bg-card/50 flex items-center justify-center rounded-xl border border-dashed py-8">
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
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => navigate({ to: '/activity' })}
        >
          View all →
        </Button>
      </div>
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {groups.map((group, idx) => (
          <motion.div key={group.label} variants={groupFade}>
            <h3
              className="text-muted-foreground/70 mb-1.5 text-[11px] font-medium"
              style={idx > 0 ? { marginTop: '1rem' } : undefined}
            >
              {group.label}
            </h3>
            <Table>
              <TableBody>
                {group.items.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </TableBody>
            </Table>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
