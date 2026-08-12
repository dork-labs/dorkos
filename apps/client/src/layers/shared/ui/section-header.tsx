/**
 * The sidebar's one section header.
 *
 * Replaces the two near-identical implementations the sidebar shipped with —
 * one for its built-in sections, one for user groups — which had drifted into
 * two hover treatments, two menu wirings and two ideas about where the "…"
 * sits. A group IS a section, so it gets the section header.
 *
 * @module shared/ui/section-header
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { SIDEBAR_SECTION_TOGGLE_ATTRIBUTE } from '@/layers/shared/model/use-roving-focus';
import { SIDEBAR_MENU_GUTTER, SidebarMenuSurface, type SidebarMenuNode } from './sidebar-menu-node';

/**
 * How tall a section header is, by pointer.
 *
 * 32px under a mouse. 44px under a thumb, matching the rows underneath it: a
 * header is a control — it folds the section, and it is the door to rename,
 * sort, mute and delete-group — so it is a touch target like any other, and a
 * list where the headers are shorter than the rows reads as a mistake before
 * anyone measures it (P4 AC-4).
 */
const SECTION_HEADER_HEIGHT = { fine: 'h-8', coarse: 'h-11' } as const;

/**
 * The header's right padding, holding its satellites off the label.
 *
 * The `+` sits at the outer edge and the "⋮" inboard of it, so a header that
 * has both pays for both — twice the gutter a row pays, at whichever size the
 * pointer earns.
 */
const SECTION_HEADER_GUTTER = {
  fine: { one: SIDEBAR_MENU_GUTTER.fine, two: 'pr-14' },
  coarse: { one: SIDEBAR_MENU_GUTTER.coarse, two: 'pr-22' },
} as const;

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  /**
   * The section's name, in sentence case. Rendered as written — the ALL-CAPS
   * letterspacing the sidebar used to wear is retired (design-decisions §11), so
   * "Direct messages" is one word capitalised and not two.
   */
  label: string;
  /**
   * The section's identity icon. On a collapsible header it MORPHS into the
   * collapse chevron on hover and on `focus-visible`: at rest the header says
   * what the section is, and the moment you reach for it, it says what pressing
   * it will do. One slot, two jobs, nothing extra drawn at rest
   * (design-decisions §11). On a header that cannot collapse there is nothing
   * to morph into, so it simply stays put.
   */
  icon?: LucideIcon;
  /**
   * Current collapse state. Omit — along with {@link onToggle} — for a section
   * that cannot collapse; the header then renders as a plain label carrying the
   * same menus.
   */
  collapsed?: boolean;
  /** Flip the collapse state. Receives `{ all: true }` for an Alt/Option-click. */
  onToggle?: (options: { all: boolean }) => void;
  /** Collapse or expand EVERY section — Alt/Option-click on any header (BC-30). */
  onToggleAll?: () => void;
  /** The section's menu, as data. Empty means no right-click menu and no "⋮". */
  nodes?: SidebarMenuNode[];
  /** Accessible name for the "⋮" trigger. Defaults to `"<label> section actions"`. */
  actionsLabel?: string;
  /** Width class for the menus. */
  menuWidth?: string;
  /**
   * The section is asking to be read — the same unread emphasis
   * {@link SidebarRow} wears, on a header.
   *
   * **This is how a folded section keeps its `activity` tier.** Collapsing may
   * never lose signal (BC-31), and the two-tier system says `activity` is a
   * bold label and NOTHING else — no badge, no dot (design-decisions §18). So
   * `trailing` cannot carry it: a mark there would be the third weight the
   * system deliberately does not have. Without this prop a collapsed section
   * holding unread activity was indistinguishable from a quiet one.
   */
  emphasized?: boolean;
  /**
   * Rendered at the right of the header — a collapsed section's rollup, an
   * activity dot. Sits left of the "⋮" gutter, never under it.
   */
  trailing?: ReactNode;
  /** Rendered immediately after the label — a smart group's rule glyph. */
  adornment?: ReactNode;
  /**
   * An inline editor that REPLACES the label — renaming a group. The "⋮" is
   * withdrawn while it is up, so the menu that opened the editor cannot offer a
   * second door back into itself.
   */
  editor?: ReactNode;
  /**
   * Heading level. Sections are `<h3>`; a group sub-header inside Agents is an
   * `<h4>`, because it is one level down and a screen reader's heading list is
   * the fastest map of the sidebar there is (R2).
   */
  level?: 3 | 4;
  /** Id of the element this header expands, for `aria-controls`. */
  controlsId?: string;
  /**
   * The section also draws a `+` in the header row's top-right corner. The "⋮"
   * then sits left of it instead of underneath it.
   */
  hasSectionAction?: boolean;
  /** Extra classes on the header row. */
  className?: string;
}

