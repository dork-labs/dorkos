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
 * The experiment every Docs feature reads (DOR-2993): wiki links, embeds,
 * comments and live editing in markdown docs. Off by default; while it is off
 * the canvas editor gets none of the Docs additions.
 */
export const DOCS_EXPERIMENT = 'docs.enabled';

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
 * The official DorkOS space's link from a config answer, or `null` when the server names none
 * (spec `official-community-space` D4). While it is `null`, every official-space prompt stays
 * hidden; the server has already checked the link is usable.
 *
 * @param config - The server config, or `undefined` before it arrives.
 */
export function officialSpaceLink(config: ServerConfig | undefined): string | null {
  return config?.officialSpace?.url ?? null;
}

/**
 * Whether any space can be reached right now, from the config cache, for code outside React:
 * the spaces experiment is on, or an official space is configured (spec
 * `official-community-space` D5). The server still judges each space by its ref.
 *
 * @param queryClient - The app's query client.
 */
export function readAnySpaceReachable(queryClient: QueryClient): boolean {
  const config = queryClient.getQueryData<ServerConfig>(configKeys.current());
  return isExperimentEnabled(config, SPACES_EXPERIMENT) || officialSpaceLink(config) !== null;
}
