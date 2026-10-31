import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { BellOff } from 'lucide-react';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import {
  CountPill,
  SidebarRow,
  statusDotClass,
  type SidebarMenuNode,
  type SidebarRowMotion,
} from '@/layers/shared/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui';
import {
  NOT_IN_ROOM_LABEL,
  NOT_IN_ROOM_PILL,
  RoomAvatar,
  RetiredMark,
  RoomTitle,
  hasUnread,
  roomDisplayTitle,
  useRoomWorking,
} from '@/layers/entities/room';
import { deriveUnreadSignal } from '../../model/rules/derive-unread-signal';
import { sidebarItemFaces, type SidebarItemVisual } from '../../model/sidebar-item';
import { directedCountCap, directedCountLabel } from './directed-count-label';
import { DISABLED_SORTABLE_BINDINGS, type SortableBindings } from '../dnd/SidebarDndPrimitives';
import { buildRoomRowMenuNodes } from './RoomRowMenuItems';
import { useRoomRowMenu, type RoomRowActs } from './use-room-row-menu';
import { openRoomPanel, type RoomDetailsFocus } from '@/layers/features/room-management';

/** Longest room name the server accepts (`UpdateRoomRequestSchema.title`). */
const MAX_NAME = 200;

/**
 * The menu of a row nobody has touched yet.
 *
 * A shared empty rather than a fresh `[]`, so the memoized row below is not
 * handed a new array on every render. The surface keeps its "⋮" and its
 * right-click target anyway, because the row also passes `onMenuIntent` — see
 * {@link useRoomRowMenu}.
 */
const SLEEPING_MENU: SidebarMenuNode[] = [];

interface RoomRowProps {
  /** The room this row opens. */
  room: RoomSummary;
  /**
   * The mark to draw, from the sidebar's item view model — a `#` for a channel,
   * the agent's own face for a one-to-one conversation, a stack of faces for a
   * group one. Resolved there because only that layer can see both the room and
   * the fleet (sidebar-groups §3.1).
   */
  visual: SidebarItemVisual;
  /** Whether this room is the one currently on screen. */
  isActive: boolean;
  /**
   * Whether the operator has silenced this room in its OWN right
   * (`ui.sidebar.muted`), not counting a muted section it happens to sit in.
   *
   * **A prop rather than a `useSidebarPrefs()` of its own** (D8). Every room row
   * used to subscribe to preferences for this one boolean, so folding a section
   * — or muting some other room — re-rendered all sixty of them. The panel
   * subscribes once, in `SidebarChrome`, and each row is handed its answer.
   */
  isMuted: boolean;
  /** The hand-made section this room is filed into, or `null`. */
  currentGroupId: string | null;
  /**
   * The sections "Move to section ▸" may offer.
   *
   * Smart sections are excluded by the panel that builds this list: their
   * membership comes from rules about agents, so a room filed into one would be
   * counted as grouped (and hidden from Channels) while that section drew its
   * derived members instead — the row would vanish. The drag layer refuses the
   * same drop; this refuses to offer it.
   */
  moveTargetGroups: readonly { id: string; name: string }[];
  /** Open the room. */
  onSelect: () => void;
  /**
   * View an agent's profile — the sidebar's one opener, so a room row and an
   * agent row send you to the same place.
   *
   * Takes a DIRECTORY, which is why the gate below is about resolving one and
   * nothing else: given a path this always opens something (`viewProfileFor`).
   */
  viewAgentProfile: (agentPath: string) => () => void;
  /** Open the inline section-create flow, moving this room into the new section on commit. */
  onRequestNewGroup: (ref: SidebarItemRef) => void;
  /**
   * Drag bindings applied to the row's root when the sidebar drag layer is
   * active (rooms-in-groups, DOR-581). Absent for a row that is not a drag
   * source, which renders exactly as before.
   */
  sortable?: SortableBindings;
  /**
   * Continuity motion for this row's list item (spec D5) — passed straight
   * through to {@link SidebarRow}.
   *
   * **It must be a stable object**, like every other prop this memoized row
   * takes: `SidebarModelRow` memoizes it on primitives so a preferences write
   * cannot move it. A fresh one per render defeats the memo for every room in
   * the panel, which is exactly what `RoomRow.render-count.test.tsx` catches.
   */
  rowMotion?: SidebarRowMotion;
}

