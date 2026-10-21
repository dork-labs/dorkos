/**
 * How a row LOOKS and what pressing it DOES — the half of the sidebar the model
 * deliberately does not carry.
 *
 * `buildSidebarModel` emits semantic ids (`glyph: { kind: 'agent-avatar' }`), a
 * target, and a reason. It never emits a face, a colour, or a navigation. Those
 * are resolved here, once, and handed to every row through a context so that
 * `SidebarSections` and `SidebarSection` can stay pure model consumers with no row
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
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import {
  appRoutes,
  extensionPageHref,
  newSessionTarget,
  reportClientError,
  toSession,
} from '@/layers/shared/lib';
import { useProfileDeepLink, useTransport } from '@/layers/shared/model';
import { disambiguateDisplayNames, useResolvedAgents } from '@/layers/entities/agent';
import {
  createGroup,
  moveTargetGroups,
  moveToGroup,
  mutedRoomIds,
  roomSectionIds,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useAgentPauses, useMeshAgentPaths, useMeshMemberIds } from '@/layers/entities/mesh';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { hasUnread, useRooms, useTeamRoom } from '@/layers/entities/room';
import {
  beginSessionNavigation,
  markPendingSessionTarget,
  clearPendingSessionTarget,
  usePendingSessionTarget,
  notifySessionLookupFailed,
  agentChatTarget,
  useStartNewSession,
} from '@/layers/entities/session';
import { useProfileStore } from '@/layers/features/profile';
import type { SidebarCommandId, SidebarTarget } from '../model/build-sidebar-model';
import { useBootState } from '../model/boot/use-boot-state';
import { useCreateFlowStore, type GroupCreationState } from '../model/create-flow-store';
import { buildRoomVisualIndex, type SidebarItemVisual } from '../model/sidebar-item';

/**
 * The mark a room draws when the index has no answer for it — a room the list
 * query dropped between the model's build and this render. A module constant so
 * the fallback keeps one identity: a fresh object here would change a memoized
 * row's `visual` prop on every render for the one room that hit it.
 */
const NO_MARK: SidebarItemVisual = { kind: 'sigil' };

/** Every unread room id, split by the two "Mark all … read" commands. */
export interface SidebarUnreadRoomIds {
  /** Channels — every room that is not a direct message. */
  channels: readonly string[];
  /** Direct messages, group conversations included. */
  dms: readonly string[];
}

