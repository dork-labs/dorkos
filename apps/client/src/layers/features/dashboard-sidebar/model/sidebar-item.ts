/**
 * The sidebar's item view model (sidebar-groups, DOR-580) — one shape for the
 * two things a section can hold, an agent and a room.
 *
 * Everything downstream reads this and never the underlying entity: sorting
 * (`section-sort-options.ts`) and
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
import { resolveAgentVisual } from '@/layers/shared/lib';
import {
  hasUnread,
  identityMarkFaces,
  roomDisplayTitle,
  roomIdentityMark,
  type IdentityMark,
  type RoomIdentityMarkInput,
} from '@/layers/entities/room';
import type { AttentionState } from '@/layers/entities/session';

/**
 * The mark a sidebar row draws for its item — the sidebar's name for
 * {@link IdentityMark}, which every surface that draws a room now shares.
 *
 * The union and the room derivation moved to `entities/room` when the "Jump
 * back in" popover needed the same mark: features may not import each other's
 * models, so the alternative was a second derivation, and a second derivation
 * is how a direct message ends up with a face in one list and a letter in the
 * next (DOR-582, re-opened exactly that way).
 */
export type SidebarItemVisual = IdentityMark;

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
   * That invariant is what lets the reveal row keep saying "N inactive".
   */
  attention: AttentionState;
  /**
   * Whether the item is muted in its OWN right (`ui.sidebar.muted`), independent
   * of any group it happens to sit in.
   *
   * Group mute is a property of the group, not of the item — the same agent can
   * sit in a muted group and an unmuted one — so it stays a per-section input to
   * the section builder rather than being folded in here.
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
 * The face is resolved here, client-side, from the manifest —
 * `resolveAgentVisual` hashes emoji and colour out of the agent's id whenever it
 * has no stored override, which is the case for most of a real fleet.
 *
 * **The path-hash fallback is for directories that have no manifest, and it is
 * final for them.** It is NOT a placeholder to paint while manifests load: the
 * two hashes disagree (id vs path), so a row painted before its manifest landed
 * changed its face and its name a beat later, on every cold load, for the whole
 * fleet at once (DOR-1143). The panel's boot gate is what stops that — no agent
 * row paints before the manifests answer — and this expression only ever runs
 * for a directory the roster genuinely cannot name.
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
export interface RoomSidebarItemInput extends RoomIdentityMarkInput {
  /** Whether the room is individually muted. */
  muted: boolean;
}

/**
 * The view model for one room row.
 *
 * The mark comes from {@link roomIdentityMark} — the entity's derivation, which
 * is what matches a participant back to the fleet so a direct message and its
 * agent's own row draw the same face (DOR-582).
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
    visual: roomIdentityMark(input),
  };
}

/**
 * The faces a mark carries, flattened — the entity's
 * {@link identityMarkFaces}, re-exported under the name every sidebar row
 * already calls it by.
 */
export const sidebarItemFaces = identityMarkFaces;

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
 *   all, for rows that are not a drag source: smart-group members, and pinned
 *   rooms (dragging one out would unpin it, and the room menu offers no Pin
 *   to undo that).
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