/**
 * A section's name, its collapse control, and everything you can do to it.
 *
 * **The whole row is the toggle.** Destinations in this sidebar are always leaf
 * rows, so pressing a header can only ever mean one thing and there is no
 * select-versus-expand ambiguity to resolve with a separate chevron hit target
 * (BC-29). `Alt`/`Option`-click folds or unfolds every section at once (BC-30).
 *
 * The chevron is decorative; `aria-expanded` on the header button carries the
 * collapse state and `aria-controls` names what it opens. The "⋮" is a real
 * focusable button that `focus-visible` reveals, so a keyboard reaches every
 * section action without a pointer.
 *
 * **On touch that "⋮" is drawn at rest, and a long press opens the same menu as
 * a sheet.** Neither used to be true here: rows passed `alwaysShowActions` and
 * headers did not, so on a phone the header's kebab sat at `opacity-0` and
 * rename, sort, mute and delete-group had no door at all (DOR-1083). Both
 * behaviours now come from {@link SidebarMenuSurface}, which reads the device
 * once for every surface that draws a menu — the fix is that the question is no
 * longer a prop a caller can forget to pass.
 */
export function SectionHeader({
  label,
  icon: Icon,
  collapsed,
  onToggle,
  onToggleAll,
  nodes = [],
  actionsLabel,
  menuWidth = 'w-48',
  emphasized = false,
  trailing,
  adornment,
  editor,
  level = 3,
  controlsId,
  hasSectionAction = false,
  className,
}: SectionHeaderProps) {
  const heading = level === 4 ? 'h4' : 'h3';
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const isMobile = useIsMobile();
  const pointer = isMobile ? 'coarse' : 'fine';
  const height = SECTION_HEADER_HEIGHT[pointer];

  const labelLine =
    editor !== undefined ? (
      <span className={cn('flex min-w-0 flex-1 items-center px-2', height)}>{editor}</span>
    ) : onToggle ? (
      <button
        type="button"
        onClick={(event) => {
          if (event.altKey && onToggleAll) {
            onToggleAll();
            return;
          }
          onToggle({ all: false });
        }}
        aria-expanded={!collapsed}
        // **Only while the target exists.** Every section unmounts its list
        // behind a `{!collapsed && …}` guard, and `aria-controls` pointing at an
        // id that is not in the document is an invalid reference — in exactly
        // the state (`aria-expanded={false}`) where assistive tech is most
        // likely to follow it.
        aria-controls={collapsed ? undefined : controlsId}
        {...{ [SIDEBAR_SECTION_TOGGLE_ATTRIBUTE]: '' }}
        className={cn(
          'text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring',
          'group/section-toggle flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-hidden focus-visible:ring-2',
          height,
          emphasized && 'text-sidebar-foreground font-semibold'
        )}
      >
        {Icon ? (
          // The morph. Both marks occupy the same 14px box and cross-fade, so
          // the label never shifts by a pixel when the pointer arrives.
          <span className="relative flex size-3.5 shrink-0 items-center justify-center">
            <Icon
              aria-hidden
              className="absolute size-3.5 transition-opacity group-hover/section-toggle:opacity-0 group-focus-visible/section-toggle:opacity-0"
            />
            <Chevron
              aria-hidden
              className="absolute size-3.5 opacity-0 transition-opacity group-hover/section-toggle:opacity-100 group-focus-visible/section-toggle:opacity-100"
            />
          </span>
        ) : (
          <Chevron aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        {adornment}
      </button>
    ) : (
      <span
        className={cn(
          'text-sidebar-foreground/70 flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs font-medium',
          height,
          emphasized && 'text-sidebar-foreground font-semibold'
        )}
      >
        {/* The icon draws here too. A section that cannot collapse has no
            chevron to morph into, so the mark simply stays put — but it still
            has to be DRAWN, or `Pinned` asks for a pin and gets a bare word. */}
        {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
        {adornment}
      </span>
    );

  return (
    <SidebarMenuSurface
      as={heading}
      nodes={nodes}
      actionsLabel={actionsLabel ?? `${label} section actions`}
      menuWidth={menuWidth}
      hideActionsTrigger={editor !== undefined}
      kebabClassName={hasSectionAction ? (isMobile ? 'right-11' : 'right-8') : undefined}
      className={cn(
        'flex items-center',
        height,
        hasSectionAction ? SECTION_HEADER_GUTTER[pointer].two : SECTION_HEADER_GUTTER[pointer].one,
        className
      )}
    >
      {labelLine}
      {trailing !== undefined && (
        <span className="flex flex-none items-center gap-1.5 pr-1">{trailing}</span>
      )}
    </SidebarMenuSurface>
  );
}
