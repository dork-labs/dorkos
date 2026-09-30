/**
 * What disconnecting this DorkOS from a Community does to the agents it added
 * there, and how to say so.
 *
 * Disconnecting removes every agent this installation added to that Community
 * (DOR-2603): an agent left active after the only app that runs it has gone is
 * access nobody holds any more. The confirmation names them before the person
 * decides, and the result names any the Community could not be told to remove,
 * so none is ever left behind without the person knowing.
 *
 * @module entities/community/model/community-disconnect
 */
import { useQuery } from '@tanstack/react-query';
import type {
  CommunityConnectionDescriptor,
  CommunityDisconnectResponse,
  CommunityInstallationAgent,
} from '@dorkos/shared/community-connections';
import { useTransport } from '@/layers/shared/model';
import { communityKeys, withinCommunityAuthority } from './use-community-connections';
import { useConfirmedCommunityAuthority } from './use-community-navigation';

/**
 * Read which agents disconnecting would remove from one Community. The local
 * server answers from its own records, so this works while the Community is
 * unreachable. A request still waiting for approval never added an agent, so
 * it is not asked about.
 *
 * @param connection - The Community about to be disconnected, or `null` while no confirmation is open.
 */
export function useCommunityDisconnectImpact(connection: CommunityConnectionDescriptor | null) {
  const transport = useTransport();
  const enabled = connection !== null && connection.status !== 'pending';
  const authority = useConfirmedCommunityAuthority(enabled);
  const ref = connection?.ref ?? '';
  return useQuery({
    queryKey: authority
      ? communityKeys.disconnectImpact(authority, ref)
      : [...communityKeys.all, 'owner', 'unresolved', ref, 'disconnect-impact'],
    queryFn: () =>
      withinCommunityAuthority(authority!, () => transport.getCommunityDisconnectImpact(ref)),
    enabled: enabled && authority !== null,
    // Read fresh on every opening: an agent added a moment ago must be named too.
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

/**
 * "Scout", "Scout and Echo", "Scout, Echo and Relay". Agents this app no longer
 * has are counted rather than listed: "Scout and 2 unnamed agents".
 */
function joinAgentNames(agents: readonly CommunityInstallationAgent[]): string {
  const names = agents.flatMap((agent) => (agent.displayName ? [agent.displayName] : []));
  const unnamed = agents.length - names.length;
  if (unnamed > 0) names.push(unnamed === 1 ? 'an unnamed agent' : `${unnamed} unnamed agents`);
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The confirmation's line about agents: how many disconnecting removes from
 * the Community, by name. `null` when it removes none, so nothing is said.
 *
 * @param label - The Community's name.
 * @param agents - The agents this installation added there.
 */
export function disconnectAgentsLine(
  label: string,
  agents: readonly CommunityInstallationAgent[]
): string | null {
  if (agents.length === 0) return null;
  if (agents.length === 1)
    return agents[0]!.displayName
      ? `The agent you added from here, ${agents[0]!.displayName}, will be removed from ${label}.`
      : `The agent you added from here will be removed from ${label}.`;
  return `The ${agents.length} agents you added from here will be removed from ${label}: ${joinAgentNames(agents)}.`;
}

/**
 * The confirmation's line when the agents could not be read. Disconnecting
 * still removes them, so the person is told that much rather than kept from
 * disconnecting.
 *
 * @param label - The Community's name.
 */
export function unknownDisconnectAgentsLine(label: string): string {
  return `Any agents you added from here will be removed from ${label}.`;
}

/** What to tell the person once a disconnect finished, and how loudly. */
export interface CommunityDisconnectOutcome {
  /** `success` when nothing is left to do; `warning` when the person has a step to finish. */
  tone: 'success' | 'warning';
  /** The sentence to show, naming the Community and any agent left on it. */
  message: string;
}

/**
 * Say how a disconnect ended. This DorkOS is always disconnected; anything the
 * Community could not be told (this installation's access, or an agent to
 * remove) is named, with where to finish it on the Community's own site.
 *
 * @param label - The Community's name.
 * @param result - What the server reported.
 */
export function disconnectOutcome(
  label: string,
  { remoteRevoked, agentsNotRemoved }: CommunityDisconnectResponse
): CommunityDisconnectOutcome {
  const names = joinAgentNames(agentsNotRemoved);
  if (agentsNotRemoved.length === 0)
    return remoteRevoked
      ? { tone: 'success', message: `${label} is disconnected.` }
      : { tone: 'warning', message: unconfirmedDisconnectMessage(label) };
  if (!remoteRevoked)
    return {
      tone: 'warning',
      message: `${label} is disconnected here, but it couldn’t be reached. To finish on ${label}, remove ${names} under Agents, and disconnect this DorkOS under Connected installations.`,
    };
  return {
    tone: 'warning',
    message: `${label} is disconnected, but ${names} couldn’t be removed from it. To finish, remove ${agentsNotRemoved.length === 1 ? 'it' : 'them'} under Agents on ${label}.`,
  };
}

/**
 * What to tell the person when this installation is disconnected but the
 * Community could not be reached to end its access there.
 *
 * @param label - The Community's name.
 */
function unconfirmedDisconnectMessage(label: string): string {
  return `${label} is disconnected here, but it couldn’t be reached. To finish, disconnect this DorkOS under Connected installations on ${label}.`;
}
