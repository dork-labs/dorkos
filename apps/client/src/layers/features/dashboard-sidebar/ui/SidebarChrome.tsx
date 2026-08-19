/**
 * How a row LOOKS and what pressing it DOES — the half of the sidebar the model
 * deliberately does not carry.
 *
 * `buildSidebarModel` emits semantic ids (`glyph: { kind: 'agent-avatar' }`), a
 * target, and a reason. It never emits a face, a colour, or a navigation. Those
 * are resolved here, once, and handed to every row through a context so that
 * `SidebarZone` and `SidebarSection` can stay pure model consumers with no row
 * plumbing threaded through them.
 *
 * **This reads queries, and `useSidebarState` is still the one assembly hook.**
 * The two answer different questions. `useSidebarState` builds the §A2 snapshot
 * — what the sidebar CONTAINS. This resolves presentation and behaviour for
 * rows the model has already decided on. Every query it touches
 * (`useResolvedAgents`, `useRooms`) is one `useSidebarState` already asked for,
 * so the shared cache answers both and the net request count is unchanged.
 *
 * @module features/dashboard-sidebar/ui/SidebarChrome
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { reportClientError } from '@/layers/shared/lib';
import {
  useAgentCreationStore,
  useImportProjectsStore,
  useProfileDeepLink,
  useTransport,
} from '@/layers/shared/model';
import { disambiguateDisplayNames, useResolvedAgents } from '@/layers/entities/agent';
import { createGroup, moveToGroup, useUpdateSidebarPrefs } from '@/layers/entities/config';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useMeshAgentPaths, useMeshMemberIds } from '@/layers/entities/mesh';
import { useRooms, useRoomOpenThreadStore } from '@/layers/entities/room';
import {
  beginSessionNavigation,
  notifySessionLookupFailed,
  resolveSessionForCwd,
  useStartNewSession,
} from '@/layers/entities/session';
import { useProfileStore } from '@/layers/features/profile';
import type { SidebarTarget, SuggestionId } from '../model/build-sidebar-model';
import { useCreateFlowStore, type GroupCreationState } from '../model/create-flow-store';
import { NOW_OVERFLOW_HREF } from '../model/rules/cap-now-items';
import { buildSidebarItems, type SidebarItemVisual } from '../model/sidebar-item';
import { toggleTodayAutomated } from '../model/today-reveal-store';

/** Everything a row needs that the model does not carry. */
export interface SidebarChromeValue {
  /**
   * Every agent directory the mesh knows, in roster order.
   *
   * Carried beside {@link SidebarChromeValue.manifests} rather than derived
   * from it: the manifests query resolves separately and answers `{}` until it
   * lands, so a fleet size read off that map is zero for the first paint —
   * which is exactly the fleet size that decides whether grouping is offered
   * at all (BC-32).
   */
  agentPaths: readonly string[];
  /** Agent manifests by directory — the face, the colour, the runtime label. */
  manifests: Record<string, AgentManifest | null>;
  /** Disambiguated display names by directory. */
  displayNames: Record<string, string>;
  /** Room records by id, for the rows that draw one. */
  roomsById: Map<string, RoomSummary>;
  /** The mark a room draws, resolved in the one place that resolves faces. */
  roomVisualOf: (room: RoomSummary) => SidebarItemVisual;
  /** What the operator has open, so the matching row (and its Library copy) tints. */
  activeTarget: SidebarTarget | null;
  /** Open whatever a row points at, and remember that it was opened (BC-16). */
  openTarget: (target: SidebarTarget) => void;
  /** Start a session, optionally scoped to one agent's directory. */
  newSession: (dir?: string) => void;
  /**
   * View an agent's profile — the sidebar's one opener, for any directory it
   * draws a row for.
   *
   * One opener, not two. The sidebar used to offer a second door beside this one
   * that opened the right panel directly; the profile has two homes now and the
   * address decides which (spec `profile-unification` §1.6), so a sidebar that
   * picked the home itself could send the same agent to a different place than
   * every other face in the cockpit.
   *
   * **It always returns an opener, and what the fallback opens is an ANSWER
   * rather than a profile.** The sheet is addressed by roster id, which the
   * fleet's path → id map may not have — an agent retired mid-session, or a
   * roster whose account source degraded, resolves to nothing. Returning
   * `undefined` there left the row's face as plain art and its menu without a
   * profile item, so the one agent you most needed to look at was the one that
   * offered you nothing at all.
   *
   * The fallback opens the docked panel on the directory, which a sidebar row
   * always has. **It will not draw a profile**: `ProfileDock` resolves the
   * identity through that same map, so it settles on `AgentNotFound` and names
   * the directory that went dead. That is the whole of what this buys — a panel
   * that opens and tells you the agent is gone, instead of a control that does
   * not respond. Pinned from the other end in `ProfileDock.test.tsx`; do not
   * describe it as opening a working profile.
   *
   * In practice the branch is close to unreachable: both this and the row list
   * derive from the same `useMeshAgentPaths()` payload, so a row usually exists
   * only for a path the map holds. It is the degraded case, kept honest.
   */
  viewProfileFor: (agentPath: string) => () => void;
  /**
   * Begin the inline group-create flow, optionally seeded with a member.
   *
   * The flow's state lives in `create-flow-store` rather than here, because the
   * New menu starts it too and that menu is mounted outside this provider —
   * persistent chrome, in `AppShell` (BC-45). This is the same flow reached
   * from a row's menu.
   */
  requestNewGroup: (ref?: SidebarItemRef) => void;
  /** The inline group-create flow, or `null` when it is not running. */
  groupCreation: GroupCreationState | null;
  /** Commit the inline flow under this name. */
  commitNewGroup: (name: string) => void;
  /** Abandon the inline flow. */
  cancelNewGroup: () => void;
}

