/**
 * A session in the sidebar's own row grammar.
 *
 * The third session row, and the one that owns nothing of its own chrome:
 * `SidebarRow` draws the inset, the hover ramp, the active tint, the "⋮" and the
 * inline editor, and this decides only what goes in the slots. `SessionRowFull`
 * and `SessionRowCompact` predate those primitives and still carry their own
 * paddings, hover treatments and menu wiring — this one is what a session looks
 * like once the sidebar decides how a row looks (spec
 * `sidebar-now-today-library` §P1).
 *
 * **It renders its own list item**, because `SidebarRow` does. Put it inside a
 * `SidebarMenu` (a `<ul>`) and nothing else — wrapping it in a `SidebarMenuItem`
 * of your own nests one `<li>` inside another.
 *
 * @module entities/session/ui/SessionRowSidebar
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { GitFork, Info, Pencil, Zap } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import {
  SidebarRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TRUST_TONE_TEXT,
  statusDotClass,
  type SidebarMenuNode,
} from '@/layers/shared/ui';
import { RuntimeMark } from '@/layers/entities/runtime';
import type { StatusSignal } from '@/layers/shared/ui';
import { useSessionBorderState, type SessionBorderKind } from '../model/use-session-border-state';
import { useSessionPermissionSummary } from '../model/use-session-permission-summary';
import { sessionDisplayTitle } from '../lib/session-display-title';
import { FULL_POWER_MARK_LABEL } from '../lib/permission-mode';
import { AccountMark } from './AccountMark';
import { SessionContextGauge } from './SessionContextGauge';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { SessionOriginMark } from './SessionOriginMark';

/**
 * The row's operational state, in the cockpit's one dot vocabulary — or `null`
 * for a session with nothing to report.
 *
 * The two vocabularies were already the same four facts under two names, which
 * is why this is a total mapping and not a lookup with a default: a fifth
 * {@link SessionBorderKind} has to be given a colour here rather than silently
 * drawing nothing.
 *
 * `idle` is `null` on purpose. The full row painted idle as a barely-visible
 * grey stripe so the border did not vanish; a dot has no such problem, and a
 * list where only the rows with news wear a mark is the whole point of the
 * signal (`status-dot.ts`).
 *
 * @param kind - What the session's live projections settled on.
 */
export function statusSignalForBorderKind(kind: SessionBorderKind): StatusSignal | null {
  switch (kind) {
    case 'streaming':
      return 'working';
    case 'pendingApproval':
      return 'needs-you';
    case 'error':
      return 'error';
    case 'unseen':
      return 'unseen';
    case 'idle':
      return null;
  }
}

/** Props for {@link SessionRowSidebar}. */
export interface SessionRowSidebarProps {
  /** The session this row opens. */
  session: Session;
  /** Whether this row is the conversation currently on screen. */
  isActive: boolean;
  /** Open the session. */
  onSelect: () => void;
  /** Optional fork handler. When omitted, Fork is offered nowhere. */
  onFork?: (sessionId: string) => void;
  /** Optional rename handler. When omitted, Rename is offered nowhere. */
  onRename?: (sessionId: string, title: string) => void;
}

/**
 * One session row: a status dot, its title, its marks, and everything you can
 * do to it.
 *
 * **The status is the glyph.** In the identity rows the sidebar was designed
 * around, the leading 18px square holds a face or a `#`; here every row in the
 * list is a conversation with the same agent, so a face on each of them would
 * repeat one fact sixty times. The dot takes the square instead — the same edge
 * of the row where the full row's coloured border used to live, and the same
 * four-signal vocabulary the rest of the cockpit reads.
 *
 * **Rename, Fork and Details are menu nodes, so all three have a keyboard
 * path.** The full row put rename behind a hover-revealed pencil and details
 * behind a hover-revealed chevron, and offered fork only inside the panel that
 * chevron opened. Here they are one list rendered into the right-click menu, the
 * "⋮" and — on touch — the long-press sheet, which is what makes the three doors
 * agree by construction.
 *
 * @param props - The session, its selection state, and its handlers.
 */
