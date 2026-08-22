/**
 * Library — the structure the operator built themselves, never reordered by us
 * (BC-28 → BC-33).
 *
 * Prediction is additive: Heads up and Today are computed and may move every render.
 * Everything in here stays exactly where it was put, which is what makes the
 * spatial memory worth having.
 *
 * @module features/dashboard-sidebar/model/rules/build-library-sections
 */
import type { SidebarDisplayFilter, SidebarGroup } from '@dorkos/shared/config-schema';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { evaluateSmartGroup } from '@dorkos/shared/smart-groups';
import {
  SIDEBAR_LIBRARY_SECTION_IDS,
  type LibrarySectionId,
  type SidebarRowModel,
  type SidebarSectionModel,
} from '../build-sidebar-model';
import type { SidebarSortMode } from '../section-sort-options';
import type { AgentRosterEntry, SidebarState } from '../sidebar-state';
import { muteIndex } from './apply-mute-rules';
import { indexSuppressedDms } from './hand-made-dm';
import { agentRow, roomLibraryRow, type LibraryRowContext } from './library-rows';
import { liveSessionIdsForPath } from './live-sessions';
import { rollUpCollapsedSection } from './roll-up-collapsed-section';
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
 * How many agent rows the Agents section draws before it will hide any (D3).
 *
 * The section lists what is recent and what is pinned, which on a quiet morning
 * is nothing at all — a panel whose Agents section is one "All 31 agents →" row
 * has hidden the product. The floor is what keeps a usable list there: if fewer
 * than this many agents qualify, the most recently active of the rest fill up to
 * it.
 */
export const AGENT_ROW_FLOOR = 8;

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
 * section's "N agents working" counts (BC-31).
 *
 * **Asked of the source, never of the row's dot.** A row carries one status and
 * `needs-you` outranks `working`, so an agent that is both blocked and running
 * reads `needs-you` — and a folded section that counted dots lost the working
 * signal for exactly the members most worth knowing about (DOR-1137).
 *
 * An agent's answer comes from {@link liveSessionIdsForPath}, so it is the same
 * human-origin list Heads up's "N working" counts (§18). A room's comes from the
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
 * The door to the whole fleet, at the bottom of the Agents section (D3).
 *
 * It replaces the "N inactive" reveal row this file used to emit, and the
 * difference is that this one goes somewhere: the reveal was a `section-count`
 * rollup with no handler anywhere in the app — pressable, and inert (DOR-1105).
 * Everything the Agents section is not showing is on the Team page, so the row
 * says how many there are in total and opens it.
 *
 * @param total - How many agents the roster holds, all told.
 */
function allAgentsRow(total: number): SidebarRowModel {
  const target = { kind: 'command', commandId: 'open-team' } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'icon', icon: 'team' },
    // **The words only. The arrow is the renderer's**, drawn `aria-hidden`
    // beside them (`SidebarModelRow`). It used to be part of this string, so a
    // screen reader read "All fifteen agents right arrow" — a direction spoken
    // as if it were a noun. The model carries meaning; the mark that says
    // "this leaves the panel" is a rendering.
    primary: `All ${total} agents`,
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason: 'library:all-agents',
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
 * for showing everything that hid things. What keeps the Agents list short is
 * the recent-and-pinned rule below, which is a separate decision with its own
 * floor and its own door to the rest; a section the operator filled by hand
 * shows what they put in it.
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
 * When each row's subject was last active, epoch ms, for either kind of row.
 *
 * **A room answers with its own timestamp, and that is a fix rather than a
 * detail.** It used to answer `null` for everything that was not an agent, which
 * `orderLibraryRows` reads as `-Infinity`: a section holding a channel and an
 * agent, sorted by "Recent activity", sank every channel to the bottom in
 * whatever order their keys happened to fall. The menu offered a sort it did not
 * perform.
 *
 * @param byPath - The roster, by path.
 * @param rooms - Every non-archived room, by id.
 */
