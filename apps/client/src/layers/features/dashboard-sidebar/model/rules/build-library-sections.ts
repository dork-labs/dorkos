/**
 * Library — the structure the operator built themselves, never reordered by us
 * (BC-28 → BC-33).
 *
 * Prediction is additive: Now and Today are computed and may move every render.
 * Everything in here stays exactly where it was put, which is what makes the
 * spatial memory worth having.
 *
 * @module features/dashboard-sidebar/model/rules/build-library-sections
 */
import type { SidebarGroup } from '@dorkos/shared/config-schema';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { evaluateSmartGroup } from '@dorkos/shared/smart-groups';
import type {
  LibrarySectionId,
  SidebarRowModel,
  SidebarSectionModel,
} from '../build-sidebar-model';
import type { AgentRosterEntry, SidebarState } from '../sidebar-state';
import { muteIndex, type MuteIndex } from './apply-mute-rules';
import { agentRow, roomLibraryRow } from './library-rows';
import { rollUpCollapsedSection } from './roll-up-collapsed-section';
import { rowKey } from './targets';

/**
 * When group affordances appear: eight agents, or two runtimes.
 *
 * Chrome appears by data volume rather than by a settings toggle
 * (design-meta rule 8) — somebody with three agents has nothing to organize,
 * and somebody running Claude Code beside Codex already has a reason to.
 */
export const GROUP_AFFORDANCE_MIN_AGENTS = 8;

/**
 * Whether the Agents section offers grouping at all.
 *
 * Exported rather than folded into the section, because it gates a create
 * action and a hint that P2 renders in the header — and the decision is a rule,
 * so it belongs here rather than in JSX.
 *
 * @param state - The snapshot.
 */
export function offersGroupAffordances(state: SidebarState): boolean {
  if (state.agents.length >= GROUP_AFFORDANCE_MIN_AGENTS) return true;
  return new Set(state.agents.map((agent) => agent.runtime)).size >= 2;
}

/**
 * The reveal row that stands for rows a filter hid, or `null` when it hid none.
 *
 * @param count - How many rows are behind it.
 * @param label - What they have in common, e.g. `'inactive'`.
 */
function revealRow(count: number, label: string): SidebarRowModel | null {
  if (count === 0) return null;
  const target = { kind: 'rollup', rollup: 'section-count' } as const;
  return {
    key: `${rowKey(target)}:${label}`,
    target,
    glyph: { kind: 'icon', icon: 'overflow' },
    primary: `${count} ${label}`,
    status: 'idle',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    actions: ['open'],
    reason: 'library:reveal',
  };
}

/**
 * The state a filter judges an agent by, with mute's downgrade applied.
 *
 * A muted agent's `needs-attention` caps at `active` — mute means "do not put
 * this in front of me", and the attention filter is exactly the thing that
 * would.
 *
 * @param agent - The roster entry.
 * @param muted - Whether it renders muted.
 */
function effectiveAttention(agent: AgentRosterEntry, muted: boolean) {
  return muted && agent.attention === 'needs-attention' ? 'active' : agent.attention;
}

/**
 * Agent rows split into what a section's display filter shows and what it hides.
 *
 * The same three branches `filterSidebarItems` applies today, expressed over
 * rows: `'all'` tucks never-active agents behind a reveal, `'active'` and
 * `'attention'` hide everything below their bar.
 *
 * @param agents - The agents in this section, in their pre-filter order.
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param filter - The section's display filter.
 * @param reason - The reason to stamp on each row.
 */
function filteredAgentRows(
  agents: readonly AgentRosterEntry[],
  state: SidebarState,
  mutes: MuteIndex,
  filter: string | undefined,
  reason: string
): { rows: SidebarRowModel[]; hidden: number; hiddenLabel: string } {
  const rows: SidebarRowModel[] = [];
  let hidden = 0;
  for (const agent of agents) {
    const muted = mutes.agents.has(agent.path);
    const attention = effectiveAttention(agent, muted);
    const keep =
      filter === 'attention'
        ? attention === 'needs-attention' && !muted
        : filter === 'active'
          ? attention === 'needs-attention' || attention === 'active'
          : attention !== 'inactive';
    if (!keep) {
      hidden += 1;
      continue;
    }
    rows.push(agentRow(agent, state, mutes, reason));
  }
  return {
    rows,
    hidden,
    hiddenLabel: filter === 'active' || filter === 'attention' ? 'hidden' : 'inactive',
  };
}

