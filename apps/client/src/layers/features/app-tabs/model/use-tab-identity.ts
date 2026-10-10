/**
 * A tab href's identity, resolved from live data (DOR-2820).
 *
 * The tab strip, a tab's hover card, the History menu and the window title
 * all call this, so they cannot disagree about what a page is called or
 * whether it needs you. It gathers; `lib/tab-identity.ts` builds.
 *
 * @module features/app-tabs/model/use-tab-identity
 */
import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { resolveIdentityFace, SETTINGS_TAB_DIRECTORY } from '@/layers/shared/lib';
import { useExtensionPageAtPath } from '@/layers/shared/model';
import { nonAutomatedSessionIds, useSessionListStore } from '@/layers/entities/session';
import { hasUnread, roomDisplayTitle, useRoom, useRooms } from '@/layers/entities/room';
import {
  communityAccessState,
  useCommunityConnections,
  useRemoteCommunityRoom,
} from '@/layers/entities/community';
import { teamMemberFace, useTeamRoster } from '@/layers/entities/team';
import {
  channelsTabIdentity,
  chatTabIdentity,
  extensionTabIdentity,
  homeTabIdentity,
  marketplaceTabIdentity,
  profileTabIdentity,
  roomTabIdentity,
  routeTabIdentity,
  settingsTabIdentity,
  teamTabIdentity,
  type TabIdentity,
  type TabStatusSignals,
} from '../lib/tab-identity';
import { parseTabHref, type TabTarget } from '../lib/tab-target';
import { useChatTabInput } from './use-chat-tab-input';
import { useTabSignalsStore } from './tab-signals';

/** Which builder names a tab. Overlays first: they are what is on screen. */
type TabKind =
  'settings' | 'profile' | 'chat' | 'room' | 'channels' | 'home' | 'team' | 'marketplace' | 'route';

/** Decide which builder names a parsed href. */
function tabKind(target: TabTarget): TabKind {
  // The Settings dialog is modal over everything, the profile panel over the
  // page: while either is open it is what the person is looking at.
  if (target.settings) return 'settings';
  if (target.profile) return 'profile';
  switch (target.pathname) {
    case '/session':
      return 'chat';
    case '/channels':
      return target.roomId ? 'room' : 'channels';
    case '/':
      return 'home';
    case '/team':
    case '/agents':
      return 'team';
    case '/marketplace':
    case '/marketplace/sources':
      return 'marketplace';
    default:
      return 'route';
  }
}

/** Fleet facts with nothing in them, minted once for a stable selector result. */
const NO_FLEET = { workingCount: 0, needsYou: false, failed: false };

/**
 * Fold the live status of every chat in `paths` (or all of them, for `null`)
 * into how many agents are working and whether any needs you or failed.
 *
 * A scheduled or automated run is not an agent "working" for you, so it never
 * counts toward the working number, the rule `useAgentHottestStatus` follows
 * (DOR-1137). A blocked or failed automated run still does: it needs you all
 * the same.
 *
 * @param enabled - Whether to read at all.
 * @param paths - Agent folders to fold, or `null` for the whole fleet.
 */
function useFleetSignals(enabled: boolean, paths: string | null) {
  return useSessionListStore(
    useShallow(
      useCallback(
        (s) => {
          if (!enabled) return NO_FLEET;
          const streaming: string[] = [];
          let needsYou = false;
          let failed = false;
          for (const [id, status] of Object.entries(s.statuses)) {
            if (paths !== null && s.statusCwds[id] !== paths) continue;
            if (status.lifecycle === 'streaming') streaming.push(id);
            else if (status.lifecycle === 'blocked') needsYou = true;
            else if (status.lifecycle === 'error') failed = true;
          }
          const working = new Set(
            nonAutomatedSessionIds(streaming, Object.values(s.sessions)).map(
              (id) => s.statusCwds[id] ?? id
            )
          );
          return { workingCount: working.size, needsYou, failed };
        },
        [enabled, paths]
      )
    )
  );
}

/** Turn folded fleet facts into status signals. */
function fleetStatus(fleet: typeof NO_FLEET): TabStatusSignals {
  return { needsYou: fleet.needsYou, failed: fleet.failed, working: fleet.workingCount > 0 };
}

/**
 * Read a channel or DM tab's room: its title, unread count and, for a DM,
 * whoever it is with.
 */
