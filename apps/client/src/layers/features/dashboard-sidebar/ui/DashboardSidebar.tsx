import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { useNavigate, useRouter, useRouterState, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Plus } from 'lucide-react';
import { SidebarContent, SidebarGroup, SidebarMenu } from '@/layers/shared/ui';
import {
  useAppStore,
  useTransport,
  useAgentCreationStore,
  useProfileDeepLink,
} from '@/layers/shared/model';
import { toast } from 'sonner';
import { reportClientError } from '@/layers/shared/lib';
import {
  disambiguateDisplayNames,
  useExecutionExceptions,
  useResolvedAgents,
  type AgentVisual,
} from '@/layers/entities/agent';
import {
  useConfig,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  createGroup,
  createSmartGroup,
  moveToGroup,
  mutedRoomIds,
  GROUPS_HINT_SUGGESTION_ID,
  isSuggestionRetired,
  retireSuggestion,
  sectionSortMode,
  sectionDisplayFilter,
} from '@/layers/entities/config';
import { useMeshAgentPaths, useMeshMemberIds } from '@/layers/entities/mesh';
import {
  useRooms,
  useRoomsByKind,
  useThreads,
  useRoomOpenThreadStore,
  roomDisplayTitle,
  hasUnread,
  type RoomSummary,
} from '@/layers/entities/room';
import {
  useAgentSessions,
  useRenameSession,
  useRecentSessions,
  useAgentAttentionMap,
  resolveSessionForCwd,
  useStartNewSession,
  notifySessionLookupFailed,
  beginSessionNavigation,
  sessionKeys,
} from '@/layers/entities/session';
import { useJumpBackIn } from '@/layers/entities/recents';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { Session } from '@dorkos/shared/types';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef, SmartGroupRules } from '@dorkos/shared/config-schema';
import type { SmartGroupCandidate } from '@dorkos/shared/smart-groups';
import { PromoSlot } from '@/layers/features/feature-promos';
import { useAgentHubStore } from '@/layers/features/agent-hub';
import { AgentListItem } from './AgentListItem';
import { AgentOnboardingCard } from './AgentOnboardingCard';
import { SidebarNavHeader } from './SidebarNavHeader';
import { JumpBackInSection } from './JumpBackInSection';
import { ChannelsSection } from './rooms/ChannelsSection';
import { ThreadsSection } from './rooms/ThreadsSection';
import { DirectMessagesSection } from './rooms/DirectMessagesSection';
import { RoomRow } from './rooms/RoomRow';
import { PinnedSection } from './PinnedSection';
import { SidebarGroupSection } from './SidebarGroupSection';
import { UngroupedSection } from './UngroupedSection';
import { GroupCreateInput } from './GroupCreateInput';
import { GroupsHintCard } from './GroupsHintCard';
import { SmartGroupRuleDialog } from './SmartGroupRuleDialog';
import { SidebarDnd } from './dnd/SidebarDnd';
import {
  Sortable,
  SortableList,
  sidebarRowDndId,
  sidebarDndData,
  DISABLED_SORTABLE_BINDINGS,
} from './dnd/SidebarDndPrimitives';
import {
  buildSidebarItems,
  lookupSidebarItems,
  sidebarItemFaces,
  sidebarItemKey,
  type SidebarItem,
  type SidebarItemVisual,
  type RenderSidebarItem,
} from '../model/sidebar-item';
import {
  effectiveMutedAgentPaths,
  groupedAgentPaths,
  groupedRoomIds,
  evaluateSmartGroups,
  groupMemberItems,
  individuallyMutedAgentPaths,
} from '../model/sidebar-membership';
import {
  meetsSmartGroupDisclosureThreshold,
  activeNowPreset,
  byRuntimePresets,
  type SmartGroupPreset,
} from '../model/smart-group-presets';

/**
 * Legacy localStorage key that held pinned agent paths before organization moved
 * to server config (DOR-329). Its presence is the one-time migration flag.
 */
const LEGACY_PINNED_STORAGE_KEY = 'dorkos-pinned-agents';

/**
 * Pending group-create flow: `pendingRef` (if set) is moved into the group on
 * commit.
 *
 * A reference rather than an agent path (rooms-in-groups, DOR-581) — "New
 * group…" is offered from a room row's menu too, and the group it creates has
 * to be able to hold the thing it was started from.
 */
