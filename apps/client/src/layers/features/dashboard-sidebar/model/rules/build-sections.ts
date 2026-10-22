/**
 * The list, top to bottom: the top items, the operator's own sections,
 * Channels, Direct messages and Add-ons.
 *
 * **Places, never sessions or threads.** Every row is a channel, a direct
 * message, a page, or a door to a page that lists the rest. An agent appears
 * once, as its direct message — in Direct messages once there is one, or once
 * it is pinned, or in a section the operator filed it into — and every other
 * agent is in the Directory, one press away at the foot of the list.
 *
 * Nothing here is reordered by us: Channels and Direct messages sort the way
 * their header menus say, and a hand-made section holds what was put in it, in
 * the order it was put there. That is what makes the spatial memory worth
 * having.
 *
 * @module features/dashboard-sidebar/model/rules/build-sections
 */
import type { SidebarDisplayFilter, SidebarGroup } from '@dorkos/shared/config-schema';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { evaluateSmartGroup } from '@dorkos/shared/smart-groups';
import type {
  FixedSectionId,
  SidebarCommandId,
  SidebarIconId,
  SidebarRowModel,
  SidebarSectionModel,
} from '../build-sidebar-model';
import { SIDEBAR_SECTION_IDS } from '../build-sidebar-model';
import type { SidebarSortMode } from '../section-sort-options';
import type { AgentRosterEntry, SidebarState } from '../sidebar-state';
import { addOnRows } from './add-on-rows';
import { indexAgentDms, type AgentDmIndex } from './agent-direct-messages';
import { muteIndex } from './apply-mute-rules';
import { liveSessionIdsForPath } from './live-sessions';
import { rollUpCollapsedSection, rowNeedsYou } from './roll-up-collapsed-section';
import { agentRow, roomRow, type RowContext } from './section-rows';
import { rowKey } from './targets';

/**
 * When the SMART-section affordances appear: eight agents, or two runtimes.
 *
 * Chrome appears by data volume rather than by a settings toggle
 * (design-meta rule 8) — somebody with three agents has nothing to sort into
 * runtime presets, and somebody running Claude Code beside Codex already has a
 * reason to.
 */
export const GROUP_AFFORDANCE_MIN_AGENTS = 8;

/**
 * Whether a fleet is offered SMART sections — rule-based membership and the
 * runtime presets that seed it.
 *
 * **It no longer gates sections themselves.** Making a section by hand is
 * offered to everybody (D3): a person with three agents still has channels, a
 * conversation and a project to file together, and the old gate is why grouping
 * read as an agent-only, large-fleet feature. What is still gated is the part
 * that only means something with a fleet — "Active now", the per-runtime presets
 * and `Custom rules…`, all of which match on agent fields.
 *
 * **It takes the fleet rather than the snapshot**, because that is all it
 * reads, and because its caller is a component that has the roster and not a
 * `SidebarState`.
 *
 * @param agents - The fleet, or anything carrying each agent's runtime.
 */
export function offersGroupAffordances(agents: readonly { runtime: string }[]): boolean {
  if (agents.length >= GROUP_AFFORDANCE_MIN_AGENTS) return true;
  return new Set(agents.map((agent) => agent.runtime)).size >= 2;
}

/**
 * Whether one row's subject is streaming right now — the answer a folded
 * section's "agents working" dot counts (BC-31).
 *
 * **Asked of the source, never of the row's dot.** A row carries one status and
 * `needs-you` outranks `working`, so an agent that is both blocked and running
 * reads `needs-you` — and a folded section that counted dots lost the working
 * signal for exactly the members most worth knowing about (DOR-1137).
 *
 * An agent's answer comes from {@link liveSessionIdsForPath}, the human-origin
 * list every live mark in the panel reads. A room's comes from the
 * `working` field its summary already carries, which is a server-side count of
 * agents mid-turn in that room and has no origin dimension to apply — a room
 * turn IS the room's work.
 *
 * @param state - The snapshot.
 * @param rooms - The non-archived rooms, by id.
 */