function recencyResolver(
  byPath: Map<string, AgentRosterEntry>,
  rooms: Map<string, RoomSummary>
): (row: SidebarRowModel) => number | null {
  return (row) => {
    if (row.target.kind === 'agent') return byPath.get(row.target.path)?.lastActivityAt ?? null;
    if (row.target.kind === 'room') {
      const iso = rooms.get(row.target.roomId)?.lastActivityAt;
      if (iso === undefined) return null;
      const at = Date.parse(iso);
      return Number.isNaN(at) ? null : at;
    }
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
 * One fixed Library section, or `null` when it holds nothing.
 *
 * Chrome appears by data volume: no Direct messages section until a DM exists,
 * no Pins section until something is pinned (BC-32). Returning `null` is how
 * that promise is kept in one place instead of at four call sites.
 *
 * @param id - Which Library section this is. Narrower than
 *   `SidebarSectionModel['id']` on purpose: this helper reads the section's
 *   STORED collapse and options, and only a persisted Library section has any.
 *   Heads up, Today, Getting started and hand-made sections never reach here.
 * @param label - Its heading.
 * @param rows - Its rows.
 * @param state - The snapshot.
 * @param reason - Its provenance.
 * @param isWorking - Whether a row's subject is streaming ({@link rowIsWorking}).
 */
function section(
  id: LibrarySectionId,
  label: string,
  rows: SidebarRowModel[],
  state: SidebarState,
  reason: string,
  isWorking: (row: SidebarRowModel) => boolean
): SidebarSectionModel | null {
  if (rows.length === 0) return null;
  const prefs = state.prefs.sections[id];
  const collapsed = prefs?.collapsed ?? false;
  const rollup = collapsed ? rollUpCollapsedSection(rows, isWorking) : undefined;
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
 * One hand-made section — a peer of Channels, Direct messages and Agents (D3).
 *
 * A smart section's membership is evaluated live and never persisted, so its
 * stored `items` are ignored here, exactly as the membership pass in
 * {@link buildLibrarySections} ignores them.
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
 * @param ctx - What every row here is built with ({@link LibraryRowContext}).
 * @param byPath - The roster, by path.
 * @param rooms - Every room, by id.
 * @param isWorking - Whether a row's subject is streaming ({@link rowIsWorking}).
 * @param recencyOf - When a row's subject was last active ({@link recencyResolver}).
 */
function groupSection(
  group: SidebarGroup,
  state: SidebarState,
  ctx: LibraryRowContext,
  byPath: Map<string, AgentRosterEntry>,
  rooms: Map<string, RoomSummary>,
  isWorking: (row: SidebarRowModel) => boolean,
  recencyOf: (row: SidebarRowModel) => number | null
): SidebarSectionModel {
  const rows: SidebarRowModel[] = [];
  /** One agent's row, or nothing when the section's filter hides it. */
  const pushAgent = (agent: AgentRosterEntry, draggable: boolean) => {
    if (!passesDisplayFilter(agent, ctx.mutes.agents.has(agent.path), group.displayFilter)) return;
    const row = agentRow(agent, state, ctx, 'library:group-member');
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
        if (room) rows.push(roomLibraryRow(room, state, ctx, 'library:group-member'));
      }
    }
  }
  const ordered = orderLibraryRows(rows, group.sortMode, recencyOf);
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
    ...(group.collapsed ? { rollup: rollUpCollapsedSection(ordered, isWorking) } : {}),
    rows: ordered,
    reason: 'library:group',
  };
}

/** What one fixed Library section holds, before {@link section} decides it exists. */
interface LibrarySectionContent {
  /** Its heading. */
  label: string;
  /** Its rows, already filtered and ordered. */
  rows: SidebarRowModel[];
  /** Its provenance. */
  reason: string;
}

