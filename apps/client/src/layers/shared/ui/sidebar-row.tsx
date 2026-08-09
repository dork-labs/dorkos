/**
 * The sidebar's one row.
 *
 * Every row in the sidebar — a session, a channel, a direct message, a thread,
 * an agent — is this component. The chrome never varies by what the row points
 * at; the glyph carries the type (design-decisions §3). Before this there were
 * three row implementations with three sets of paddings, three hover
 * treatments and three menu wirings, which is why an agent row and the
 * conversation with that same agent looked like different products.
 *
 * @module shared/ui/sidebar-row
 */
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/layers/shared/lib';
import {
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
  ROW_SESSION_MARKER,
  composeRowLabel,
  hasSecondLine,
} from '@/layers/shared/lib/row-grammar';
import { SIDEBAR_ROW_ATTRIBUTE } from '@/layers/shared/model/use-roving-focus';
import { SidebarMenuItem } from './sidebar';
import { SidebarMenuSurface, type SidebarMenuNode } from './sidebar-menu-node';

/** The horizontal inset every sidebar row pays, and the only place it is paid. */
export const SIDEBAR_ROW_INSET = 'px-2';

/** Props for {@link SidebarRow}. */
export interface SidebarRowProps {
  /**
   * The mark at the head of the row, in a fixed 18px slot — an agent's face, a
   * room's `#`, a stack of faces for a group conversation. A node rather than a
   * descriptor so `shared/` never has to know what an agent or a room is.
   */
  glyph?: ReactNode;
  /**
   * The agent a session belongs to. Rendered before the title with a `›`
   * between them, capped at 42% of the line. Omit for a row that is a place
   * rather than a thread of one — the missing `›` is what says so (BC-23).
   */
  who?: string | null;
  /** What the row is called. A node so a room can bring its own `#name`. */
  title: ReactNode;
  /**
   * The title as plain text, when {@link title} is a node. Used to build the
   * row's tooltip and its `title` attribute; falls back to {@link title} when it
   * is already a string.
   */
  titleText?: string;
  /**
   * The trailing meta slot — a timestamp, an unread badge, an origin mark, a
   * project chip. Never shrunk and never pushed off the line (BC-25).
   */
  trailing?: ReactNode;
  /**
   * The second line. Renders only when the row earns one: a live verb
   * ({@link reservesVerbLine}) or a {@link preview} worth showing (BC-24).
   */
  secondLine?: ReactNode;
  /** The row carries a live verb, so it keeps its second line even while the verb is empty. */
  reservesVerbLine?: boolean;
  /** One line about the last thing that happened here, or `null` for none. */
  preview?: string | null;
  /** The row's menu, as data. An empty list means no right-click menu and no "⋮". */
  menuNodes?: SidebarMenuNode[];
  /** Accessible name for the "⋮" trigger, e.g. `"#general actions"`. Required once `menuNodes` is non-empty. */
  actionsLabel?: string;
  /** Width class for the menus. */
  menuWidth?: string;
  /** Show the "⋮" at rest rather than on hover — touch, where there is no hover. */
  alwaysShowActions?: boolean;
  /** This row is the thing currently on screen. */
  isActive?: boolean;
  /** The row is asking to be read — unread, in the two-tier sense (bold, no badge). */
  emphasized?: boolean;
  /** Muted: dimmed, still there, still clickable, no longer asking for anything. */
  muted?: boolean;
  /** Open whatever the row points at. */
  onSelect?: () => void;
  /**
   * Text read out before the row's visible content. For a row whose own
   * contents do not name the act — a drag-enabled row whose accessible name
   * would otherwise be built from its face's label.
   */
  srLabel?: string;
  /**
   * An inline editor that REPLACES the row — a rename field. The "⋮" is
   * withdrawn while it is up: the menu that opened the editor must not offer a
   * second door back into itself.
   */
  editor?: ReactNode;
  /** Rendered under the row, inside the same list item — an expansion panel. */
  expansion?: ReactNode;
  /** Stamped on the row button, for tests and page objects. */
  dataSlot?: string;
  /** Extra classes on the row button. */
  className?: string;
  /** Extra classes on the list item. */
  itemClassName?: string;
  /** Ref to the row button, for focus restoration after an inline editor closes. */
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * The drag bindings from the sidebar's drag layer, when this row is a drag
   * source.
   *
   * They land on a wrapper INSIDE the list item and OUTSIDE the context-menu
   * trigger, deliberately: dnd-kit registers that node as its own activator, so
   * a keydown has to reach it to pick the row up — while the "⋮" trigger and any
   * inline editor inside keep their own keyboard behaviour. A row with no
   * bindings renders the same wrapper with nothing on it.
   */
  dragRef?: (element: HTMLElement | null) => void;
  /** Listeners and ARIA the drag layer puts on the drag root. */
  dragProps?: HTMLAttributes<HTMLElement>;
  /** Transform/transition the drag layer applies while the row moves. */
  dragStyle?: CSSProperties;
  /** The row is currently being dragged. */
  isDragging?: boolean;
  /** Something is hovering over this row as a drop target. */
  isOver?: boolean;
}