function rowIsWorking(
  state: SidebarState,
  rooms: Map<string, RoomSummary>
): (row: SidebarRowModel) => boolean {
  return (row) => {
    if (row.target.kind === 'agent') {
      return liveSessionIdsForPath(state, row.target.path).length > 0;
    }
    if (row.target.kind === 'room') {
      return (rooms.get(row.target.roomId)?.working ?? 0) > 0;
    }
    return false;
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
 * Whether one agent survives a section's display filter.
 *
 * **`'all'` means all.** It used to mean "everything except what has been quiet
 * for a week", with the remainder tucked behind a reveal row — a filter named
 * for showing everything that hid things. A section the operator filled by
 * hand shows what they put in it.
 *
 * @param agent - The roster entry.
 * @param muted - Whether it renders muted.
 * @param filter - The section's display filter, absent meaning `'all'`.
 */
function passesDisplayFilter(
  agent: AgentRosterEntry,
  muted: boolean,
  filter: SidebarDisplayFilter | undefined
): boolean {
  const attention = effectiveAttention(agent, muted);
  if (filter === 'attention') return attention === 'needs-attention' && !muted;
  if (filter === 'active') return attention === 'needs-attention' || attention === 'active';
  return true;
}

/**
 * Rows in the order a section asks for.
 *
 * `'manual'` is the identity: the order they came in IS the operator's order,
 * and a sort that "improves" it is the one thing the sidebar promises never to
 * do.
 *
 * @param rows - The section's rows.
 * @param sortMode - What the section is sorted by.
 * @param recencyOf - When each row's subject was last active, epoch ms.
 */
function orderRows(
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
 * When each row's subject was last active, epoch ms, for either kind of row.
 *
 * **A room answers with its own timestamp, and that is a fix rather than a
 * detail.** It used to answer `null` for everything that was not an agent, which
 * `orderRows` reads as `-Infinity`: a section holding a channel and an
 * agent, sorted by "Recent activity", sank every channel to the bottom in
 * whatever order their keys happened to fall. The menu offered a sort it did not
 * perform.
 *
 * **An agent with a direct message answers with the conversation's time**,
 * because in Direct messages its row IS that conversation: a ping it sent you
 * moves it up the same way a person's message would. An agent with none
 * answers with when it last ran.
 *
 * @param byPath - The roster, by path.
 * @param rooms - Every non-archived room, by id.
 * @param dms - The agents' direct messages.
 */
function recencyResolver(
  byPath: Map<string, AgentRosterEntry>,
  rooms: Map<string, RoomSummary>,
  dms: AgentDmIndex
): (row: SidebarRowModel) => number | null {
  const parse = (iso: string | undefined) => {
    if (iso === undefined) return null;
    const at = Date.parse(iso);
    return Number.isNaN(at) ? null : at;
  };
  return (row) => {
    if (row.target.kind === 'agent') {
      const room = dms.roomByAgentPath.get(row.target.path);
      if (room !== undefined) return parse(room.lastActivityAt);
      return byPath.get(row.target.path)?.lastActivityAt ?? null;
    }
    if (row.target.kind === 'room') return parse(rooms.get(row.target.roomId)?.lastActivityAt);
    return null;
  };
}

/**
 * The `options` a section publishes so its header's radios read from the model
 * rather than from a second read of prefs, or `undefined` when it has none.
 *
 * @param sortMode - The stored sort, if any.
 * @param displayFilter - The stored filter, if any.
 */
function sectionOptions(
  sortMode: SidebarSortMode | undefined,
  displayFilter: SidebarDisplayFilter | undefined
): SidebarSectionModel['options'] | undefined {
  if (!sortMode && !displayFilter) return undefined;
  return {
    ...(sortMode ? { sortMode } : {}),
    ...(displayFilter ? { displayFilter } : {}),
  };
}

/**
 * One fixed section, or `null` when it holds nothing.
 *
 * Chrome appears by data volume: no Channels section without a channel, no
 * Add-ons section until a mini app adds a page (BC-32). Returning `null` is how
 * that promise is kept in one place instead of at every call site.
 *
 * @param id - Which fixed section this is. Narrower than
 *   `SidebarSectionModel['id']` on purpose: this helper reads the section's
 *   STORED collapse and options, and only a fixed section has any. The top
 *   items and hand-made sections never reach here.
 * @param label - Its heading.
 * @param rows - Its rows.
 * @param state - The snapshot.
 * @param reason - Its provenance.
 * @param isWorking - Whether a row's subject is streaming ({@link rowIsWorking}).
 */
function section(
  id: FixedSectionId,
  label: string,
  rows: SidebarRowModel[],
  state: SidebarState,
  reason: string,
  isWorking: (row: SidebarRowModel) => boolean
): SidebarSectionModel | null {
  return rows.length === 0 ? null : fixedSection(id, label, rows, state, reason, isWorking);
}

/**
 * One fixed section, drawn whatever it holds — {@link section} without the
 * "nothing in it, no section" rule, for Direct messages, which always stands.
 *
 * @param id - Which fixed section this is.
 * @param label - Its heading.
 * @param rows - Its rows. A folded section's rollup is read from exactly these.
 * @param state - The snapshot.
 * @param reason - Its provenance.
 * @param isWorking - Whether a row's subject is streaming ({@link rowIsWorking}).
 */
function fixedSection(
  id: FixedSectionId,
  label: string,
  rows: SidebarRowModel[],
  state: SidebarState,
  reason: string,
  isWorking: (row: SidebarRowModel) => boolean
): SidebarSectionModel {
  const prefs = state.prefs.sections[id];
  const collapsed = prefs?.collapsed ?? false;
  const rollup = collapsed
    ? rollUpCollapsedSection(rows, isWorking, rowNeedsYou(state))
    : undefined;
  const options = sectionOptions(prefs?.sortMode, prefs?.displayFilter);
  return {
    id,
    label,
    collapsible: true,
    collapsed,
    ...(rollup ? { rollup } : {}),
    ...(options ? { options } : {}),
    rows,
    reason,
  };
}

/**
 * One hand-made section — a peer of Channels and Direct messages (D3).
 *
 * A smart section's membership is evaluated live and never persisted, so its
 * stored `items` are ignored here, exactly as the membership pass in
 * {@link buildSections} ignores them.
 *
 * **This is the one section that renders while empty**, and the exception is
 * deliberate: every other section in this file appears because something is in
 * it (BC-32), while a section appears because the operator made it. A section
 * that vanished the moment it was created could never be dragged into.
 *
 * **Its display filter is applied here.** For three releases the filter was
 * stored, offered in the header menu, ticked, and read by nobody — the only
 * list it ever narrowed was ungrouped Agents (DOR-1371). The header radio now
 * reads back from `options`, so what the menu says and what the section shows
 * are one fact.
 *
 * @param group - The section, as stored.
 * @param state - The snapshot.
 * @param ctx - What every row here is built with ({@link RowContext}).
 * @param byPath - The roster, by path.
 * @param rooms - Every room, by id.
 * @param isWorking - Whether a row's subject is streaming ({@link rowIsWorking}).
 * @param recencyOf - When a row's subject was last active ({@link recencyResolver}).
 */
function groupSection(
  group: SidebarGroup,
  state: SidebarState,
  ctx: RowContext,
  byPath: Map<string, AgentRosterEntry>,
  rooms: Map<string, RoomSummary>,
  isWorking: (row: SidebarRowModel) => boolean,
  recencyOf: (row: SidebarRowModel) => number | null
): SidebarSectionModel {
  const rows: SidebarRowModel[] = [];
  /** One agent's row, or nothing when the section's filter hides it. */
  const pushAgent = (agent: AgentRosterEntry, draggable: boolean) => {
    if (!passesDisplayFilter(agent, ctx.mutes.agents.has(agent.path), group.displayFilter)) return;
    const row = agentRow(agent, state, ctx, 'group:member');
    rows.push(draggable ? row : { ...row, draggable: false });
  };

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
      // A smart section's members are rule-owned, so they are not drag sources:
      // dragging one out would ask the operator to hand-edit a list the rules
      // rebuild on the next render. `classifySidebarDrop` refuses a drop INTO
      // one for the same reason; this is the other half of it.
      if (agent) pushAgent(agent, false);
    }
  } else {
    for (const ref of group.items) {
      if (ref.kind === 'agent') {
        const agent = byPath.get(ref.path);
        if (agent) pushAgent(agent, true);
      } else {
        const room = rooms.get(ref.roomId);
        // A room has no attention state, so no display filter can judge one:
        // "Needs attention" is an agent question, and a channel the operator
        // filed here stays filed here whatever the radio says.
        if (room) rows.push(roomRow(room, state, ctx, 'group:member'));
      }
    }
  }
  const ordered = orderRows(rows, group.sortMode, recencyOf);
  // **No `options` here, and that is not an oversight.** A fixed section
  // publishes them because its header has nowhere else to read them from; a
  // hand-made section's header already holds the whole `SidebarGroup` — sort,
  // filter, mute, rules — and `useSectionChrome` builds its menu from that.
  // Emitting a second copy would be one more place for the two to disagree.
  return {
    id: `group:${group.id}`,
    label: group.name,
    collapsible: true,
    collapsed: group.collapsed ?? false,
    ...(group.collapsed
      ? { rollup: rollUpCollapsedSection(ordered, isWorking, rowNeedsYou(state)) }
      : {}),
    rows: ordered,
    reason: 'section:group',
  };
}

/** What one fixed section holds, before {@link section} decides it exists. */
interface SectionContent {
  /** Its heading. */
  label: string;
  /** Its rows, already filtered and ordered. */
  rows: SidebarRowModel[];
  /** Its provenance. */
  reason: string;
}

/**
 * A door: a row that opens a page rather than a conversation.
 *
 * Never dragged, never muted, never unread — the page it opens is where those
 * things live.
 *
 * @param commandId - What pressing it does.
 * @param icon - The glyph it draws.
 * @param primary - What it says.
 * @param reason - Its provenance.
 */
function doorRow(
  commandId: SidebarCommandId,
  icon: SidebarIconId,
  primary: string,
  reason: string
): SidebarRowModel {
  const target = { kind: 'command', commandId } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'icon', icon },
    primary,
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason,
  };
}

