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
import {
  SIDEBAR_LIBRARY_SECTION_IDS,
  type LibrarySectionId,
  type SidebarRowModel,
  type SidebarSectionModel,
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
 * Whether the Agents section offers grouping at all (BC-32).
 *
 * Exported because it gates real chrome — the "New group" item in the Agents
 * header menu and the smart-group presets behind its `+` — and the decision is
 * a rule, so it belongs here rather than in JSX.
 *
 * **It takes the fleet rather than the snapshot**, because that is all it
 * reads, and because its one caller in the running application is a component
 * that has the roster and not a `SidebarState` (`useSectionChrome`). A rule
 * that demanded the whole snapshot would have been unreachable from the only
 * place it matters, which is how it spent P2.1 exported, unit-tested and called
 * by nothing.
 *
 * @param agents - The fleet, or anything carrying each agent's runtime.
 */
export function offersGroupAffordances(agents: readonly { runtime: string }[]): boolean {
  if (agents.length >= GROUP_AFFORDANCE_MIN_AGENTS) return true;
  return new Set(agents.map((agent) => agent.runtime)).size >= 2;
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
 * stored `items` are ignored here, exactly as the grouped-membership pass in
 * {@link buildLibrarySections} ignores them.
 *
 * **This is the one section that renders while empty**, and the exception is
 * deliberate: every other section in this file appears because something is in
 * it (BC-32), while a group appears because the operator made it. A group that
 * vanished the moment it was created could never be dragged into.
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
): SidebarSectionModel {
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
      // A smart group's members are rule-owned, so they are not drag sources:
      // dragging one out would ask the operator to hand-edit a list the rules
      // rebuild on the next render. `classifySidebarDrop` refuses a drop INTO
      // one for the same reason; this is the other half of it.
      if (agent)
        rows.push({ ...agentRow(agent, state, mutes, 'library:group-member'), draggable: false });
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
  // An empty group still renders, and it is the ONE section that may. Every
  // other section in this file exists because something is in it (BC-32); a
  // group exists because the operator MADE it, and a group that vanished the
  // moment it was created could never be dragged into. The renderer fills it
  // with a hint — "drag things here", or "no agents match these rules" —
  // which is information rather than disappearance.
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

/** What one Library section holds, before {@link section} decides it exists. */
interface LibrarySectionContent {
  /** Its heading. */
  label: string;
  /** Its rows, already filtered and ordered. */
  rows: SidebarRowModel[];
  /** Its provenance. */
  reason: string;
  /** Its group sub-headers — Agents only. */
  subsections?: SidebarSectionModel[];
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

  // ── The Agents pipeline ──
  // A second composition lives inside this one, and it is worth saying so:
  // from the entry point above this reads as a single rule, while Agents is
  // actually four steps in a fixed order — who is ungrouped, then what the
  // display filter shows (`filteredAgentRows`), then what order they come in
  // (`orderLibraryRows`), then one `revealRow` standing for whatever the filter
  // hid. Filter BEFORE sort, matching how a group section has always ordered
  // its own two, and the reveal row is appended last so it never sorts into the
  // middle of the list it is summarizing.
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
  const groups = state.prefs.groups.map((group) =>
    groupSection(group, state, mutes, byPath, rooms)
  );

  // What each of the four sections holds, keyed by id. A `Record` over
  // `LibrarySectionId` rather than a list, so adding an id to
  // `SIDEBAR_LIBRARY_SECTION_IDS` fails to compile here until it is given
  // content — which is what makes that tuple's docblock true.
  const content: Record<LibrarySectionId, LibrarySectionContent> = {
    pins: { label: 'Pins', rows: pinnedRows, reason: 'library:pins' },
    channels: {
      label: 'Channels',
      rows: orderLibraryRows(
        channelRows,
        state.prefs.sections.channels?.sortMode ?? 'name',
        () => null
      ),
      reason: 'library:channels',
    },
    dms: {
      label: 'Direct messages',
      rows: orderLibraryRows(dmRows, state.prefs.sections.dms?.sortMode ?? 'name', () => null),
      reason: 'library:dms',
    },
    agents: {
      label: 'Agents',
      rows: reveal ? [...agentRows, reveal] : agentRows,
      reason: 'library:agents',
      subsections: groups,
    },
  };

  // The tuple IS the order, so this walks it rather than repeating the four ids.
  return SIDEBAR_LIBRARY_SECTION_IDS.map((id) =>
    section(
      id,
      content[id].label,
      content[id].rows,
      state,
      content[id].reason,
      content[id].subsections
    )
  ).filter((entry): entry is SidebarSectionModel => entry !== null);
}