/**
 * One room in the sidebar — its mark, its name, its unread state, and
 * everything you can do to it.
 *
 * **Memoized, and every prop it takes is stable across a render it does not
 * care about** (D8). Anything that moves per render — a callback built inline, a
 * preferences subscription, a fleet walk — defeats that, so this row reads no
 * context and holds no query of its own: what it draws arrives as props, and
 * what it DOES arrives when somebody reaches for its menu (see
 * {@link useRoomRowMenu}). Before that, one preferences write re-rendered every
 * room row in the panel and rebuilt seven mutation hooks apiece.
 *
 * **Unread is two tiers, decided by {@link deriveUnreadSignal}.** New messages
 * make the name bold and add nothing else; only messages aimed at you get a
 * number — an @mention of you anywhere, or any new message in a direct
 * message, which is addressed to you by nature. A channel with forty new
 * messages that nobody named you in is a bold name, not a 40. Mute takes the
 * bold away and keeps a mention's count, because being named by hand is not
 * the room pulling at you.
 *
 * `unreadCount` is read strictly: `null` means "you are not in this room",
 * which is not the same as `0` ("you are in it and caught up"), so a room the
 * operator has never joined is neither bold nor counted.
 *
 * The row's accessible name is built from its parts — `RoomTitle` contributes
 * `#general`, the pill contributes `3 mentions` — so no part names the room a
 * second time. Resting the pointer on the row shows the room's last line.
 *
 * A direct message shows whether its agent is working as a soft dot on the
 * face; a channel, which has no face, carries the same dot after its name.
 *
 * The actions live in {@link RoomRowMenuItems}, which builds them once and
 * renders the same list into the right-click ContextMenu and the "…"
 * DropdownMenu. Rename is an inline editor on the row itself, matching the
 * gesture the sidebar already uses for naming a section. Everything else opens
 * the room panel — including "Edit topic…", which used to raise a modal of its
 * own for one text field; the panel is where the topic is now written, and this
 * menu item is one of its doors. Those items open the ROOM as well as the panel,
 * because the panel describes whichever room the page is showing.
 */
