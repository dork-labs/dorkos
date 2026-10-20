/**
 * An agent's card over its face, its name and its mentions in a room, while
 * the DM view is on (DOR-3074): Message opens its DM, Profile its profile.
 *
 * @module widgets/room-view/ui/identity/room-agent-card
 */
import { cloneElement, useMemo, type ReactElement, type ReactNode } from 'react';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { cn } from '@/layers/shared/lib';
import type { IdentityHoverCardDescriptor } from '@/layers/shared/ui';
import { useDmViewEnabled } from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { AgentHoverCard } from '@/layers/features/direct-message';
import { useAgentInfo } from '../../model/agent-info-context';

/** Each fleet listing's `agentRef → directory` index, built once per listing. */
const PATHS_BY_REF = new WeakMap<readonly AgentPathEntry[], Map<string, string>>();

/** The index for one fleet listing. */
function pathsByRef(entries: readonly AgentPathEntry[]): Map<string, string> {
  const known = PATHS_BY_REF.get(entries);
  if (known) return known;
  const built = new Map(
    entries.map((entry) => [agentAuthorRef(entry.projectPath), entry.projectPath])
  );
  PATHS_BY_REF.set(entries, built);
  return built;
}

/**
 * The directory of the agent a roster names, or undefined when the fleet does
 * not list it (or has not answered). A roster carries a stable handle derived
 * from the directory, never the directory itself, so this turns it back.
 *
 * @param agentRef - The roster's handle for the agent.
 */
export function useAgentPathForRef(agentRef: string | undefined): string | undefined {
  const mesh = useMeshAgentPaths();
  const entries = mesh.data?.agents;
  return useMemo(
    () => (agentRef === undefined || !entries ? undefined : pathsByRef(entries).get(agentRef)),
    [entries, agentRef]
  );
}

/** Who a card is about, as a room row or a mention resolved them. */
export interface RoomAgentCardInput {
  /** The roster's handle for the agent; undefined for a person. */
  agentRef: string | undefined;
  /** The identity the card shows: face, name, handle. */
  identity: IdentityHoverCardDescriptor;
  /** Open the agent's profile, the door the surface already had. */
  onViewProfile?: () => void;
}

/** How a room row wraps an agent's face and name in its card. */
export interface RoomAgentCard {
  /** Put the card over the face in the gutter. */
  wrapAvatar: (avatar: ReactElement) => ReactNode;
  /** Put the card over the name in the author line. */
  wrapName: (name: ReactElement) => ReactNode;
  /** Put the card over any other trigger, such as a mention pill. */
  wrap: (trigger: ReactElement, options?: { openOnClick?: boolean }) => ReactNode;
}

/**
 * The card for one agent in a room, or `null` with the DM view off, for a
 * person, and for an agent the fleet cannot place. `null` means the row draws
 * exactly what it did before.
 *
 * Clicking the face or the name opens the card (a pointer or a finger); the
 * keyboard keeps the row's own "View profile" in its action capsule.
 *
 * @param input - See {@link RoomAgentCardInput}.
 */
export function useRoomAgentCard(input: RoomAgentCardInput): RoomAgentCard | null {
  const { agentRef, identity, onViewProfile } = input;
  const enabled = useDmViewEnabled();
  const agentPath = useAgentPathForRef(enabled ? agentRef : undefined);
  const info = useAgentInfo(agentRef);
  return useMemo(() => {
    if (!enabled || identity.kind !== 'agent' || agentPath === undefined) return null;
    const card: IdentityHoverCardDescriptor = {
      ...identity,
      agent: info && { runtime: info.runtime, ...(info.model && { model: info.model }) },
    };
    const wrap = (trigger: ReactElement, options: { openOnClick?: boolean } = {}) => (
      <AgentHoverCard
        identity={card}
        agentPath={agentPath}
        onViewProfile={onViewProfile}
        openOnClick={options.openOnClick ?? false}
      >
        {trigger}
      </AgentHoverCard>
    );
    return {
      wrap,
      wrapAvatar: (avatar) =>
        wrap(
          <span className="inline-flex cursor-pointer" data-slot="room-agent-card-face">
            {avatar}
          </span>,
          { openOnClick: true }
        ),
      wrapName: (name) =>
        wrap(
          cloneElement(name as ReactElement<{ className?: string }>, {
            className: cn(
              (name.props as { className?: string }).className,
              'cursor-pointer underline-offset-4 hover:underline'
            ),
          }),
          { openOnClick: true }
        ),
    };
  }, [enabled, identity, agentPath, info, onViewProfile]);
}