/**
 * Whether an agent is quiet enough for the Agents section to leave out.
 *
 * **Two ways to be quiet, and reading only the first is the bug this exists to
 * name.** `attention` answers `'inactive'` for an agent that RAN and then went
 * silent for a week; an agent that has never run at all answers `'fresh'`, which
 * is deliberate — a DorkBot somebody set up ten seconds ago should read as new
 * rather than dormant, and its dot and its Team-page row still say so. But
 * `'fresh'` is not `'inactive'`, so a rule that asked only that question trimmed
 * nobody on a fresh install: fifteen registered-and-never-run agents all
 * qualified as "recent", the floor never bit, and `All N agents →` never
 * appeared. A never-run agent you have also never opened is the emptiest row the
 * panel can draw.
 *
 * The floor above is what keeps this from being harsh: a day-one cockpit with
 * three agents still shows all three, because there are fewer than eight of
 * them.
 *
 * @param agent - The roster entry.
 */
function isQuiet(agent: AgentRosterEntry): boolean {
  if (agent.attention === 'inactive') return true;
  return agent.lastActivityAt === null && agent.lastInteractionAt === null;
}

/**
 * Which ungrouped agents the Agents section draws (D3).
 *
 * Recent and pinned, with a floor. An agent is also a project, so a fleet grows
 * a row per project and never gives one back — a cockpit that has been used for
 * six months lists thirty agents, most of them cold, and the four the operator
 * is actually working with are somewhere in the middle. What is left off is not
 * hidden: `All N agents →` is the last row, and the Team page lists every one.
 *
 * The floor is what stops the rule from emptying the section on a quiet morning.
 *
 * @param candidates - The ungrouped agents that survived the display filter.
 * @param pinnedPaths - Which agent paths are pinned.
 */
function agentsToShow(
  candidates: readonly AgentRosterEntry[],
  pinnedPaths: ReadonlySet<string>
): AgentRosterEntry[] {
  const kept: AgentRosterEntry[] = [];
  const rest: AgentRosterEntry[] = [];
  for (const agent of candidates) {
    if (pinnedPaths.has(agent.path) || !isQuiet(agent)) kept.push(agent);
    else rest.push(agent);
  }
  if (kept.length >= AGENT_ROW_FLOOR) return kept;
  // Most recently active first — the ones closest to coming back. An agent
  // nobody has ever run or opened has no instant of either kind and fills last,
  // in path order so the choice is at least stable between renders.
  const at = (agent: AgentRosterEntry) =>
    Math.max(
      agent.lastActivityAt ?? Number.NEGATIVE_INFINITY,
      agent.lastInteractionAt ?? Number.NEGATIVE_INFINITY
    );
  const fill = [...rest].sort((a, b) => at(b) - at(a) || a.path.localeCompare(b.path));
  return [...kept, ...fill.slice(0, AGENT_ROW_FLOOR - kept.length)];
}

/**
 * Library's sections: the operator's own sections first, then Pins, Channels,
 * Direct messages and Agents.
 *
 * **Sections lead, and they are peers rather than children** (D3). They used to
 * render as sub-headers inside Agents, which said "these are for agents" about a
 * list that has held channels and conversations since DOR-581, and buried the
 * one part of the panel the operator built themselves under the one part that
 * grows on its own.
 *
 * A pinned item keeps its row in its home section too — pinning is a shortcut,
 * not a move — while a manual section's members leave the ungrouped list, which
 * is the membership rule the sidebar has always had.
 *
 * @param state - The snapshot.
 */
