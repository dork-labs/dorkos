/**
 * The one row for lists outside the sidebar and outside menus.
 *
 * `[leading] [who ›] [title] [meta] [trailing] [actions]`, with an optional
 * second line — the same grammar the sidebar row draws, at list density: 32px
 * on desktop, 44 on a phone, 48 / 60 with a second line. The sidebar keeps its
 * own `SidebarRow` (its own geometry, its own drag); both take their states
 * from `shared/ui/row`.
 *
 * @module shared/ui/list-row
 */
import type { ReactNode, Ref } from 'react';
import { Slot } from 'radix-ui';
import { cn } from '@/layers/shared/lib/utils';
import { useIsMobile } from '@/layers/shared/model';
import {
  ROW_SESSION_MARKER,
  ROW_TITLE_CLASS,
  ROW_TRAILING_CLASS,
  ROW_WHO_CLASS,
  composeRowLabel,
} from '@/layers/shared/lib/row-grammar';
import { PRESS_ROW } from './press';
import { ROW_FOCUS_CLASS, rowState, rowTintVariants } from './row';
import { SIDEBAR_MENU_GUTTER, SidebarMenuSurface, type SidebarMenuNode } from './sidebar-menu-node';

/** Props for {@link ListRow}. */
export interface ListRowProps {
  /** The glyph: an icon, an avatar, a logo, a status mark. */
  leading?: ReactNode;
  /** `sm` (20 desktop / 24 phone) for icons and small avatars; `lg` (32 / 40) for two-line rows. */
  leadingSize?: 'sm' | 'lg';
  /** What the row is called. Never wraps. */
  title: ReactNode;
  /** The title as plain text, for the tooltip, when `title` is a node. */
  titleText?: string;
  /** Whose thread this is, for a session row: drawn as `who ›` before the title. */
  who?: string | null;
  /** Read-only facts after the title: a time, a count. Never shrinks. */
  meta?: ReactNode;
  /** One more line, when it earns it. Makes the row 48 / 60. */
  secondLine?: ReactNode;
  /**
   * Read-only state at the end: a count pill, a status word, a chevron. Always
   * shown. Under a 24rem row it moves to the start of the subtitle line.
   */
  trailing?: ReactNode;
  /**
   * The title is authored state copy — an empty, filtered or failed list — and
   * wraps rather than truncating. On a narrow row its `trailing` moves under it.
   */
  wrapTitle?: boolean;
  /**
   * Up to two ghost icon buttons. Rendered as siblings of the row's own
   * button, never inside it, and hidden until the row is hovered or focused
   * (always shown on touch). Space is reserved, so the title never reflows.
   */
  actions?: ReactNode;
  /** The row's menu, as data: a "⋮", a right-click menu and a long-press sheet. */
  menu?: SidebarMenuNode[];
  /** Accessible name for the "⋮". Required with `menu`. */
  menuLabel?: string;
  /** Chosen in a list you pick from: `aria-selected`. */
  selected?: boolean;
  /** The place you are: `aria-current="page"`. Drawn the same as selected. */
  current?: boolean;
  /** Asking to be read: weight 600. */
  emphasized?: boolean;
  /** Why the row can't be used. Disables it but keeps it focusable, and says why on hover. */
  disabledReason?: string;
  /** `page` (default): `px-2`, the list sits at `-mx-2`. `group`: `px-4`, full bleed inside a `FieldCard`. */
  inset?: 'page' | 'group';
  /** The row's child is the target (a router `Link` with no children): the row's body renders inside it. */
  asChild?: boolean;
  /** What a press does. Absent (and no `asChild`): a static row, with no hover and no Tab stop. */
  onSelect?: () => void;
  /** Extra classes on the outer row. */
  className?: string;
  /** Ref to the row's target, for focus restoration. */
  targetRef?: Ref<HTMLElement>;
  /** For `asChild`: the element that becomes the target. */
  children?: ReactNode;
}