export function SessionRowSidebar({
  session,
  isActive,
  onSelect,
  onFork,
  onRename,
}: SessionRowSidebarProps) {
  const [expanded, setExpanded] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const renameRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const committedRef = useRef(false);

  const border = useSessionBorderState(session.id);
  const signal = statusSignalForBorderKind(border.kind);
  const { isUnsafe } = useSessionPermissionSummary(session);
  // Re-read on the shared minute tick, so "2m ago" does not go stale under a
  // reader who is looking straight at it.
  useNow(60_000);
  const relativeTime = formatRelativeTime(session.updatedAt);
  const title = sessionDisplayTitle(session.title);

  useEffect(() => {
    if (!isRenaming) return;
    committedRef.current = false;
    // After the menu that opened it has finished closing — Radix restores focus
    // one commit later, and it would take it straight back off this field.
    requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(session.title);
    setIsRenaming(true);
  };

  /**
   * Leave the editor and put focus back on the row it replaced — without this
   * the editor unmounts and focus falls to `<body>`, dropping a keyboard reader
   * out of the sidebar entirely.
   */
  const endRename = () => {
    setIsRenaming(false);
    requestAnimationFrame(() => rowRef.current?.focus());
  };

  const commitRename = () => {
    // First Enter/Escape decides; the blur that follows a commit is a no-op.
    if (committedRef.current) return;
    committedRef.current = true;
    endRename();
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === session.title) return;
    onRename?.(session.id, trimmed);
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

  const menuNodes: SidebarMenuNode[] = [
    ...(onRename
      ? [
          {
            kind: 'action' as const,
            id: 'rename',
            label: 'Rename',
            icon: Pencil,
            opensInput: true,
            run: startRename,
          },
        ]
      : []),
    ...(onFork
      ? [
          {
            kind: 'action' as const,
            id: 'fork',
            label: 'Fork session',
            icon: GitFork,
            run: () => onFork(session.id),
          },
        ]
      : []),
    {
      kind: 'action' as const,
      id: 'details',
      label: expanded ? 'Hide details' : 'Details',
      icon: Info,
      run: () => setExpanded((prev) => !prev),
    },
  ];

  return (
    <SidebarRow
      glyph={
        signal === null ? (
          // An empty square rather than no glyph at all: dropping the slot on
          // quiet rows would left-shift every title that has nothing to report,
          // and a list whose text moves by 26px depending on whether an agent is
          // mid-turn is unreadable.
          <span aria-hidden className="size-1.5" />
        ) : (
          // **Colour is never the sole indicator** (`status-dot.ts`, WCAG 1.4.1).
          // A dot's entire content is a hue, so it has to be paired with words:
          // the label for a screen reader, and this tooltip for everyone else.
          //
          // A tooltip rather than a verb line, of the two stronger pairings the
          // dot vocabulary sanctions. A verb line only speaks while a turn is
          // streaming, and three of the four signals here — needs-you, error,
          // unseen — are exactly the states where nothing is streaming and the
          // line would sit empty. `border.label` names all four in the same
          // words the full row used, so this restores the affordance the old row
          // had rather than inventing a different one, and it matches the three
          // marks in the trailing slot beside it, which are all tooltipped
          // already.
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                // `img` because the dot has no text of its own — a bare
                // `aria-label` on a generic element is not reliably read out,
                // and the role is what turns this from decoration into
                // something with a name. Presentational within the row's
                // `<button>`: the trigger adds no tab stop of its own.
                role="img"
                aria-label={border.label}
                className={cn('size-1.5 rounded-full', statusDotClass(signal))}
              />
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {border.label}
            </TooltipContent>
          </Tooltip>
        )
      }
      title={title}
      isActive={isActive}
      emphasized={border.kind === 'unseen'}
      onSelect={onSelect}
      buttonRef={rowRef}
      menuNodes={menuNodes}
      actionsLabel={`${title} actions`}
      menuWidth="w-44"
      editor={
        isRenaming ? (
          <input
            ref={renameRef}
            value={renameValue}
            aria-label="Session title"
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={commitRename}
            // The row is a context-menu trigger and this field sits inside it,
            // so without this a right-click to paste opens the SESSION menu,
            // which blurs the editor and blur-commits a half-typed name. The
            // event is deliberately not prevented — the browser's own edit menu
            // is the whole point of right-clicking a text field.
            onContextMenu={(e) => e.stopPropagation()}
            className="bg-background text-foreground focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1"
          />
        ) : undefined
      }
      trailing={
        <>
          {isUnsafe && (
            // Presentational, unlike the full row's version of this mark, which
            // is a `<button>` carrying a tooltip. `trailing` renders inside the
            // row's own `<button>`, so the mark is an icon with a name.
            //
            // Green and a bolt, the same pair every other full-power surface
            // uses. Red here would have marked most rows in the list once the
            // defaults flipped (spec `full-power-defaults`, D8).
            <Zap
              role="img"
              aria-label={FULL_POWER_MARK_LABEL}
              className={`size-(--size-icon-xs) shrink-0 ${TRUST_TONE_TEXT.power}`}
            />
          )}
          <SessionContextGauge session={session} />
          <SessionOriginMark
            origin={session.origin}
            label={session.originLabel}
            className="text-sidebar-foreground/50"
          />
          <RuntimeMark
            type={session.runtime}
            model={session.model}
            className="text-sidebar-foreground/50"
          />
          <AccountMark account={session.account} className="text-sidebar-foreground/60" />
          <span className="text-sidebar-foreground/50 text-[10px] tabular-nums">
            {relativeTime}
          </span>
        </>
      }
      expansion={
        <SessionDetailsPanel
          session={session}
          expanded={expanded}
          {...(onFork ? { onFork } : {})}
        />
      }
    />
  );
}