/**
 * The headerless block at the head of the list: a door to each page that
 * holds what the list deliberately does not.
 *
 * **A top item never shows before its page exists.** Threads holds every thread
 * you are in, the Directory every agent and person; each is here because its
 * page is.
 */
function topSection(): SidebarSectionModel {
  return {
    id: 'top',
    label: null,
    collapsible: false,
    collapsed: false,
    rows: [
      doorRow('open-threads', 'threads', 'Threads', 'top:threads'),
      doorRow('open-directory', 'directory', 'Directory', 'top:directory'),
    ],
    reason: 'section:top',
  };
}

/**
 * Direct messages: one row per agent you have a direct message with, one per
 * conversation with people or with several agents, and the pinned agents.
 *
 * **An agent's direct message IS the agent's row** ({@link indexAgentDms}): its
 * face, its name and its menu, opening its Direct chat. A pinned agent you have
 * not written to yet is here too — pinning is how an agent is kept in reach —
 * and an agent filed into a section of the operator's own is drawn there
 * instead, which is the membership rule the sidebar has always had.
 *
 * @param state - The snapshot.
 * @param ctx - What every row is built with.
 * @param dms - The agents' direct messages.
 * @param rooms - The live direct messages not filed into a section.
 * @param groupedAgents - Agents filed into a hand-made section.
 * @param byPath - The roster, by path.
 */