/**
 * Rows in the order a section asks for.
 *
 * `'manual'` is the identity: the order they came in IS the operator's order,
 * and a sort that "improves" it is the one thing Library promises never to do.
 *
 * @param rows - The section's rows.
 * @param sortMode - What the section is sorted by.
 * @param recencyOf - When each row's subject was last active, epoch ms.
 */
function orderLibraryRows(
  rows: readonly SidebarRowModel[],
  sortMode: string | undefined,
  recencyOf: (row: SidebarRowModel) => number | null
): SidebarRowModel[] {
  if (sortMode === 'name') {
    return [...rows].sort(
      (a, b) => a.primary.localeCompare(b.primary) || a.key.localeCompare(b.key)
    );
  }
  if (sortMode === 'recent') {
    return [...rows].sort((a, b) => {
      const atA = recencyOf(a) ?? Number.NEGATIVE_INFINITY;
      const atB = recencyOf(b) ?? Number.NEGATIVE_INFINITY;
      return atB - atA || a.key.localeCompare(b.key);
    });
  }
  return [...rows];
}

/**
 * One Library section, or `null` when it holds nothing.
 *
 * Chrome appears by data volume: no Direct messages section until a DM exists,
 * no Pins section until something is pinned (BC-32). Returning `null` is how
 * that promise is kept in one place instead of at four call sites.
 *
 * @param id - Which Library section this is. Narrower than
 *   `SidebarSectionModel['id']` on purpose: this helper reads the section's
 *   STORED collapse and options, and only a persisted Library section has any.
 *   Now, Today, Getting started and group sub-headers never reach here.
 * @param label - Its heading.
 * @param rows - Its rows.
 * @param state - The snapshot.
 * @param reason - Its provenance.
 * @param subsections - Its group sub-headers, when it has any.
 */
function section(
  id: LibrarySectionId,
  label: string,
  rows: SidebarRowModel[],
  state: SidebarState,
  reason: string,
  subsections?: SidebarSectionModel[]
): SidebarSectionModel | null {
  if (rows.length === 0 && (subsections?.length ?? 0) === 0) return null;
  const prefs = state.prefs.sections[id];
  const collapsed = prefs?.collapsed ?? false;
  const all = [...rows, ...(subsections ?? []).flatMap((sub) => sub.rows)];
  const rollup = collapsed ? rollUpCollapsedSection(all) : undefined;
  return {
    id,
    label,
    collapsible: true,
    collapsed,
    ...(rollup ? { rollup } : {}),
    ...(prefs?.sortMode || prefs?.displayFilter
      ? {
          options: {
            ...(prefs.sortMode ? { sortMode: prefs.sortMode } : {}),
            ...(prefs.displayFilter ? { displayFilter: prefs.displayFilter } : {}),
          },
        }
      : {}),
    rows,
    ...(subsections && subsections.length > 0 ? { subsections } : {}),
    reason,
  };
}

/**
 * One group as a sub-header inside Agents — one indent level, and no deeper.
 *
 * A smart group's membership is evaluated live and never persisted, so its
 * stored `items` are ignored here exactly as `groupedAgentPaths` ignores them.
 *
 * @param group - The group.
 * @param state - The snapshot.
 * @param mutes - The resolved mute sets.
 * @param byPath - The roster, by path.
 * @param rooms - Every room, by id.
 */