export const RoomRow = memo(function RoomRow({
  room,
  visual,
  isActive,
  isMuted,
  currentGroupId,
  moveTargetGroups,
  onSelect,
  viewAgentProfile,
  onRequestNewGroup,
  sortable = DISABLED_SORTABLE_BINDINGS,
  rowMotion,
}: RoomRowProps) {
  const unread = hasUnread(room);
  const working = useRoomWorking(room.id, room.working);
  const isDm = room.kind === 'dm';
  const signal = deriveUnreadSignal({
    unreadCount: room.unreadCount,
    directed: isDm,
    ...(room.mentionCount === undefined ? {} : { mentionCount: room.mentionCount }),
    muted: isMuted,
  });
  const title = roomDisplayTitle(room);
  const faces = sidebarItemFaces(visual);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(room.title);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  /**
   * Open this room's panel at the part the menu item named — after opening the
   * room itself.
   *
   * The panel describes the room the PAGE is showing (spec §3.6), and this menu
   * is over a list of rooms most of which are not it. So the row does what
   * pressing the row does first, and the panel follows it there; the id travels
   * with the request so the panel being left behind cannot answer instead.
   */
  const openRoomDetails = (focus: RoomDetailsFocus) => {
    onSelect();
    openRoomPanel(focus, room.id);
  };
  const renameRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const committedRef = useRef(false);

  // ── Waking the row (D8) ──
  //
  // `acts` is `null` until the reader presses, right-clicks or focuses this row;
  // {@link RoomRowActsBearer} then mounts the seven hooks behind the menu and
  // hands them up. `flushSync` is what makes the latch safe rather than racy:
  // the "⋮" opens its dropdown on the same `pointerdown` this fires from, so the
  // acts have to be in hand by the time that event finishes bubbling, not one
  // commit later — and a layout effect inside a `flushSync` lands in it.
  //
  // Safe to call from any of the three intents: the surface hands the focus one
  // over in a microtask, because focus can land while React is already
  // rendering and a flush is illegal there (see `onMenuIntent`).
  const [acts, setActs] = useState<RoomRowActs | null>(null);
  const [awake, setAwake] = useState(false);
  const awakeRef = useRef(false);
  const wake = useCallback(() => {
    if (awakeRef.current) return;
    awakeRef.current = true;
    flushSync(() => setAwake(true));
  }, []);

  // "Rename…" and "Edit topic…" both mount an editor that blur-commits, and the
  // launching menu closes in a SECOND commit whose focus restore would blur it
  // (DOR-329). Both nodes carry `opensInput: true`, which is what arms the
  // shared surface's close-focus guard — the arming lives there now, once,
  // instead of at every call site.

  useEffect(() => {
    if (isRenaming) {
      committedRef.current = false;
      requestAnimationFrame(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      });
    }
  }, [isRenaming]);

  const startRename = () => {
    // Seeded from `title`, not from what the row draws: a channel row reads
    // `#general` and the thing being edited is the name behind it.
    setRenameValue(room.title);
    setIsRenaming(true);
  };

  /**
   * Leave the editor and put the focus back on the row it replaced.
   *
   * Without this the editor unmounts under the cursor and focus falls to
   * `<body>`, which drops a keyboard reader out of the sidebar entirely — they
   * would have to Tab back in from the top of the page to reach the row they
   * just renamed.
   */
  const endRename = () => {
    setIsRenaming(false);
    // After the commit that swaps the editor back for the button.
    requestAnimationFrame(() => rowRef.current?.focus());
  };

  const commitRename = () => {
    // First Enter/Escape decides; everything after is a no-op — guards
    // double-Enter and the blur that follows a commit.
    if (committedRef.current) return;
    committedRef.current = true;
    endRename();
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME || trimmed === room.title) return;
    acts?.rename(trimmed);
  };

  const cancelRename = () => {
    committedRef.current = true;
    endRename();
  };

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  const confirmArchive = () => {
    setArchiveOpen(false);
    acts?.archive();
  };

  const confirmLeave = () => {
    setLeaveOpen(false);
    acts?.leave();
  };

  const roomRef: SidebarItemRef = { kind: 'room', roomId: room.id };

  /**
   * Whether this room IS a 1:1 — decided straight from `room.participants`, and
   * never from mesh resolution. Deliberately a DIFFERENT question than
   * {@link RoomRowFacts.soleAgentPath}'s: that answer is also `null` while the
   * fleet has not loaded yet and once the agent has left the mesh, and the
   * Leave/Join gate below must not read either of those as "not a 1:1" — a DM
   * whose one agent left the mesh is still exactly the room shape leaving
   * strands.
   */
  const isOneToOne = (room.participants ?? []).filter((p) => p.kind === 'agent').length === 1;
  /**
   * A direct message every agent in which is retired — unregistered, or its
   * folder now holding a different agent (DOR-2095). Nobody in it answers any
   * more, so the row says so beside the name rather than looking like a
   * conversation that is waiting on somebody.
   */
  const agentParticipants = (room.participants ?? []).filter((p) => p.kind === 'agent');
  const allRetired =
    agentParticipants.length > 0 && agentParticipants.every((p) => p.retired === true);

  /**
   * `room.wellKnown` on the wire — `'team'` for #team, `null`/absent for
   * every room a person or an agent opened (team-room-home spec D3.1). The
   * server refuses removing the owner from one of these outright.
   */
  const isSystemRoom = room.wellKnown != null;
  /**
   * Whether the viewer is currently on this room's roster. `unreadCount` is
   * `null` for exactly one reason — a read cursor is a property of membership,
   * and a non-member has none (`RoomService.listRooms`) — so this is the same
   * fact the sidebar's own unread badge already reads this way, not a new signal
   * invented for Leave.
   */
  const isMember = room.unreadCount !== null;
  // **What mute removes is what was asking** (DOR-1098). A muted row keeps its
  // name at full contrast — that is the part still worth reading — and loses the
  // bold and the working dot. It used to keep both and dim the lot, which made
  // the name hard to read and left the signals shouting through the dimming.
  // A mention's count is the one signal that stays: `deriveUnreadSignal` has
  // already let it through mute, and nothing here takes it back.
  const quiet = isMuted || !isMember;
  const countKind = isDm && !isMuted ? 'messages' : 'mentions';
  const showWorking = working > 0 && !quiet;
  // The row's own tooltip carries the name and the last line together, so the
  // name drops its browser tooltip whenever there is a line to show.
  const hasHint = (room.lastLine ?? '').trim().length > 0;

  const menuNodes = acts
    ? buildRoomRowMenuNodes({
        kind: room.kind,
        hasUnread: unread,
        isOneToOne,
        canLeave: acts.canLeave,
        isSystemRoom,
        isMember,
        isMuted,
        currentGroupId,
        groups: [...moveTargetGroups],
        onMarkRead: acts.markRead,
        onToggleMute: () => acts.setMuted(!isMuted),
        onMoveToGroup: acts.moveToSection,
        onNewGroup: () => onRequestNewGroup(roomRef),
        onAddAgents: () => openRoomDetails('add'),
        onOpenMembers: () => openRoomDetails('members'),
        onViewAgentProfile:
          acts.soleAgentPath === null ? null : viewAgentProfile(acts.soleAgentPath),
        onRename: startRename,
        onEditTopic: () => openRoomDetails('topic'),
        onLeave: () => setLeaveOpen(true),
        onJoin: acts.join,
        onArchive: () => setArchiveOpen(true),
      })
    : SLEEPING_MENU;

  return (
    <>
      {awake && <RoomRowActsBearer room={room} isActive={isActive} onReady={setActs} />}
      <SidebarRow
        glyph={
          <RoomAvatar
            room={room}
            participants={room.participants}
            visuals={faces}
            working={isDm && showWorking}
          />
        }
        title={
          allRetired ? (
            <>
              <RoomTitle room={room} tooltip={!hasHint} />
              <RetiredMark retired className="ml-1 shrink-0" />
            </>
          ) : (
            <RoomTitle room={room} tooltip={!hasHint} />
          )
        }
        titleText={title}
        isActive={isActive}
        emphasized={signal.tier !== 'none' && !quiet}
        muted={quiet}
        hint={room.lastLine ?? null}
        onSelect={onSelect}
        buttonRef={rowRef}
        menuNodes={menuNodes}
        onMenuIntent={wake}
        actionsLabel={`${title} actions`}
        menuWidth="w-52"
        drag={sortable}
        {...(rowMotion === undefined ? {} : { rowMotion })}
        editor={
          isRenaming ? (
            <input
              ref={renameRef}
              value={renameValue}
              maxLength={MAX_NAME}
              aria-label={`Rename ${title}`}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              // The row is a context-menu trigger, and this field sits inside
              // it. Without this, right-clicking to paste opened the ROOM menu,
              // which blurred the editor and blur-committed a half-typed name
              // nobody confirmed. Propagation stops here so the browser's own
              // edit menu appears instead; the event is deliberately not
              // prevented, because that menu is the whole point of
              // right-clicking a text field.
              onContextMenu={(e) => e.stopPropagation()}
              className={cn(
                'bg-background text-foreground',
                'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
              )}
            />
          ) : undefined
        }
        trailing={
          <>
            {!isMember && (
              <span
                className="text-muted-foreground bg-muted text-3xs shrink-0 rounded-full px-1.5 py-0.5 font-medium"
                // A hint, not a repeat of the mute icon's shape: the room is
                // still visible (the owner sees every room whether or not
                // they are on its roster), only unpostable — a fact the
                // dimmed row alone does not say. It names the room's state
                // and not a past action, because `unreadCount === null` is
                // equally true of a room she left and one an agent opened
                // without her (DOR-1620).
                aria-label={NOT_IN_ROOM_LABEL}
              >
                {NOT_IN_ROOM_PILL}
              </span>
            )}
            {isMuted && (
              <BellOff className="text-sidebar-foreground/50 size-3" aria-label="Muted" />
            )}
            {showWorking &&
              (isDm ? (
                // The face carries the dot (`RoomAvatar`'s `working`), and the
                // face is hidden from assistive technology — so the words live
                // here, where the row's name is built.
                <span className="sr-only">
                  {working === 1 ? '1 agent working' : `${working} agents working`}
                </span>
              ) : (
                <span
                  // `img` because the dot has no text of its own: a bare
                  // `aria-label` on a generic element is not reliably read out,
                  // and a role is what turns this from decoration into something
                  // with a name.
                  role="img"
                  // The shared dot vocabulary — `statusDotClass('working')` is
                  // the success token plus the one pulse this sidebar spends on
                  // "right now".
                  className={cn('size-1.5 rounded-full', statusDotClass('working'))}
                  // A dot, and nothing else: work in flight is a fact about
                  // right now that needs no number on screen. A reader who
                  // cannot see it gets the count in the label, which does not
                  // name the room again — the row's own name is already the
                  // first half of what a screen reader reads out.
                  aria-label={working === 1 ? '1 agent working' : `${working} agents working`}
                />
              ))}
            {signal.tier === 'directed' && signal.count !== undefined && (
              <CountPill
                count={signal.count}
                cap={directedCountCap(countKind)}
                label={directedCountLabel(signal.count, countKind)}
              />
            )}
          </>
        }
      />

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {title}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>It leaves your sidebar, and its agents stop answering there.</p>
                <p>Its messages are kept. You can bring it back any time.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {title}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>You can still read it, but you can’t post.</p>
                <p>Rejoin from this menu any time.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLeave}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});

/**
 * The row's acts, mounted.
 *
 * A component of its own because hooks cannot be conditional and the whole point
 * is that these seven are not mounted for a row nobody has touched. It draws
 * nothing — it hands the acts up in a LAYOUT effect, which is what puts them in
 * the row's hands inside the same synchronous commit the wake latch forces,
 * before the press that woke it has finished bubbling.
 *
 * `useRoomRowMenu` memoizes its answer, so this publishes once and then only
 * when something the acts are built from actually moves.
 */
function RoomRowActsBearer({
  room,
  isActive,
  onReady,
}: {
  room: RoomSummary;
  isActive: boolean;
  onReady: (acts: RoomRowActs) => void;
}) {
  const acts = useRoomRowMenu({ room, isActive });
  useLayoutEffect(() => {
    onReady(acts);
  }, [acts, onReady]);
  return null;
}