function directMessageRows(
  state: SidebarState,
  ctx: RowContext,
  dms: AgentDmIndex,
  rooms: readonly RoomSummary[],
  groupedAgents: ReadonlySet<string>,
  byPath: ReadonlyMap<string, AgentRosterEntry>
): SidebarRowModel[] {
  const rows: SidebarRowModel[] = [];
  const drawn = new Set<string>();
  for (const room of rooms) {
    const path = dms.agentPathOf(room);
    if (path === null) {
      rows.push(roomRow(room, state, ctx, 'dms:conversation'));
      continue;
    }
    const agent = byPath.get(path);
    if (agent === undefined || groupedAgents.has(path)) continue;
    drawn.add(path);
    rows.push(withRoomMute(agentRow(agent, state, ctx, 'dms:agent'), room, ctx));
  }
  for (const ref of state.prefs.pinned) {
    if (ref.kind !== 'agent' || drawn.has(ref.path) || groupedAgents.has(ref.path)) continue;
    const agent = byPath.get(ref.path);
    if (agent === undefined) continue;
    drawn.add(ref.path);
    rows.push(agentRow(agent, state, ctx, 'dms:pinned-agent'));
  }
  return rows;
}

/**
 * An agent row that also wears its direct message's own mute.
 *
 * The row is the conversation, so silencing the conversation silences the row,
 * exactly as muting the agent does.
 *
 * @param row - The agent's row.
 * @param room - Its direct message.
 * @param ctx - The mute sets.
 */
function withRoomMute(row: SidebarRowModel, room: RoomSummary, ctx: RowContext): SidebarRowModel {
  return ctx.mutes.rooms.has(room.id) && !row.muted ? { ...row, muted: true } : row;
}

/**
 * The Direct messages section, which — unlike every other fixed section —
 * always stands.
 *
 * With nothing in it, its one row is the way to start a conversation with an
 * agent. With something in it, the last row is the way to start one with
 * anybody, agent or person. Both open the Directory.
 *
 * @param state - The snapshot.
 * @param rows - Its conversations, already ordered.
 * @param isWorking - Whether a row's subject is streaming.
 */
