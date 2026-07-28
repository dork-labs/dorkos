/**
 * The sidebar's item view model (sidebar-groups, DOR-580) — one shape for the
 * two things a section can hold, an agent and a room.
 *
 * Everything downstream reads this and never the underlying entity: sorting
 * (`sort-sidebar-items.ts`), the display filter (`filter-sidebar-items.ts`) and
 * mute all operate on the union, so a group holding a channel needs no code of
 * its own.
 *
 * **Why it lives at the feature layer.** Building it needs `entities/agent` AND
 * `entities/room`, and sibling entities may not import each other
 * (`.claude/rules/fsd-layers.md`). A feature may import both, so this is the
 * lowest layer where the two can meet. Moving room code into the agent entity to
 * dodge the rule is what produced a duplicate avatar system last time
 * (`specs/rooms/02-specification.md` §12.2).
 *
 * @module features/dashboard-sidebar/model/sidebar-item
 */
import type { ReactNode } from 'react';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { resolveAgentVisual, type AgentVisual } from '@/layers/shared/lib';
import { hasUnread, roomDisplayTitle } from '@/layers/entities/room';
import type { AttentionState } from '@/layers/entities/session';

/**
 * The mark a sidebar row draws for its item.
 *
 * The three arms are the three answers, not three shapes of the same answer:
 *
 * - `identity` — one agent's face. An agent row, and a one-to-one direct
 *   message, which IS that agent as far as the reader is concerned.
 * - `stack` — several agents' faces, for a direct message with more than one
 *   agent in it. A group conversation's title already names everyone; the mark
 *   is what tells you it is a group at a glance.
 * - `sigil` — no face at all: the room's own mark, which is `#` for a channel.
 *   A channel is anchored to a topic rather than to a participant
 *   (`specs/rooms/02-specification.md` §14.4), so giving it a face would be the
 *   same category error as giving it a `cwd`. It is also the honest answer for a
 *   direct message whose agents this cockpit cannot resolve — the room's own
 *   letter disc is stable and true, where a guessed face is neither.
 */
export type SidebarItemVisual =
  | { kind: 'identity'; visual: AgentVisual }
  | { kind: 'stack'; visuals: AgentVisual[] }
  | { kind: 'sigil' };

/**
 * One row in the sidebar, whatever it points at.
 *
 * @see {@link agentSidebarItem} and {@link roomSidebarItem} — the two producers.
 */
export interface SidebarItem {
  /** What this row points at. */
  ref: SidebarItemRef;
  /**
   * What the item is called. An agent's disambiguated display name, or a room's
   * {@link roomDisplayTitle}. Read by the `name` sort and by the `recent` sort's
   * tiebreak; a row draws its own name from its own component.
   */
  name: string;
  /**
   * When the item was last active, as epoch milliseconds — `null` when it never
   * has been, which the `recent` sort puts last.
   */
  lastActiveAt: number | null;
  /**
   * How much of the operator's attention the item is asking for.
   *
   * **Three states, not the `needsAttention: boolean` the spec first drafted.**
   * The display filter has three branches (`all` hides `inactive`, `active`
   * keeps `active` and above, `attention` keeps only the top state), so a
   * boolean cannot drive it without collapsing `active` into `inactive` — which
   * would hide every quiet-but-running agent behind the "N inactive" reveal row.
   * The boolean the spec's mapping table describes is `attention ===
   * 'needs-attention'`.
   *
   * A room is never `inactive`: it is a place rather than a process, so it is
   * `needs-attention` when there is something unread and `active` otherwise.
   * That invariant is what lets `RevealRow` keep saying "N inactive agents".
   */
  attention: AttentionState;
  /**
   * Whether the item is muted in its OWN right (`ui.sidebar.muted`), independent
   * of any group it happens to sit in.
   *
   * Group mute is a property of the group, not of the item — the same agent can
   * sit in a muted group and an unmuted one — so it stays a per-section input to
   * {@link filterSidebarItems} rather than being folded in here.
   */
  muted: boolean;
  /** The mark this row draws. */
  visual: SidebarItemVisual;
}

/** What {@link agentSidebarItem} needs to describe one agent. */
export interface AgentSidebarItemInput {
  /** The agent's `projectPath`. */
  path: string;
  /** Its resolved manifest, or `null`/`undefined` when the directory has none. */
  agent: AgentManifest | null | undefined;
  /** Its disambiguated display name, when the roster has one. */
  displayName: string | undefined;
  /** Its live attention state (from `useAgentAttentionMap`). */
  attention: AttentionState;
  /** Its latest session `updatedAt` as an ISO string, absent when it has none. */
  lastActivityAt: string | undefined;
  /** Whether it is individually muted. */
  muted: boolean;
}