/**
 * One row: `[glyph] [who] [› title] [trailing]`, with an optional second line
 * and a hover/`focus-visible` vertical kebab in a narrow gutter.
 *
 * **The truncation budget is CSS and only CSS** — the name is capped at 42%,
 * the title flexes down to ~6 characters, the meta slot never moves. No
 * JavaScript measures anything, so the budget is deterministic at any width and
 * a browser test can read it straight off computed style (BC-25).
 *
 * **Separation is tint, never a line.** Hover is one step up the
 * `--sidebar-accent` ramp and active is the top of it; there is no border
 * anywhere in this component. `--muted` is deliberately absent: it is lighter
 * than the sidebar panel in light mode and darker in dark, so a row tinted with
 * it would separate in opposite directions between themes (spec R1).
 */
export function SidebarRow({
  glyph,
  who,
  title,
  titleText,
  trailing,
  secondLine,
  reservesVerbLine,
  preview,
  menuNodes = [],
  actionsLabel,
  menuWidth,
  alwaysShowActions = false,
  isActive = false,
  emphasized = false,
  muted = false,
  onSelect,
  srLabel,
  editor,
  expansion,
  dataSlot,
  className,
  itemClassName,
  buttonRef,
  dragRef,
  dragProps,
  dragStyle,
  isDragging = false,
  isOver = false,
}: SidebarRowProps) {
  const plainTitle = titleText ?? (typeof title === 'string' ? title : '');
  const showSecondLine = hasSecondLine({ reservesVerbLine, preview });
  const second = secondLine ?? (preview?.trim() ? preview : null);

  const row =
    editor !== undefined ? (
      <div className={cn('flex w-full items-center gap-2 rounded-md py-1.5', SIDEBAR_ROW_INSET)}>
        {glyph !== undefined && (
          <span className="flex size-[18px] shrink-0 items-center">{glyph}</span>
        )}
        {editor}
      </div>
    ) : (
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        title={composeRowLabel(who, plainTitle) || undefined}
        aria-current={isActive ? 'page' : undefined}
        data-slot={dataSlot}
        {...{ [SIDEBAR_ROW_ATTRIBUTE]: '' }}
        className={cn(
          // 13px on a 28px line, the density §11 asks for: `min-h-7` is the
          // line and `py-1` is what keeps a one-line row on it exactly. A row
          // that earned a second line grows past it, which is the point —
          // height carries meaning here.
          'focus-visible:ring-sidebar-ring flex min-h-7 w-full rounded-md py-1 pr-7 text-left text-[13px] outline-hidden transition-colors duration-100 focus-visible:ring-2 active:scale-[0.98]',
          SIDEBAR_ROW_INSET,
          showSecondLine ? 'items-start py-1.5' : 'items-center',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
          emphasized && !isActive && !muted && 'text-sidebar-foreground font-medium',
          className
        )}
      >
        {srLabel !== undefined && <span className="sr-only">{srLabel}</span>}
        {glyph !== undefined && (
          // Nudged down when there is a second line, so the mark reads as
          // centred on the FIRST line rather than on a two-line block.
          <span
            className={cn(
              'flex size-[18px] shrink-0 items-center justify-center',
              showSecondLine && 'mt-px'
            )}
          >
            {glyph}
          </span>
        )}
        <span className={cn('flex min-w-0 flex-1 flex-col', glyph !== undefined && 'ml-2')}>
          <span className="flex w-full items-center gap-1.5">
            {who ? (
              <>
                <span className={ROW_WHO_CLASS}>{who}</span>
                <span aria-hidden className="text-sidebar-foreground/40 flex-none">
                  {ROW_SESSION_MARKER}
                </span>
              </>
            ) : null}
            <span className={ROW_TITLE_CLASS}>{title}</span>
            {trailing !== undefined && (
              <span className={cn('flex items-center gap-1.5', ROW_TRAILING_CLASS)}>
                {trailing}
              </span>
            )}
          </span>
          {showSecondLine && second !== null && (
            <span className="text-sidebar-foreground/50 truncate text-[11px] font-normal">
              {second}
            </span>
          )}
        </span>
      </button>
    );

  return (
    <SidebarMenuItem className={itemClassName}>
      <div
        ref={dragRef}
        style={dragStyle}
        {...dragProps}
        className={cn(
          dragRef !== undefined &&
            'focus-visible:ring-sidebar-ring rounded-md outline-hidden focus-visible:ring-2',
          isDragging && 'opacity-40',
          isOver && 'ring-sidebar-ring ring-2',
          // Muted dims the whole row and drops the unread emphasis above: still
          // there, still clickable, just no longer asking for anything (DOR-339).
          muted && 'opacity-60'
        )}
      >
        <SidebarMenuSurface
          nodes={menuNodes}
          actionsLabel={actionsLabel ?? ''}
          menuWidth={menuWidth}
          hideActionsTrigger={editor !== undefined}
          alwaysShowActions={alwaysShowActions}
        >
          {row}
        </SidebarMenuSurface>
      </div>
      {expansion}
    </SidebarMenuItem>
  );
}
