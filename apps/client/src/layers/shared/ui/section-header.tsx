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
import { SIDEBAR_SECTION_TOGGLE_ATTRIBUTE } from '@/layers/shared/model/use-roving-focus';
import { SidebarMenuSurface, type SidebarMenuNode } from './sidebar-menu-node';

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
 * section action without a pointer — which is also the only way the menu exists
 * at all on a device with no right-click.
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

  const labelLine =
    editor !== undefined ? (
      <span className="flex h-8 min-w-0 flex-1 items-center px-2">{editor}</span>
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
          'group/section-toggle flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-hidden focus-visible:ring-2'
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
      <span className="text-sidebar-foreground/70 flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-xs font-medium">
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
      kebabClassName={hasSectionAction ? 'right-8' : undefined}
      className={cn('flex h-8 items-center', hasSectionAction ? 'pr-14' : 'pr-7', className)}
    >
      {labelLine}
      {trailing !== undefined && (
        <span className="flex flex-none items-center gap-1.5 pr-1">{trailing}</span>
      )}
    </SidebarMenuSurface>
  );
}
