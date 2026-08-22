/**
 * The fleet's real faces, keyed by the handle a room's roster carries.
 *
 * @module features/room-management/model/use-room-faces
 */
import { useMemo } from 'react';
import { agentAuthorRef, type RoomRosterEntry } from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import { useAgentPickerCandidates } from './use-agent-picker-candidates';

/**
 * Every agent's own face, keyed by `agentRef` — the one-way hash of its
 * directory that a room's roster carries (ADR 260726-170126).
 *
 * **One derivation, three surfaces.** The panel's roster rows, the room mark at
 * the top of the panel, and the room's mark in the bar all have to draw the same
 * agent the same way — that is the whole subject of `room-agent-faces.test.tsx`,
 * and the bug it was written for was three surfaces each deciding for
 * themselves. So the join lives here and is read, never re-made.
 *
 * **It is exported from this slice for the bar's sake**, which is a widget and
 * may therefore import it. The fleet read it rests on composes `entities/mesh`
 * with `entities/agent`, which no entity may do — so a feature is the lowest
 * layer this can live in, and a second copy in the widget is the thing this
 * export exists to prevent.
 *
 * An agent the fleet cannot place is simply absent, which is what leaves the
 * honest letter disc in place rather than inventing a face for it.
 */
export function useRoomFaces(): ReadonlyMap<string, AgentVisual> {
  const agents = useAgentPickerCandidates();
  return useMemo(() => {
    const faces = new Map<string, AgentVisual>();
    for (const candidate of agents.candidates) {
      if (candidate.visual !== null)
        faces.set(agentAuthorRef(candidate.agentPath), candidate.visual);
    }
    return faces;
  }, [agents.candidates]);
}

/**
 * The faces of a room's agents, in roster order, for a mark that draws them.
 *
 * Agents only — a room's mark stands for who it is WITH — and only those the
 * fleet can place, so the stack never mixes a real face with a hashed letter.
 *
 * @param members - The room's roster, as the server ordered it.
 * @param faces - {@link useRoomFaces}' map.
 */
export function facesOfRoster(
  members: readonly RoomRosterEntry[],
  faces: ReadonlyMap<string, AgentVisual>
): AgentVisual[] {
  return members
    .filter((member) => member.author.kind === 'agent')
    .map((member) => (member.author.agentRef ? faces.get(member.author.agentRef) : undefined))
    .filter((visual): visual is AgentVisual => visual !== undefined);
}
