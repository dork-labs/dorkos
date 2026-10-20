/**
 * Whether the DM view experiment is on (DOR-3074), read once, outside React.
 *
 * @module shared/lib/dm-view
 */
import type { QueryClient } from '@tanstack/react-query';
// The leaf rather than the `shared/model` barrel, as `session-link.ts` does: a
// click handler reading one switch has no reason to pull the whole model in.
import { DM_VIEW_EXPERIMENT, readExperimentEnabled } from '../model/server-config/experiments';

/**
 * Whether a chat with one agent reads like a DM, as the config cache says at
 * this moment. For a handler that decides on a click where its agent opens;
 * a component that draws differently reads `useDmViewEnabled` instead, so it
 * follows the switch live.
 *
 * @param queryClient - The app's query client, holding the config answer.
 */
export function readDmViewEnabled(queryClient: QueryClient): boolean {
  return readExperimentEnabled(queryClient, DM_VIEW_EXPERIMENT);
}
