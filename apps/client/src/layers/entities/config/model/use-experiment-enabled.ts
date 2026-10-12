import { SPACES_EXPERIMENT, isExperimentEnabled, officialSpaceLink } from '@/layers/shared/model';
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
 * The spaces experiment with its loading state (DOR-2740). Every space
 * surface reads spaces through this or {@link useSpacesEnabled}, so a later
 * exception (the official space, DOR-2764) has one place to plug in.
 */
export function useSpacesState(): ExperimentEnabledState {
  return useExperimentEnabledState(SPACES_EXPERIMENT);
}

/**
 * Whether the spaces experiment is on (DOR-2740). False until the config
 * arrives, so a space surface stays hidden rather than flashing in.
 */
export function useSpacesEnabled(): boolean {
  return useSpacesState().enabled;
}

/** The spaces experiment beside the one space that ignores it. */
export interface SpacesAccessState extends ExperimentEnabledState {
  /**
   * The official DorkOS space's link, or `null` when the server names none (spec
   * `official-community-space` D4). With it set, that one space shows and can be joined even
   * while {@link ExperimentEnabledState.enabled} is false.
   */
  officialLink: string | null;
  /** Whether any space can be reached: the experiment is on, or an official space is named. */
  anySpace: boolean;
}

/**
 * The spaces experiment and the official-space exception together (spec
 * `official-community-space` D5). A surface that lists or opens spaces reads this, then asks
 * `useSpaceVisible` about one space; Start, hosting and joining other spaces keep reading
 * {@link useSpacesEnabled} alone.
 */
export function useSpacesAccess(): SpacesAccessState {
  const { data, isLoading } = useConfig();
  const enabled = isExperimentEnabled(data, SPACES_EXPERIMENT);
  const officialLink = officialSpaceLink(data);
  return { enabled, isLoading, officialLink, anySpace: enabled || officialLink !== null };
}
