import { SPACES_EXPERIMENT, isExperimentEnabled } from '@/layers/shared/model';
import { useConfig } from './use-config';

/** Whether an experiment is on, and whether that answer can be believed yet. */
export interface ExperimentEnabledState {
  /** True only when the config has arrived AND says the experiment is on. */
  enabled: boolean;
  /**
   * True while the config read has not answered. **`false` is not "off" while
   * this is true**: a surface that would send somebody away when the
   * experiment is off must wait for this to clear first.
   */
  isLoading: boolean;
}

/**
 * Read one Settings → Experiments switch, live: flipping it in Settings
 * updates the shared config cache, so every reader follows without a reload.
 *
 * @param path - The experiment's setting path, e.g. `SPACES_EXPERIMENT`.
 */
export function useExperimentEnabledState(path: string): ExperimentEnabledState {
  const { data, isLoading } = useConfig();
  return { enabled: isExperimentEnabled(data, path), isLoading };
}

/**
 * Whether the spaces experiment is on (DOR-2740). False until the config
 * arrives, so a space surface stays hidden rather than flashing in.
 */
export function useSpacesEnabled(): boolean {
  return useExperimentEnabledState(SPACES_EXPERIMENT).enabled;
}
