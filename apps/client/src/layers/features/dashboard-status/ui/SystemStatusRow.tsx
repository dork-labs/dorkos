import { motion } from 'motion/react';
import { useSubsystemStatus } from '../model/use-subsystem-status';
import { useSessionActivity } from '../model/use-session-activity';
import { SubsystemCard } from './SubsystemCard';
import { ActivitySparkline } from './ActivitySparkline';
import { useAppStore } from '@/layers/shared/model';

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
 * Shows Pulse, Relay, Mesh health, and a 7-day session activity sparkline.
 */
export function SystemStatusRow() {
  const status = useSubsystemStatus();
  const activityData = useSessionActivity();
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);
  const setRelayOpen = useAppStore((s) => s.setRelayOpen);
  const setMeshOpen = useAppStore((s) => s.setMeshOpen);

  const total = activityData.reduce((sum, d) => sum + d, 0);

  const pulseSecondary = status.pulse.nextRunIn ? `Next: ${status.pulse.nextRunIn}` : undefined;
  const relaySecondary =
    status.relay.connectedNames.length > 0 ? status.relay.connectedNames.join(' · ') : undefined;

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
            title="Pulse"
            primaryMetric={`${status.pulse.scheduleCount} schedule${status.pulse.scheduleCount !== 1 ? 's' : ''}`}
            secondaryInfo={pulseSecondary}
            exception={
              status.pulse.failedRunCount > 0
                ? { count: status.pulse.failedRunCount, label: 'failed today', severity: 'error' }
                : undefined
            }
            disabled={!status.pulse.enabled}
            onClick={() => setPulseOpen(true)}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <SubsystemCard
            title="Relay"
            primaryMetric={`${status.relay.adapterCount} adapter${status.relay.adapterCount !== 1 ? 's' : ''}`}
            secondaryInfo={relaySecondary}
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
            onClick={() => setRelayOpen(true)}
          />
        </motion.div>
        <motion.div variants={staggerItem}>
          <SubsystemCard
            title="Mesh"
            primaryMetric={`${status.mesh.totalAgents} agent${status.mesh.totalAgents !== 1 ? 's' : ''}`}
            exception={
              status.mesh.offlineCount > 0
                ? { count: status.mesh.offlineCount, label: 'offline', severity: 'error' }
                : undefined
            }
            onClick={() => setMeshOpen(true)}
          />
        </motion.div>
        {/* Activity card with sparkline */}
        <motion.div variants={staggerItem}>
          <button
            type="button"
            className="bg-card shadow-soft card-interactive w-full cursor-pointer rounded-xl border p-4 text-left"
            onClick={() => {}}
            aria-label="Session activity this week"
          >
            <p className="text-foreground text-sm font-medium">Activity</p>
            <p className="text-muted-foreground mt-1 text-xs">{total} this week</p>
            <ActivitySparkline data={activityData} className="mt-2 h-8 w-full" />
          </button>
        </motion.div>
      </motion.div>
    </motion.section>
  );
}
