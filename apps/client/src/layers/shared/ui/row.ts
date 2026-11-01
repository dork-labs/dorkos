/**
 * How a row answers: hover, press, focus and selection, in one recipe.
 *
 * Every list outside a menu draws its rows from this — `ListRow`, `OptionRow`
 * and the sidebar's own `SidebarRow` — so "what a hovered row looks like" is
 * one answer rather than six. Before it, the same grammar was hand-rolled with
 * `hover:bg-muted`, `hover:bg-accent/50`, `ring-2` and a ternary to `bg-accent`,
 * and `--muted` inverts between themes, so a hover could be a step down.
 *
 * **The tints are foreground alpha** (`--row-hover`, `--row-selected`, defined
 * in `index.css` with gentler values inside floating and modal surfaces), so a
 * step reads the same on the page, a card, a group and a popover. Selected is
 * one step and does not change on hover; it is instant, because selection
 * follows the keyboard and must never lag behind it.
 *
 * **Focus is an inset outline**, not an outer one: rows tile edge to edge
 * inside clipped scrollers, so an outer ring overlaps the next row and is cut
 * off by `overflow`. Same colour and width as every other control's (B6), and
 * an outline survives `forced-colors`. A focused row also takes the hover tint,
 * so a keyboard user never learns less than a mouse user.
 *
 * @module shared/ui/row
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib/utils';
import { PRESS_ROW } from './press';

/** The inset focus outline every row uses (C7). Exported for rows that are not `cva`-built. */
export const ROW_FOCUS_CLASS =
  'outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/**
 * The row's tint and weight, by state: the half of the recipe that belongs on
 * whatever element draws the row's background.
 *
 * Split from {@link rowStateVariants} because a row with actions draws its
 * tint on a wrapper (the actions sit inside the tint) while focus and press
 * belong to the row's own button, and the actions are its siblings.
 *
 * - `surface`: `default` takes the row ladder; `sidebar` keeps the sidebar's own
 *   `--sidebar-accent` ramp (its `/70` hover measures as the same step).
 * - `interactive`: `false` for a static row — no hover, nothing that promises a
 *   click it will not answer.
 * - `state`: `rest`, `selected` (one tint step, weight 500), `emphasized`
 *   (unread: weight 600, full ink) or `disabled`.
 */
export const rowTintVariants = cva('', {
  variants: {
    surface: { default: '', sidebar: '' },
    interactive: { true: '', false: '' },
    state: {
      rest: '',
      selected: 'font-medium',
      emphasized: 'font-semibold',
      disabled: 'opacity-50',
    },
  },
  compoundVariants: [
    {
      surface: 'default',
      interactive: true,
      state: ['rest', 'emphasized'],
      className: 'hover:bg-row-hover',
    },
    { surface: 'default', state: 'selected', className: 'bg-row-selected' },
    {
      surface: 'sidebar',
      interactive: true,
      state: ['rest', 'emphasized'],
      className: 'hover:bg-sidebar-accent/70',
    },
    {
      surface: 'sidebar',
      state: 'selected',
      className: 'bg-sidebar-accent text-sidebar-accent-foreground',
    },
  ],
  defaultVariants: { surface: 'default', interactive: true, state: 'rest' },
});

/**
 * The whole recipe on one element: tint, weight, the inset focus outline (with
 * the hover tint beside it) and the row press. For a row that is a single
 * focusable element — `OptionRow`, a plain list button.
 *
 * @param props - The same axes as {@link rowTintVariants}.
 */
export function rowStateVariants(props: RowStateVariants = {}): string {
  const interactive = props.interactive ?? true;
  const state = props.state ?? 'rest';
  const surface = props.surface ?? 'default';
  return cn(
    rowTintVariants({ surface, interactive, state }),
    interactive && cn(ROW_FOCUS_CLASS, PRESS_ROW),
    interactive &&
      state !== 'selected' &&
      (surface === 'sidebar' ? 'focus-visible:bg-sidebar-accent/70' : 'focus-visible:bg-row-hover'),
    // Selection follows the keyboard, so it lands at once rather than easing in.
    state === 'selected' && 'motion-safe:duration-0'
  );
}

/** The props {@link rowTintVariants} and {@link rowStateVariants} read. */
export type RowStateVariants = VariantProps<typeof rowTintVariants>;

/** The four states a row can stand in, stamped as `data-row-state` so tests read state, not classes. */
export type RowState = 'rest' | 'selected' | 'emphasized' | 'disabled';

/**
 * Which state a row is in, from the flags that decide it.
 *
 * Precedence, highest first: disabled, selected, emphasized.
 *
 * @param row - The row's flags.
 */
export function rowState(row: {
  disabled?: boolean;
  selected?: boolean;
  emphasized?: boolean;
}): RowState {
  if (row.disabled) return 'disabled';
  if (row.selected) return 'selected';
  if (row.emphasized) return 'emphasized';
  return 'rest';
}
