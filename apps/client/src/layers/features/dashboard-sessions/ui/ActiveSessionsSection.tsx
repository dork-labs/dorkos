import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui';
import { motion } from 'motion/react';
import { useActiveSessions } from '../model/use-active-sessions';
import { ActiveSessionCard } from './ActiveSessionCard';

const sectionEntrance = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: 'easeOut' },
} as const;

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
} as const;

/** Dashboard section showing recently active sessions in a responsive grid. */
export function ActiveSessionsSection() {
  const navigate = useNavigate();
  const { sessions, totalCount } = useActiveSessions();

  return (
    <motion.section {...sectionEntrance}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
          Active Now
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => navigate({ to: '/session' })}
        >
          New session →
        </Button>
      </div>

      {sessions.length === 0 ? (
        <div className="bg-card/50 flex flex-col items-center justify-center rounded-xl border border-dashed py-12">
          <p className="text-muted-foreground text-sm">No active sessions</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-6 text-xs"
            onClick={() => navigate({ to: '/session' })}
          >
            New session →
          </Button>
        </div>
      ) : (
        <>
          <motion.div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {sessions.map((session, idx) => (
              <motion.div key={session.id} variants={idx < 8 ? staggerItem : undefined}>
                <ActiveSessionCard session={session} />
              </motion.div>
            ))}
          </motion.div>
          {totalCount > 6 && (
            <button
              className="text-muted-foreground hover:text-foreground mt-2 text-xs transition-colors"
              onClick={() => navigate({ to: '/session' })}
            >
              and {totalCount - 6} more active →
            </button>
          )}
        </>
      )}
    </motion.section>
  );
}