function groupSection(
  group: SidebarGroup,
  state: SidebarState,
  mutes: MuteIndex,
  byPath: Map<string, AgentRosterEntry>,
  rooms: Map<string, RoomSummary>
): SidebarSectionModel | null {
  const rows: SidebarRowModel[] = [];
  if (group.kind === 'smart' && group.rules) {
    const matched = evaluateSmartGroup(
      group.rules,
      state.agents.map((agent) => ({
        projectPath: agent.path,
        runtime: agent.runtime,
        namespace: agent.namespace,
        attention: agent.attention,
        lastActivityAt: agent.lastActivityAt,
      })),
      state.now
    );
    for (const path of matched) {
      const agent = byPath.get(path);
      if (agent) rows.push(agentRow(agent, state, mutes, 'library:group-member'));
    }
  } else {
    for (const ref of group.items) {
      if (ref.kind === 'agent') {
        const agent = byPath.get(ref.path);
        if (agent) rows.push(agentRow(agent, state, mutes, 'library:group-member'));
      } else {
        const room = rooms.get(ref.roomId);
        if (room) rows.push(roomLibraryRow(room, state, mutes, 'library:group-member'));
      }
    }
  }
  if (rows.length === 0) return null;
  const ordered = orderLibraryRows(rows, group.sortMode, (row) =>
    row.target.kind === 'agent' ? (byPath.get(row.target.path)?.lastActivityAt ?? null) : null
  );
  return {
    id: `group:${group.id}`,
    label: group.name,
    collapsible: true,
    collapsed: group.collapsed ?? false,
    ...(group.collapsed ? { rollup: rollUpCollapsedSection(ordered) } : {}),
    rows: ordered,
    reason: 'library:group',
  };
}

/**
 * Library's sections, in their fixed order: Pins, Channels, Direct messages,
 * Agents.
 *
 * A pinned item keeps its row in its home section too — pinning is a shortcut,
 * not a move — while a manual group's members leave the ungrouped list, which
 * is the membership rule the sidebar has always had.
 *
 * @param state - The snapshot.
 */
export function buildLibrarySections(state: SidebarState): SidebarSectionModel[] {
  const mutes = muteIndex(state.prefs);
  const byPath = new Map(state.agents.map((agent) => [agent.path, agent]));
  const rooms = new Map(
    state.rooms.filter((room) => !room.archived).map((room) => [room.id, room])
  );

  const groupedAgents = new Set<string>();
  const groupedRooms = new Set<string>();
  for (const group of state.prefs.groups) {
    if (group.kind === 'smart') continue;
    for (const ref of group.items) {
      if (ref.kind === 'agent') groupedAgents.add(ref.path);
      else groupedRooms.add(ref.roomId);
    }
  }

  const pinnedRows: SidebarRowModel[] = [];
  for (const ref of state.prefs.pinned) {
    if (ref.kind === 'agent') {
      const agent = byPath.get(ref.path);
      if (agent) pinnedRows.push(agentRow(agent, state, mutes, 'library:pinned'));
    } else {
      const room = rooms.get(ref.roomId);
      if (room) pinnedRows.push(roomLibraryRow(room, state, mutes, 'library:pinned'));
    }
  }

  const channelRows: SidebarRowModel[] = [];
  const dmRows: SidebarRowModel[] = [];
  for (const room of rooms.values()) {
    if (groupedRooms.has(room.id)) continue;
    const row = roomLibraryRow(
      room,
      state,
      mutes,
      room.kind === 'dm' ? 'library:dm' : 'library:channel'
    );
    (room.kind === 'dm' ? dmRows : channelRows).push(row);
  }

  const ungrouped = state.agents.filter((agent) => !groupedAgents.has(agent.path));
  const agentPrefs = state.prefs.sections.agents;
  const filtered = filteredAgentRows(
    ungrouped,
    state,
    mutes,
    agentPrefs?.displayFilter,
    'library:agent'
  );
  const agentRows = orderLibraryRows(filtered.rows, agentPrefs?.sortMode, (row) =>
    row.target.kind === 'agent' ? (byPath.get(row.target.path)?.lastActivityAt ?? null) : null
  );
  const reveal = revealRow(filtered.hidden, filtered.hiddenLabel);
  const groups = state.prefs.groups
    .map((group) => groupSection(group, state, mutes, byPath, rooms))
    .filter((sub): sub is SidebarSectionModel => sub !== null);

  return [
    section('pins', 'Pins', pinnedRows, state, 'library:pins'),
    section(
      'channels',
      'Channels',
      orderLibraryRows(channelRows, state.prefs.sections.channels?.sortMode ?? 'name', () => null),
      state,
      'library:channels'
    ),
    section(
      'dms',
      'Direct messages',
      orderLibraryRows(dmRows, state.prefs.sections.dms?.sortMode ?? 'name', () => null),
      state,
      'library:dms'
    ),
    section(
      'agents',
      'Agents',
      reveal ? [...agentRows, reveal] : agentRows,
      state,
      'library:agents',
      groups
    ),
  ].filter((entry): entry is SidebarSectionModel => entry !== null);
}
