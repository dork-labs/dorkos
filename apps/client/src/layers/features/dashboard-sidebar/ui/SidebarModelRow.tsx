/**
 * One {@link SidebarRowModel}, drawn.
 *
 * The model decided that this row exists, where it sits, what it points at and
 * how much attention it is asking for. This decides nothing — it dispatches on
 * `target.kind` and hands the row to the component that knows how that kind of
 * thing looks.
 *
 * An agent and a room keep their existing components, which carry their menus,
 * their inline rename editors and their dialogs. A mini app's page draws the
 * icon its extension registered. A door — Threads, Directory, "Message an agent
 * or person" — is a {@link SidebarRow} built straight from the model's own
 * fields.
 *
 * @module features/dashboard-sidebar/ui/SidebarModelRow
 */
import { useCallback, useMemo } from 'react';
import { useReducedMotion } from 'motion/react';
import { BookUser, LayoutGrid, MessageSquareReply, Plus, SquareCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { cn } from '@/layers/shared/lib';
import { CountPill, SidebarRow, STATUS_TONE_DOT, type SidebarRowMotion } from '@/layers/shared/ui';
import { useAgentVisual } from '@/layers/entities/agent';
import type {
  SidebarCommandId,
  SidebarIconId,
  SidebarRowModel,
  SidebarTarget,
} from '../model/build-sidebar-model';
import type { UngroupedSectionId } from '../model/use-sidebar-dnd';
import { sameTarget } from '../model/rules/targets';
import { AgentListItem } from './AgentListItem';
import { PinnedAppRow } from './apps/PinnedAppRow';
import { RoomRow } from './rooms/RoomRow';
import { Sortable, sidebarDndData, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import { buildRowMotion } from './motion/sidebar-motion';
import { useSidebarChrome } from './SidebarChrome';
import { ROW_GLYPH_CLASS } from './row-glyph';

/**
 * Whether a row points at what is currently on screen.
 *
 * An agent row is active when the open conversation belongs to it — its
 * Direct chat, or any other chat of its — so the row stands for the agent
 * wherever you are talking to it.
 *
 * "Belongs to it" is THE canonical membership rule — the agent's directory or
 * any folder inside it, through the shared `isWithinDirectory` predicate that
 * `selectAgentSessions` and the server's own listing use (DOR-674/DOR-1550).
 * Exact equality here meant a session started at `<project>/packages/api` sat
 * in the agent's own session list while the agent's row stayed dark, which
 * reads as the wrong agent being open. The consequence of the wider rule,
 * stated rather than discovered: an agent nested inside another agent's
 * directory lights both rows for a session in the inner one, because from a
 * single row there is no way to see that a closer agent exists.
 *
 * A door lights when its page is open, and a mini app's page when it is.
 *
 * @param target - The row's target.
 * @param active - What the router says is open, or `null`.
 * @param homeRoomId - The room `/` is showing, when `/` is showing — `null`
 *   everywhere else. Only Home's own row consults it.
 * @param pendingAgentPath - The agent a click is heading to while its chat is
 *   being looked up, or `null`. While set, that agent's row is the only one
 *   lit, so the click shows at once (DOR-2891). Tint only, like `homeRoomId`.
 */
export function isRowActive(
  target: SidebarTarget,
  active: SidebarTarget | null,
  homeRoomId: string | null = null,
  pendingAgentPath: string | null = null
): boolean {
  if (pendingAgentPath !== null) return target.kind === 'agent' && target.path === pendingAgentPath;
  // **Home's room, lit without being "active".** `/` draws #team, so its row has
  // to look open there — but `/` has no active target and deliberately does not
  // get one (`useActiveTarget` explains why).
  if (homeRoomId !== null && target.kind === 'room' && target.roomId === homeRoomId) return true;
  if (active === null) return false;
  if (target.kind === 'session') {
    return active.kind === 'session' && active.sessionId === target.sessionId;
  }
  if (target.kind === 'agent') {
    if (active.kind === 'agent') return active.path === target.path;
    return active.kind === 'session' && isWithinDirectory(active.cwd, target.path);
  }
  // A pinned app is one row for all its pages, so any of them lights it.
  if (target.kind === 'add-on') {
    return active.kind === 'add-on' && active.extensionId === target.extensionId;
  }
  // A room and a door are each one row with one key, so a key comparison
  // lights exactly one of them.
  return sameTarget(target, active);
}

/** Stable handles for the doors that have one, for tests and recordings. */
const DOOR_TEST_IDS: Partial<Record<SidebarCommandId, string>> = { 'open-apps': 'apps-door' };

/** The mark each semantic icon id draws. */
const ICON: Record<SidebarIconId, LucideIcon> = {
  threads: MessageSquareReply,
  todos: SquareCheck,
  directory: BookUser,
  add: Plus,
  apps: LayoutGrid,
};

/**
 * The stored reference a row drags as, or `null` for a row that never
 * does.
 *
 * Exported so a section can register exactly the ids it is about to wrap in a
 * `Sortable`, from the same function that decides what those ids are.
 *
 * @param target - The row's target.
 */
export function dragRefOf(target: SidebarTarget): SidebarItemRef | null {
  if (target.kind === 'agent') return { kind: 'agent', path: target.path };
  if (target.kind === 'room') return { kind: 'room', roomId: target.roomId };
  return null;
}

/** Props for {@link SidebarModelRow}. */
export interface SidebarModelRowProps {
  /** The row to draw. */
  row: SidebarRowModel;
  /**
   * The drag container this copy of the row lives in — `ungrouped` or a group
   * id.
   */
  keyPrefix: string;
  /** The ungrouped section the drag layer announces this row's home as. */
  sectionId?: UngroupedSectionId;
  /**
   * The section's row ids, in order — what this row's FLIP measures against
   * (spec D5). Per section and never per panel: a conversation arriving in
   * Direct messages must not make every channel re-measure.
   */
  layoutKey?: string;
  /**
   * The section this row is in announces arrivals — Direct messages, whose
   * membership changes without the operator asking.
   */
  arrives?: boolean;
  /** This row is one of the arrivals, so it tints once. */
  arrived?: boolean;
}

/**
 * Draw one row, wrapping it in a drag source when the model says it is one.
 *
 * `row.draggable` is the only gate. R3 puts that decision in the model — a door
 * and a mini app's page are never drag sources — precisely so that no call site
 * here can re-enable it by accident.
 *
 * @param props - The row and where it sits.
 */
export function SidebarModelRow({
  row,
  keyPrefix,
  sectionId,
  layoutKey,
  arrives = false,
  arrived = false,
}: SidebarModelRowProps) {
  const reducedMotion = useReducedMotion();
  // **Memoized because the row underneath may be** (D8). `RoomRow` is
  // `React.memo` and this arrives as one prop, so a fresh object per render
  // would defeat the memo for every room in the panel — the exact regression
  // `RoomRow.render-count.test.tsx` guards. Every dependency here is a primitive,
  // so the object moves only when something about the row's motion moved.
  // An agent is the one row that moves between sections on its own, so it is
  // the one that carries an identity across them (DOR-3092).
  const moveId = row.target.kind === 'agent' ? row.key : undefined;
  const rowMotion = useMemo<SidebarRowMotion>(
    () => buildRowMotion({ layoutKey, arrives, arrived, reducedMotion, moveId }),
    [layoutKey, arrives, arrived, reducedMotion, moveId]
  );
  const ref = dragRefOf(row.target);
  const body = <SidebarModelRowBody row={row} rowMotion={rowMotion} />;
  if (!row.draggable || ref === null) return body;
  return (
    <Sortable id={sidebarRowDndId(keyPrefix, ref)} data={sidebarDndData(keyPrefix, ref, sectionId)}>
      {(bindings) => <SidebarModelRowBody row={row} rowMotion={rowMotion} drag={bindings} />}
    </Sortable>
  );
}

/** The row itself, once the drag layer has (or has not) wrapped it. */
function SidebarModelRowBody({
  row,
  rowMotion,
  drag,
}: {
  row: SidebarRowModel;
  rowMotion: SidebarRowMotion;
  drag?: React.ComponentProps<typeof SidebarRow>['drag'];
}) {
  const chrome = useSidebarChrome();
  const target = row.target;
  const isActive = isRowActive(
    target,
    chrome.activeTarget,
    chrome.homeRoomId,
    chrome.pendingAgentPath
  );

  if (target.kind === 'agent') {
    return (
      <AgentRowFromModel
        path={target.path}
        row={row}
        isActive={isActive}
        rowMotion={rowMotion}
        drag={drag}
      />
    );
  }

  if (target.kind === 'room') {
    return (
      <RoomRowFromModel
        roomId={target.roomId}
        roomKind={target.roomKind}
        isActive={isActive}
        rowMotion={rowMotion}
        drag={drag}
      />
    );
  }

  if (target.kind === 'add-on') {
    return <PinnedAppRow row={row} isActive={isActive} rowMotion={rowMotion} />;
  }

  return <DoorRowFromModel row={row} isActive={isActive} rowMotion={rowMotion} />;
}

/**
 * A room row: the memoized row, handed only what it draws.
 *
 * **Every prop here has to survive a render the row does not care about** (D8).
 * `RoomRow` is `React.memo`, and a preferences write rebuilds the whole model —
 * so a callback closed over `target` (a fresh object per build) would change
 * identity on every one of them and the memo would never hold. The two ids are
 * primitives, so the handler below is stable for the life of the row, and every
 * other prop comes from a memo in `SidebarChrome` that only moves when its own
 * data does.
 */
function RoomRowFromModel({
  roomId,
  roomKind,
  isActive,
  rowMotion,
  drag,
}: {
  roomId: string;
  roomKind: 'channel' | 'dm';
  isActive: boolean;
  rowMotion: SidebarRowMotion;
  drag?: React.ComponentProps<typeof SidebarRow>['drag'];
}) {
  const chrome = useSidebarChrome();
  const { openTarget } = chrome;
  const onSelect = useCallback(
    () => openTarget({ kind: 'room', roomId, roomKind }),
    [openTarget, roomId, roomKind]
  );
  const room = chrome.roomsById.get(roomId);
  // The index and this map are built from the same query, so a room row always
  // has its room. Drawing nothing rather than throwing keeps a torn render from
  // taking the whole sidebar down with it.
  if (room === undefined) return null;
  return (
    <RoomRow
      room={room}
      visual={chrome.roomVisualOf(room)}
      isActive={isActive}
      isMuted={chrome.mutedRoomIds.has(roomId)}
      currentGroupId={chrome.roomSectionIds.get(roomId) ?? null}
      moveTargetGroups={chrome.moveTargetGroups}
      onSelect={onSelect}
      viewAgentProfile={chrome.viewProfileFor}
      onRequestNewGroup={chrome.requestNewGroup}
      rowMotion={rowMotion}
      {...(drag ? { sortable: drag } : {})}
    />
  );
}

/** An agent row: the existing roster row, told what the model decided. */
function AgentRowFromModel({
  path,
  row,
  isActive,
  rowMotion,
  drag,
}: {
  path: string;
  row: SidebarRowModel;
  isActive: boolean;
  rowMotion: SidebarRowMotion;
  drag?: React.ComponentProps<typeof SidebarRow>['drag'];
}) {
  const chrome = useSidebarChrome();
  const manifest = chrome.manifests[path] ?? null;
  const visual = useAgentVisual(manifest, path);
  return (
    <AgentListItem
      path={path}
      agent={manifest}
      displayName={row.primary}
      visual={visual}
      isActive={isActive}
      isMuted={row.muted}
      isPaused={manifest !== null && chrome.pausedAgentIds.has(manifest.id)}
      {...(row.liveCount === undefined ? {} : { liveCount: row.liveCount })}
      unread={row.unread}
      onSelect={() => chrome.openTarget(row.target)}
      onViewProfile={chrome.viewProfileFor(path)}
      onRequestNewGroup={chrome.requestNewGroup}
      onSessionClick={(sessionId) =>
        chrome.openTarget({ kind: 'session', sessionId, agentPath: path, cwd: path })
      }
      onNewSession={() => chrome.newSession(path)}
      rowMotion={rowMotion}
      {...(drag ? { sortable: drag } : {})}
    />
  );
}

/**
 * A door — Threads, Directory, or the way to start a conversation — drawn
 * straight from the model's own fields.
 *
 * Never dragged, never unread, and carrying no menu: the page it opens is where
 * all of that lives. The To-dos door alone carries a neutral count of what is due.
 */
function DoorRowFromModel({
  row,
  isActive,
  rowMotion,
}: {
  row: SidebarRowModel;
  isActive: boolean;
  rowMotion: SidebarRowMotion;
}) {
  const chrome = useSidebarChrome();
  const Icon = row.glyph.kind === 'icon' ? ICON[row.glyph.icon] : Plus;
  return (
    <SidebarRow
      glyph={<Icon className={ROW_GLYPH_CLASS} aria-hidden />}
      title={row.primary}
      isActive={isActive}
      emphasized={false}
      muted={false}
      onSelect={() => chrome.openTarget(row.target)}
      rowMotion={rowMotion}
      {...(row.target.kind === 'command' ? { testId: DOOR_TEST_IDS[row.target.commandId] } : {})}
      {...(row.heldDot
        ? {
            trailing: (
              <>
                <span
                  aria-hidden
                  className={cn('size-1.5 rounded-full', STATUS_TONE_DOT.warning)}
                />
                <span className="sr-only">, an app needs your OK</span>
              </>
            ),
          }
        : {})}
      {...(row.count === undefined
        ? {}
        : {
            trailing: (
              <CountPill count={row.count} tone="neutral" label={`${row.count} due or overdue`} />
            ),
          })}
    />
  );
}
