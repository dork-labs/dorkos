import { usePulseEnabled, useSchedules, useRuns } from '@/layers/entities/pulse';
import {
  useRelayEnabled,
  useRelayAdapters,
  useAggregatedDeadLetters,
} from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';

/** Derived health data for the Pulse scheduler subsystem. */
interface PulseStatus {
  enabled: boolean;
  scheduleCount: number;
  /** Relative time until next scheduled run, e.g. "47m" or "2h". Null if no schedules. */
  nextRunIn: string | null;
  /** Count of failed runs in the last 24 hours. */
  failedRunCount: number;
}

/** Derived health data for the Relay message bus subsystem. */
interface RelayStatus {
  enabled: boolean;
  adapterCount: number;
  /** Display names of connected adapters. */
  connectedNames: string[];
  deadLetterCount: number;
}

/** Derived health data for the Mesh agent registry subsystem. */
interface MeshStatusDerived {
  totalAgents: number;
  /** Count of unreachable/offline agents. */
  offlineCount: number;
}

/** Aggregated subsystem health derived from entity hooks. */
export interface SubsystemStatus {
  pulse: PulseStatus;
  relay: RelayStatus;
  mesh: MeshStatusDerived;
}

/** Relative time formatting constants. */
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Format a future timestamp as a relative time string (e.g. "47m", "2h"). */
function formatNextRunIn(nextRun: string): string | null {
  const diff = new Date(nextRun).getTime() - Date.now();
  if (diff <= 0) return null;
  if (diff < MS_PER_HOUR) return `${Math.floor(diff / MS_PER_MINUTE)}m`;
  if (diff < MS_PER_DAY) return `${Math.floor(diff / MS_PER_HOUR)}h`;
  return `${Math.floor(diff / MS_PER_DAY)}d`;
}

/**
 * Derive subsystem health from existing entity hooks.
 * Returns disabled state for Pulse/Relay when their feature flag is off.
 */
export function useSubsystemStatus(): SubsystemStatus {
  const pulseEnabled = usePulseEnabled();
  const { data: schedules } = useSchedules(pulseEnabled);
  const { data: failedRuns } = useRuns({ status: 'failed' }, pulseEnabled);
  const relayEnabled = useRelayEnabled();
  const { data: adapters } = useRelayAdapters(relayEnabled);
  const { data: deadLetters } = useAggregatedDeadLetters(relayEnabled);
  const { data: meshStatus } = useMeshStatus();

  // Pulse: find earliest next run across all enabled schedules
  const now = Date.now();
  const twentyFourHoursAgo = now - MS_PER_DAY;

  const nextRunIn = (() => {
    if (!schedules) return null;
    const nextRunTimes = schedules
      .filter((s) => s.nextRun != null)
      .map((s) => new Date(s.nextRun!).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b);
    if (nextRunTimes.length === 0) return null;
    return formatNextRunIn(new Date(nextRunTimes[0]).toISOString());
  })();

  const failedRunCount = failedRuns
    ? failedRuns.filter((r) => new Date(r.createdAt).getTime() > twentyFourHoursAgo).length
    : 0;

  // Relay: collect connected adapter names and total dead letter count
  const connectedNames = adapters
    ? adapters.filter((a) => a.status.state === 'connected').map((a) => a.config.type)
    : [];

  const deadLetterCount = deadLetters
    ? deadLetters.reduce((sum, group) => sum + group.count, 0)
    : 0;

  return {
    pulse: {
      enabled: pulseEnabled,
      scheduleCount: schedules?.length ?? 0,
      nextRunIn,
      failedRunCount,
    },
    relay: {
      enabled: relayEnabled,
      adapterCount: adapters?.length ?? 0,
      connectedNames,
      deadLetterCount,
    },
    mesh: {
      totalAgents: meshStatus?.totalAgents ?? 0,
      offlineCount: meshStatus?.unreachableCount ?? 0,
    },
  };
}