function useRoomTabInput(target: TabTarget, enabled: boolean) {
  // A community channel's id is that community's, not a local room's: asking
  // the local rooms route for it answers 404 and names the tab "Channels".
  const community = enabled ? target.community : null;
  const roomId = enabled ? target.roomId : null;
  const { data: localRoom } = useRoom(!community ? roomId : null);
  // Read under the connection's verified access, exactly as the channel bar
  // does: the tab shares its cache entry, and a revoked community's title
  // clears instead of lingering on a tab.
  const connections = useCommunityConnections(community !== null);
  const access = communityAccessState(
    connections.data?.find((item) => item.ref === community)?.access
  );
  const { data: communityRoom } = useRemoteCommunityRoom(
    community ?? '',
    roomId ?? '',
    community !== null && roomId !== null && access.capabilities.read,
    access.fingerprint
  );
  // The list carries this viewer's unread count and a DM's participants.
  const { data: rooms } = useRooms({ enabled });
  const summary = !community && roomId ? rooms?.find((room) => room.id === roomId) : undefined;
  const room = community ? communityRoom : localRoom;
  const unreadRooms = useMemo(() => (rooms ?? []).filter(hasUnread).length, [rooms]);

  if (!room) return { room: null, unreadRooms } as const;
  const other =
    room.kind === 'dm'
      ? summary?.participants?.find(
          (author) => !('viewerAuthorId' in room) || author.id !== room.viewerAuthorId
        )
      : undefined;
  return {
    room: {
      kind: room.kind,
      title: roomDisplayTitle(room),
      unreadCount: summary?.unreadCount ?? null,
      face: other
        ? resolveIdentityFace({
            record: {
              id: other.id,
              kind: other.kind,
              displayName: other.displayName,
              ...(other.emoji ? { emoji: other.emoji } : {}),
              ...(other.color ? { color: other.color } : {}),
              ...(other.imageUrl ? { imageUrl: other.imageUrl } : {}),
            },
          })
        : null,
      lastActiveAt: 'lastActivityAt' in room ? Date.parse(String(room.lastActivityAt)) : undefined,
    },
    unreadRooms,
  } as const;
}

/**
 * Resolve an href to its tab identity: a chat is named after its agent and
 * titled after the chat, a channel after its room, an overlay after what it
 * shows, and anything else after its route. Every route's own name shows
 * until its live data resolves, never a wrong one.
 *
 * @param href - Router-relative location.
 */
export function useTabIdentity(href: string): TabIdentity {
  const target = useMemo(() => parseTabHref(href), [href]);
  const kind = tabKind(target);

  const chat = useChatTabInput(kind === 'chat' ? target : null);
  const roomInput = useRoomTabInput(target, kind === 'room' || kind === 'channels');
  const fleet = useFleetSignals(kind === 'team', null);

  const { data: roster } = useTeamRoster({ enabled: kind === 'profile' });
  const member =
    kind === 'profile' ? roster?.members.find((entry) => entry.id === target.profile) : undefined;
  const memberFleet = useFleetSignals(
    member?.agent?.projectPath !== undefined,
    member?.agent?.projectPath ?? null
  );

  const extensionAt = useExtensionPageAtPath(target.pathname);
  const needsYouCount = useTabSignalsStore((state) => state.needsYouCount);
  const badge = useTabSignalsStore((state) => state.routeBadges[target.pathname]);

  switch (kind) {
    case 'settings':
      return settingsTabIdentity(
        SETTINGS_TAB_DIRECTORY.find((entry) => entry.id === target.settings)?.label
      );
    case 'profile':
      return profileTabIdentity({
        name: member?.displayName,
        face: member ? teamMemberFace(member) : null,
        signals: member?.agent ? fleetStatus(memberFleet) : undefined,
      });
    case 'chat':
      return chatTabIdentity(chat ?? {});
    case 'room':
      return roomInput.room ? roomTabIdentity(roomInput.room) : channelsTabIdentity(0);
    case 'channels':
      return channelsTabIdentity(roomInput.unreadRooms);
    case 'home':
      return homeTabIdentity(needsYouCount);
    case 'team':
      return teamTabIdentity(target.pathname, {
        workingCount: fleet.workingCount,
        signals: fleetStatus(fleet),
      });
    case 'marketplace':
      return marketplaceTabIdentity({
        pathname: target.pathname,
        query: target.query,
        pkg: target.pkg,
      });
    case 'route':
      return extensionAt !== null
        ? extensionTabIdentity(extensionAt.match?.page, badge)
        : routeTabIdentity(target.pathname, badge);
  }
}
