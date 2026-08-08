/**
 * Jump-back-in feature — the recents popover that floats over an empty
 * composer (spec `team-room-home` §D2.3).
 *
 * The panel half of the "one model, two surfaces" split: `entities/recents`
 * owns the list, the sidebar section draws it as a place, and this draws it as
 * a glance back at what you were doing before you start typing.
 *
 * Shaped after `features/mentions`, the composer's other palette: a hook that
 * owns the panel and its cursor, a presentational component that draws it, and
 * a host that wires both to `Composer.Input`'s shipped palette props. Neither
 * palette forks the composer, and the two are told to yield to each other
 * rather than stacking two listboxes over one text field.
 *
 * @module features/jump-back-in
 */
export { JumpBackInPopover } from './ui/JumpBackInPopover';
export type { JumpBackInPopoverProps } from './ui/JumpBackInPopover';
export {
  useJumpBackInPopover,
  JUMP_BACK_IN_LISTBOX_ID,
  JUMP_BACK_IN_POPOVER_ROWS,
  jumpBackInRowId,
} from './model/use-jump-back-in-popover';
export type {
  UseJumpBackInPopover,
  UseJumpBackInPopoverOptions,
} from './model/use-jump-back-in-popover';