const SidebarChromeContext = createContext<SidebarChromeValue | null>(null);

/**
 * The row chrome for the current tree.
 *
 * Throws outside a provider rather than degrading: a row rendered without it
 * would draw faceless and navigate nowhere, which is a defect that should stop
 * a test rather than ship quietly.
 */
export function useSidebarChrome(): SidebarChromeValue {
  const value = useContext(SidebarChromeContext);
  if (value === null) {
    throw new Error('useSidebarChrome must be used inside <SidebarChrome>');
  }
  return value;
}

/** Props for {@link SidebarChrome}. */
interface SidebarChromeProps {
  /** What the operator has open, from the model's snapshot. */
  activeTarget: SidebarTarget | null;
  /** The zones. */
  children: ReactNode;
}

/**
 * Resolve every row's presentation and behaviour once, for the whole panel.
 *
 * @param props - The active target and the tree to serve.
 */
export function SidebarChrome({ activeTarget, children }: SidebarChromeProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const transport = useTransport();
  const startNewSession = useStartNewSession();
  const { open: openProfile } = useProfileDeepLink();
  const memberIdByPath = useMeshMemberIds();
  const { update } = useUpdateSidebarPrefs();

  const { data: meshData } = useMeshAgentPaths();
  const rawPaths = useMemo(
    () => (meshData?.agents ?? []).map((entry) => entry.projectPath),
    [meshData]
  );
  const { data: manifests } = useResolvedAgents(rawPaths);
  const displayNames = useMemo(
    () => disambiguateDisplayNames(rawPaths, manifests ?? {}),
    [rawPaths, manifests]
  );
  const roomsQuery = useRooms();
  const roomsById = useMemo(
    () => new Map((roomsQuery.data ?? []).map((room) => [room.id, room])),
    [roomsQuery.data]
  );
  // The one place a room's mark is resolved. A direct message draws the agent's
  // own face, which only a layer that can see both the room and the fleet can
  // work out (sidebar-groups §3.1) — resolving it twice is what let a DM row and
  // its agent row disagree (DOR-582).
  const itemIndex = useMemo(
    () =>
      buildSidebarItems({
        agentPaths: rawPaths,
        agentsByPath: manifests ?? {},
        displayNames,
        attention: {},
        agentActivity: {},
        rooms: roomsQuery.data ?? [],
        mutedAgentPaths: new Set<string>(),
        mutedRoomIds: new Set<string>(),
      }),
    [rawPaths, manifests, displayNames, roomsQuery.data]
  );
  const roomVisualOf = useCallback(
    (room: RoomSummary): SidebarItemVisual =>
      itemIndex.byRoomId.get(room.id)?.visual ?? { kind: 'sigil' },
    [itemIndex]
  );

  const groupCreation = useCreateFlowStore((s) => s.groupCreation);
  const requestNewGroup = useCreateFlowStore((s) => s.requestNewGroup);
  const endNewGroup = useCreateFlowStore((s) => s.endNewGroup);

  const openSession = useCallback(
    (sessionId: string, cwd: string | null) => {
      useInteractionStore.getState().recordOpened('session', sessionId);
      // The agent too, on the same key space. Today is ordered by the session
      // record; the New menu's "starts with <name> (last used)" is answered by
      // the agent one, and it has to survive walking away to Marketplace or
      // Team — which the router's `?dir` does not.
      if (cwd !== null) useInteractionStore.getState().recordOpened('agent', cwd);
      navigate({ to: '/session', search: { dir: cwd ?? undefined, session: sessionId } });
    },
    [navigate]
  );

  const openAgent = useCallback(
    (agentPath: string) => {
      // Clicking an agent resumes its most recent conversation (BC-34). The
      // lookup goes through the shared resolver rather than this tab's cache:
      // the roster lists every agent, but only the one this window has opened
      // has a cached session list, so a cache read alone would send you to an
      // empty chat for every other one (DOR-928). It is asynchronous while every
      // row around it is not, so it guards against being overtaken — by another
      // agent click, and by any of the app's other navigations, which it
      // notices through the router's own location.
      const isStillWanted = beginSessionNavigation(() => router.state.location);
      void resolveSessionForCwd({ queryClient, transport }, agentPath)
        .then((resolved) => {
          if (!isStillWanted()) return;
          if (resolved === null) {
            notifySessionLookupFailed(agentPath);
            return;
          }
          openSession(resolved.sessionId, agentPath);
        })
        .catch((error: unknown) => {
          // The resolver handles its own failures, so a throw here is a defect
          // in this callback — otherwise an unhandled rejection and a click that
          // died in silence.
          reportClientError(transport, error);
          if (isStillWanted()) notifySessionLookupFailed(agentPath);
        });
    },
    [openSession, queryClient, router, transport]
  );

  // DorkBot, found the only way the client can: `isSystem` is the flag on the
  // wire, and an install is free to put the directory anywhere.
  const dorkBotPath = useMemo(
    () => rawPaths.find((path) => manifests?.[path]?.isSystem === true) ?? null,
    [rawPaths, manifests]
  );

  const openSuggestion = useCallback(
    (suggestionId: SuggestionId) => {
      switch (suggestionId) {
        case 'suggestion:agents-found':
          // Straight into the review-and-join dialog, which already holds the
          // scan this suggestion is counting.
          useImportProjectsStore.getState().open();
          return;
        case 'suggestion:add-agent':
          useAgentCreationStore.getState().open();
          return;
        case 'suggestion:first-session':
          startNewSession();
          return;
        case 'suggestion:say-hi-team':
          // Home IS #team (team-room-home §D3.2), so this is the room, not a
          // page about it.
          void navigate({ to: '/' });
          return;
        case 'suggestion:ask-dorkbot':
          // A fresh session with the system agent. The seeded context BC-48
          // describes belongs to the footer's Ask DorkBot button (P2.5); the
          // suggestion's promise is only that a conversation opens.
          if (dorkBotPath !== null) startNewSession(dorkBotPath);
          return;
      }
    },
    [dorkBotPath, navigate, startNewSession]
  );

  const openTarget = useCallback(
    (target: SidebarTarget) => {
      switch (target.kind) {
        case 'session':
          openSession(target.sessionId, target.cwd);
          return;
        case 'agent':
          openAgent(target.path);
          return;
        case 'room':
          // The interaction is recorded against the room, because a thread
          // reads the room's own cursor (ADR 260728-022013) and one place has
          // one record.
          useInteractionStore.getState().recordOpened('room', target.roomId);
          // **A thread row opens the PANEL, and the STORE is what opens it.**
          // Navigating with `?thread=` alone is not enough: the room widget
          // treats its own store as the source of truth and mirrors it back out
          // (`use-thread-url-sync.ts`), seeding from the URL only on the way
          // INTO a room. So a thread opened while already reading that room had
          // its param wiped a frame later and the click did nothing. Writing
          // the store is the same act a reply row in the timeline performs; the
          // URL then follows from it, which is also what makes the address
          // survive a reload. `focusComposer` stays false — clicking a row in
          // the sidebar is a request to READ, and on a phone the difference is
          // whether a keyboard opens over what you came to look at.
          if (target.rootEntryId !== undefined) {
            useRoomOpenThreadStore.getState().openThread(target.roomId, target.rootEntryId, false);
          }
          navigate({
            to: '/channels',
            search: {
              id: target.roomId,
              ...(target.rootEntryId && { thread: target.rootEntryId }),
            },
          });
          return;
        case 'attention':
          // A raw href, because a deep link is a string the signal supplies
          // rather than one of the router's declared routes.
          void router.navigate({ href: target.deepLink });
          return;
        case 'command':
          if (target.commandId === 'new-session') startNewSession();
          return;
        case 'suggestion':
          openSuggestion(target.suggestionId);
          return;
        case 'rollup':
          // "+ N more" goes to the home surface's triage header, which already
          // holds the full list — Heads up never grows a second one (BC-7). "N
          // working" goes to the same place for now: home carries the presence
          // strip of who is working, and P2.6's session switcher scoped to live
          // sessions is what BC-9 actually asks for.
          if (target.rollup === 'now-overflow' || target.rollup === 'working') {
            void navigate({ to: NOW_OVERFLOW_HREF });
          }
          // Today's "+ N automated" is a fold, not a destination: the runs it
          // stands for open underneath it (BC-19). Pressing it again puts them
          // away.
          if (target.rollup === 'automated') toggleTodayAutomated();
          // `section-count` ("N inactive") is deliberately not handled: it is
          // being replaced outright by an `All N agents →` command row that
          // navigates to /team (spec `sidebar-simplification` §D3, task 2.2).
          // Wiring it here would be a destination written twice and deleted
          // once.
          return;
        case 'digest':
          // "While you were away…" is a door into the welcome-back note, and
          // that note is a post in #team — which IS the home surface
          // (team-room-home §D3.2). So the row goes where the words already
          // are rather than to a summary written a second time.
          void navigate({ to: '/' });
          return;
        default:
          // Nothing else the union carries is clickable from a Today row.
          return;
      }
    },
    [navigate, openAgent, openSession, openSuggestion, router, startNewSession]
  );

  const value = useMemo<SidebarChromeValue>(
    () => ({
      agentPaths: rawPaths,
      manifests: manifests ?? {},
      displayNames,
      roomsById,
      roomVisualOf,
      activeTarget,
      openTarget,
      newSession: (dir?: string) => startNewSession(dir),
      // Sheet when the fleet can name the agent, docked panel when it cannot.
      // Never a no-op — but the second branch opens a panel that says the agent
      // is gone, not a profile. See `viewProfileFor`'s docs.
      viewProfileFor: (agentPath: string) => {
        const memberId = memberIdByPath.get(agentPath);
        return memberId === undefined
          ? () => useProfileStore.getState().openProfileDocked(agentPath)
          : () => openProfile(memberId);
      },
      requestNewGroup,
      groupCreation,
      commitNewGroup: (name: string) => {
        const pending = groupCreation?.pendingRef ?? null;
        update((prev) => {
          const { next, id } = createGroup(prev, name);
          return pending ? moveToGroup(next, pending, id) : next;
        });
        endNewGroup();
      },
      cancelNewGroup: endNewGroup,
    }),
    [
      rawPaths,
      manifests,
      displayNames,
      roomsById,
      roomVisualOf,
      activeTarget,
      openTarget,
      startNewSession,
      memberIdByPath,
      openProfile,
      groupCreation,
      requestNewGroup,
      endNewGroup,
      update,
    ]
  );

  return <SidebarChromeContext.Provider value={value}>{children}</SidebarChromeContext.Provider>;
}