const META_CLASS = 'text-muted-foreground text-xs font-normal tabular-nums';

/** The " · " between the facts on a subtitle line. */
function Separator() {
  return (
    <span aria-hidden className="text-faint px-1">
      ·
    </span>
  );
}

const LEADING = {
  sm: 'size-5 max-md:size-6',
  lg: 'size-8 max-md:size-10',
} as const;

/**
 * A list row: leading glyph, title, meta, trailing state and actions.
 *
 * @param props - See {@link ListRowProps}.
 */
export function ListRow({
  leading,
  leadingSize = 'sm',
  title,
  titleText,
  who,
  meta,
  secondLine,
  trailing,
  wrapTitle,
  actions,
  menu,
  menuLabel,
  selected,
  current,
  emphasized,
  disabledReason,
  inset = 'page',
  asChild,
  onSelect,
  className,
  targetRef,
  children,
}: ListRowProps) {
  const isMobile = useIsMobile();
  const disabled = disabledReason !== undefined;
  const interactive = asChild === true || onSelect !== undefined;
  const state = rowState({ disabled, selected: selected || current, emphasized });
  const twoLines = secondLine !== undefined && secondLine !== null;
  const plainTitle = titleText ?? (typeof title === 'string' ? title : '');
  const label = plainTitle ? composeRowLabel(who, plainTitle) : undefined;
  const hasMenu = menu !== undefined && menu.length > 0;
  // On a narrow row the trailing state moves under the title. For state copy
  // ("Couldn't load schedules.") that is its way out ("Try again"), which then
  // sits under the words rather than squeezing them into a sliver.
  const movesTrailing = trailing !== undefined && trailing !== null;
  const hasSubtitle = twoLines || Boolean(meta) || movesTrailing;

  const body = (
    <>
      {leading && (
        <span
          data-slot="list-row-leading"
          className={cn(
            'text-muted-foreground flex flex-none items-center justify-center',
            LEADING[leadingSize],
            twoLines && 'self-start'
          )}
        >
          {leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5 max-md:gap-2">
          {who && (
            <span className={cn(ROW_WHO_CLASS, 'text-foreground')}>
              {who} <span className="text-faint">{ROW_SESSION_MARKER}</span>
            </span>
          )}
          <span
            data-slot="list-row-title"
            data-wrap={wrapTitle || undefined}
            className={wrapTitle ? 'min-w-0 flex-auto whitespace-normal' : ROW_TITLE_CLASS}
          >
            {title}
          </span>
          {meta && (
            <span
              data-slot="list-row-meta"
              className={cn(ROW_TRAILING_CLASS, META_CLASS, 'hidden @min-[24rem]/row:inline')}
            >
              {meta}
            </span>
          )}
        </span>
        {hasSubtitle && (
          // The subtitle line. Under a 24rem row (a phone) the meta and the
          // trailing state move here, ahead of the second line and joined by
          // " · ", so the title gets the row's whole width instead of "Morni…".
          <span
            data-slot="list-row-subtitle"
            className={cn(
              'text-muted-foreground flex min-w-0 items-baseline text-xs font-normal',
              !twoLines && '@min-[24rem]/row:hidden'
            )}
          >
            {meta && (
              <span
                data-slot="list-row-subtitle-meta"
                className={cn(ROW_TRAILING_CLASS, 'tabular-nums @min-[24rem]/row:hidden')}
              >
                {meta}
                {(movesTrailing || twoLines) && <Separator />}
              </span>
            )}
            {movesTrailing && (
              <span
                data-slot="list-row-subtitle-trailing"
                className={cn(ROW_TRAILING_CLASS, '@min-[24rem]/row:hidden')}
              >
                {trailing}
                {twoLines && <Separator />}
              </span>
            )}
            {twoLines && <span className="min-w-0 truncate">{secondLine}</span>}
          </span>
        )}
      </span>
      {trailing && (
        <span
          data-slot="list-row-trailing"
          className={cn(
            ROW_TRAILING_CLASS,
            'flex items-center gap-1.5 text-xs font-normal',
            movesTrailing && 'hidden @min-[24rem]/row:flex'
          )}
        >
          {trailing}
        </span>
      )}
    </>
  );

  const targetClass = cn(
    'flex min-w-0 flex-1 items-center gap-2 text-left max-md:gap-3',
    'rounded-[inherit] py-1',
    twoLines ? 'min-h-12 py-1.5 max-md:min-h-15' : 'min-h-8 max-md:min-h-11',
    inset === 'group' ? 'px-4' : 'px-2',
    interactive && cn(ROW_FOCUS_CLASS, !disabled && PRESS_ROW),
    disabled && 'cursor-not-allowed'
  );

  const ariaState = {
    'aria-current': current ? ('page' as const) : undefined,
    'aria-selected': selected === undefined || current ? undefined : selected,
    'aria-disabled': disabled || undefined,
    title: disabledReason ?? label,
  };

  let target: ReactNode;
  if (asChild) {
    target = (
      <Slot.Root
        ref={targetRef as Ref<HTMLElement>}
        data-slot="list-row-target"
        className={targetClass}
        {...ariaState}
      >
        {/* The caller's element is the target, and the row's body goes inside
            it: pass a `Link` with no children of its own. */}
        <Slot.Slottable>{children}</Slot.Slottable>
        {body}
      </Slot.Root>
    );
  } else if (onSelect) {
    target = (
      <button
        ref={targetRef as Ref<HTMLButtonElement>}
        type="button"
        data-slot="list-row-target"
        className={targetClass}
        onClick={disabled ? undefined : onSelect}
        {...ariaState}
      >
        {body}
      </button>
    );
  } else {
    target = (
      <div data-slot="list-row-target" className={targetClass} title={label}>
        {body}
      </div>
    );
  }

  const row = (
    <div
      data-slot="list-row"
      data-row-state={state}
      className={cn(
        'group/row @container/row relative flex items-center text-sm',
        inset === 'group' ? 'rounded-none' : 'rounded-md',
        'transition-[background-color] duration-150 ease-out',
        rowTintVariants({ interactive: interactive && !disabled, state }),
        // A focused row says what a hovered one says.
        interactive &&
          state !== 'selected' &&
          !disabled &&
          'has-[[data-slot=list-row-target]:focus-visible]:bg-row-hover',
        hasMenu && (isMobile ? SIDEBAR_MENU_GUTTER.coarse : SIDEBAR_MENU_GUTTER.fine),
        className
      )}
    >
      {target}
      {actions && (
        <span
          data-slot="list-row-actions"
          className={cn(
            'flex flex-none items-center gap-0.5 pr-1',
            'opacity-0 transition-opacity duration-100 ease-in',
            // A wide row reserves the actions' space so the title never
            // reflows on hover. A narrow one can't afford it: the actions
            // leave the flow at rest and come back on hover, focus or an open
            // menu, so the title gets the width (always shown on touch).
            '@max-[24rem]/row:hidden @max-[24rem]/row:group-hover/row:flex',
            '@max-[24rem]/row:group-focus-within/row:flex @max-[24rem]/row:group-has-[[data-state=open]]/row:flex',
            '@max-[24rem]/row:pointer-coarse:flex',
            'group-hover/row:opacity-100 group-hover/row:duration-150 group-hover/row:ease-out',
            'group-focus-within/row:opacity-100 group-has-[[data-state=open]]/row:opacity-100',
            'motion-reduce:transition-none pointer-coarse:opacity-100'
          )}
        >
          {actions}
        </span>
      )}
    </div>
  );

  if (!hasMenu) return row;
  return (
    <SidebarMenuSurface nodes={menu} actionsLabel={menuLabel ?? `${plainTitle} actions`}>
      {row}
    </SidebarMenuSurface>
  );
}
