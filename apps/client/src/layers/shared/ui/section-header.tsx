/**
 * The sidebar's one section header.
 *
 * Replaces the two near-identical implementations the sidebar shipped with —
 * one for its built-in sections, one for user groups — which had drifted into
 * two hover treatments, two menu wirings and two ideas about where the "…"
 * sits. A group IS a section, so it gets the section header.
 *
 * **And it is now the only header in the panel.** Heads up, Today, Getting
 * started, Pins, Channels, Direct messages, Agents and every section the
 * operator makes are all this component: 11px, medium, `--sidebar-header-x`,
 * no icon. The zone `<h2>` above it is gone (`specs/sidebar-simplification`
 * D1) — three levels in a 272px panel was one more than anybody could read.
 *
 * @module shared/ui/section-header
 */
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { SIDEBAR_SECTION_TOGGLE_ATTRIBUTE } from '@/layers/shared/model/interaction/use-roving-focus';
import { SIDEBAR_MENU_GUTTER, SidebarMenuSurface, type SidebarMenuNode } from './sidebar-menu-node';

/**
 * How tall a section header is, by pointer.
 *
 * 28px under a mouse — one step down from the 32px it used to be, because the
 * header lost its icon and gained a smaller type size, and a header taller than
 * the rows under it reads as a gap. 44px under a thumb, matching those rows: a
 * header is a control — it folds the section, and it is the door to rename,
 * sort, mute and delete — so it is a touch target like any other (P4 AC-4).
 */
const SECTION_HEADER_HEIGHT = { fine: 'h-7', coarse: 'h-11' } as const;

/**
 * The header's left inset, derived from `--sidebar-header-x`.
 *
 * The token says where the label starts measured from the PANEL's left edge
 * (12px); the panel already paid 8 of it with its own `px-2`, so the header pays
 * the remainder. Same arithmetic, same `0.5rem` literal and same browser
 * assertion as `SIDEBAR_ROW_INSET` — see its docblock.
 */
export const SECTION_HEADER_INSET = 'pl-[calc(var(--sidebar-header-x)_-_0.5rem)]';

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

/**
 * Chrome that is drawn only when somebody is reaching for it.
 *
 * Opacity only, 120 ms, and nothing at rest — the calm-panel rule (R2). Under a
 * reduced-motion preference the transition is never applied, so the reveal is
 * instant rather than a shorter animation. Touch has no hover and overrides this
 * to `opacity-100`; `focus-within` is what makes it reachable from a keyboard.
 */
export const SIDEBAR_HOVER_REVEAL =
  'opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 motion-safe:transition-opacity motion-safe:duration-[120ms]';

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  /**
   * The section's name, in sentence case. Rendered as written — the ALL-CAPS
   * letterspacing the sidebar used to wear is retired (design-decisions §11), so
   * "Direct messages" is one word capitalised and not two.
   */
  label: string;
  /**
   * Current collapse state. Omit — along with {@link onToggle} — for a section
   * that cannot collapse; the header then renders as a plain label carrying the
   * same menus.
   */
  collapsed?: boolean;
  /** Flip the collapse state. Receives `{ all: true }` for an Alt/Option-click. */
  onToggle?: (options: { all: boolean }) => void;
  /** Collapse or expand EVERY header in the panel — Alt/Option-click on any one (BC-30). */
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
   * What a folded header says about what it is hiding — "12 · 3 unread".
   *
   * Sits at the right of the label, inboard of the chevron, and is the whole of
   * BC-31 now that headers fold everywhere: folding Heads up must not be a way
   * to make a permission prompt disappear quietly, so its roll-up carries the
   * needs-you count.
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
 * (BC-29). `Alt`/`Option`-click folds or unfolds every header in the panel at
 * once (BC-30, widened from Library to the whole panel in D1).
 *
 * **Nothing is drawn at rest but the label.** The icon that used to sit before
 * it is gone — the rows underneath carry the glyph, and a `#` above a list of
 * `#` rows said the same thing twice. The chevron replaces it at the RIGHT, and
 * only while the header is hovered or holds focus; `aria-expanded` on the button
 * carries the collapse state for anyone who cannot see it, and `aria-controls`
 * names what it opens.
 *
 * **On touch the "⋮" and the `+` are drawn at rest, and a long press opens the
 * same menu as a sheet.** Neither used to be true here: rows passed
 * `alwaysShowActions` and headers did not, so on a phone the header's kebab sat
 * at `opacity-0` and rename, sort, mute and delete-group had no door at all
 * (DOR-1083). Both behaviours now come from {@link SidebarMenuSurface}, which
 * reads the device once for every surface that draws a menu — the fix is that
 * the question is no longer a prop a caller can forget to pass.
 */