/** One choice in a smart section's rule editor. */
export interface SmartGroupOption {
  /** The stored value the rule matches on. */
  value: string;
  /** What the reader sees. */
  label: string;
}

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
  /**
   * Rooms the operator has silenced in their own right (`ui.sidebar.muted`),
   * NOT counting the ones a muted section is dimming.
   *
   * **The one prefs subscription a row's mute reads through** (D8). Every room
   * row used to call `useSidebarPrefs()` for this, so writing any preference —
   * folding a section, renaming one, muting something else — re-rendered all
   * sixty of them. Group mute is deliberately excluded: it is a lens the model
   * applies to a row's `muted` flag, while the bell on the row and the
   * Mute/Unmute item in its menu are about the room's own setting.
   */
  mutedRoomIds: ReadonlySet<string>;
  /**
   * Mesh ids of the agents paused everywhere (spec `audit-trail` PR5), read
   * once here so every agent row draws its paused mark from one query.
   */
  pausedAgentIds: ReadonlySet<string>;
  /**
   * The hand-made section each room is filed into, for the rows that offer
   * "Move to section ▸". Absent from the map means "not in one".
   */
  roomSectionIds: ReadonlyMap<string, string>;
  /**
   * The sections a row may be moved INTO.
   *
   * Smart sections are left out: their membership comes from rules about
   * agents, so a room filed into one would be counted as grouped (and hidden
   * from Channels) while that section drew its derived members instead — the
   * row would vanish. The drag layer refuses the same drop; this refuses to
   * offer it.
   */
  moveTargetGroups: readonly { id: string; name: string }[];
  /**
   * Every unread room, walked once for the whole panel.
   *
   * "Mark all … read" means every room of that kind, including the ones filed
   * into a section and drawn somewhere else entirely — so the list is the whole
   * kind, never a section's own rows. Computed here because a section that
   * worked it out for itself walked the room list once per section.
   */
  unreadRoomIds: SidebarUnreadRoomIds;
  /**
   * The runtimes a smart section's rule editor can offer, from the fleet.
   *
   * Built from the ROSTER with manifests looked up — never from the manifest
   * map's own keys. That map is a separate query and answers `{}` until it
   * lands, so keying off it reports an empty fleet on the first paint and
   * withdraws chrome that should be there (BC-32).
   */
  runtimeOptions: readonly SmartGroupOption[];
  /** The namespaces a smart section's rule editor can offer, from the same walk. */
  namespaceOptions: readonly string[];
  /**
   * Whether the boot gate has opened — the one fact the continuity layer needs
   * (spec D5/D6).
   *
   * **Read once for the whole panel, and that is the reason it is here.**
   * `useBootState` opens ten query subscriptions and starts a 1500 ms timer per
   * caller, and its own docblock says every consumer latching independently is
   * only safe while there are a handful of them mounted in one commit. A section
   * calling it directly made that a per-SECTION cost — ten subscriptions and a
   * timer times however many sections the operator has — and turned a
   * whole-panel fact into N latches that could in principle disagree.
   *
   * Rows arriving before this is true are the panel loading, not arrivals.
   */
  bootSettled: boolean;
  /** What the operator has open, so the matching row tints. */
  activeTarget: SidebarTarget | null;
  /**
   * The room `/` is showing, when `/` is what is showing — otherwise `null`.
   *
   * **Only the row tint reads this, and that narrowness is the point.** Home
   * draws #team, so that row has to look open when you are on Home; but the
   * sidebar's `activeTarget` also feeds the scroll anchor, which must not move
   * on every visit to the dashboard. This carries the one fact the tint needs
   * and reaches nothing else.
   */
  homeRoomId: string | null;
  /**
   * The agent a click is heading to while its chat is looked up, or `null`.
   * Tint only, for the same reason as `homeRoomId`: the anchor keeps following
   * what is actually open (DOR-2891).
   */
  pendingAgentPath: string | null;
  /** Open whatever a row points at, and remember that it was opened. */
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
   * Begin the inline section-create flow, optionally seeded with a member.
   *
   * The flow's state lives in `create-flow-store` rather than here, because the
   * New menu starts it too and that menu is mounted outside this provider —
   * persistent chrome, in `AppShell` (BC-45). This is the same flow reached
   * from a row's menu.
   */
  requestNewGroup: (ref?: SidebarItemRef) => void;
  /** The inline section-create flow, or `null` when it is not running. */
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
  /** The sections. */
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
  const transport = useTransport();
  const queryClient = useQueryClient();
  const startNewSession = useStartNewSession();
  const { open: openProfile } = useProfileDeepLink();
  const memberIdByPath = useMeshMemberIds();
  const { update } = useUpdateSidebarPrefs();
  // The panel's ONE boot subscription for the rows below — see
  // {@link SidebarChromeValue.bootSettled}.
  const { settled: bootSettled } = useBootState();

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
  const roomVisuals = useMemo(
    () =>
      buildRoomVisualIndex({
        agentPaths: rawPaths,
        agentsByPath: manifests ?? {},
        rooms: roomsQuery.data ?? [],
      }),
    [rawPaths, manifests, roomsQuery.data]
  );
  const roomVisualOf = useCallback(
    (room: RoomSummary): SidebarItemVisual => roomVisuals.get(room.id) ?? NO_MARK,
    [roomVisuals]
  );

  // ── The three fleet-and-room walks the sections used to make one apiece ──
  //
  // `useSectionChrome` runs per section, so each of these was N walks over the
  // whole fleet or the whole room list on every render of the panel. They are
  // the same answer for every section, so they are worked out once here (D8).
  const prefs = useSidebarPrefs();
  // **Each one is handed the LIST it reads, never the whole prefs object.** Any
  // preferences write produces a new `prefs` — muting one room, folding a
  // section — and a memo that took the whole of it would hand all sixty rows a
  // fresh `moveTargetGroups` array on every one of them: a changed prop, and a
  // defeated memo. The stored lists keep their identity across a write that did
  // not touch them, so these do too (`SidebarChrome.memo.test.tsx`).
  const mutedRooms = useMemo(() => mutedRoomIds(prefs.muted), [prefs.muted]);
  const { data: pauseData } = useAgentPauses();
  const pausedAgentIds = useMemo(
    () => new Set((pauseData?.pauses ?? []).map((pause) => pause.agentId)),
    [pauseData]
  );
  const roomSections = useMemo(() => roomSectionIds(prefs.groups), [prefs.groups]);
  const moveTargets = useMemo(() => moveTargetGroups(prefs.groups), [prefs.groups]);
  const unreadRoomIds = useMemo<SidebarUnreadRoomIds>(() => {
    const channels: string[] = [];
    const dms: string[] = [];
    for (const room of roomsQuery.data ?? []) {
      if (!hasUnread(room)) continue;
      (room.kind === 'dm' ? dms : channels).push(room.id);
    }
    return { channels, dms };
  }, [roomsQuery.data]);
  const runtimeOptions = useMemo<SmartGroupOption[]>(() => {
    const seen = new Map<string, string>();
    for (const path of rawPaths) {
      const runtime = manifests?.[path]?.runtime ?? 'claude-code';
      if (!seen.has(runtime)) seen.set(runtime, getRuntimeDescriptor(runtime).label);
    }
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [rawPaths, manifests]);
  const namespaceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const path of rawPaths) {
      const namespace = manifests?.[path]?.namespace;
      if (namespace) set.add(namespace);
    }
    return Array.from(set).sort();
  }, [rawPaths, manifests]);

  const groupCreation = useCreateFlowStore((s) => s.groupCreation);
  const requestNewGroup = useCreateFlowStore((s) => s.requestNewGroup);
  const endNewGroup = useCreateFlowStore((s) => s.endNewGroup);

  const openSession = useCallback(
    (sessionId: string, cwd: string | null) => {
      // The chat page records the chat itself as opened, wherever you came from
      // (`useRecordChatOpened`, spec `your-activity-first` D3). The agent is
      // recorded here: the New menu's "starts with <name> (last used)" is
      // answered by that record, and it has to survive walking away to
      // Marketplace or Team — which the router's `?dir` does not.
      if (cwd !== null) useInteractionStore.getState().recordOpened('agent', cwd);
      return navigate(toSession({ dir: cwd ?? undefined, session: sessionId }));
    },
    [navigate]
  );

  const openAgent = useCallback(
    (agentPath: string) => {
      // Clicking an agent opens its Direct chat (rule S12, DOR-2997): one
      // standing chat per agent, where its messages to you land, rather than
      // its newest chat, which would keep moving. Its work chats stay one click
      // away in its chat switcher. Asynchronous while every row around it is
      // not, so it guards against being overtaken — by another agent click,
      // and by any of the app's other navigations.
      const isStillWanted = beginSessionNavigation(() => router.state.location);
      // The row shows the click landed while the lookup is out (DOR-2891).
      const clearPending = markPendingSessionTarget(agentPath);
      useInteractionStore.getState().recordOpened('agent', agentPath);
      // The Direct chat, or for anyone but the owner the agent's latest chat
      // with them: one rule, shared with every other door (`agentChatTarget`).
      void agentChatTarget({ queryClient, transport }, agentPath)
        .then(async (target) => {
          if (target && isStillWanted()) await navigate(target);
        })
        .catch((error: unknown) => {
          reportClientError(transport, error);
          if (isStillWanted()) notifySessionLookupFailed(agentPath);
        })
        .finally(clearPending);
    },
    [navigate, queryClient, router, transport]
  );

  // The doors. Each is a meaning, so the address of the page it stands for is
  // decided here, once: Threads, and the Directory — narrowed to agents for the
  // empty Direct messages section, whose one row offers exactly that.
  const openCommand = useCallback(
    (commandId: SidebarCommandId) => {
      switch (commandId) {
        case 'open-threads':
          void navigate({ ...appRoutes.threads() });
          return;
        case 'open-directory':
        case 'message-someone':
          void navigate({ ...appRoutes.team() });
          return;
        case 'message-agent':
          void navigate({ ...appRoutes.team(), search: { kind: 'agents' } });
          return;
      }
    },
    [navigate]
  );

  // Which room is #team, so its row can go to the one address that draws it.
  // A cache read of the room list this sidebar is already rendering.
  const teamRoomId = useTeamRoom().room?.id ?? null;
  // Home IS #team, so on `/` that row is the open one. Read off the live
  // pathname rather than the model's target for the reason `homeRoomId`
  // documents: this must not become a second opinion about what is "active".
  const onHome = useRouterState({ select: (state) => state.location.pathname === '/' });
  const homeRoomId = onHome ? teamRoomId : null;
  // An agent click still finding out which chat to open lights its row at once.
  // Any navigation, that click's own included, hands the answer back to the
  // router's location, so a lookup that was overtaken cannot keep a row lit.
  const pendingAgentPath = usePendingSessionTarget();
  useEffect(() => router.subscribe('onBeforeNavigate', clearPendingSessionTarget), [router]);

  const openTarget = useCallback(
    (target: SidebarTarget) => {
      switch (target.kind) {
        case 'session':
          void openSession(target.sessionId, target.cwd);
          return;
        case 'agent':
          openAgent(target.path);
          return;
        case 'room':
          useInteractionStore.getState().recordOpened('room', target.roomId);
          // **#team's row goes to Home, because Home IS #team** (spec
          // `one-bar-header` §3.5). `/channels` would redirect here anyway, so
          // this is not what makes the one door — it is what keeps the door from
          // being a bounce through an address that no longer draws anything.
          if (target.roomId === teamRoomId) {
            void navigate({ ...appRoutes.home() });
            return;
          }
          void navigate({ ...appRoutes.channels(), search: { id: target.roomId } });
          return;
        case 'command':
          openCommand(target.commandId);
          return;
        case 'add-on':
          // A raw href: `/x/<id>/<path>` is matched by the extension-page route
          // rather than declared one page at a time.
          void router.navigate({ href: extensionPageHref(target.extensionId, target.path) });
          return;
      }
    },
    [navigate, openAgent, openCommand, openSession, router, teamRoomId]
  );

  // Sheet when the fleet can name the agent, docked panel when it cannot. Never
  // a no-op — but the second branch opens a panel that says the agent is gone,
  // not a profile. See `viewProfileFor`'s docs.
  //
  // A `useCallback` of its own rather than a closure inside the value below,
  // because a memoized row takes it as a prop: the value's own identity moves
  // whenever anything in the panel changes, and a row that re-rendered for that
  // is a row that did not have to.
  const viewProfileFor = useCallback(
    (agentPath: string) => {
      const memberId = memberIdByPath.get(agentPath);
      return memberId === undefined
        ? () => useProfileStore.getState().openProfileDocked(agentPath)
        : () => openProfile(memberId);
    },
    [memberIdByPath, openProfile]
  );

  const value = useMemo<SidebarChromeValue>(
    () => ({
      agentPaths: rawPaths,
      manifests: manifests ?? {},
      displayNames,
      roomsById,
      roomVisualOf,
      mutedRoomIds: mutedRooms,
      pausedAgentIds,
      roomSectionIds: roomSections,
      moveTargetGroups: moveTargets,
      unreadRoomIds,
      runtimeOptions,
      namespaceOptions,
      bootSettled,
      activeTarget,
      homeRoomId,
      pendingAgentPath,
      openTarget,
      newSession: (dir?: string) => startNewSession(dir),
      viewProfileFor,
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
      mutedRooms,
      pausedAgentIds,
      roomSections,
      moveTargets,
      unreadRoomIds,
      runtimeOptions,
      namespaceOptions,
      bootSettled,
      activeTarget,
      homeRoomId,
      pendingAgentPath,
      openTarget,
      startNewSession,
      viewProfileFor,
      groupCreation,
      requestNewGroup,
      endNewGroup,
      update,
    ]
  );

  return <SidebarChromeContext.Provider value={value}>{children}</SidebarChromeContext.Provider>;
}
