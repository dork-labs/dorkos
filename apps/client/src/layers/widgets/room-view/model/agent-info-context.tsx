/**
 * What a room knows about the agents on its roster — how each one runs, and
 * what each one looks like — made available to every row and pill inside it.
 *
 * @module widgets/room-view/model/agent-info-context
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AgentVisual } from '@/layers/shared/lib';
import { useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { agentFacesByRef, agentInfoByRef, type RosterAgentInfo } from '../lib/agent-details';

/** Everything a room reads off the fleet, resolved in one pass. */
export interface RoomAgentDirectory {
  /**
   * How each agent runs, keyed by `agentRef` — what a mention pill's hover card
   * reads.
   */
  info: ReadonlyMap<string, RosterAgentInfo>;
  /**
   * Each agent's face, keyed by `agentRef` — the override a disc takes over
   * whatever the author row cached.
   */
  faces: ReadonlyMap<string, AgentVisual>;
}

/** One shared empty answer, so a room with no provider above it costs nothing. */
const NOTHING_KNOWN: RoomAgentDirectory = { info: new Map(), faces: new Map() };

const AgentInfoContext = createContext<RoomAgentDirectory>(NOTHING_KNOWN);

/**
 * Hand a room's agents down to every mention pill inside it.
 *
 * **A context rather than a prop, because a prop cannot get there.** A mention
 * pill is rendered by Streamdown, and Streamdown's own top-level memo
 * comparator (2.5.0) does not include `components` — it compares `children`,
 * the plugin arrays, and a dozen display options, and stops. A rebuilt
 * component map therefore re-renders nothing below it, so a room whose messages
 * were drawn before the fleet answered never redrew its pills and every card
 * came up bare. (Its inner per-block memo DOES compare `components`; the outer
 * bail-out is what the update never gets past.) Context is the one channel that
 * reaches a consumer inside a bailed-out subtree, and it costs no re-parse.
 *
 * **It reads nothing itself**, which is what lets the Dev Playground bench the
 * real `RoomMessage` against seeded data with no fleet to read. The routed app
 * feeds it {@link useRoomAgentDirectory}, so the surface holding the
 * answer is also the one that can use it for its own rows — a provider that
 * fetched privately would have to be read back through a second hook.
 *
 * @param props.known - What this room knows about its agents.
 * @param props.children - The surface this answers for.
 */
export function AgentInfoProvider({
  known,
  children,
}: {
  known: RoomAgentDirectory;
  children: ReactNode;
}) {
  return <AgentInfoContext.Provider value={known}>{children}</AgentInfoContext.Provider>;
}

/**
 * Read the fleet once for a whole room: how its agents run, and what they look
 * like.
 *
 * **Both halves come from one pass**, so the four faces a room draws for one
 * agent — its roster stack, the room's own mark for a direct message, every
 * message's disc in the gutter, and the hover card a mention opens — cannot be
 * resolved differently. That divergence is what DOR-1002 closes, and one
 * derivation is what keeps it closed.
 *
 * **One query pair per surface, never one per row.** Both reads are the shared
 * cache entries the sidebar and every agent picker already keep warm
 * (`useAgentPickerCandidates` reads the same two), so a second caller in the
 * same room — the masthead beside the feed — costs a memo rather than a
 * request.
 *
 * **Nothing here reads a clock.** The identity card can also say that an agent
 * is working right now, and this deliberately does not answer that: the elapsed
 * time behind it ticks once a second, and holding a ticking read above a feed
 * redraws every row, every reaction row and every action bar with it — the
 * regression `useRoomPresenceAuthorIds` exists to undo. That chip belongs to
 * whatever leaf can own the timer, not here.
 *
 * **A failed read costs only the extra detail.** Names, cached faces and
 * origins all come from the room's own roster, which is already in hand; an
 * unreachable mesh or a manifest that will not resolve simply leaves both maps
 * empty, and every surface falls back to what the roster cached for itself.
 */
export function useRoomAgentDirectory(): RoomAgentDirectory {
  const mesh = useMeshAgentPaths();
  // The entries whole, not just their paths: each one carries the registry id
  // the team roster is keyed by, which is what a profile link opens on. Reading
  // only the paths here is how that id got reconstructed from the manifest
  // instead — a different id space, and a dead link for any agent whose two
  // disagree (`RosterAgentInfo.memberId`).
  const entries = useMemo(() => mesh.data?.agents ?? [], [mesh.data]);
  const paths = useMemo(() => entries.map((entry) => entry.projectPath), [entries]);
  const resolved = useResolvedAgents(paths);
  const info = useMemo(
    () => agentInfoByRef(entries, resolved.data ?? {}),
    [entries, resolved.data]
  );
  const faces = useMemo(() => agentFacesByRef(info), [info]);
  return useMemo(() => ({ info, faces }), [info, faces]);
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
  return agentRef === undefined ? undefined : known.info.get(agentRef);
}

/**
 * The faces of every agent this room could resolve, keyed by `agentRef`.
 *
 * The map rather than one face, because the surfaces that need it resolve one
 * author at a time off a roster they already hold — `toMessageAuthor` does the
 * join itself, and a row asking for a single face would have to know which key
 * to ask under.
 *
 * Empty anywhere no provider is mounted, and empty when the fleet could not be
 * read; both mean the same thing to a caller — leave the lower rungs of the
 * ladder to answer — which is why they are one answer rather than two.
 */
export function useRoomAgentFaces(): ReadonlyMap<string, AgentVisual> {
  return useContext(AgentInfoContext).faces;
}