export function buildLibrarySections(state: SidebarState): SidebarSectionModel[] {
  const mutes = muteIndex(state.prefs);
  // One pass over the rooms, answering both halves of the one-door rule: which
  // direct messages Library leaves out, and what each agent's row says instead
  // (`sidebar-simplification` D2).
  const suppressedDms = indexSuppressedDms(state, mutes);
  const ctx: LibraryRowContext = { mutes, dmUnread: suppressedDms.unreadByAgentPath };
  const byPath = new Map(state.agents.map((agent) => [agent.path, agent]));
  const rooms = new Map(
    state.rooms.filter((room) => !room.archived).map((room) => [room.id, room])
  );
  const recencyOf = recencyResolver(byPath, rooms);

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
  const pinnedAgentPaths = new Set<string>();
  for (const ref of state.prefs.pinned) {
    if (ref.kind === 'agent') {
      pinnedAgentPaths.add(ref.path);
      const agent = byPath.get(ref.path);
      if (agent) pinnedRows.push(agentRow(agent, state, ctx, 'library:pinned'));
    } else {
      const room = rooms.get(ref.roomId);
      if (room) pinnedRows.push(roomLibraryRow(room, state, ctx, 'library:pinned'));
    }
  }

  const channelRows: SidebarRowModel[] = [];
  const dmRows: SidebarRowModel[] = [];
  for (const room of rooms.values()) {
    if (groupedRooms.has(room.id)) continue;
    // A hand-made 1:1 direct message is the agent's own session under a second
    // name, and the agent already has a row. It keeps its place in Today, in
    // ⌘K and on the agent's profile; what it loses is a standing second list
    // (reason `library:dm-suppressed-1to1`). A section the operator put it in
    // by hand is left alone above — an item somebody filed is somewhere they
    // put it.
    if (suppressedDms.isSuppressed(room)) continue;
    const row = roomLibraryRow(
      room,
      state,
      ctx,
      room.kind === 'dm' ? 'library:dm' : 'library:channel'
    );
    (room.kind === 'dm' ? dmRows : channelRows).push(row);
  }

  // ── The Agents pipeline ──
  // A second composition lives inside this one, and it is worth saying so:
  // from the entry point above this reads as a single rule, while Agents is
  // actually four steps in a fixed order — who is ungrouped, then what the
  // display filter shows, then which of those the recent-and-pinned rule draws
  // ({@link agentsToShow}), then what order they come in. Filter BEFORE the
  // visibility rule, so a filter the operator chose is never overruled by the
  // floor; sort last, so the `All N agents →` row appended after it can never
  // sort into the middle of the list it is standing at the end of.
  const agentPrefs = state.prefs.sections.agents;
  const candidates = state.agents.filter(
    (agent) =>
      !groupedAgents.has(agent.path) &&
      passesDisplayFilter(agent, ctx.mutes.agents.has(agent.path), agentPrefs?.displayFilter)
  );
  const shown = agentsToShow(candidates, pinnedAgentPaths);
  const agentRows = orderLibraryRows(
    shown.map((agent) => agentRow(agent, state, ctx, 'library:agent')),
    agentPrefs?.sortMode,
    recencyOf
  );
  // **What is on screen is `shown` PLUS whatever the operator filed into a
  // section**, because those rows are drawn too — a few inches higher up. A
  // guard that compared the roster with `shown` alone offered "All 3 agents →"
  // to somebody who could see all three of them, which is a door to nowhere new.
  const drawnElsewhere = groupedAgents.size;
  if (state.agents.length > shown.length + drawnElsewhere) {
    agentRows.push(allAgentsRow(state.agents.length));
  }

  const isWorking = rowIsWorking(state, rooms);

  // What each of the four fixed sections holds, keyed by id. A `Record` over
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
        recencyOf
      ),
      reason: 'library:channels',
    },
    dms: {
      label: 'Direct messages',
      rows: orderLibraryRows(dmRows, state.prefs.sections.dms?.sortMode ?? 'name', recencyOf),
      reason: 'library:dms',
    },
    agents: { label: 'Agents', rows: agentRows, reason: 'library:agents' },
  };

  // The tuple IS the order of the four fixed sections; the operator's own come
  // first, in the order they stored them.
  return [
    ...state.prefs.groups.map((group) =>
      groupSection(group, state, ctx, byPath, rooms, isWorking, recencyOf)
    ),
    ...SIDEBAR_LIBRARY_SECTION_IDS.map((id) =>
      section(id, content[id].label, content[id].rows, state, content[id].reason, isWorking)
    ).filter((entry): entry is SidebarSectionModel => entry !== null),
  ];
}