/**
 * The view model for one agent row.
 *
 * The face is resolved here, client-side, from the manifest — `resolveAgentVisual`
 * hashes emoji and colour out of the agent's id whenever it has no stored
 * override, which is the case for most of a real fleet. Falling back to
 * `resolveAgentVisual({ id: path })` when there is no manifest is the same
 * expression `useAgentVisual` uses for an unregistered directory, so a row's
 * face never changes as its manifest loads.
 *
 * @param input - The agent and its live state.
 */
export function agentSidebarItem(input: AgentSidebarItemInput): SidebarItem {
  const lastActive = input.lastActivityAt ? Date.parse(input.lastActivityAt) : Number.NaN;
  return {
    ref: { kind: 'agent', path: input.path },
    // The path is the fallback the agent-only sort used, kept so ordering does
    // not shift for a path the roster has not named yet.
    name: input.displayName ?? input.path,
    lastActiveAt: Number.isNaN(lastActive) ? null : lastActive,
    attention: input.attention,
    muted: input.muted,
    visual: {
      kind: 'identity',
      visual: input.agent
        ? resolveAgentVisual(input.agent)
        : resolveAgentVisual({ id: input.path }),
    },
  };
}

/** What {@link roomSidebarItem} needs to describe one room. */
export interface RoomSidebarItemInput {
  /** The room, as the list query carries it. */
  room: RoomSummary;
  /** Resolved manifests by `projectPath`, for a direct message's faces. */
  agentsByPath: Readonly<Record<string, AgentManifest | null | undefined>>;
  /** `agentAuthorRef(projectPath)` → `projectPath`, so a participant can be matched to the fleet. */
  pathByAgentRef: ReadonlyMap<string, string>;
  /** Whether the room is individually muted. */
  muted: boolean;
}

/**
 * The view model for one room row.
 *
 * **This is where DOR-582 is fixed.** A direct message used to draw a letter
 * where its agent's face belongs, because the only emoji it had to work with was
 * `AuthorRef.emoji` — a render cache the server fills in only for an agent that
 * has an emoji explicitly stored on its manifest, which almost none do. Hashing
 * the `AuthorRef.id` instead would be worse than a letter: that id is a row in
 * the `authors` table, unrelated to the manifest ULID the agent's own row hashes
 * from, so it would draw a confidently WRONG face.
 *
 * So the participant is matched back to the fleet on its `agentRef` — the stable
 * handle derived from the agent's directory, never a display name — and the face
 * is resolved from the manifest, exactly as {@link agentSidebarItem} does. That
 * is the only way the DM and the agent row can agree, and it is why the visual
 * belongs to the view model rather than to either row.
 *
 * `unreadCount` is read through `hasUnread`, which treats `null` ("you are not
 * in this room") as distinct from `0` ("you are, and you are caught up").
 *
 * @param input - The room and the fleet it is read against.
 */
export function roomSidebarItem(input: RoomSidebarItemInput): SidebarItem {
  const { room } = input;
  const lastActive = Date.parse(room.lastActivityAt);
  return {
    ref: { kind: 'room', roomId: room.id },
    name: roomDisplayTitle(room),
    lastActiveAt: Number.isNaN(lastActive) ? null : lastActive,
    // A room is a place, not a process: it asks for attention when something in
    // it is unread, and is otherwise simply there. It is never `inactive`, which
    // would collapse it behind the "N inactive agents" reveal row.
    attention: hasUnread(room) ? 'needs-attention' : 'active',
    muted: input.muted,
    visual: roomVisual(input),
  };
}

/** The mark for a room: its participants' faces for a DM, its own sigil otherwise. */
function roomVisual({
  room,
  agentsByPath,
  pathByAgentRef,
}: RoomSidebarItemInput): SidebarItemVisual {
  if (room.kind !== 'dm') return { kind: 'sigil' };
  const visuals: AgentVisual[] = [];
  for (const author of room.participants ?? []) {
    if (author.kind !== 'agent' || author.agentRef === undefined) continue;
    const path = pathByAgentRef.get(author.agentRef);
    // An agent this cockpit cannot see — removed, or on another machine — has no
    // manifest to hash, and hashing anything else would invent a face. It drops
    // out, and a DM left with none falls through to the room's own mark.
    if (path === undefined) continue;
    const agent = agentsByPath[path];
    visuals.push(agent ? resolveAgentVisual(agent) : resolveAgentVisual({ id: path }));
  }
  if (visuals.length === 0) return { kind: 'sigil' };
  if (visuals.length === 1) return { kind: 'identity', visual: visuals[0]! };
  return { kind: 'stack', visuals };
}

/**
 * The faces a visual carries, flattened — one for an `identity`, several for a
 * `stack`, none for a `sigil`.
 *
 * Exists so a row can hand a component "the faces to draw" without re-deriving
 * the union, which is the split that let two avatar systems co-exist before.
 *
 * @param visual - The item's mark.
 */
export function sidebarItemFaces(visual: SidebarItemVisual): AgentVisual[] {
  if (visual.kind === 'sigil') return [];
  return visual.kind === 'identity' ? [visual.visual] : visual.visuals;
}