export function SectionHeader({
  label,
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
  const isMobile = useIsMobile();
  const pointer = isMobile ? 'coarse' : 'fine';
  const height = SECTION_HEADER_HEIGHT[pointer];
  // One line, whether it comes from the label button or the plain span: 11px
  // medium at `--sidebar-header-x`, and nothing else. Spelled once so a section
  // that cannot fold cannot end up looking like a different kind of thing.
  const line = cn(
    'text-sidebar-foreground/70 flex min-w-0 flex-1 items-center gap-1.5 text-2xs font-medium',
    SECTION_HEADER_INSET,
    height,
    emphasized && 'text-sidebar-foreground font-semibold'
  );
  // The right cluster inside the label line: what the fold is hiding, then the
  // chevron that unhides it. `ml-auto` on the group rather than on either piece,
  // so a header with no roll-up still parks its chevron at the right edge.
  const rightCluster = (
    // **Capped at half the line, and the cap is the priority rule.** `flex-none`
    // here put every pixel of shortfall on the label, so a 272px panel folded
    // "Channels" into "Chann…" to make room for "12 · 3 unread · 1 working". The
    // section's NAME is what a person navigates by; the roll-up is what they
    // read once they are looking, and it truncates from its own half. Same
    // budget-in-CSS idiom the row uses for `who › title` (`row-grammar.ts`).
    <span className="ml-auto flex max-w-[50%] min-w-0 items-center gap-1.5 pl-1.5">
      {trailing !== undefined && (
        // `/70` rather than `/50`: this is 11px text and owes 4.5:1 like every
        // other label in the panel, and `/50` measures 3.2:1 on the light
        // theme's zone tint. It reads as secondary because it is not `medium`
        // and the label is.
        <span
          // It fades in over 120 ms rather than appearing (spec D5). The fold
          // that produced it is a spring, and a count snapping into existence
          // halfway through one reads as a second, unrelated event. `motion-safe`
          // and nothing else: under a reduced-motion preference the count is
          // simply there, which is the same rule the chevron beside it follows.
          className="text-sidebar-foreground/70 motion-safe:animate-sidebar-rollup-in text-2xs truncate font-normal tabular-nums"
        >
          {trailing}
        </span>
      )}
      {onToggle !== undefined && (
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0',
            SIDEBAR_HOVER_REVEAL,
            // The fold state, as a rotation rather than as a second icon: one
            // element, so the label beside it never shifts by a pixel when the
            // section opens.
            'motion-safe:transition-transform motion-safe:duration-[120ms]',
            collapsed && '-rotate-90'
          )}
        />
      )}
    </span>
  );

  const labelLine =
    editor !== undefined ? (
      <span className={cn('flex min-w-0 flex-1 items-center', SECTION_HEADER_INSET, height)}>
        {editor}
      </span>
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
          line,
          'hover:text-sidebar-foreground focus-visible:ring-sidebar-ring rounded-md outline-hidden focus-visible:ring-2'
        )}
      >
        <span className="truncate">{label}</span>
        {adornment}
        {rightCluster}
      </button>
    ) : (
      <span className={line}>
        <span className="truncate">{label}</span>
        {adornment}
        {rightCluster}
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
    </SidebarMenuSurface>
  );
}
