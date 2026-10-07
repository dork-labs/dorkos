/**
 * Reading Settings → Experiments switches from the server config, outside React
 * as well as in it. The hooks live in `entities/config` beside `useConfig`.
 *
 * @module shared/model/server-config/experiments
 */
import type { QueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { configKeys } from './query-keys';

/**
 * The experiment every space surface reads (DOR-2740): joining, starting and
 * showing spaces on other servers. Off by default; this machine's own rooms
 * and #team never read it.
 */
export const SPACES_EXPERIMENT = 'spaces.enabled';

/**
 * Whether one Settings → Experiments switch is on, read from a config answer.
 *
 * The server resolves every registered experiment into `config.experiments`
 * (environment overrides included), so this reads that block rather than the
 * raw setting. A config that has not arrived, or does not list the path, is off.
 *
 * @param config - The server config, or `undefined` before it arrives.
 * @param path - The experiment's setting path, e.g. {@link SPACES_EXPERIMENT}.
 */
export function isExperimentEnabled(config: ServerConfig | undefined, path: string): boolean {
  return config?.experiments?.find(({ key }) => key === path)?.enabled === true;
}

/**
 * The same answer from the shared config cache, for code outside React (the
 * router's load hook). Off until the config has been read once.
 *
 * @param queryClient - The app's query client.
 * @param path - The experiment's setting path.
 */
export function readExperimentEnabled(queryClient: QueryClient, path: string): boolean {
  return isExperimentEnabled(queryClient.getQueryData<ServerConfig>(configKeys.current()), path);
}

/**
 * Whether the spaces experiment is on, from the config cache, for code outside
 * React. The single non-hook spaces check, beside `useSpacesEnabled`.
 *
 * @param queryClient - The app's query client.
 */
export function readSpacesEnabled(queryClient: QueryClient): boolean {
  return readExperimentEnabled(queryClient, SPACES_EXPERIMENT);
}