/**
 * A React key for one row, unique within its section.
 *
 * An ephemeral DOM identity, never a membership key: membership is always
 * compared with `sameSidebarItem` over the reference itself. The section's key
 * prefix is what lets a pinned reference sit beside its home copy.
 *
 * @param ref - The row's reference.
 */
export function sidebarItemKey(ref: SidebarItemRef): string {
  return ref.kind === 'agent' ? `agent:${ref.path}` : `room:${ref.roomId}`;
}

/**
 * Render one row of a section.
 *
 * Sections do not know how to draw either kind — they resolve, filter and order
 * items and hand each one back to the orchestrator, which dispatches on
 * `ref.kind` to the existing agent row or room row. Neither of those is forked.
 *
 * @param item - The item to draw.
 * @param keyPrefix - The section's own key (`pinned`, `ungrouped`, or a group id).
 * @param options.draggable - `false` renders the row with no drag wrapper at
 *   all, for rows that are not a drag source: smart-group members, and every
 *   room until rooms become draggable in S3.
 */
export type RenderSidebarItem = (
  item: SidebarItem,
  keyPrefix: string,
  options?: { draggable?: boolean }
) => ReactNode;

/** Every sidebar item currently renderable, indexed by what a reference names. */
export interface SidebarItemIndex {
  /** Agent items by `projectPath`. */
  byAgentPath: ReadonlyMap<string, SidebarItem>;
  /** Room items by room id. */
  byRoomId: ReadonlyMap<string, SidebarItem>;
}

/** What {@link buildSidebarItems} reads to produce the whole index. */
export interface BuildSidebarItemsInput {
  /** Every agent `projectPath` the mesh knows. */
  agentPaths: readonly string[];
  /** Resolved manifests by `projectPath`. */
  agentsByPath: Readonly<Record<string, AgentManifest | null | undefined>>;
  /** Disambiguated display names by `projectPath`. */
  displayNames: Readonly<Record<string, string>>;
  /** Attention state by `projectPath`. */
  attention: Readonly<Record<string, AttentionState>>;
  /** Latest session `updatedAt` (ISO) by `projectPath`. */
  agentActivity: Readonly<Record<string, string>>;
  /** Every non-archived room. */
  rooms: readonly RoomSummary[];
  /** `projectPath`s muted in their own right. */
  mutedAgentPaths: ReadonlySet<string>;
  /** Room ids muted in their own right. */
  mutedRoomIds: ReadonlySet<string>;
}

/**
 * Build the whole index once per render.
 *
 * One pass over the fleet and one over the rooms, so a section resolves its
 * membership with map lookups instead of re-deriving a view model per row. The
 * `agentRef` map is built here too: it is a hash per agent, and every direct
 * message would otherwise recompute it for the whole fleet.
 *
 * @param input - The fleet, the rooms, and their live state.
 */
export function buildSidebarItems(input: BuildSidebarItemsInput): SidebarItemIndex {
  const byAgentPath = new Map<string, SidebarItem>();
  const pathByAgentRef = new Map<string, string>();
  for (const path of input.agentPaths) {
    pathByAgentRef.set(agentAuthorRef(path), path);
    byAgentPath.set(
      path,
      agentSidebarItem({
        path,
        agent: input.agentsByPath[path],
        displayName: input.displayNames[path],
        attention: input.attention[path] ?? 'inactive',
        lastActivityAt: input.agentActivity[path],
        muted: input.mutedAgentPaths.has(path),
      })
    );
  }

  const byRoomId = new Map<string, SidebarItem>();
  for (const room of input.rooms) {
    byRoomId.set(
      room.id,
      roomSidebarItem({
        room,
        agentsByPath: input.agentsByPath,
        pathByAgentRef,
        muted: input.mutedRoomIds.has(room.id),
      })
    );
  }

  return { byAgentPath, byRoomId };
}

/**
 * Resolve one reference to its item, or `null` when nothing currently answers to
 * it.
 *
 * @param index - The current index.
 * @param ref - The stored reference.
 */
export function lookupSidebarItem(
  index: SidebarItemIndex,
  ref: SidebarItemRef
): SidebarItem | null {
  return (
    (ref.kind === 'agent' ? index.byAgentPath.get(ref.path) : index.byRoomId.get(ref.roomId)) ??
    null
  );
}

/**
 * Resolve a stored membership list to items, in order, dropping references
 * nothing answers to.
 *
 * Stale membership is filtered at render and never pruned on write, so an agent
 * that comes back — or a room that is un-archived — finds its group intact.
 *
 * @param index - The current index.
 * @param refs - A stored membership list.
 */
export function lookupSidebarItems(
  index: SidebarItemIndex,
  refs: readonly SidebarItemRef[]
): SidebarItem[] {
  return refs.flatMap((ref) => {
    const item = lookupSidebarItem(index, ref);
    return item ? [item] : [];
  });
}
