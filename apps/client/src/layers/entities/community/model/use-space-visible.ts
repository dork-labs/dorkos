/**
 * Whether one space shows right now (spec `official-community-space` D5): every space while the
 * spaces experiment is on, and the official DorkOS space alone while it is off. The client half
 * of the server's `spaceReachable(ref)`; the server still judges every request.
 *
 * @module entities/community/model/use-space-visible
 */
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { useSpacesAccess } from '@/layers/entities/config';
import { useCommunityConnections } from './use-community-connections';

/**
 * Whether a connection shows, given the experiment. The `official` mark comes from the server,
 * which works it out against the configured link on every read.
 *
 * @param connection - The space's connection.
 * @param spacesEnabled - Whether the spaces experiment is on.
 */
export function isSpaceVisible(
  connection: Pick<CommunityConnectionDescriptor, 'official'>,
  spacesEnabled: boolean
): boolean {
  return spacesEnabled || connection.official === true;
}

/** Whether a space shows, and whether that answer can be believed yet. */
export interface SpaceVisibleState {
  /** True only when the space may be shown and opened. */
  visible: boolean;
  /** True while the config or the connection list has not answered yet. */
  isLoading: boolean;
}

/**
 * `useSpaceVisible(ref)`: whether the space a `?community=` names may be shown. With the
 * experiment on, every space; off, only a connection the server marked official.
 *
 * @param ref - The space's local connection ref, or `undefined` when none is named.
 */
export function useSpaceVisible(ref: string | undefined): SpaceVisibleState {
  const access = useSpacesAccess();
  const asks = !access.enabled && access.officialLink !== null && ref !== undefined;
  const connections = useCommunityConnections(asks);
  if (access.enabled) return { visible: true, isLoading: false };
  if (access.isLoading) return { visible: false, isLoading: true };
  if (!asks) return { visible: false, isLoading: false };
  const connection = connections.data?.find((item) => item.ref === ref);
  if (connection) return { visible: isSpaceVisible(connection, false), isLoading: false };
  return {
    visible: false,
    isLoading: connections.data === undefined && !connections.isError,
  };
}
