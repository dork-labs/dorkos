/**
 * One {@link SidebarRowModel}, drawn.
 *
 * The model decided that this row exists, where it sits, what it points at and
 * how much attention it is asking for. This decides nothing — it dispatches on
 * `target.kind` and hands the row to the component that knows how that kind of
 * thing looks.
 *
 * An agent and a room keep their existing components, which carry their menus,
 * their inline rename editors and their dialogs. Everything else is a
 * {@link SidebarRow} built straight from the model's own fields.
 *
 * @module features/dashboard-sidebar/ui/SidebarModelRow
 */
import { useCallback, useMemo } from 'react';
import { useReducedMotion } from 'motion/react';
import {
  Bot,
  CalendarClock,
  CircleHelp,
  Clock,
  Hash,
  MessageSquare,
  MoreHorizontal,
  ShieldQuestion,
  Sparkles,
  TriangleAlert,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { SidebarRow, type SidebarRowMotion } from '@/layers/shared/ui';
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import { SessionVerbLine } from '@/layers/entities/session';
import type { SidebarIconId, SidebarRowModel, SidebarTarget } from '../model/build-sidebar-model';
import type { UngroupedSectionId } from '../model/use-sidebar-dnd';
import { sameTarget } from '../model/rules/targets';
import { AgentListItem } from './AgentListItem';
import { RoomRow } from './rooms/RoomRow';
import { Sortable, sidebarDndData, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
import {
  ARRIVE_FROM,
  ARRIVE_TO,
  LEAVE_TO,
  arriveTransition,
  leaveTransition,
} from './motion/sidebar-motion';
import { useSidebarChrome } from './SidebarChrome';

/**
 * Whether a row points at what is currently on screen.
 *
 * An agent row is active when the open conversation belongs to it, which is
 * what makes BC-33's dual presence readable: the anchor in Today and the
 * agent's own Library row both take the active tint, and the operator can see
 * they are the same thing.
 *
 * @param target - The row's target.
 * @param active - What the router says is open, or `null`.
 * @param homeRoomId - The room `/` is showing, when `/` is showing — `null`
 *   everywhere else. Only Home's own row consults it.
 */
export function isRowActive(
  target: SidebarTarget,
  active: SidebarTarget | null,
  homeRoomId: string | null = null
): boolean {
  // **Home's room, lit without being "active".** `/` draws #team, so its row has
  // to look open there — but `/` has no active target and deliberately does not
  // get one (`useActiveTarget` explains what widening it broke). A thread row
  // carries the same `roomId` as its channel and is excluded, or Home would
  // light two rows and leave `aria-current="page"` no longer unique.
  if (
    homeRoomId !== null &&
    target.kind === 'room' &&
    target.roomKind !== 'thread' &&
    target.roomId === homeRoomId
  ) {
    return true;
  }
  if (active === null) return false;
  if (target.kind === 'session') {
    return active.kind === 'session' && active.sessionId === target.sessionId;
  }
  if (target.kind === 'agent') {
    if (active.kind === 'agent') return active.path === target.path;
    return active.kind === 'session' && active.cwd === target.path;
  }
  if (target.kind === 'room') {
    // **Compared through the row key, never through `roomId`.** A thread and
    // the room it lives in are two rows carrying the same `roomId`, so an id
    // comparison lights both — two active tints, and an `aria-current="page"`
    // that is no longer unique, which is exactly the handle scroll-to-active
    // finds the anchor by (BC-36).
    return sameTarget(target, active);
  }
  return false;
}

/** The mark each semantic icon id draws. */
const ICON: Record<SidebarIconId, LucideIcon> = {
  permission: ShieldQuestion,
  question: CircleHelp,
  error: TriangleAlert,
  schedule: CalendarClock,
  overflow: MoreHorizontal,
  working: Sparkles,
  automated: Clock,
  digest: Sparkles,
  'add-agent': Bot,
  'first-session': MessageSquare,
  team: Users,
  dorkbot: Bot,
  session: MessageSquare,
};

/**
 * The stored reference a Library row drags as, or `null` for a row that never
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
   * The drag container this copy of the row lives in — `pinned`, `ungrouped`,
   * or a group id. Also what lets a pinned copy coexist with its home copy,
   * which is the same row twice with two different React keys.
   */
  keyPrefix: string;
  /** The ungrouped section the drag layer announces this row's home as. */
  sectionId?: UngroupedSectionId;
  /**
   * The section's row ids, in order — what this row's FLIP measures against
   * (spec D5). Per section and never per panel: a channel arriving in Today must
   * not make thirty agent rows re-measure.
   */
  layoutKey?: string;
  /**
   * The section this row is in announces arrivals — Heads up and Today, the two
   * zones whose membership changes without the operator asking.
   */
  arrives?: boolean;
  /** This row is one of the arrivals, so it tints once. */
  arrived?: boolean;
}

/**
 * Draw one row, wrapping it in a drag source when the model says it is one.
 *
 * `row.draggable` is the only gate. R3 puts that decision in the model — Heads up
 * and Today are computed, so their rows are never drag sources — precisely so
 * that no call site here can re-enable it by accident.
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
  const rowMotion = useMemo<SidebarRowMotion>(
    () => ({
      layout: true,
      layoutDependency: layoutKey,
      // A row that was already there has no entrance. `false` is motion's "start
      // where you are", and it is what every row wears on the frame the panel
      // first paints — warm boot and cold reveal alike.
      initial: arrives && arrived ? ARRIVE_FROM : false,
      animate: arrives ? ARRIVE_TO : undefined,
      exit: arrives ? LEAVE_TO : undefined,
      transition: arrived ? arriveTransition(reducedMotion) : leaveTransition(reducedMotion),
      arrived,
    }),
    [layoutKey, arrives, arrived, reducedMotion]
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
  const isActive = isRowActive(target, chrome.activeTarget, chrome.homeRoomId);

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

  // **A thread is deliberately NOT routed here.** `RoomRow` draws the room —
  // its `#slug`, its roster, its menu — so a thread sent through it comes out
  // as a second copy of its channel, with the root message it hangs off
  // nowhere on the row. It goes to the generic row instead, which draws what
  // the model actually gave it: `general › Anything else to check?` (BC-23).
  if (target.kind === 'room' && target.roomKind !== 'thread') {
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

  return <GenericRowFromModel row={row} isActive={isActive} rowMotion={rowMotion} drag={drag} />;
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
      {...(row.liveCount === undefined ? {} : { liveCount: row.liveCount })}
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
 * Every other row — an attention item, a rollup, a suggestion, a session.
 *
 * Built entirely from the model's own fields, which is what makes Heads up, Today
 * and Getting started renderable before P2.2 and P2.3 land their behaviour: the
 * shape is decided already, and those tasks fill in the destinations.
 */
function GenericRowFromModel({
  row,
  isActive,
  rowMotion,
  drag,
}: {
  row: SidebarRowModel;
  isActive: boolean;
  rowMotion: SidebarRowMotion;
  drag?: React.ComponentProps<typeof SidebarRow>['drag'];
}) {
  const chrome = useSidebarChrome();
  const agentPath = row.glyph.kind === 'agent-avatar' ? row.glyph.agentPath : null;
  const visual = useAgentVisual(
    agentPath === null ? null : (chrome.manifests[agentPath] ?? null),
    agentPath ?? row.key
  );
  const Icon = row.glyph.kind === 'icon' ? ICON[row.glyph.icon] : null;
  // **No menu on a Heads up row, and there is no longer a row that could earn
  // one.** The idle nudge was the single thing in this zone the operator could
  // wave away (BC-10), and DOR-1391 retired the nudge; everything left here
  // clears by being answered, allowed, refused or fixed. There is no dismiss and
  // no snooze anywhere in Heads up (BC-42).
  const glyph =
    row.glyph.kind === 'agent-avatar' ? (
      <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
    ) : row.glyph.kind === 'hash' ? (
      <Hash className="text-sidebar-foreground/60 size-3.5" aria-hidden />
    ) : Icon !== null ? (
      <Icon className="text-sidebar-foreground/60 size-3.5" aria-hidden />
    ) : (
      <MessageSquare className="text-sidebar-foreground/60 size-3.5" aria-hidden />
    );

  // The one row in the panel that leaves it. `All N agents` opens the Team page,
  // so it wears the mark every "goes elsewhere" affordance in the cockpit wears
  // — and wears it `aria-hidden`, because a direction is a picture rather than a
  // word: "All fifteen agents right arrow" is not a sentence anybody wants read
  // to them. `titleText` keeps the tooltip and the accessible name as the words.
  const leavesPanel = row.target.kind === 'command' && row.target.commandId === 'open-team';

  return (
    <SidebarRow
      glyph={glyph}
      {...(row.secondary === undefined ? {} : { who: row.primary })}
      title={
        leavesPanel ? (
          <>
            {row.primary}
            <span aria-hidden className="text-sidebar-foreground/50 ml-1">
              →
            </span>
          </>
        ) : (
          (row.secondary ?? row.primary)
        )
      }
      {...(leavesPanel ? { titleText: row.primary } : {})}
      isActive={isActive}
      // Muted drops every signal the row was using to ask for something — the
      // bold, and the badge below — and keeps the label at full contrast
      // (DOR-1098).
      emphasized={row.unread.tier !== 'none' && !row.muted}
      muted={row.muted}
      {...(row.reservesVerbLine ? { reservesVerbLine: true } : {})}
      {...(row.target.kind === 'session'
        ? {
            // **The words, subscribed to at the leaf** (BC-37, spec R1). The
            // model says whether there IS a second line; this node says what is
            // in it, and it is the only thing in the panel that watches a
            // session's tool activity. A row that reserved the line and was
            // handed no node held an empty 16px gap open under every streaming
            // conversation while the chat strip beside it read "Working…".
            secondLine: (
              <SessionVerbLine sessionId={row.target.sessionId} lifecycle={row.lifecycle} />
            ),
          }
        : {})}
      {...(row.preview === undefined ? {} : { preview: row.preview })}
      onSelect={() => chrome.openTarget(row.target)}
      rowMotion={rowMotion}
      {...(drag ? { drag } : {})}
      trailing={
        row.unread.tier === 'directed' && row.unread.count !== undefined && !row.muted ? (
          <span
            className="bg-brand/15 text-brand rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
            aria-label={`${row.unread.count} unread`}
          >
            {row.unread.count}
          </span>
        ) : undefined
      }
    />
  );
}
