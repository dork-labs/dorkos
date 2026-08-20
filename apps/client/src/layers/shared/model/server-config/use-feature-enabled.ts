import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../TransportContext';

type Subsystem = 'tasks' | 'relay';

const CONFIG_STALE_TIME = 5 * 60 * 1000;

/** Whether a subsystem is on, and whether that answer can be believed yet. */
export interface FeatureEnabledState {
  /** True only when the config has arrived AND says the subsystem is on. */
  enabled: boolean;
  /**
   * True while the config read has not answered.
   *
   * **`false` is not "off" while this is true**, and the difference matters to
   * anything that gates a query on `enabled`: a disabled query reports
   * `isLoading: false`, so a caller reading only its own query would call an
   * empty list settled and then announce everything in it as new the moment the
   * config landed. Whoever gates on `enabled` must OR this into its own loading
   * flag (DOR-1391).
   */
  isLoading: boolean;
}

/**
 * Fetch server config and derive whether a subsystem feature flag is enabled,
 * with the config read's own pending state beside it.
 *
 * @param subsystem - Which subsystem to ask about.
 */
export function useFeatureEnabledState(subsystem: Subsystem): FeatureEnabledState {
  const transport = useTransport();

  const { data, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME,
  });

  return { enabled: data?.[subsystem]?.enabled ?? false, isLoading };
}

/**
 * Fetch server config and derive whether a subsystem feature flag is enabled.
 *
 * @param subsystem - Which subsystem to ask about.
 */
export function useFeatureEnabled(subsystem: Subsystem): boolean {
  return useFeatureEnabledState(subsystem).enabled;
}
