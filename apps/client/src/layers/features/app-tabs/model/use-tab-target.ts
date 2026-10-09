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
import {
  sessionDisplayTitle,
  useSessionRow,
  useSessionRouteContext,
} from '@/layers/entities/session';
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
  /** A chat's title, shown after its agent's name; `null` for any other page. */
  chatTitle: string | null;
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

  // A chat URL carries no `dir` (#2682), so find the chat's folder the way
  // `useDirectoryState` does: the route context the loader installed, then the
  // legacy URL hint, then the chat's own row, which the server resolves by id.
  // Reading only `?dir=` named every chat tab "Chat" with a generic icon.
  const routeContext = useSessionRouteContext(isSession ? target.sessionId : null);
  const { data: session } = useSessionRow(isSession ? target.sessionId : null, {
    // A draft has no row on the server yet; asking for one only earns a 404.
    // The href says so too, for a tab restored after a reload, when the
    // in-memory route context is gone.
    enabled: !(routeContext?.draft ?? target.draft),
    nameOnly: true,
    select: (row) => ({ cwd: row.cwd ?? null, title: row.title }),
  });
  const dir = isSession ? (routeContext?.cwd ?? target.dir ?? session?.cwd ?? null) : null;

  const { data: agent } = useCurrentAgent(dir);
  const visual = useAgentVisual(agent ?? null, dir ?? '');
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
      : (extensionTab?.label ?? fallbackTabLabel({ ...target, dir }));

  return {
    target,
    label,
    chatTitle: session ? sessionDisplayTitle(session.title) : null,
    emoji: agent ? visual.emoji : null,
    extensionIcon: agent ? null : (extensionTab?.icon ?? null),
    Icon: ROUTE_ICONS[target.pathname] ?? MessageSquare,
  };
}
