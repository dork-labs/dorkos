import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../TransportContext';
import { configKeys, CONFIG_STALE_TIME_MS } from './query-keys';

type Subsystem = 'tasks' | 'relay';

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
  /** True when DorkOS could not read the server config. */
  isError: boolean;
  /** True while a settled read is being tried again. */
  isRetrying: boolean;
  /** A startup failure reported for a subsystem the server tried to start. */
  initError?: string;
  /**
   * What the saved setting says. It can differ from {@link enabled} because the
   * server starts each subsystem once, at boot: a switch turned on since then is
   * saved but not yet running. Undefined until the config arrives.
   */
  enabledInConfig?: boolean;
  /** True when an environment variable on this computer decides it, not the setting. */
  lockedByEnv: boolean;
  /** Ask the server for its current config again. */
  retry: () => void;
}

/**
 * Fetch server config and derive whether a subsystem feature flag is enabled,
 * with the config read's own pending state beside it.
 *
 * @param subsystem - Which subsystem to ask about.
 */
export function useFeatureEnabledState(subsystem: Subsystem): FeatureEnabledState {
  const transport = useTransport();

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
  });

  const state = data?.[subsystem];
  const initError = state?.initError;
  return {
    enabled: state?.enabled ?? false,
    isLoading,
    isError,
    isRetrying: isFetching && !isLoading,
    ...(initError && { initError }),
    ...(state?.enabledInConfig !== undefined && { enabledInConfig: state.enabledInConfig }),
    lockedByEnv: state?.lockedByEnv === true,
    retry: () => void refetch(),
  };
}

/**
 * Fetch server config and derive whether a subsystem feature flag is enabled.
 *
 * @param subsystem - Which subsystem to ask about.
 */
export function useFeatureEnabled(subsystem: Subsystem): boolean {
  return useFeatureEnabledState(subsystem).enabled;
}
