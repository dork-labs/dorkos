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
import { SidebarRow } from '@/layers/shared/ui';
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import { SessionVerbLine } from '@/layers/entities/session';
import type { SidebarIconId, SidebarRowModel, SidebarTarget } from '../model/build-sidebar-model';
import type { UngroupedSectionId } from '../model/use-sidebar-dnd';
import { sameTarget } from '../model/rules/targets';
import { AgentListItem } from './AgentListItem';
import { RoomRow } from './rooms/RoomRow';
import { Sortable, sidebarDndData, sidebarRowDndId } from './dnd/SidebarDndPrimitives';
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
export function SidebarModelRow({ row, keyPrefix, sectionId }: SidebarModelRowProps) {
  const ref = dragRefOf(row.target);
  const body = <SidebarModelRowBody row={row} keyPrefix={keyPrefix} />;
  if (!row.draggable || ref === null) return body;
  return (
    <Sortable id={sidebarRowDndId(keyPrefix, ref)} data={sidebarDndData(keyPrefix, ref, sectionId)}>
      {(bindings) => <SidebarModelRowBody row={row} keyPrefix={keyPrefix} drag={bindings} />}
    </Sortable>
  );
}

/** The row itself, once the drag layer has (or has not) wrapped it. */
function SidebarModelRowBody({
  row,
  keyPrefix,
  drag,
}: {
  row: SidebarRowModel;
  keyPrefix: string;
  drag?: React.ComponentProps<typeof SidebarRow>['drag'];
}) {
  const chrome = useSidebarChrome();
  const target = row.target;
  const isActive = isRowActive(target, chrome.activeTarget, chrome.homeRoomId);

  if (target.kind === 'agent') {
    return <AgentRowFromModel path={target.path} row={row} isActive={isActive} drag={drag} />;
  }

  // **A thread is deliberately NOT routed here.** `RoomRow` draws the room —
  // its `#slug`, its roster, its menu — so a thread sent through it comes out
  // as a second copy of its channel, with the root message it hangs off
  // nowhere on the row. It goes to the generic row instead, which draws what
  // the model actually gave it: `general › Anything else to check?` (BC-23).
  if (target.kind === 'room' && target.roomKind !== 'thread') {
    const room = chrome.roomsById.get(target.roomId);
    // The index and this map are built from the same query, so a room row
    // always has its room. Drawing nothing rather than throwing keeps a torn
    // render from taking the whole sidebar down with it.
    if (room === undefined) return null;
    return (
      <RoomRow
        room={room}
        visual={chrome.roomVisualOf(room)}
        isActive={isActive}
        onSelect={() => chrome.openTarget(target)}
        viewAgentProfile={chrome.viewProfileFor}
        onRequestNewGroup={chrome.requestNewGroup}
        {...(drag ? { sortable: drag } : {})}
      />
    );
  }

  return <GenericRowFromModel row={row} isActive={isActive} drag={drag} />;
}

/** An agent row: the existing roster row, told what the model decided. */
function AgentRowFromModel({
  path,
  row,
  isActive,
  drag,
}: {
  path: string;
  row: SidebarRowModel;
  isActive: boolean;
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
  drag,
}: {
  row: SidebarRowModel;
  isActive: boolean;
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

  return (
    <SidebarRow
      glyph={glyph}
      {...(row.secondary === undefined ? {} : { who: row.primary })}
      title={row.secondary ?? row.primary}
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