function directMessagesSection(
  state: SidebarState,
  rows: SidebarRowModel[],
  isWorking: (row: SidebarRowModel) => boolean
): SidebarSectionModel {
  const door =
    rows.length === 0
      ? doorRow('message-agent', 'add', 'Message an agent', 'dms:empty')
      : doorRow('message-someone', 'add', 'Message an agent or person', 'dms:message-someone');
  // **The rollup reads the conversations, and the door joins after it**
  // (DOR-3200). Folded, the header says how many conversations it hides; a door
  // fed into the rollup was counted as one, so "· 8 more" hid seven, and an
  // empty folded section said "· 1 more" with nothing hidden.
  const built = fixedSection('dms', 'Direct messages', rows, state, 'section:dms', isWorking);
  // **Folded and empty, the door stays.** It is the section's whole content
  // and the one way to start a conversation, so folding must not hide it.
  const rollup =
    built.rollup !== undefined && rows.length === 0
      ? { ...built.rollup, keptRows: [door] }
      : built.rollup;
  return { ...built, ...(rollup ? { rollup } : {}), rows: [...rows, door] };
}

/**
 * Every section in the panel, in render order: the top items, the operator's
 * own sections, Channels, Direct messages and Add-ons.
 *
 * **The operator's own sections come right after the top items**, and they are
 * peers rather than children: the one part of the panel the operator built
 * themselves sits above the parts that grow on their own.
 *
 * @param state - The snapshot.
 */
export function buildSections(state: SidebarState): SidebarSectionModel[] {
  const mutes = muteIndex(state.prefs);
  const dms = indexAgentDms(state, mutes);
  const ctx: RowContext = { mutes, dmUnread: dms.unreadByAgentPath };
  const byPath = new Map(state.agents.map((agent) => [agent.path, agent]));
  const rooms = new Map(
    state.rooms.filter((room) => !room.archived).map((room) => [room.id, room])
  );
  const recencyOf = recencyResolver(byPath, rooms, dms);
  const isWorking = rowIsWorking(state, rooms);

  const groupSections = state.prefs.groups.map((group) =>
    groupSection(group, state, ctx, byPath, rooms, isWorking, recencyOf)
  );

  // **An agent is one row** (DOR-3092). One filed into a hand-made section, or
  // matched by a smart section's rules, is drawn there and not in Direct
  // messages. A smart match is read off the rows the section actually drew,
  // so an agent its display filter hides stays in Direct messages rather than
  // vanishing from the panel.
  const groupedAgents = new Set<string>();
  const groupedRooms = new Set<string>();
  state.prefs.groups.forEach((group, index) => {
    if (group.kind === 'smart') {
      for (const row of groupSections[index]?.rows ?? []) {
        if (row.target.kind === 'agent') groupedAgents.add(row.target.path);
      }
      return;
    }
    for (const ref of group.items) {
      if (ref.kind === 'agent') groupedAgents.add(ref.path);
      else groupedRooms.add(ref.roomId);
    }
  });

  const channelRows: SidebarRowModel[] = [];
  const dmRooms: RoomSummary[] = [];
  for (const room of rooms.values()) {
    if (groupedRooms.has(room.id)) continue;
    if (room.kind === 'dm') dmRooms.push(room);
    else channelRows.push(roomRow(room, state, ctx, 'channels:channel'));
  }

  const content: Record<Exclude<FixedSectionId, 'dms'>, SectionContent> = {
    channels: {
      label: 'Channels',
      rows: orderRows(channelRows, state.prefs.sections.channels?.sortMode ?? 'name', recencyOf),
      reason: 'section:channels',
    },
    addons: { label: 'Add-ons', rows: addOnRows(state), reason: 'section:addons' },
  };
  const dmRows = orderRows(
    directMessageRows(state, ctx, dms, dmRooms, groupedAgents, byPath),
    state.prefs.sections.dms?.sortMode ?? 'name',
    recencyOf
  );

  return [
    topSection(),
    ...groupSections,
    ...SIDEBAR_SECTION_IDS.map((id) =>
      id === 'dms'
        ? directMessagesSection(state, dmRows, isWorking)
        : section(id, content[id].label, content[id].rows, state, content[id].reason, isWorking)
    ).filter((entry): entry is SidebarSectionModel => entry !== null),
  ];
}
