import { motion } from 'motion/react';
import { useSubsystemStatus } from '../model/use-subsystem-status';
import { useSessionActivity } from '../model/use-session-activity';
import { tasksOutcome, relayOutcome, meshOutcome, activityOutcome } from '../lib/subsystem-copy';
import { SubsystemCard } from './SubsystemCard';
import { ActivitySparkline } from './ActivitySparkline';
import { useNavigate } from '@tanstack/react-router';
import { useTasksDeepLink, useRelayDeepLink } from '@/layers/shared/model';

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

/**
 * System Status section composing 4 subsystem cards in a responsive grid.
 * Shows Tasks, Relay, Mesh health, and a 7-day session activity sparkline.
 */
export function SystemStatusRow() {
  const status = useSubsystemStatus();
  const activityData = useSessionActivity();
  const tasksDeepLink = useTasksDeepLink();
  const relayDeepLink = useRelayDeepLink();
  const navigate = useNavigate();

  const total = activityData.reduce((sum, d) => sum + d, 0);

  const tasksDetail = status.tasks.nextRunIn ? `Next run in ${status.tasks.nextRunIn}` : undefined;

  return (
    <motion.section {...sectionEntrance}>
      <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-widest uppercase">
        System Status
      </h2>
      <motion.div
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        <motion.div variants={staggerItem}>
          <SubsystemCard
            caption="Tasks"
            outcome={tasksOutcome(status.tasks.scheduleCount)}
            detail={tasksDetail}
            exception={
              status.tasks.failedRunCount > 0
                ? { count: status.tasks.failedRunCount, label: 'failed today', severity: 'error' }
                : undefined
            }
            disabled={!status.tasks.enabled}
            onClick={() => tasksDeepLink.open()}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <SubsystemCard
            caption="Relay"
            outcome={relayOutcome(status.relay.connectedNames)}
            exception={
              status.relay.deadLetterCount > 0
                ? {
                    count: status.relay.deadLetterCount,
                    label: 'dead letters',
                    severity: 'warning',
                  }
                : undefined
            }
            disabled={!status.relay.enabled}
            onClick={() => relayDeepLink.open()}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <SubsystemCard
            caption="Mesh"
            outcome={meshOutcome(status.mesh.totalAgents)}
            exception={
              status.mesh.offlineCount > 0
                ? { count: status.mesh.offlineCount, label: 'offline', severity: 'error' }
                : undefined
            }
            onClick={() => navigate({ to: '/agents', search: { view: 'topology' } })}
          />
        </motion.div>
        {/* Activity card with sparkline */}
        <motion.div variants={staggerItem}>
          <button
            type="button"
            className="bg-card shadow-soft card-interactive flex h-full w-full cursor-pointer flex-col items-start rounded-xl border p-4 text-left"
            onClick={() => {}}
            aria-label="Session activity this week"
          >
            <p className="text-muted-foreground text-[0.65rem] font-medium tracking-widest uppercase">
              Activity
            </p>
            <p className="text-foreground mt-1 text-sm font-medium">{activityOutcome(total)}</p>
            <ActivitySparkline data={activityData} className="mt-2 h-8 w-full" />
          </button>
        </motion.div>
      </motion.div>
    </motion.section>
  );
}
