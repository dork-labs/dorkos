/**
 * What a tab href shows as — one name and one icon — resolved from live data.
 *
 * The tab strip and the History menu (DOR-2107) both name pages from nothing
 * but an href, and they must name the same page the same way: a tab reading
 * "api" beside a history row reading "Session" for the one page is a control
 * panel contradicting itself. So both read this one hook.
 *
 * @module features/app-tabs/model/use-tab-target
 */
import { useMemo } from 'react';
import { MessageSquare, type LucideIcon } from 'lucide-react';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useExtensionPageAtPath } from '@/layers/shared/model';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { roomDisplayTitle, useRoom } from '@/layers/entities/room';
import {
  communityAccessState,
  useCommunityConnections,
  useRemoteCommunityRoom,
} from '@/layers/entities/community';
import {
  extensionPageTab,
  fallbackTabLabel,
  parseTabHref,
  ROUTE_ICONS,
  type TabTarget,
} from '../lib/tab-target';

/** How to draw an href: its parsed parts, its name, and which icon to show. */
export interface TabTargetView {
  /** The href, taken apart. */
  target: TabTarget;
  /** The name a person would use for this page. */
  label: string;
  /** The agent's emoji, for a chat page whose agent is known; else `null`. */
  emoji: string | null;
  /**
   * The extension's own icon, for an extension page; else `null`. `unknown`
   * because it is the extension's value — draw it through `ContributedIcon`.
   */
  extensionIcon: unknown;
  /** The route's icon, used when there is neither an emoji nor an extension icon. */
  Icon: LucideIcon;
}

/**
 * Resolve an href to its name and icon: a chat page is named after the agent
 * that lives in that project, a channel after its room (`#general`, a DM's
 * title), an extension page after what the extension registered, and anything
 * else after its route.
 *
 * The agent and room queries share their cache entries with the rest of the app,
 * so a rename anywhere updates this label too, and the route's own name shows
 * until that data resolves rather than a wrong one.
 *
 * @param href - Router-relative location.
 */
export function useTabTarget(href: string): TabTargetView {
  const target = useMemo(() => parseTabHref(href), [href]);
  const isSession = target.pathname === '/session';
  const isChannel = target.pathname === '/channels';

  const { data: agent } = useCurrentAgent(isSession ? target.dir : null);
  const visual = useAgentVisual(agent ?? null, target.dir ?? '');
  // A community channel's id is that community's, not a local room's: asking
  // the local rooms route for it answers 404 and names the tab "Channels".
  const community = isChannel ? target.community : null;
  const { data: localRoom } = useRoom(isChannel && !community ? target.roomId : null);
  // Read under the connection's verified access, exactly as the channel bar
  // does: the tab shares its cache entry, and a revoked community's title
  // clears instead of lingering on a tab.
  const connections = useCommunityConnections(community !== null);
  const access = communityAccessState(
    connections.data?.find((item) => item.ref === community)?.access
  );
  const { data: communityRoom } = useRemoteCommunityRoom(
    community ?? '',
    target.roomId ?? '',
    community !== null && target.roomId !== null && access.capabilities.read,
    access.fingerprint
  );
  const room = community ? communityRoom : localRoom;
  // An extension page names itself (spec `flow-multiproject` §6.5).
  const extensionTab = extensionPageTab(useExtensionPageAtPath(target.pathname));

  const label = agent
    ? getAgentDisplayName(agent)
    : room
      ? roomDisplayTitle(room)
      : (extensionTab?.label ?? fallbackTabLabel(target));

  return {
    target,
    label,
    emoji: agent ? visual.emoji : null,
    extensionIcon: agent ? null : (extensionTab?.icon ?? null),
    Icon: ROUTE_ICONS[target.pathname] ?? MessageSquare,
  };
}
