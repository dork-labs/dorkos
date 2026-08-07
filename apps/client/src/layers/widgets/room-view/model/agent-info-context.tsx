/**
 * How the agents on a room's roster RUN, made available to every mention pill
 * in that room's history.
 *
 * @module widgets/room-view/model/agent-info-context
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { agentInfoByRef, type RosterAgentInfo } from '../lib/agent-details';

/** One shared empty answer, so a room with no provider above it costs nothing. */
const NOTHING_KNOWN: ReadonlyMap<string, RosterAgentInfo> = new Map();

const AgentInfoContext = createContext<ReadonlyMap<string, RosterAgentInfo>>(NOTHING_KNOWN);

/**
 * Read the fleet once for a whole room, and hand the answer down.
 *
 * **A context rather than a prop, because a prop cannot get there.** A mention
 * pill is rendered by Streamdown, which memoises each parsed block of a message
 * and keeps the render it already produced — so a room whose messages were
 * drawn before the fleet answered never redrew its pills, and every card came
 * up bare. Context is the one channel that reaches a consumer inside a bailed
 * out subtree, which is exactly the situation here.
 *
 * **One query pair per room, never one per pill.** Both reads are the shared
 * cache entries the sidebar and every agent picker already keep warm
 * (`useAgentPickerCandidates` reads the same two), so a history full of
 * mentions costs a map lookup each rather than a request each.
 *
 * **Nothing here reads a clock.** The identity card can also say that an agent
 * is working right now, and this deliberately does not answer that: the elapsed
 * time behind it ticks once a second, and holding a ticking read above a feed
 * redraws every row, every reaction row and every action bar with it — the
 * regression `useRoomPresenceAuthorIds` exists to undo. That chip belongs to
 * whatever leaf can own the timer, not here.
 *
 * **A failed read costs only the extra detail.** Names, faces and origins all
 * come from the room's own roster, which is already in hand; an unreachable
 * mesh or a manifest that will not resolve simply leaves the map empty.
 *
 * @param props.children - The room surface this answers for.
 */
export function RoomAgentInfoProvider({ children }: { children: ReactNode }) {
  const mesh = useMeshAgentPaths();
  const paths = useMemo(() => (mesh.data?.agents ?? []).map((a) => a.projectPath), [mesh.data]);
  const resolved = useResolvedAgents(paths);
  const value = useMemo(() => agentInfoByRef(paths, resolved.data ?? {}), [paths, resolved.data]);
  return <AgentInfoContext.Provider value={value}>{children}</AgentInfoContext.Provider>;
}

/**
 * How one agent runs, if this client knows.
 *
 * `undefined` for a human (no `agentRef` to ask about), for an agent the fleet
 * has no manifest for, and anywhere no provider is mounted. Every one of those
 * means the same thing to a caller — draw nothing — which is why they are one
 * answer rather than three.
 *
 * @param agentRef - The roster's stable handle for the agent, from `AuthorRef`.
 */
export function useAgentInfo(agentRef: string | undefined): RosterAgentInfo | undefined {
  const known = useContext(AgentInfoContext);
  return agentRef === undefined ? undefined : known.get(agentRef);
}