interface GroupCreationState {
  pendingRef: SidebarItemRef | null;
}

/**
 * Unified dashboard sidebar — top-level navigation plus the organized agent
 * roster (DOR-329): Recent sessions, Pinned references, user-defined groups, and
 * the ungrouped "Agents" list, with progressive disclosure so a small unorganized
 * fleet stays as clean as before.
 *
 * This component is a slim orchestrator: it wires data (roster, sidebar prefs,
 * recent sessions), computes membership maps, and composes the section
 * components. Section chrome, sorting, and CRUD live in those children.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const queryClient = useQueryClient();
  const transport = useTransport();
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  // ── Server-persisted sidebar organization (DOR-329) ──
  const { data: config } = useConfig();
  const sidebarPrefs = useSidebarPrefs();
  const { update: updateSidebarPrefs } = useUpdateSidebarPrefs();

  // ── Full mesh roster (unsorted; per-section sorting is derived below) ──
  const { open: openProfile } = useProfileDeepLink();
  const { data: meshData } = useMeshAgentPaths();
  const rawPaths = useMemo(() => (meshData?.agents ?? []).map((a) => a.projectPath), [meshData]);
  // A row knows an agent by its directory; the profile drawer knows it by the
  // id the mesh registered. One shared join, so this and the chat status chip
  // cannot disagree about who a row points at.
  const memberIdByPath = useMeshMemberIds();
  const { data: agents } = useResolvedAgents(rawPaths);

  // ── Rooms (channels + DMs, spec `rooms` §7) ──
  // One list query, partitioned by kind, so the two sections share a request and
  // a cache. The active room is read off the URL rather than held in state —
  // room identity travels as a search param, matching `/session?session=`.
  // Read-only: the list's live subscription belongs to the app shell, which is
  // always mounted. This body is not — mobile keeps it in a closed drawer and
  // /marketplace swaps it out — so a subscription here would stop refreshing
  // the browser tab's unread badge the moment either happened.
  const roomsQuery = useRooms();
  const { channels, dms } = useRoomsByKind(roomsQuery.data);
  // Room titles for the drag layer's overlay and ARIA announcements — what a
  // room is called while it is under the cursor (rooms-in-groups, DOR-581).
  const roomTitles = useMemo(
    () => Object.fromEntries((roomsQuery.data ?? []).map((r) => [r.id, roomDisplayTitle(r)])),
    [roomsQuery.data]
  );
  const routeSearch = useSearch({ strict: false }) as {
    id?: string;
    thread?: string;
    session?: string;
  };
  const activeRoomId = pathname === '/channels' ? (routeSearch.id ?? null) : null;
  const activeThreadId = pathname === '/channels' ? (routeSearch.thread ?? null) : null;
  // Which session is on screen, read off the URL for the same reason the active
  // room is: a session's identity travels as `?session=`, and the URL is the one
  // answer every window agrees on.
  const activeSessionOnScreen = pathname === '/session' ? (routeSearch.session ?? null) : null;
  const handleSelectRoom = useCallback(
    (room: RoomSummary) => {
      navigate({ to: '/channels', search: { id: room.id } });
    },
    [navigate]
  );

  // ── Threads (room-messaging-design §3) ──
  // Every thread this person is in, wherever it lives. Its own query rather
  // than a slice of the room list: a thread is not a room, and the question
  // "where is this thread?" is the one the room list cannot answer.
  const threadsQuery = useThreads();
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);

  /**
   * Open a thread: its room, with its panel showing.
   *
   * **The store is written BEFORE the URL, and both are needed.** The panel
   * reads the open-thread store and `ChannelsPage` mirrors it into `?thread=`;
   * the URL is only read back on the way INTO a room, once per room. So
   * navigating alone would land correctly on a room the reader is not already
   * in and do nothing at all — worse than nothing, actually — when they are:
   * the mirror would find the store still holding the old thread and write the
   * new `?thread=` straight back out of the address bar. Setting the store is
   * what opens the panel; the search param is what makes the result linkable.
   *
   * **This PUSHES a history entry, while `useThreadUrlSync` replaces — and the
   * two are right to differ.** That hook mirrors a panel being opened and
   * closed inside a room you are already looking at, which is reading rather
   * than going somewhere; pushing there would make Back walk through every
   * thread you glanced at. This is a sidebar row that changes which ROOM is on
   * screen — the same act as `handleSelectRoom` directly above, which pushes
   * too — so Back should return you to where you came from rather than skip
   * past it.
   */
  const handleSelectThread = useCallback(
    (thread: ThreadSummary) => {
      useRoomOpenThreadStore.getState().openThread(thread.roomId, thread.rootEntryId);
      navigate({ to: '/channels', search: { id: thread.roomId, thread: thread.rootEntryId } });
    },
    [navigate]
  );

  // ── Per-agent activity (drives the "recent" sort) ──
  // The same query "Jump back in" reads below, so the two share one request and
  // one cache; this call is here for `agentActivity`, which the sort needs and
  // the recents model has no use for.
  const recentQuery = useRecentSessions();
  const agentActivity = useMemo(() => recentQuery.data?.agentActivity ?? {}, [recentQuery.data]);

  // ── Display names (duplicates disambiguated) ──
  const displayNamesRecord = useMemo(
    () => disambiguateDisplayNames(rawPaths, agents ?? {}),
    [rawPaths, agents]
  );

  // ── Attention + mute (DOR-339): one attention-map subscription for the whole
  // sidebar, and the individually-muted reference sets every section's filter and
  // rollup dot reads. ──
  // Execution breakage joins the live signals: an agent whose runtime is not
  // connected, or whose pinned model is gone, needs a person as surely as a
  // pending approval does (spec `execution-defaults` §5, operator requirement).
  // Catalog checks stay off here — they are per-runtime network fetches and this
  // runs for the whole fleet; the Settings strip, which is one screen opened on
  // purpose, is where the model catalog gets asked.
  const { brokenPaths } = useExecutionExceptions();
  const attentionMap = useAgentAttentionMap(rawPaths, brokenPaths);
  const mutedPathsSet = useMemo(() => individuallyMutedAgentPaths(sidebarPrefs), [sidebarPrefs]);
  // Read from the prefs entity rather than derived here: "Jump back in" reads
  // the same set from the same place, so the sidebar and its popover cannot
  // disagree about which rooms were told to stop pulling anyone back in.
  const mutedRoomIdSet = useMemo(() => mutedRoomIds(sidebarPrefs), [sidebarPrefs]);

  // ── "Jump back in" — sessions, DMs and channels as one ordered list ──
  // Fed the muted set: a muted room is one the operator asked not to be pulled
  // back into, and this list's whole job is pulling you back into things.
  const jumpBackIn = useJumpBackIn({ mutedRoomIds: mutedRoomIdSet });
  const effectiveMutedForRender = useMemo(
    () => effectiveMutedAgentPaths(sidebarPrefs, mutedPathsSet),
    [sidebarPrefs, mutedPathsSet]
  );

  // ── The item view model (sidebar-groups §3) ──
  // Built once for the whole sidebar, so each section resolves its membership
  // with a map lookup and nothing below this line has to know how an agent and a
  // room each answer "what are you called" and "when were you last active".
  const itemIndex = useMemo(
    () =>
      buildSidebarItems({
        agentPaths: rawPaths,
        agentsByPath: agents ?? {},
        displayNames: displayNamesRecord,
        attention: attentionMap,
        agentActivity,
        rooms: roomsQuery.data ?? [],
        mutedAgentPaths: mutedPathsSet,
        mutedRoomIds: mutedRoomIdSet,
      }),
    [
      rawPaths,
      agents,
      displayNamesRecord,
      attentionMap,
      agentActivity,
      roomsQuery.data,
      mutedPathsSet,
      mutedRoomIdSet,
    ]
  );
  const roomsById = useMemo(
    () => new Map((roomsQuery.data ?? []).map((room) => [room.id, room])),
    [roomsQuery.data]
  );

  // ── Membership maps (stale references filtered at render, never pruned on write) ──
  const knownSet = useMemo(() => new Set(rawPaths), [rawPaths]);
  const pinnedItems = useMemo(
    () => lookupSidebarItems(itemIndex, sidebarPrefs.pinned),
    [itemIndex, sidebarPrefs.pinned]
  );
  const groupedSet = useMemo(
    () => groupedAgentPaths(sidebarPrefs, knownSet),
    [sidebarPrefs, knownSet]
  );
  const groupedRooms = useMemo(() => groupedRoomIds(sidebarPrefs), [sidebarPrefs]);

  // ── Smart groups (DOR-338): rule-derived membership, re-evaluated live ──
  // Candidates are built ONCE per render from data the sidebar already holds;
  // evaluation below is memoized on (groups, candidates) identity so unrelated
  // store updates skip re-derivation (spec Performance Considerations).
  const smartGroupCandidates = useMemo<SmartGroupCandidate[]>(
    () =>
      rawPaths.map((path) => ({
        projectPath: path,
        runtime: agents?.[path]?.runtime ?? 'claude-code',
        namespace: agents?.[path]?.namespace ?? null,
        attention: attentionMap[path] ?? 'inactive',
        lastActivityAt: agentActivity[path] ? new Date(agentActivity[path]).getTime() : null,
      })),
    [rawPaths, agents, attentionMap, agentActivity]
  );
  const smartGroupMemberPaths = useMemo(
    () => evaluateSmartGroups(sidebarPrefs, smartGroupCandidates, Date.now()),
    [sidebarPrefs, smartGroupCandidates]
  );

  const knownGroupMembers = useMemo(
    () => groupMemberItems(sidebarPrefs, itemIndex, smartGroupMemberPaths),
    [sidebarPrefs, itemIndex, smartGroupMemberPaths]
  );

  // ── Smart-group create/edit chrome (DOR-338 spec §4-5) ──
  const runtimeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of smartGroupCandidates) {
      if (!seen.has(c.runtime)) seen.set(c.runtime, getRuntimeDescriptor(c.runtime).label);
    }
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [smartGroupCandidates]);
  const namespaceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of smartGroupCandidates) if (c.namespace) set.add(c.namespace);
    return Array.from(set).sort();
  }, [smartGroupCandidates]);
  // "Small cockpits see zero new chrome" (spec §5) — the fork and its presets
  // only appear once the fleet is large or varied enough to benefit.
  const smartGroupsUnlocked = useMemo(
    () => meetsSmartGroupDisclosureThreshold(smartGroupCandidates),
    [smartGroupCandidates]
  );
  const smartGroupPresets = useMemo<SmartGroupPreset[]>(
    () =>
      smartGroupsUnlocked ? [activeNowPreset(), ...byRuntimePresets(smartGroupCandidates)] : [],
    [smartGroupsUnlocked, smartGroupCandidates]
  );

  // Pre-filter/pre-sort — UngroupedSection filters then sorts internally,
  // same order of operations as a group section (spec: sorting applies after
  // filtering).
  const ungroupedItems = useMemo(
    () =>
      rawPaths.flatMap((path) => {
        if (groupedSet.has(path)) return [];
        const item = itemIndex.byAgentPath.get(path);
        return item ? [item] : [];
      }),
    [rawPaths, groupedSet, itemIndex]
  );

  // A room in a group renders there and nowhere else, matching how the Agents
  // section has always shown only ungrouped agents (sidebar-groups §4).
  const ungroupedChannels = useMemo(
    () => channels.filter((room) => !groupedRooms.has(room.id)),
    [channels, groupedRooms]
  );
  const ungroupedDms = useMemo(
    () => dms.filter((room) => !groupedRooms.has(room.id)),
    [dms, groupedRooms]
  );
  // "Mark all … read" means every room of that kind, including the ones filed
  // into a group and drawn somewhere else entirely — so the lists it works from
  // are the whole kind, not the section's own rows.
  const unreadChannelIds = useMemo(
    () => channels.filter(hasUnread).map((room) => room.id),
    [channels]
  );
  const unreadDmIds = useMemo(() => dms.filter(hasUnread).map((room) => room.id), [dms]);
  // The mark a room row draws, from the one place that resolves faces. The
  // fallback is the type's floor rather than a behaviour: the index is built
  // from the same query these lists are partitioned out of, so every room in
  // them has an entry.
  const roomVisualOf = useCallback(
    (room: RoomSummary): SidebarItemVisual =>
      itemIndex.byRoomId.get(room.id)?.visual ?? { kind: 'sigil' },
    [itemIndex]
  );

  const agentCount = rawPaths.length;
  const organized = sidebarPrefs.groups.length > 0 || pinnedItems.length > 0;
  // Discovery nudge: only for a fleet big enough to benefit, with no groups yet,
  // and never again once dismissed (Resolved Q — organization is user investment).
  const showGroupsHint =
    agentCount >= 8 &&
    sidebarPrefs.groups.length === 0 &&
    !isSuggestionRetired(sidebarPrefs, GROUPS_HINT_SUGGESTION_ID);

  // ── One-time migration of legacy localStorage pins → server config (DOR-329) ──
  // If the old `dorkos-pinned-agents` key exists and the server has no pins yet,
  // seed the server pins from it (order preserved); server state wins when it
  // already has pins. The key's presence IS the migration flag — it is removed
  // afterward either way, so re-mounts and reloads are no-ops.
  const pinMigrationDoneRef = useRef(false);
  useEffect(() => {
    if (pinMigrationDoneRef.current) return;
    if (config === undefined) return; // wait for real server config
    const raw = localStorage.getItem(LEGACY_PINNED_STORAGE_KEY);
    if (raw === null) {
      pinMigrationDoneRef.current = true;
      return;
    }
    pinMigrationDoneRef.current = true;
    let stored: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      stored = [];
    }
    if (sidebarPrefs.pinned.length === 0 && stored.length > 0) {
      updateSidebarPrefs((prev) => ({
        ...prev,
        pinned: stored.map((path) => ({ kind: 'agent', path })),
      }));
    }
    localStorage.removeItem(LEGACY_PINNED_STORAGE_KEY);
  }, [config, sidebarPrefs.pinned.length, updateSidebarPrefs]);

  // ── Sessions for the active agent (canonical cwd-scoped selector, DOR-203) ──
  const {
    sessions: agentSessions,
    activeSessionId,
    isLoading: sessionsLoading,
  } = useAgentSessions(selectedCwd);
  const previewSessions = useMemo(() => agentSessions.slice(0, 3), [agentSessions]);

  // ── Expanded agent tracking — auto-expand active agent ──
  const [expandedPath, setExpandedPath] = useState<string | null>(selectedCwd);
  useEffect(() => {
    setExpandedPath(selectedCwd);
  }, [selectedCwd]);

  // ── Inline group-create flow ──
  const [groupCreation, setGroupCreation] = useState<GroupCreationState | null>(null);
  const handleRequestNewGroup = useCallback((ref?: SidebarItemRef) => {
    setGroupCreation({ pendingRef: ref ?? null });
  }, []);
  const handleCommitNewGroup = useCallback(
    (name: string) => {
      const pending = groupCreation?.pendingRef ?? null;
      updateSidebarPrefs((prev) => {
        const { next, id } = createGroup(prev, name);
        return pending ? moveToGroup(next, pending, id) : next;
      });
      setGroupCreation(null);
    },
    [groupCreation, updateSidebarPrefs]
  );
  const handleCancelNewGroup = useCallback(() => setGroupCreation(null), []);
  const handleDismissGroupsHint = useCallback(
    () => updateSidebarPrefs((prev) => retireSuggestion(prev, GROUPS_HINT_SUGGESTION_ID)),
    [updateSidebarPrefs]
  );

  // ── Smart-group create flow (DOR-338) — presets create immediately; "Custom
  // rules…" opens the same rule form the header's "Edit rules" reuses. ──
  const [smartGroupDialogOpen, setSmartGroupDialogOpen] = useState(false);
  const handleCreatePresetSmartGroup = useCallback(
    (preset: SmartGroupPreset) =>
      updateSidebarPrefs((prev) => createSmartGroup(prev, preset.label, preset.rules).next),
    [updateSidebarPrefs]
  );
  const handleOpenSmartGroupDialog = useCallback(() => setSmartGroupDialogOpen(true), []);
  const handleSubmitSmartGroupDialog = useCallback(
    ({ name, rules }: { name: string; rules: SmartGroupRules }) =>
      updateSidebarPrefs((prev) => createSmartGroup(prev, name, rules).next),
    [updateSidebarPrefs]
  );

  // ── Handlers ──
  const handleSelectAgent = useCallback(
    (agentPath: string) => {
      // Clicking an agent resumes its most recent conversation. The lookup goes
      // through the shared resolver rather than reading this tab's cache
      // directly: the roster lists every agent, but only the one this window has
      // opened has a cached session list, so a cache read alone would send you
      // to an empty chat for every other one (DOR-928).
      // The lookup is asynchronous while every row around it is not, so it
      // guards against being overtaken: by another agent click, and by any of
      // the app's other navigations, which it notices through the router's own
      // location rather than by asking them to cooperate.
      const isStillWanted = beginSessionNavigation(() => router.state.location);
      void resolveSessionForCwd({ queryClient, transport }, agentPath)
        .then((resolved) => {
          // Overtaken first: an abandoned lookup neither moves you nor explains
          // itself — you are somewhere else now, and "we left you where you are"
          // would be about a place you have left.
          if (!isStillWanted()) return;
          if (resolved === null) {
            notifySessionLookupFailed(agentPath);
            return;
          }
          navigate({ to: '/session', search: { dir: agentPath, session: resolved.sessionId } });
        })
        .catch((error: unknown) => {
          // The resolver handles its own failures, so a throw here is a defect
          // in this callback — which would otherwise be an unhandled rejection
          // and a click that died in silence. Reported either way; only the
          // message to the person waits on them still wanting this.
          reportClientError(transport, error);
          if (isStillWanted()) notifySessionLookupFailed(agentPath);
        });
    },
    [navigate, router, queryClient, transport]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigate({ to: '/session', search: (prev) => ({ ...prev, session: sessionId }) });
    },
    [navigate]
  );

  const handleResumeRecentSession = useCallback(
    (session: Session) => {
      navigate({ to: '/session', search: { dir: session.cwd ?? undefined, session: session.id } });
    },
    [navigate]
  );

  const startNewSession = useStartNewSession();
  const handleNewSession = useCallback((dir?: string) => startNewSession(dir), [startNewSession]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPath((prev) => (prev === path ? null : path));
  }, []);

  const handleOpenProfile = useCallback(
    (path: string) => {
      useAgentHubStore.getState().openHub(path);
      setRightPanelOpen(true);
      setActiveRightPanelTab('agent-hub');
    },
    [setRightPanelOpen, setActiveRightPanelTab]
  );

  // `undefined` — never a no-op handler — for an agent the mesh cannot name, so
  // the face renders as plain art instead of a control that opens nothing.
  const viewProfileFor = useCallback(
    (path: string) => {
      const memberId = memberIdByPath.get(path);
      return memberId === undefined ? undefined : () => openProfile(memberId);
    },
    [memberIdByPath, openProfile]
  );

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const forked = await transport.forkSession(sessionId, undefined, selectedCwd ?? undefined);
        await queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });
        navigate({ to: '/session', search: (prev) => ({ ...prev, session: forked.id }) });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to fork session');
      }
    },
    [transport, selectedCwd, queryClient, navigate]
  );

  const renameSession = useRenameSession(selectedCwd);
  const handleRenameSession = useCallback(
    (sessionId: string, title: string) => {
      renameSession.mutate({ sessionId, title });
    },
    [renameSession]
  );

  // ── Shared row renderers (keep section components lean; keyPrefix lets a
  // pinned reference coexist with its home copy). `draggable: false` renders
  // the row without a `Sortable` wrapper at all — smart-group members
  // (DOR-338) are rule-owned, never a drag source. ──
  const renderAgentRow = useCallback(
    (
      path: string,
      visual: AgentVisual,
      keyPrefix: string,
      options?: { draggable?: boolean }
    ): ReactNode => {
      const isActive = selectedCwd === path && pathname === '/session';
      const ref: SidebarItemRef = { kind: 'agent', path };
      const itemProps = {
        path,
        agent: agents?.[path] ?? null,
        displayName: displayNamesRecord[path],
        visual,
        isActive,
        isExpanded: expandedPath === path,
        isMuted: effectiveMutedForRender.has(path),
        onSelect: () => handleSelectAgent(path),
        onToggleExpand: () => handleToggleExpand(path),
        onOpenProfile: () => handleOpenProfile(path),
        onViewProfile: viewProfileFor(path),
        onRequestNewGroup: handleRequestNewGroup,
        sessions: isActive ? previewSessions : [],
        isLoadingSessions: isActive && sessionsLoading,
        activeSessionId,
        onSessionClick: handleSessionClick,
        onNewSession: () => handleNewSession(path),
        onForkSession: handleForkSession,
        onRenameSession: handleRenameSession,
      };
      if (options?.draggable === false) {
        return (
          <AgentListItem
            key={`${keyPrefix}-${path}`}
            {...itemProps}
            sortable={DISABLED_SORTABLE_BINDINGS}
          />
        );
      }
      return (
        <Sortable
          key={`${keyPrefix}-${path}`}
          id={sidebarRowDndId(keyPrefix, ref)}
          data={sidebarDndData(keyPrefix, ref)}
        >
          {(bindings) => <AgentListItem {...itemProps} sortable={bindings} />}
        </Sortable>
      );
    },
    [
      selectedCwd,
      pathname,
      agents,
      viewProfileFor,
      displayNamesRecord,
      expandedPath,
      effectiveMutedForRender,
      previewSessions,
      sessionsLoading,
      activeSessionId,
      handleSelectAgent,
      handleToggleExpand,
      handleOpenProfile,
      handleRequestNewGroup,
      handleSessionClick,
      handleNewSession,
      handleForkSession,
      handleRenameSession,
    ]
  );

  // The one place a stored reference becomes a row. Dispatching on `ref.kind`
  // here is what lets every section stay kind-agnostic and keeps both row
  // components unforked (sidebar-groups §4).
  const renderSidebarItem = useCallback<RenderSidebarItem>(
    (item: SidebarItem, keyPrefix, options) => {
      if (item.ref.kind === 'agent') {
        const [face] = sidebarItemFaces(item.visual);
        // `agentSidebarItem` always builds an `identity` visual, so an agent
        // item always has exactly one face — but the union cannot say so here
        // and this deliberately does NOT hash a replacement. A second
        // resolution site is what let the DM and the agent row disagree in the
        // first place (DOR-582); drawing no row is loud, drawing a
        // differently-hashed face would be the same bug wearing a fix.
        if (face === undefined) return null;
        return renderAgentRow(item.ref.path, face, keyPrefix, options);
      }
      const room = roomsById.get(item.ref.roomId);
      // The index and this map are built from the same query, so a room item
      // always has its room. Answering `null` rather than throwing keeps a
      // torn render from taking the whole sidebar down with it.
      if (room === undefined) return null;
      const key = `${keyPrefix}-${sidebarItemKey(item.ref)}`;
      const roomProps = {
        room,
        visual: item.visual,
        isActive: room.id === activeRoomId,
        onSelect: () => handleSelectRoom(room),
        onOpenAgentProfile: handleOpenProfile,
        onRequestNewGroup: handleRequestNewGroup,
      };
      // Same rule the agent row follows: `draggable: false` renders with no
      // `Sortable` wrapper at all, for a smart group's rule-owned members.
      if (options?.draggable === false) return <RoomRow key={key} {...roomProps} />;
      return (
        <Sortable
          key={key}
          id={sidebarRowDndId(keyPrefix, item.ref)}
          data={sidebarDndData(keyPrefix, item.ref)}
        >
          {(bindings) => <RoomRow {...roomProps} sortable={bindings} />}
        </Sortable>
      );
    },
    [
      renderAgentRow,
      roomsById,
      activeRoomId,
      handleSelectRoom,
      handleOpenProfile,
      handleRequestNewGroup,
    ]
  );

  return (
    <>
      <SidebarNavHeader />

      {/* **The sidebar's whole horizontal inset, paid here and at the row.**
          Eight pixels of panel padding plus eight on every row is the 16px total
          left inset the density calls for (design-decisions §11) — replacing the
          30px that used to stack up from three levels each adding its own
          (`p-3` here, `p-2` on every group, `px-2.5` on every row). Groups now
          pass `px-0`, so nothing between the panel edge and the row's own
          padding adds anything. */}
      <SidebarContent className="sidebar-scroll-edges px-2 py-3">
        <SidebarDnd displayNames={displayNamesRecord} roomTitles={roomTitles}>
          <JumpBackInSection
            items={jumpBackIn.items}
            automated={jumpBackIn.automated}
            isLoading={jumpBackIn.isLoading}
            warnings={jumpBackIn.warnings}
            agents={agents ?? {}}
            displayNames={displayNamesRecord}
            visualOf={roomVisualOf}
            activeRoomId={activeRoomId}
            activeSessionId={activeSessionOnScreen}
            onSelectSession={handleResumeRecentSession}
            onSelectRoom={handleSelectRoom}
            onNewSession={() => handleNewSession()}
          />

          <ThreadsSection
            threads={threads}
            error={threadsQuery.error}
            activeThreadId={activeThreadId}
            onSelectThread={handleSelectThread}
          />

          <ChannelsSection
            channels={ungroupedChannels}
            hasGroupedChannels={ungroupedChannels.length < channels.length}
            unreadChannelIds={unreadChannelIds}
            visualOf={roomVisualOf}
            isLoading={roomsQuery.isLoading}
            error={roomsQuery.error}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            onOpenAgentProfile={handleOpenProfile}
            onRequestNewGroup={handleRequestNewGroup}
          />

          <DirectMessagesSection
            dms={ungroupedDms}
            hasGroupedDms={ungroupedDms.length < dms.length}
            unreadDmIds={unreadDmIds}
            visualOf={roomVisualOf}
            isLoading={roomsQuery.isLoading}
            error={roomsQuery.error}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            onOpenAgentProfile={handleOpenProfile}
            onRequestNewGroup={handleRequestNewGroup}
          />

          {pinnedItems.length > 0 && (
            <PinnedSection items={pinnedItems} renderItem={renderSidebarItem} />
          )}

          <SortableList items={sidebarPrefs.groups.map((g) => `group-header::${g.id}`)}>
            <AnimatePresence initial={false}>
              {sidebarPrefs.groups.map((group) => (
                <motion.div
                  key={group.id}
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.2, ease: [0, 0, 0.2, 1] },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
                >
                  <SidebarGroupSection
                    group={group}
                    items={knownGroupMembers.get(group.id) ?? []}
                    mutedPaths={mutedPathsSet}
                    renderItem={renderSidebarItem}
                    runtimeOptions={runtimeOptions}
                    namespaceOptions={namespaceOptions}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </SortableList>

          <AnimatePresence>
            {groupCreation !== null && (
              <motion.div
                key="group-create"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0, 0, 0.2, 1] } }}
                exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
              >
                <SidebarGroup className="px-0">
                  <SidebarMenu>
                    <GroupCreateInput
                      onCommit={handleCommitNewGroup}
                      onCancel={handleCancelNewGroup}
                    />
                  </SidebarMenu>
                </SidebarGroup>
              </motion.div>
            )}
          </AnimatePresence>

          <UngroupedSection
            items={ungroupedItems}
            organized={organized}
            allAgentsGrouped={agentCount > 0 && ungroupedItems.length === 0}
            sortMode={sectionSortMode(sidebarPrefs, 'agents', ['name', 'recent'])}
            filter={sectionDisplayFilter(sidebarPrefs, 'agents', 'all')}
            renderItem={renderSidebarItem}
            onNewGroup={() => handleRequestNewGroup()}
            smartGroupPresets={smartGroupPresets}
            onCreatePresetSmartGroup={handleCreatePresetSmartGroup}
            onOpenSmartGroupDialog={handleOpenSmartGroupDialog}
          />
        </SidebarDnd>

        <SmartGroupRuleDialog
          open={smartGroupDialogOpen}
          onOpenChange={setSmartGroupDialogOpen}
          mode="create"
          runtimeOptions={runtimeOptions}
          namespaceOptions={namespaceOptions}
          onSubmit={handleSubmitSmartGroupDialog}
        />

        <AnimatePresence>
          {showGroupsHint && (
            <GroupsHintCard
              onNewGroup={() => handleRequestNewGroup()}
              onDismiss={handleDismissGroupsHint}
            />
          )}
        </AnimatePresence>

        {/* Progressive empty state — less prominent as the roster grows */}
        {agentCount <= 2 && (
          <AgentOnboardingCard onAddAgent={() => useAgentCreationStore.getState().open()} />
        )}
        {agentCount >= 3 && agentCount <= 4 && (
          <button
            type="button"
            onClick={() => useAgentCreationStore.getState().open()}
            className="text-sidebar-foreground/70 hover:text-sidebar-foreground mt-1 flex items-center gap-1.5 px-2 text-xs font-medium transition-colors"
          >
            <Plus className="size-3.5" />
            Add agent
          </button>
        )}

        <PromoSlot placement="dashboard-sidebar" maxUnits={3} />
      </SidebarContent>
    </>
  );
}
